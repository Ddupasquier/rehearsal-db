/**
 * Execute reviewed privacy policy version 2 without project-owned callbacks.
 * The engine is intentionally small and fail-closed: unsupported shapes and
 * recipes must be reviewed and added here instead of evaluated as code.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const BINDING_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set([
  "KEEP",
  "PSEUDONYMIZE",
  "REPLACE",
  "EXCLUDE",
  "DERIVE",
]);
const PSEUDONYM_FORMATS = new Set(["uuid", "email", "text", "integer"]);
const DERIVATION_KINDS = new Set([
  "date-shift",
  "path-map",
  "json-object",
  "json-array",
  "approved-owner",
]);
const KEY_BYTES = 32;
const DEFAULT_JSON_MAXIMUM_BYTES = 65_536;
const DEFAULT_JSON_MAXIMUM_DEPTH = 8;
const DEFAULT_PATH_MAXIMUM_BYTES = 2_048;
const DEFAULT_PATH_MAXIMUM_SEGMENTS = 32;
const MAXIMUM_POLICY_DEPTH = 16;

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

const validateNestedDeclaration = (
  declaration,
  label,
  { allowRequired = false, depth = 0 } = {},
) => {
  if (!isObject(declaration)) throw new Error(`${label} must be an object.`);
  knownKeys(
    declaration,
    allowRequired ? ["action", "recipe", "required"] : ["action", "recipe"],
    label,
  );
  if (
    allowRequired &&
    declaration.required !== undefined &&
    typeof declaration.required !== "boolean"
  ) {
    throw new Error(`${label}.required must be true or false.`);
  }
  const action = String(declaration.action ?? "").toUpperCase();
  if (!ACTIONS.has(action)) throw new Error(`${label}.action is unsupported.`);
  return Object.freeze({
    action,
    recipe: validateRecipe(action, declaration.recipe, label, depth + 1),
    ...(allowRequired ? { required: declaration.required !== false } : {}),
  });
};

const validateRecipe = (action, recipe, label, depth = 0) => {
  if (depth > MAXIMUM_POLICY_DEPTH) {
    throw new Error(`${label}.recipe exceeds the supported nesting depth.`);
  }
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
  knownKeys(
    recipe,
    [
      "kind",
      "days",
      "group",
      "mapping",
      "fields",
      "items",
      "approved",
      "otherwise",
      "allowNull",
      "maximumBytes",
      "maximumDepth",
      "maximumItems",
    ],
    `${label}.recipe`,
  );
  if (!DERIVATION_KINDS.has(recipe.kind)) {
    throw new Error(`${label}.recipe.kind is unsupported.`);
  }
  if (recipe.kind === "date-shift") {
    const days = positiveInteger(recipe.days, `${label}.recipe.days`, 3_650);
    if (
      Object.keys(recipe).some(
        (key) => !["kind", "days", "group"].includes(key),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by date-shift.`,
      );
    }
    if (recipe.group !== undefined && !BINDING_NAME.test(recipe.group)) {
      throw new Error(`${label}.recipe.group is invalid.`);
    }
    return Object.freeze({
      kind: "date-shift",
      days,
      ...(recipe.group === undefined ? {} : { group: recipe.group }),
    });
  }
  if (recipe.kind === "path-map") {
    if (Object.keys(recipe).some((key) => !["kind", "mapping"].includes(key))) {
      throw new Error(`${label}.recipe contains fields not used by path-map.`);
    }
    if (!BINDING_NAME.test(recipe.mapping ?? "")) {
      throw new Error(`${label}.recipe.mapping is invalid.`);
    }
    return Object.freeze({ kind: "path-map", mapping: recipe.mapping });
  }
  if (recipe.kind === "approved-owner") {
    if (
      Object.keys(recipe).some(
        (key) => !["kind", "approved", "otherwise"].includes(key),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by approved-owner.`,
      );
    }
    return Object.freeze({
      kind: "approved-owner",
      approved: validateNestedDeclaration(
        recipe.approved,
        `${label}.recipe.approved`,
        { depth },
      ),
      otherwise: validateNestedDeclaration(
        recipe.otherwise,
        `${label}.recipe.otherwise`,
        { depth },
      ),
    });
  }
  if (recipe.allowNull !== undefined && typeof recipe.allowNull !== "boolean") {
    throw new Error(`${label}.recipe.allowNull must be true or false.`);
  }
  const bounds = Object.freeze({
    maximumBytes: positiveInteger(
      recipe.maximumBytes ?? DEFAULT_JSON_MAXIMUM_BYTES,
      `${label}.recipe.maximumBytes`,
      16_777_216,
    ),
    maximumDepth: positiveInteger(
      recipe.maximumDepth ?? DEFAULT_JSON_MAXIMUM_DEPTH,
      `${label}.recipe.maximumDepth`,
      MAXIMUM_POLICY_DEPTH,
    ),
  });
  if (recipe.kind === "json-array") {
    if (
      Object.keys(recipe).some(
        (key) =>
          ![
            "kind",
            "items",
            "allowNull",
            "maximumBytes",
            "maximumDepth",
            "maximumItems",
          ].includes(key),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by json-array.`,
      );
    }
    return Object.freeze({
      kind: "json-array",
      allowNull: recipe.allowNull === true,
      ...bounds,
      maximumItems: positiveInteger(
        recipe.maximumItems,
        `${label}.recipe.maximumItems`,
        10_000,
      ),
      items: validateNestedDeclaration(recipe.items, `${label}.recipe.items`, {
        depth,
      }),
    });
  }
  if (!isObject(recipe.fields) || Object.keys(recipe.fields).length === 0) {
    throw new Error(`${label}.recipe.fields must classify JSON object keys.`);
  }
  if (
    Object.keys(recipe).some(
      (key) =>
        ![
          "kind",
          "fields",
          "allowNull",
          "maximumBytes",
          "maximumDepth",
        ].includes(key),
    )
  ) {
    throw new Error(`${label}.recipe contains fields not used by json-object.`);
  }
  const fields = Object.fromEntries(
    Object.entries(recipe.fields).map(([key, declaration]) => {
      if (!key) {
        throw new Error(`${label}.recipe.fields contains an invalid key.`);
      }
      return [
        key,
        validateNestedDeclaration(
          declaration,
          `${label}.recipe.fields.${key}`,
          { allowRequired: true, depth },
        ),
      ];
    }),
  );
  return Object.freeze({
    kind: "json-object",
    allowNull: recipe.allowNull === true,
    ...bounds,
    fields: Object.freeze(fields),
  });
};

export const validateExecutablePrivacyPolicy = (policy) => {
  if (!isObject(policy)) throw new Error("Privacy policy must be an object.");
  knownKeys(
    policy,
    [
      "policyVersion",
      "draft",
      "migrationCutoff",
      "bindings",
      "pathMappings",
      "tables",
    ],
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
  if (policy.bindings !== undefined && !isObject(policy.bindings)) {
    throw new Error("policy.bindings must be an object.");
  }
  const bindings = Object.fromEntries(
    Object.entries(policy.bindings ?? {}).map(([name, binding]) => {
      if (!BINDING_NAME.test(name) || !isObject(binding)) {
        throw new Error("policy.bindings contains an invalid binding.");
      }
      knownKeys(
        binding,
        ["environmentVariable", "approvedValueSha256"],
        `policy.bindings.${name}`,
      );
      if (!ENVIRONMENT_KEY.test(binding.environmentVariable ?? "")) {
        throw new Error(
          `policy.bindings.${name}.environmentVariable is invalid.`,
        );
      }
      if (!HEX_64.test(binding.approvedValueSha256 ?? "")) {
        throw new Error(
          `policy.bindings.${name}.approvedValueSha256 must be a lowercase SHA-256 receipt.`,
        );
      }
      return [name, Object.freeze({ ...binding })];
    }),
  );
  if (policy.pathMappings !== undefined && !isObject(policy.pathMappings)) {
    throw new Error("policy.pathMappings must be an object.");
  }
  const pathMappings = Object.fromEntries(
    Object.entries(policy.pathMappings ?? {}).map(([name, mapping]) => {
      const label = `policy.pathMappings.${name}`;
      if (!BINDING_NAME.test(name) || !isObject(mapping)) {
        throw new Error("policy.pathMappings contains an invalid mapping.");
      }
      knownKeys(
        mapping,
        [
          "binding",
          "format",
          "namespace",
          "maxLength",
          "maximumBytes",
          "maximumSegments",
        ],
        label,
      );
      if (!Object.hasOwn(bindings, mapping.binding ?? "")) {
        throw new Error(`${label}.binding references an unknown binding.`);
      }
      if (!["uuid", "text"].includes(mapping.format)) {
        throw new Error(`${label}.format must be uuid or text.`);
      }
      const normalized = {
        binding: mapping.binding,
        format: mapping.format,
        namespace: nonEmpty(mapping.namespace, `${label}.namespace`),
        maximumBytes: positiveInteger(
          mapping.maximumBytes ?? DEFAULT_PATH_MAXIMUM_BYTES,
          `${label}.maximumBytes`,
          16_384,
        ),
        maximumSegments: positiveInteger(
          mapping.maximumSegments ?? DEFAULT_PATH_MAXIMUM_SEGMENTS,
          `${label}.maximumSegments`,
          256,
        ),
      };
      if (mapping.format === "text") {
        normalized.maxLength = positiveInteger(
          mapping.maxLength,
          `${label}.maxLength`,
          1_024,
        );
      } else if (mapping.maxLength !== undefined) {
        throw new Error(`${label}.maxLength is supported only for text.`);
      }
      return [name, Object.freeze(normalized)];
    }),
  );
  const names = new Set();
  const tables = policy.tables.map((table, tableIndex) => {
    const label = `policy.tables[${tableIndex}]`;
    if (!isObject(table)) throw new Error(`${label} must be an object.`);
    knownKeys(
      table,
      ["schema", "name", "sourceRows", "ownerBinding", "columns"],
      label,
    );
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
    let ownerBinding = null;
    if (table.ownerBinding !== undefined && table.ownerBinding !== null) {
      if (!isObject(table.ownerBinding)) {
        throw new Error(`${label}.ownerBinding must be an object.`);
      }
      knownKeys(
        table.ownerBinding,
        ["binding", "column"],
        `${label}.ownerBinding`,
      );
      const binding = nonEmpty(
        table.ownerBinding.binding,
        `${label}.ownerBinding.binding`,
      );
      const column = identifier(
        table.ownerBinding.column,
        `${label}.ownerBinding.column`,
      );
      if (!Object.hasOwn(bindings, binding)) {
        throw new Error(`${label}.ownerBinding references an unknown binding.`);
      }
      if (!columnNames.has(column)) {
        throw new Error(`${label}.ownerBinding references an unknown column.`);
      }
      const ownerColumn = columns.find((entry) => entry.name === column);
      if (
        ownerColumn.action !== "PSEUDONYMIZE" ||
        ownerColumn.identity !== "YES"
      ) {
        throw new Error(
          `${label}.ownerBinding column must be an explicitly pseudonymized identity.`,
        );
      }
      ownerBinding = Object.freeze({ binding, column });
    }
    const usesApprovedOwner = (declaration) =>
      declaration.recipe?.kind === "approved-owner" ||
      (declaration.recipe?.kind === "json-object" &&
        Object.values(declaration.recipe.fields).some(usesApprovedOwner)) ||
      (declaration.recipe?.kind === "json-array" &&
        usesApprovedOwner(declaration.recipe.items));
    if (columns.some(usesApprovedOwner) && !ownerBinding) {
      throw new Error(`${label} uses approved-owner without ownerBinding.`);
    }
    const visitRecipes = (declaration, visit) => {
      visit(declaration.recipe);
      if (declaration.recipe?.kind === "approved-owner") {
        visitRecipes(declaration.recipe.approved, visit);
        visitRecipes(declaration.recipe.otherwise, visit);
      } else if (declaration.recipe?.kind === "json-object") {
        Object.values(declaration.recipe.fields).forEach((nested) =>
          visitRecipes(nested, visit),
        );
      } else if (declaration.recipe?.kind === "json-array") {
        visitRecipes(declaration.recipe.items, visit);
      }
    };
    for (const column of columns) {
      visitRecipes(column, (recipe) => {
        if (
          recipe?.kind === "path-map" &&
          !Object.hasOwn(pathMappings, recipe.mapping)
        ) {
          throw new Error(
            `${label} references unknown path mapping ${recipe.mapping}.`,
          );
        }
      });
    }
    return Object.freeze({
      schema,
      name,
      sourceRows: table.sourceRows,
      ownerBinding,
      columns: Object.freeze(columns),
    });
  });
  const dateShiftGroups = new Map();
  const visitDateShiftGroups = (declaration) => {
    const recipe = declaration.recipe;
    if (recipe?.kind === "date-shift" && recipe.group) {
      const existing = dateShiftGroups.get(recipe.group);
      if (existing !== undefined && existing !== recipe.days) {
        throw new Error(
          `Privacy date-shift group ${recipe.group} must use one days value.`,
        );
      }
      dateShiftGroups.set(recipe.group, recipe.days);
    }
    if (recipe?.kind === "approved-owner") {
      visitDateShiftGroups(recipe.approved);
      visitDateShiftGroups(recipe.otherwise);
    } else if (recipe?.kind === "json-object") {
      Object.values(recipe.fields).forEach(visitDateShiftGroups);
    } else if (recipe?.kind === "json-array") {
      visitDateShiftGroups(recipe.items);
    }
  };
  tables.forEach((table) => table.columns.forEach(visitDateShiftGroups));
  return Object.freeze({
    policyVersion: 2,
    migrationCutoff: policy.migrationCutoff,
    bindings: Object.freeze(bindings),
    pathMappings: Object.freeze(pathMappings),
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

const remapPath = ({ key, mapping, bindingValue, value, label }) => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a Storage-style path string.`);
  }
  if (Buffer.byteLength(value) > mapping.maximumBytes) {
    throw new Error(`${label} exceeds its reviewed byte limit.`);
  }
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    segments.length > mapping.maximumSegments ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is not a safe bounded Storage path.`);
  }
  if (
    typeof bindingValue !== "string" ||
    !bindingValue ||
    bindingValue.includes("/") ||
    bindingValue === "." ||
    bindingValue === ".."
  ) {
    throw new Error(`${label} has an invalid reviewed identity binding.`);
  }
  if (segments[0] !== bindingValue) {
    throw new Error(
      `${label} does not begin with its exact reviewed identity.`,
    );
  }
  const destination = [
    String(pseudonym(key, mapping, bindingValue)),
    ...segments.slice(1),
  ].join("/");
  if (Buffer.byteLength(destination) > mapping.maximumBytes) {
    throw new Error(`${label} destination exceeds its reviewed byte limit.`);
  }
  return destination;
};

const assertJsonBounds = (value, recipe, path) => {
  let bytes = 0;
  const jsonStringBytes = (string) => {
    let size = 2;
    for (let index = 0; index < string.length; index += 1) {
      const code = string.charCodeAt(index);
      if (code === 34 || code === 92) size += 2;
      else if (code < 32) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = string.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          size += 4;
          index += 1;
        } else size += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) size += 6;
      else if (code <= 0x7f) size += 1;
      else if (code <= 0x7ff) size += 2;
      else size += 3;
    }
    return size;
  };
  const visit = (current, depth) => {
    if (depth > recipe.maximumDepth) {
      throw new Error(`${path} exceeds maximumDepth ${recipe.maximumDepth}.`);
    }
    if (typeof current === "string") bytes += jsonStringBytes(current);
    else if (current === null) bytes += 4;
    else if (typeof current === "number" && !Number.isFinite(current))
      throw new Error(`${path} contains an unsupported JSON value.`);
    else if (["number", "boolean"].includes(typeof current))
      bytes += String(current).length;
    else if (Array.isArray(current)) {
      if (
        recipe.kind === "json-array" &&
        current.length > recipe.maximumItems
      ) {
        throw new Error(`${path} exceeds maximumItems ${recipe.maximumItems}.`);
      }
      bytes += 2 + Math.max(0, current.length - 1);
      for (const item of current) visit(item, depth + 1);
    } else if (isObject(current)) {
      bytes += 2 + Math.max(0, Object.keys(current).length - 1);
      for (const [key, nested] of Object.entries(current)) {
        bytes += jsonStringBytes(key) + 1;
        visit(nested, depth + 1);
      }
    } else throw new Error(`${path} contains an unsupported JSON value.`);
    if (bytes > recipe.maximumBytes) {
      throw new Error(`${path} exceeds maximumBytes ${recipe.maximumBytes}.`);
    }
  };
  visit(value, 1);
};

const executeDeclaration = ({
  declaration,
  value,
  key,
  path,
  ownerApproved,
  pathMappings,
  bindingValues,
}) => {
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
    const direction = declaration.recipe.group
      ? digest(key, "date-shift-group", declaration.recipe.group)[0] % 2 === 0
        ? -1
        : 1
      : digest(key, path, value)[0] % 2 === 0
        ? -1
        : 1;
    date.setUTCDate(date.getUTCDate() + direction * declaration.recipe.days);
    return date.toISOString();
  }
  if (declaration.recipe.kind === "path-map") {
    const mapping = pathMappings[declaration.recipe.mapping];
    return remapPath({
      key,
      mapping,
      bindingValue: bindingValues.get(mapping.binding),
      value,
      label: path,
    });
  }
  if (declaration.recipe.kind === "approved-owner") {
    if (ownerApproved === undefined) {
      throw new Error(`${path} has no reviewed owner condition.`);
    }
    return executeDeclaration({
      declaration: ownerApproved
        ? declaration.recipe.approved
        : declaration.recipe.otherwise,
      value,
      key,
      path,
      ownerApproved,
      pathMappings,
      bindingValues,
    });
  }
  if (value === null && declaration.recipe.allowNull) return null;
  assertJsonBounds(value, declaration.recipe, path);
  if (declaration.recipe.kind === "json-array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be a JSON array.`);
    return value.flatMap((item, index) => {
      const transformed = executeDeclaration({
        declaration: declaration.recipe.items,
        value: item,
        key,
        path: `${path}[${index}]`,
        ownerApproved,
        pathMappings,
        bindingValues,
      });
      return transformed === undefined ? [] : [transformed];
    });
  }
  if (!isObject(value)) throw new Error(`${path} must be a JSON object.`);
  const actual = Object.keys(value).sort();
  const expected = Object.keys(declaration.recipe.fields);
  if (actual.some((field) => !expected.includes(field))) {
    throw new Error(`${path} contains an unclassified JSON key.`);
  }
  const missing = expected.filter(
    (field) =>
      declaration.recipe.fields[field].required && !Object.hasOwn(value, field),
  );
  if (missing.length) throw new Error(`${path} is missing required JSON keys.`);
  return Object.fromEntries(
    Object.entries(declaration.recipe.fields).flatMap(([field, nested]) => {
      if (!Object.hasOwn(value, field)) return [];
      const transformed = executeDeclaration({
        declaration: nested,
        value: value[field],
        key,
        path: `${path}.${field}`,
        ownerApproved,
        pathMappings,
        bindingValues,
      });
      return transformed === undefined ? [] : [[field, transformed]];
    }),
  );
};

export const createPrivacyEngine = ({
  policy,
  key,
  environment = process.env,
}) => {
  const normalized = validateExecutablePrivacyPolicy(policy);
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(key ?? "");
  if (secret.length < KEY_BYTES) {
    throw new Error(`Privacy key must contain at least ${KEY_BYTES} bytes.`);
  }
  const bindingValues = new Map(
    Object.entries(normalized.bindings).map(([name, binding]) => {
      const value = environment[binding.environmentVariable];
      if (typeof value !== "string" || !value) {
        throw new Error(
          `Privacy binding ${name} requires ${binding.environmentVariable}.`,
        );
      }
      const receipt = createHash("sha256").update(value).digest("hex");
      if (receipt !== binding.approvedValueSha256) {
        throw new Error(
          `Privacy binding ${name} does not match its review receipt.`,
        );
      }
      return [name, value];
    }),
  );
  const tables = new Map(
    normalized.tables.map((table) => [
      table.schema === "public" ? table.name : `${table.schema}.${table.name}`,
      table,
    ]),
  );
  return Object.freeze({
    keyFingerprint: createHash("sha256").update(secret).digest("hex"),
    remapPath({ mapping: mappingName, value }) {
      const mapping = normalized.pathMappings[mappingName];
      if (!mapping) {
        throw new Error(`Privacy path mapping ${mappingName} is not declared.`);
      }
      return remapPath({
        key: secret,
        mapping,
        bindingValue: bindingValues.get(mapping.binding),
        value,
        label: `Privacy path mapping ${mappingName}`,
      });
    },
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
      let ownerApproved;
      if (table.ownerBinding) {
        const owner = record.row[table.ownerBinding.column];
        if (!["string", "number"].includes(typeof owner) || owner === "") {
          throw new Error(`${relation} has an invalid owner binding value.`);
        }
        ownerApproved =
          String(owner) === bindingValues.get(table.ownerBinding.binding);
      }
      const row = Object.fromEntries(
        table.columns.flatMap((column) => {
          const transformed = executeDeclaration({
            declaration: column,
            value: record.row[column.name],
            key: secret,
            path: `${relation}.${column.name}`,
            ownerApproved,
            pathMappings: normalized.pathMappings,
            bindingValues,
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
