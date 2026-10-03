/**
 * Generic, fail-closed sanitization policy validation and value operations.
 * Projects own the policy, schema inventory, pseudonym keys, and derivation logic.
 */

import { createHash } from "node:crypto";
import { validateExecutablePrivacyPolicy } from "./privacy_engine.mjs";

export const SANITIZATION_ACTIONS = Object.freeze({
  KEEP: "KEEP",
  PSEUDONYMIZE: "PSEUDONYMIZE",
  REPLACE: "REPLACE",
  EXCLUDE: "EXCLUDE",
  DERIVE: "DERIVE",
});

export const EXCLUDED_VALUE = Symbol("REHEARSAL_EXCLUDED_VALUE");

const actionAliases = new Map([
  ["KEEP", SANITIZATION_ACTIONS.KEEP],
  ["KEEP EXACTLY", SANITIZATION_ACTIONS.KEEP],
  ["PSEUDONYMIZE", SANITIZATION_ACTIONS.PSEUDONYMIZE],
  ["REPLACE", SANITIZATION_ACTIONS.REPLACE],
  ["REPLACE WITH SYNTHETIC", SANITIZATION_ACTIONS.REPLACE],
  ["EXCLUDE", SANITIZATION_ACTIONS.EXCLUDE],
  ["DERIVE", SANITIZATION_ACTIONS.DERIVE],
]);

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;

const assertIdentifier = (value, label) => {
  if (!identifierPattern.test(value ?? "")) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
};
const tableSchema = (table) => table.schema ?? "public";
const tableKey = (table) =>
  tableSchema(table) === "public"
    ? table.name
    : `${tableSchema(table)}.${table.name}`;

export const normalizeSanitizationAction = (action) => {
  const normalized = actionAliases.get(
    String(action ?? "")
      .trim()
      .toUpperCase(),
  );
  if (!normalized) {
    throw new Error(`Unknown Rehearsal sanitization action: ${action}.`);
  }
  return normalized;
};

export const validateRuntimeSanitizationPolicy = (policy) => {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("A Rehearsal sanitization policy object is required.");
  }
  if (policy.draft === true) {
    throw new Error(
      "The sanitization policy is still a REVIEW REQUIRED draft.",
    );
  }
  if (policy.policyVersion === 2) {
    return validateExecutablePrivacyPolicy(policy);
  }
  if (policy.policyVersion !== 1) {
    throw new Error("The sanitization policy must use policyVersion 1 or 2.");
  }
  if (!/^\d{14}$/u.test(policy.migrationCutoff ?? "")) {
    throw new Error(
      "The sanitization policy must declare a timestamp migrationCutoff.",
    );
  }
  if (!Array.isArray(policy.tables) || policy.tables.length === 0) {
    throw new Error("The sanitization policy does not list tables.");
  }
  const tables = new Set();
  for (const table of policy.tables) {
    const schemaName = assertIdentifier(
      tableSchema(table),
      "Sanitization policy table schema",
    );
    const tableName = assertIdentifier(
      table?.name,
      "Sanitization policy table name",
    );
    const key =
      schemaName === "public" ? tableName : `${schemaName}.${tableName}`;
    if (tables.has(key)) {
      throw new Error(`Sanitization policy duplicates table ${key}.`);
    }
    tables.add(key);
    if (!["STREAM AND SANITIZE", "EXCLUDE"].includes(table.sourceRows)) {
      throw new Error(
        `Sanitization policy table ${tableName} has an invalid sourceRows decision.`,
      );
    }
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      throw new Error(
        `Sanitization policy table ${tableName} must list its columns.`,
      );
    }
    const columns = new Set();
    for (const column of table.columns) {
      const columnName = assertIdentifier(
        column?.name,
        `Sanitization policy column in ${tableName}`,
      );
      if (columns.has(columnName)) {
        throw new Error(
          `Sanitization policy duplicates column ${tableName}.${columnName}.`,
        );
      }
      columns.add(columnName);
      normalizeSanitizationAction(column.action);
      if (!["ALWAYS", "NEVER"].includes(column.generated)) {
        throw new Error(
          `Sanitization policy column ${tableName}.${columnName} must classify generated as ALWAYS or NEVER.`,
        );
      }
      if (!["YES", "NO"].includes(column.identity)) {
        throw new Error(
          `Sanitization policy column ${tableName}.${columnName} must classify identity as YES or NO.`,
        );
      }
      if (column.foreignKey !== null) {
        if (
          !column.foreignKey ||
          typeof column.foreignKey !== "object" ||
          Array.isArray(column.foreignKey)
        ) {
          throw new Error(
            `Sanitization policy column ${tableName}.${columnName} has an invalid foreignKey decision.`,
          );
        }
        assertIdentifier(
          column.foreignKey.schema,
          `Foreign-key schema for ${tableName}.${columnName}`,
        );
        assertIdentifier(
          column.foreignKey.table,
          `Foreign-key table for ${tableName}.${columnName}`,
        );
        assertIdentifier(
          column.foreignKey.column,
          `Foreign-key column for ${tableName}.${columnName}`,
        );
      }
    }
  }
  return policy;
};

