/**
 * Execute reviewed privacy policy version 2 without project-owned callbacks.
 * The engine is intentionally small and fail-closed: unsupported shapes and
 * recipes must be reviewed and added here instead of evaluated as code.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set([
  "KEEP",
  "PSEUDONYMIZE",
  "REPLACE",
  "EXCLUDE",
  "DERIVE",
]);
const PSEUDONYM_FORMATS = new Set(["uuid", "email", "text", "integer"]);
const DERIVATION_KINDS = new Set(["date-shift", "json-object"]);
const KEY_BYTES = 32;

const isObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const knownKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};

const identifier = (value, label) => {
  if (!IDENTIFIER.test(value ?? "")) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
};

const nonEmpty = (value, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

const positiveInteger = (value, label, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
};

const validateRecipe = (action, recipe, label) => {
  if (action === "KEEP" || action === "EXCLUDE") {
    if (recipe !== undefined && recipe !== null) {
      throw new Error(`${label}.recipe is not allowed for ${action}.`);
    }
    return null;
  }
  if (!isObject(recipe)) {
    throw new Error(`${label}.recipe is required for ${action}.`);
  }
  if (action === "PSEUDONYMIZE") {
    knownKeys(recipe, ["format", "namespace", "maxLength"], `${label}.recipe`);
    if (!PSEUDONYM_FORMATS.has(recipe.format)) {
      throw new Error(`${label}.recipe.format is unsupported.`);
    }
    const normalized = {
      format: recipe.format,
      namespace: nonEmpty(recipe.namespace, `${label}.recipe.namespace`),
    };
    if (recipe.format === "text") {
      normalized.maxLength = positiveInteger(
        recipe.maxLength,
        `${label}.recipe.maxLength`,
        1_024,
      );
    } else if (recipe.maxLength !== undefined) {
      throw new Error(
        `${label}.recipe.maxLength is supported only for text pseudonyms.`,
      );
    }
    return Object.freeze(normalized);
  }
  if (action === "REPLACE") {
    knownKeys(recipe, ["kind", "value"], `${label}.recipe`);
    if (recipe.kind !== "constant" || !Object.hasOwn(recipe, "value")) {
      throw new Error(`${label}.recipe must be an explicit constant.`);
    }
    if (typeof recipe.value === "function" || recipe.value === undefined) {
      throw new Error(`${label}.recipe.value must be JSON-compatible.`);
    }
    JSON.stringify(recipe.value);
    return Object.freeze({ kind: "constant", value: recipe.value });
  }
  knownKeys(recipe, ["kind", "days", "fields", "allowNull"], `${label}.recipe`);
  if (!DERIVATION_KINDS.has(recipe.kind)) {
    throw new Error(`${label}.recipe.kind is unsupported.`);
  }
  if (recipe.kind === "date-shift") {
    const days = positiveInteger(recipe.days, `${label}.recipe.days`, 3_650);
    if (recipe.fields !== undefined || recipe.allowNull !== undefined) {
      throw new Error(
        `${label}.recipe contains fields not used by date-shift.`,
      );
    }
    return Object.freeze({ kind: "date-shift", days });
  }
  if (!isObject(recipe.fields) || Object.keys(recipe.fields).length === 0) {
    throw new Error(`${label}.recipe.fields must classify JSON object keys.`);
  }
  if (recipe.allowNull !== undefined && typeof recipe.allowNull !== "boolean") {
    throw new Error(`${label}.recipe.allowNull must be true or false.`);
  }
  const fields = Object.fromEntries(
    Object.entries(recipe.fields).map(([key, declaration]) => {
      if (!key || !isObject(declaration)) {
        throw new Error(`${label}.recipe.fields contains an invalid key.`);
      }
      knownKeys(
        declaration,
        ["action", "recipe"],
        `${label}.recipe.fields.${key}`,
      );
      const nestedAction = String(declaration.action ?? "").toUpperCase();
      if (!ACTIONS.has(nestedAction)) {
        throw new Error(`${label}.recipe.fields.${key}.action is unsupported.`);
      }
      return [
        key,
        Object.freeze({
          action: nestedAction,
          recipe: validateRecipe(
            nestedAction,
            declaration.recipe,
            `${label}.recipe.fields.${key}`,
          ),
        }),
      ];
    }),
  );
  return Object.freeze({
    kind: "json-object",
    allowNull: recipe.allowNull === true,
    fields: Object.freeze(fields),
  });
};

export const validateExecutablePrivacyPolicy = (policy) => {
  if (!isObject(policy)) throw new Error("Privacy policy must be an object.");
  knownKeys(
    policy,
    ["policyVersion", "draft", "migrationCutoff", "tables"],
    "policy",
  );
  if (policy.policyVersion !== 2) {
    throw new Error("Executable privacy policies must use policyVersion 2.");
  }
  if (policy.draft === true) {
    throw new Error("The privacy policy is still a REVIEW REQUIRED draft.");
  }
  if (!/^\d{14}$/u.test(policy.migrationCutoff ?? "")) {
    throw new Error(
      "Privacy policy migrationCutoff must be a timestamp version.",
    );
  }
  if (!Array.isArray(policy.tables) || policy.tables.length === 0) {
    throw new Error("Privacy policy must classify at least one table.");
  }
  const names = new Set();
  const tables = policy.tables.map((table, tableIndex) => {
    const label = `policy.tables[${tableIndex}]`;
    if (!isObject(table)) throw new Error(`${label} must be an object.`);
    knownKeys(table, ["schema", "name", "sourceRows", "columns"], label);
    const schema = identifier(table.schema ?? "public", `${label}.schema`);
    const name = identifier(table.name, `${label}.name`);
    const key = schema === "public" ? name : `${schema}.${name}`;
    if (names.has(key))
      throw new Error(`Privacy policy duplicates table ${key}.`);
    names.add(key);
    if (!["STREAM AND SANITIZE", "EXCLUDE"].includes(table.sourceRows)) {
      throw new Error(`${label}.sourceRows is unsupported.`);
    }
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      throw new Error(`${label}.columns must not be empty.`);
    }
    const columnNames = new Set();
    const columns = table.columns.map((column, columnIndex) => {
      const columnLabel = `${label}.columns[${columnIndex}]`;
      if (!isObject(column))
        throw new Error(`${columnLabel} must be an object.`);
      knownKeys(
        column,
        ["name", "action", "recipe", "generated", "identity", "foreignKey"],
        columnLabel,
      );
      const columnName = identifier(column.name, `${columnLabel}.name`);
      if (columnNames.has(columnName)) {
        throw new Error(
          `Privacy policy duplicates column ${name}.${columnName}.`,
        );
      }
      columnNames.add(columnName);
      const action = String(column.action ?? "").toUpperCase();
      if (!ACTIONS.has(action))
        throw new Error(`${columnLabel}.action is unsupported.`);
      if (!["ALWAYS", "NEVER"].includes(column.generated)) {
        throw new Error(`${columnLabel}.generated must be ALWAYS or NEVER.`);
      }
      if (!["YES", "NO"].includes(column.identity)) {
        throw new Error(`${columnLabel}.identity must be YES or NO.`);
      }
      if (column.foreignKey !== null) {
        if (!isObject(column.foreignKey)) {
          throw new Error(
            `${columnLabel}.foreignKey must be null or an object.`,
          );
        }
        knownKeys(
          column.foreignKey,
          ["schema", "table", "column"],
          `${columnLabel}.foreignKey`,
        );
        identifier(
          column.foreignKey.schema,
          `${columnLabel}.foreignKey.schema`,
        );
        identifier(column.foreignKey.table, `${columnLabel}.foreignKey.table`);
        identifier(
          column.foreignKey.column,
          `${columnLabel}.foreignKey.column`,
        );
      }
      return Object.freeze({
        ...column,
        name: columnName,
        action,
        recipe: validateRecipe(action, column.recipe, columnLabel),
      });
    });
    return Object.freeze({
      schema,
      name,
      sourceRows: table.sourceRows,
      columns: Object.freeze(columns),
    });
  });
  return Object.freeze({
    policyVersion: 2,
    migrationCutoff: policy.migrationCutoff,
    tables: Object.freeze(tables),
  });
};

const digest = (key, namespace, value) =>
  createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(JSON.stringify(value))
    .digest();

const pseudonym = (key, recipe, value) => {
  if (value === null) return null;
  const bytes = digest(key, recipe.namespace, value);
  if (recipe.format === "uuid") {
    const copy = Buffer.from(bytes.subarray(0, 16));
    copy[6] = (copy[6] & 0x0f) | 0x40;
    copy[8] = (copy[8] & 0x3f) | 0x80;
    const hex = copy.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (recipe.format === "email") {
    return `rehearsal+${bytes.toString("hex").slice(0, 24)}@example.invalid`;
  }
  if (recipe.format === "integer") {
    return Number(bytes.readBigUInt64BE(0) % 9_007_199_254_740_991n) + 1;
  }
  const token = `rehearsal_${bytes.toString("hex")}`;
  return token.slice(0, recipe.maxLength);
};

const executeDeclaration = ({ declaration, value, key, path }) => {
  if (declaration.action === "KEEP") return value;
  if (declaration.action === "EXCLUDE") return undefined;
  if (declaration.action === "REPLACE")
    return structuredClone(declaration.recipe.value);
  if (declaration.action === "PSEUDONYMIZE") {
    return pseudonym(key, declaration.recipe, value);
  }
  if (declaration.recipe.kind === "date-shift") {
    if (value === null) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf()))
      throw new Error(`${path} is not a valid date.`);
    const direction = digest(key, path, value)[0] % 2 === 0 ? -1 : 1;
    date.setUTCDate(date.getUTCDate() + direction * declaration.recipe.days);
    return date.toISOString();
  }
  if (value === null && declaration.recipe.allowNull) return null;
  if (!isObject(value)) throw new Error(`${path} must be a JSON object.`);
  const actual = Object.keys(value).sort();
  const expected = Object.keys(declaration.recipe.fields).sort();
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`${path} contains an unclassified JSON key.`);
  }
  return Object.fromEntries(
    Object.entries(declaration.recipe.fields).flatMap(([field, nested]) => {
      const transformed = executeDeclaration({
        declaration: nested,
        value: value[field],
        key,
        path: `${path}.${field}`,
      });
      return transformed === undefined ? [] : [[field, transformed]];
    }),
  );
};

export const createPrivacyEngine = ({ policy, key }) => {
  const normalized = validateExecutablePrivacyPolicy(policy);
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(key ?? "");
  if (secret.length < KEY_BYTES) {
    throw new Error(`Privacy key must contain at least ${KEY_BYTES} bytes.`);
  }
  const tables = new Map(
    normalized.tables.map((table) => [
      table.schema === "public" ? table.name : `${table.schema}.${table.name}`,
      table,
    ]),
  );
  return Object.freeze({
    keyFingerprint: createHash("sha256").update(secret).digest("hex"),
    sanitize(record) {
      if (
        !isObject(record) ||
        !IDENTIFIER.test(record.schema ?? "public") ||
        !IDENTIFIER.test(record.table ?? "") ||
        !isObject(record.row)
      ) {
        throw new Error("Source record has an invalid privacy-engine shape.");
      }
      const schema = record.schema ?? "public";
      const relation =
        schema === "public" ? record.table : `${schema}.${record.table}`;
      const table = tables.get(relation);
      if (!table)
        throw new Error(`Privacy policy does not classify table ${relation}.`);
      if (table.sourceRows === "EXCLUDE") return null;
      const actual = Object.keys(record.row).sort();
      const expected = table.columns.map((column) => column.name).sort();
      if (actual.join("\0") !== expected.join("\0")) {
        throw new Error(
          `Source table ${relation} contains an unclassified or missing column.`,
        );
      }
      const row = Object.fromEntries(
        table.columns.flatMap((column) => {
          const transformed = executeDeclaration({
            declaration: column,
            value: record.row[column.name],
            key: secret,
            path: `${relation}.${column.name}`,
          });
          return transformed === undefined ? [] : [[column.name, transformed]];
        }),
      );
      return schema === "public"
        ? { table: record.table, row }
        : { schema, table: record.table, row };
    },
  });
};

export const createPrivacyKey = async (path) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${key.toString("base64")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return { fingerprint: createHash("sha256").update(key).digest("hex") };
};

export const readPrivacyKey = async (path) => {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error("Privacy key must be an owner-only regular file.");
  }
  const encoded = (await readFile(path, "utf8")).trim();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Privacy key file is invalid.");
  }
  return key;
};

export const assertPrivacyKeyFingerprint = (key, expected) => {
  if (!HEX_64.test(expected ?? ""))
    throw new Error("Privacy key fingerprint is invalid.");
  const actual = createHash("sha256").update(key).digest("hex");
  if (actual !== expected)
    throw new Error(
      "Privacy key does not match the reviewed baseline receipt.",
    );
};
