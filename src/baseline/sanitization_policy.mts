/**
 * Generic, fail-closed sanitization policy validation and value operations.
 * Projects own the policy, schema inventory, pseudonym keys, and derivation logic.
 */

import { createHash } from "node:crypto";
import {
  validateExecutablePrivacyPolicy,
  type ExecutablePrivacyPolicy,
} from "./privacy_engine.mjs";

export const SANITIZATION_ACTIONS = Object.freeze({
  KEEP: "KEEP",
  PSEUDONYMIZE: "PSEUDONYMIZE",
  REPLACE: "REPLACE",
  EXCLUDE: "EXCLUDE",
  DERIVE: "DERIVE",
});

export const EXCLUDED_VALUE = Symbol("REHEARSAL_EXCLUDED_VALUE");

export type SanitizationAction =
  (typeof SANITIZATION_ACTIONS)[keyof typeof SANITIZATION_ACTIONS];

export interface LegacySanitizationPolicyColumn extends PolicyObject {
  readonly name: string;
  readonly action: SanitizationAction;
  readonly generated: "ALWAYS" | "NEVER";
  readonly identity: "YES" | "NO";
  readonly foreignKey: Readonly<{
    schema: string;
    table: string;
    column: string;
  }> | null;
}

export interface LegacySanitizationPolicyTable {
  readonly schema?: string;
  readonly name: string;
  readonly sourceRows: "STREAM AND SANITIZE" | "EXCLUDE";
  readonly columns: readonly LegacySanitizationPolicyColumn[];
}

export interface LegacySanitizationPolicy {
  readonly policyVersion: 1;
  readonly migrationCutoff: string;
  readonly tables: readonly LegacySanitizationPolicyTable[];
}

export type RuntimeSanitizationPolicy =
  LegacySanitizationPolicy | ExecutablePrivacyPolicy;

type PolicyObject = Record<string, unknown>;
type SanitizationCallback = (
  value: unknown,
  context: Record<string, unknown>,
) => unknown;

const isPolicyObject = (value: unknown): value is PolicyObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertPolicyObject = (value: unknown, label: string): PolicyObject => {
  if (!isPolicyObject(value)) throw new Error(`${label} must be an object.`);
  return value;
};

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

const assertIdentifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
};
const tableSchema = (table: PolicyObject): string =>
  assertIdentifier(
    table.schema ?? "public",
    "Sanitization policy table schema",
  );

export const normalizeSanitizationAction = (
  action: unknown,
): SanitizationAction => {
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

export const validateRuntimeSanitizationPolicy = (
  policy: unknown,
): RuntimeSanitizationPolicy => {
  if (!isPolicyObject(policy)) {
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
  if (
    typeof policy.migrationCutoff !== "string" ||
    !/^\d{14}$/u.test(policy.migrationCutoff)
  ) {
    throw new Error(
      "The sanitization policy must declare a timestamp migrationCutoff.",
    );
  }
  if (!Array.isArray(policy.tables) || policy.tables.length === 0) {
    throw new Error("The sanitization policy does not list tables.");
  }
  const tables = new Set();
  for (const tableValue of policy.tables) {
    const table = assertPolicyObject(tableValue, "Sanitization policy table");
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
    if (
      typeof table.sourceRows !== "string" ||
      !["STREAM AND SANITIZE", "EXCLUDE"].includes(table.sourceRows)
    ) {
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
    for (const columnValue of table.columns) {
      const column = assertPolicyObject(
        columnValue,
        `Sanitization policy column in ${tableName}`,
      );
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
      if (
        typeof column.generated !== "string" ||
        !["ALWAYS", "NEVER"].includes(column.generated)
      ) {
        throw new Error(
          `Sanitization policy column ${tableName}.${columnName} must classify generated as ALWAYS or NEVER.`,
        );
      }
      if (
        typeof column.identity !== "string" ||
        !["YES", "NO"].includes(column.identity)
      ) {
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
        const foreignKey = column.foreignKey as PolicyObject;
        assertIdentifier(
          foreignKey.schema,
          `Foreign-key schema for ${tableName}.${columnName}`,
        );
        assertIdentifier(
          foreignKey.table,
          `Foreign-key table for ${tableName}.${columnName}`,
        );
        assertIdentifier(
          foreignKey.column,
          `Foreign-key column for ${tableName}.${columnName}`,
        );
      }
    }
  }
  return policy as unknown as LegacySanitizationPolicy;
};

export const readBoundRuntimeSanitizationPolicy = ({
  bytes,
  expectedSha256,
}: {
  bytes: Uint8Array | string;
  expectedSha256: string;
}): RuntimeSanitizationPolicy => {
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

interface IndexedTable {
  table: PolicyObject;
  columns: Map<string, unknown>;
}

const indexTables = (
  tables: unknown,
  label: string,
): Map<string, IndexedTable> => {
  if (!Array.isArray(tables)) throw new Error(`${label} must be an array.`);
  const index = new Map<string, IndexedTable>();
  for (const tableValue of tables) {
    const table = assertPolicyObject(tableValue, `${label} table`);
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
    const columns = new Map<string, unknown>();
    for (const column of table.columns) {
      const columnName = assertIdentifier(
        typeof column === "string"
          ? column
          : isPolicyObject(column)
            ? column.name
            : undefined,
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

export const validateSanitizationCoverage = ({
  policy,
  schemaTables,
}: {
  policy: unknown;
  schemaTables: unknown;
}) => {
  if (!isPolicyObject(policy)) {
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
      const policyColumn = assertPolicyObject(
        column,
        `Sanitization policy column ${tableName}.${columnName}`,
      );
      normalizedColumns.push({
        ...policyColumn,
        name: columnName,
        action: normalizeSanitizationAction(policyColumn.action),
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
}: {
  action: unknown;
  value: unknown;
  replace?: SanitizationCallback;
  pseudonymize?: SanitizationCallback;
  derive?: SanitizationCallback;
  context?: Record<string, unknown>;
}): unknown | typeof EXCLUDED_VALUE => {
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