export const readBoundRuntimeSanitizationPolicy = ({
  bytes,
  expectedSha256,
}) => {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const policy = validateRuntimeSanitizationPolicy(
    JSON.parse(source.toString("utf8")),
  );
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      "The active sanitization policy does not match the reviewed baseline policy checksum.",
    );
  }
  return policy;
};

const indexTables = (tables, label) => {
  if (!Array.isArray(tables)) throw new Error(`${label} must be an array.`);
  const index = new Map();
  for (const table of tables) {
    const schema = assertIdentifier(
      tableSchema(table),
      `${label} table schema`,
    );
    const name = assertIdentifier(table?.name, `${label} table name`);
    const key = schema === "public" ? name : `${schema}.${name}`;
    if (index.has(key)) throw new Error(`${label} duplicates table ${key}.`);
    if (!Array.isArray(table.columns)) {
      throw new Error(`${label} table ${name} must list its columns.`);
    }
    const columns = new Map();
    for (const column of table.columns) {
      const columnName = assertIdentifier(
        typeof column === "string" ? column : column?.name,
        `${label} column name`,
      );
      if (columns.has(columnName)) {
        throw new Error(`${label} duplicates column ${name}.${columnName}.`);
      }
      columns.set(columnName, column);
    }
    index.set(key, { table: { ...table, schema }, columns });
  }
  return index;
};

export const validateSanitizationCoverage = ({ policy, schemaTables }) => {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("A Rehearsal sanitization policy object is required.");
  }
  const schema = indexTables(schemaTables, "Schema inventory");
  const classified = indexTables(policy.tables, "Sanitization policy");
  const normalizedTables = [];

  for (const [tableName, schemaEntry] of schema) {
    const policyEntry = classified.get(tableName);
    if (!policyEntry) {
      throw new Error(
        `Sanitization policy does not classify table ${tableName}.`,
      );
    }
    const normalizedColumns = [];
    for (const columnName of schemaEntry.columns.keys()) {
      const column = policyEntry.columns.get(columnName);
      if (!column) {
        throw new Error(
          `Sanitization policy does not classify column ${tableName}.${columnName}.`,
        );
      }
      normalizedColumns.push({
        ...column,
        name: columnName,
        action: normalizeSanitizationAction(column.action),
      });
    }
    for (const columnName of policyEntry.columns.keys()) {
      if (!schemaEntry.columns.has(columnName)) {
        throw new Error(
          `Sanitization policy references unknown column ${tableName}.${columnName}.`,
        );
      }
    }
    normalizedTables.push({
      ...policyEntry.table,
      schema: tableSchema(policyEntry.table),
      columns: normalizedColumns,
    });
  }

  for (const tableName of classified.keys()) {
    if (!schema.has(tableName)) {
      throw new Error(
        `Sanitization policy references unknown table ${tableName}.`,
      );
    }
  }

  return Object.freeze({
    policyVersion: policy.policyVersion,
    tableCount: normalizedTables.length,
    columnCount: normalizedTables.reduce(
      (total, table) => total + table.columns.length,
      0,
    ),
    tables: Object.freeze(normalizedTables),
  });
};

export const applySanitizationAction = ({
  action,
  value,
  replace,
  pseudonymize,
  derive,
  context = {},
}) => {
  switch (normalizeSanitizationAction(action)) {
    case SANITIZATION_ACTIONS.KEEP:
      return value;
    case SANITIZATION_ACTIONS.EXCLUDE:
      return EXCLUDED_VALUE;
    case SANITIZATION_ACTIONS.REPLACE:
      if (typeof replace !== "function") {
        throw new Error(
          "REPLACE requires a project-owned replacement function.",
        );
      }
      return replace(value, context);
    case SANITIZATION_ACTIONS.PSEUDONYMIZE:
      if (typeof pseudonymize !== "function") {
        throw new Error(
          "PSEUDONYMIZE requires a project-owned pseudonymization function.",
        );
      }
      return pseudonymize(value, context);
    case SANITIZATION_ACTIONS.DERIVE:
      if (typeof derive !== "function") {
        throw new Error("DERIVE requires a project-owned derivation function.");
      }
      return derive(value, context);
    default:
      throw new Error("Unreachable Rehearsal sanitization action.");
  }
};
