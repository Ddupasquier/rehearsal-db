/**
 * Validate and digest the separately authorized source-access boundary.
 * Plans contain no credentials or raw owner identifiers.
 */

import { createHash } from "node:crypto";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

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

const envKey = (value, label) => {
  if (!ENVIRONMENT_KEY.test(value ?? "")) {
    throw new Error(`${label} must name an uppercase environment variable.`);
  }
  return value;
};

const fingerprint = (value, label) => {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be a SHA-256.`);
  return value;
};

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const canonicalJson = (value) => `${JSON.stringify(value, null, "\t")}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const sourceTargetFingerprint = (connectionString) => {
  let target;
  try {
    const parsed = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol))
      throw new Error();
    target = {
      protocol: "postgresql",
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || "5432",
      database: decodeURIComponent(parsed.pathname.replace(/^\//u, "")),
    };
  } catch {
    throw new Error(
      "Source credential is not a valid PostgreSQL connection URL.",
    );
  }
  if (!target.hostname || !target.database) {
    throw new Error("Source credential must identify a host and database.");
  }
  return sha256(canonicalJson(target));
};

export const validateSourceAccessPolicy = (policy) => {
  if (!isObject(policy))
    throw new Error("Source access policy must be an object.");
  knownKeys(
    policy,
    [
      "accessVersion",
      "targetFingerprint",
      "administratorEnvironmentVariable",
      "reader",
      "exportSchema",
      "migrationLedger",
      "relations",
      "assetReader",
      "assets",
    ],
    "sourcePolicy",
  );
  if (policy.accessVersion !== 1) {
    throw new Error("Source access policy must use accessVersion 1.");
  }
  fingerprint(policy.targetFingerprint, "sourcePolicy.targetFingerprint");
  envKey(
    policy.administratorEnvironmentVariable,
    "sourcePolicy.administratorEnvironmentVariable",
  );
  if (!isObject(policy.reader))
    throw new Error("sourcePolicy.reader must be an object.");
  knownKeys(
    policy.reader,
    ["role", "ownerRole", "credentialFile", "validForMinutes"],
    "sourcePolicy.reader",
  );
  const role = identifier(policy.reader.role, "sourcePolicy.reader.role");
  const ownerRole = identifier(
    policy.reader.ownerRole,
    "sourcePolicy.reader.ownerRole",
  );
  if (role === ownerRole)
    throw new Error("Source reader and owner roles must differ.");
  if (
    typeof policy.reader.credentialFile !== "string" ||
    !policy.reader.credentialFile.startsWith(".rehearsal/") ||
    policy.reader.credentialFile.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(
      "sourcePolicy.reader.credentialFile must stay under .rehearsal/.",
    );
  }
  if (
    !Number.isSafeInteger(policy.reader.validForMinutes) ||
    policy.reader.validForMinutes < 5 ||
    policy.reader.validForMinutes > 240
  ) {
    throw new Error(
      "sourcePolicy.reader.validForMinutes must be from 5 through 240.",
    );
  }
  const exportSchema = identifier(
    policy.exportSchema,
    "sourcePolicy.exportSchema",
  );
  if (!isObject(policy.migrationLedger)) {
    throw new Error("sourcePolicy.migrationLedger must be an object.");
  }
  knownKeys(
    policy.migrationLedger,
    ["schema", "table", "versionColumn", "nameColumn", "statementsColumn"],
    "sourcePolicy.migrationLedger",
  );
  const migrationLedger = Object.freeze({
    schema: identifier(
      policy.migrationLedger.schema,
      "sourcePolicy.migrationLedger.schema",
    ),
    table: identifier(
      policy.migrationLedger.table,
      "sourcePolicy.migrationLedger.table",
    ),
    versionColumn: identifier(
      policy.migrationLedger.versionColumn,
      "sourcePolicy.migrationLedger.versionColumn",
    ),
    nameColumn: identifier(
      policy.migrationLedger.nameColumn,
      "sourcePolicy.migrationLedger.nameColumn",
    ),
    statementsColumn: identifier(
      policy.migrationLedger.statementsColumn,
      "sourcePolicy.migrationLedger.statementsColumn",
    ),
  });
  if (!Array.isArray(policy.relations) || policy.relations.length === 0) {
    throw new Error(
      "sourcePolicy.relations must declare at least one relation.",
    );
  }
  const viewNames = new Set();
  const targetTables = new Set();
  const relations = policy.relations.map((relation, index) => {
    const label = `sourcePolicy.relations[${index}]`;
    if (!isObject(relation)) throw new Error(`${label} must be an object.`);
    knownKeys(
      relation,
      [
        "source",
        "view",
        "targetSchema",
        "targetTable",
        "columns",
        "orderBy",
        "rowScope",
      ],
      label,
    );
    if (!isObject(relation.source))
      throw new Error(`${label}.source must be an object.`);
    knownKeys(relation.source, ["schema", "table"], `${label}.source`);
    const source = Object.freeze({
      schema: identifier(relation.source.schema, `${label}.source.schema`),
      table: identifier(relation.source.table, `${label}.source.table`),
    });
    const view = identifier(relation.view, `${label}.view`);
    const targetSchema = identifier(
      relation.targetSchema ?? "public",
      `${label}.targetSchema`,
    );
    const targetTable = identifier(
      relation.targetTable,
      `${label}.targetTable`,
    );
    const targetKey = `${targetSchema}.${targetTable}`;
    if (targetTables.has(targetKey)) {
      throw new Error(
        `Source access policy duplicates target table ${targetKey}.`,
      );
    }
    targetTables.add(targetKey);
    if (viewNames.has(view))
      throw new Error(`Source access policy duplicates view ${view}.`);
    viewNames.add(view);
    if (
      !Array.isArray(relation.columns) ||
      relation.columns.length === 0 ||
      new Set(relation.columns).size !== relation.columns.length
    ) {
      throw new Error(`${label}.columns must be a non-empty unique array.`);
    }
    const columns = Object.freeze(
      relation.columns.map((column, columnIndex) =>
        identifier(column, `${label}.columns[${columnIndex}]`),
      ),
    );
    if (
      !Array.isArray(relation.orderBy) ||
      relation.orderBy.length === 0 ||
      new Set(relation.orderBy).size !== relation.orderBy.length ||
      relation.orderBy.some((column) => !columns.includes(column))
    ) {
      throw new Error(`${label}.orderBy must name unique exported columns.`);
    }
    const orderBy = Object.freeze([...relation.orderBy]);
    if (!isObject(relation.rowScope))
      throw new Error(`${label}.rowScope must be an object.`);
    knownKeys(
      relation.rowScope,
      ["kind", "column", "valueEnvironmentVariable"],
      `${label}.rowScope`,
    );
    let rowScope;
    if (relation.rowScope.kind === "approved-public") {
      if (
        relation.rowScope.column !== undefined ||
        relation.rowScope.valueEnvironmentVariable !== undefined
      ) {
        throw new Error(
          `${label}.rowScope approved-public accepts no owner fields.`,
        );
      }
      rowScope = Object.freeze({ kind: "approved-public" });
    } else if (relation.rowScope.kind === "approved-owner") {
      const column = identifier(
        relation.rowScope.column,
        `${label}.rowScope.column`,
      );
      if (!columns.includes(column)) {
        throw new Error(
          `${label}.rowScope.column must be included in exported columns.`,
        );
      }
      rowScope = Object.freeze({
        kind: "approved-owner",
        column,
        valueEnvironmentVariable: envKey(
          relation.rowScope.valueEnvironmentVariable,
          `${label}.rowScope.valueEnvironmentVariable`,
        ),
      });
    } else {
      throw new Error(`${label}.rowScope.kind is unsupported.`);
    }
    return Object.freeze({
      source,
      view,
      targetSchema,
      targetTable,
      columns,
      orderBy,
      rowScope,
    });
  });
  const assets = policy.assets ?? [];
  if (!Array.isArray(assets))
    throw new Error("sourcePolicy.assets must be an array.");
  const normalizedAssets = assets.map((asset, index) => {
    const label = `sourcePolicy.assets[${index}]`;
    if (!isObject(asset)) throw new Error(`${label} must be an object.`);
    knownKeys(asset, ["bucket", "prefix", "rights"], label);
    if (!/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(asset.bucket ?? "")) {
      throw new Error(`${label}.bucket is invalid.`);
    }
    const prefixParts =
      typeof asset.prefix === "string"
        ? asset.prefix.replace(/\/$/u, "").split("/")
        : [];
    if (
      typeof asset.prefix !== "string" ||
      !asset.prefix ||
      asset.prefix.startsWith("/") ||
      prefixParts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`${label}.prefix is unsafe.`);
    }
    if (!["approved-public", "approved-owner"].includes(asset.rights)) {
      throw new Error(`${label}.rights must be explicitly approved.`);
    }
    return Object.freeze({
      bucket: asset.bucket,
      prefix: asset.prefix,
      rights: asset.rights,
    });
  });
  let assetReader = null;
  if (normalizedAssets.length > 0) {
    if (!isObject(policy.assetReader)) {
      throw new Error(
        "sourcePolicy.assetReader is required when assets are declared.",
      );
    }
    knownKeys(
      policy.assetReader,
      [
        "endpointFingerprint",
        "baseUrlEnvironmentVariable",
        "tokenEnvironmentVariable",
        "maximumObjects",
        "maximumObjectBytes",
        "maximumTotalBytes",
      ],
      "sourcePolicy.assetReader",
    );
    assetReader = Object.freeze({
      endpointFingerprint: fingerprint(
        policy.assetReader.endpointFingerprint,
        "sourcePolicy.assetReader.endpointFingerprint",
      ),
      baseUrlEnvironmentVariable: envKey(
        policy.assetReader.baseUrlEnvironmentVariable,
        "sourcePolicy.assetReader.baseUrlEnvironmentVariable",
      ),
      tokenEnvironmentVariable: envKey(
        policy.assetReader.tokenEnvironmentVariable,
        "sourcePolicy.assetReader.tokenEnvironmentVariable",
      ),
      maximumObjects: positiveInteger(
        policy.assetReader.maximumObjects,
        "sourcePolicy.assetReader.maximumObjects",
      ),
      maximumObjectBytes: positiveInteger(
        policy.assetReader.maximumObjectBytes,
        "sourcePolicy.assetReader.maximumObjectBytes",
      ),
      maximumTotalBytes: positiveInteger(
        policy.assetReader.maximumTotalBytes,
        "sourcePolicy.assetReader.maximumTotalBytes",
      ),
    });
  } else if (policy.assetReader !== undefined && policy.assetReader !== null) {
    throw new Error(
      "sourcePolicy.assetReader is not allowed without declared assets.",
    );
  }
  return Object.freeze({
    accessVersion: 1,
    targetFingerprint: policy.targetFingerprint,
    administratorEnvironmentVariable: policy.administratorEnvironmentVariable,
    reader: Object.freeze({
      role,
      ownerRole,
      credentialFile: policy.reader.credentialFile,
      validForMinutes: policy.reader.validForMinutes,
    }),
    exportSchema,
    migrationLedger,
    assetReader,
    relations: Object.freeze(relations),
    assets: Object.freeze(normalizedAssets),
  });
};

