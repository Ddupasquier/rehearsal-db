/**
 * Generic, fail-closed sanitization policy validation and value operations.
 * Projects own the policy, schema inventory, pseudonym keys, and derivation logic.
 */

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

const indexTables = (tables, label) => {
  if (!Array.isArray(tables)) throw new Error(`${label} must be an array.`);
  const index = new Map();
  for (const table of tables) {
    const name = assertIdentifier(table?.name, `${label} table name`);
    if (index.has(name)) throw new Error(`${label} duplicates table ${name}.`);
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
    index.set(name, { table, columns });
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
      name: tableName,
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