export const createSourceAccessPlan = ({
  policy,
  environment = process.env,
}) => {
  const normalized = validateSourceAccessPolicy(policy);
  const sourceCredential =
    environment[normalized.administratorEnvironmentVariable];
  if (!sourceCredential) {
    throw new Error(
      `Source preparation requires ${normalized.administratorEnvironmentVariable}; the value is read from the environment and never printed.`,
    );
  }
  const actualTarget = sourceTargetFingerprint(sourceCredential);
  if (actualTarget !== normalized.targetFingerprint) {
    throw new Error(
      "Source credential does not match the reviewed target fingerprint.",
    );
  }
  const ownerScopes = Object.fromEntries(
    normalized.relations
      .filter((relation) => relation.rowScope.kind === "approved-owner")
      .map((relation) => {
        const key = relation.rowScope.valueEnvironmentVariable;
        const value = environment[key];
        if (!value) throw new Error(`Source preparation requires ${key}.`);
        return [relation.view, sha256(value)];
      }),
  );
  if (normalized.assetReader) {
    const baseUrl =
      environment[normalized.assetReader.baseUrlEnvironmentVariable];
    const token = environment[normalized.assetReader.tokenEnvironmentVariable];
    if (
      !baseUrl ||
      assetEndpointFingerprint(baseUrl) !==
        normalized.assetReader.endpointFingerprint
    ) {
      throw new Error(
        "Asset reader URL does not match the reviewed endpoint fingerprint.",
      );
    }
    if (!token)
      throw new Error(
        `Source preparation requires ${normalized.assetReader.tokenEnvironmentVariable}.`,
      );
  }
  const review = {
    planVersion: 1,
    operation: "prepare-source-access",
    targetFingerprint: normalized.targetFingerprint,
    exportSchema: normalized.exportSchema,
    reader: {
      role: normalized.reader.role,
      ownerRole: normalized.reader.ownerRole,
      validForMinutes: normalized.reader.validForMinutes,
      credentialFile: normalized.reader.credentialFile,
    },
    relations: normalized.relations.map((relation) => ({
      source: relation.source,
      view: relation.view,
      targetTable: relation.targetTable,
      columns: relation.columns,
      orderBy: relation.orderBy,
      rowScope: {
        kind: relation.rowScope.kind,
        ...(relation.rowScope.kind === "approved-owner"
          ? {
              column: relation.rowScope.column,
              valueSha256: ownerScopes[relation.view],
            }
          : {}),
      },
    })),
    assets: normalized.assets,
    assetReader: normalized.assetReader
      ? {
          endpointFingerprint: normalized.assetReader.endpointFingerprint,
          maximumObjects: normalized.assetReader.maximumObjects,
          maximumObjectBytes: normalized.assetReader.maximumObjectBytes,
          maximumTotalBytes: normalized.assetReader.maximumTotalBytes,
        }
      : null,
    denyChecks: [
      "raw relation reads",
      "writes",
      "role creation and escalation",
      "network functions",
      "unrelated private assets",
    ],
  };
  return Object.freeze({
    policy: normalized,
    review: Object.freeze(review),
    digest: sha256(canonicalJson(review)),
  });
};

export const assetEndpointFingerprint = (value) => {
  let endpoint;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)
      )
    ) {
      throw new Error();
    }
    endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/u, "")}`;
  } catch {
    throw new Error("Asset reader endpoint is invalid or insecure.");
  }
  return sha256(endpoint);
};

export const assertSourceAccessConfirmation = (plan, confirmation) => {
  if (confirmation !== plan.digest) {
    throw new Error(
      `Source access confirmation does not match this exact plan. Expected ${plan.digest}.`,
    );
  }
  return plan;
};

export const createSourceRetirementPlan = ({
  receipt,
  targetFingerprint: target,
}) => {
  if (!isObject(receipt) || receipt.receiptVersion !== 1) {
    throw new Error("Source access receipt is invalid.");
  }
  fingerprint(target, "Source retirement target fingerprint");
  if (receipt.targetFingerprint !== target) {
    throw new Error(
      "Source access receipt belongs to a different source target.",
    );
  }
  if (!Array.isArray(receipt.views) || !Array.isArray(receipt.relations)) {
    throw new Error("Source access receipt object inventory is invalid.");
  }
  const relations = receipt.relations.map((relation, index) => {
    if (!isObject(relation))
      throw new Error(`receipt.relations[${index}] is invalid.`);
    knownKeys(
      relation,
      ["schema", "table", "columns"],
      `receipt.relations[${index}]`,
    );
    if (!Array.isArray(relation.columns) || relation.columns.length === 0) {
      throw new Error(`receipt.relations[${index}].columns is invalid.`);
    }
    return {
      schema: identifier(relation.schema, `receipt.relations[${index}].schema`),
      table: identifier(relation.table, `receipt.relations[${index}].table`),
      columns: relation.columns.map((column) =>
        identifier(column, `receipt.relations[${index}].columns[]`),
      ),
    };
  });
  if (!isObject(receipt.migrationLedger)) {
    throw new Error("Source access receipt migration ledger is invalid.");
  }
  const ledger = {
    schema: identifier(
      receipt.migrationLedger.schema,
      "receipt.migrationLedger.schema",
    ),
    table: identifier(
      receipt.migrationLedger.table,
      "receipt.migrationLedger.table",
    ),
  };
  const review = {
    planVersion: 1,
    operation: "retire-source-access",
    targetFingerprint: target,
    preparationDigest: fingerprint(receipt.planDigest, "receipt.planDigest"),
    exportSchema: identifier(receipt.exportSchema, "receipt.exportSchema"),
    views: [...receipt.views]
      .map((view) => identifier(view, "receipt.views[]"))
      .sort(),
    relations,
    migrationLedger: ledger,
    readerRole: identifier(receipt.readerRole, "receipt.readerRole"),
    ownerRole: identifier(receipt.ownerRole, "receipt.ownerRole"),
  };
  return Object.freeze({
    review: Object.freeze(review),
    digest: sha256(canonicalJson(review)),
  });
};
