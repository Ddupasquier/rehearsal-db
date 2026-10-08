/**
 * Validate and digest the separately authorized source-access boundary.
 * Plans contain no credentials or raw owner identifiers.
 */

import { createHash } from "node:crypto";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

type PlainObject = Record<string, unknown>;

export type SourceReader =
  | Readonly<{
      mode: "managed";
      role: string;
      ownerRole: string;
      credentialFile: string;
      validForMinutes: number;
    }>
  | Readonly<{
      mode: "external";
      role: string;
      allowedMemberships: readonly string[];
      connectionEnvironmentVariable: string;
      credentialFile: string;
      maximumValidForMinutes: number;
    }>;

export type SourceRowScope =
  | Readonly<{ kind: "approved-public" }>
  | Readonly<{
      kind: "approved-owner";
      column: string;
      valueEnvironmentVariable: string;
    }>;

export interface SourceRelation {
  readonly source: Readonly<{ schema: string; table: string }>;
  readonly view: string;
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly columns: readonly string[];
  readonly orderBy: readonly string[];
  readonly rowScope: SourceRowScope;
  readonly viewDefinitionSha256?: string;
}

export type SourceAsset =
  | Readonly<{
      bucket: string;
      prefix: string;
      rights: "approved-public" | "approved-owner";
    }>
  | Readonly<{
      bucket: string;
      prefixEnvironmentVariable: string;
      rights: "approved-owner";
      pathMapping: string;
    }>;

export interface SourceAssetReader {
  readonly endpointFingerprint: string;
  readonly baseUrlEnvironmentVariable: string;
  readonly tokenEnvironmentVariable: string;
  readonly maximumObjects: number;
  readonly maximumObjectBytes: number;
  readonly maximumTotalBytes: number;
}

type SourceAssetReview =
  | Extract<SourceAsset, { prefix: string }>
  | Readonly<
      Extract<SourceAsset, { prefixEnvironmentVariable: string }> & {
        prefixValueSha256: string;
      }
    >;

export interface SourceAccessPolicy {
  readonly accessVersion: 1;
  readonly targetFingerprint: string;
  readonly administratorEnvironmentVariable?: string;
  readonly reader: SourceReader;
  readonly exportSchema: string;
  readonly migrationLedger: Readonly<{
    schema: string;
    table: string;
    versionColumn: string;
    nameColumn: string;
    statementsColumn: string;
  }>;
  readonly assetReader: Readonly<SourceAssetReader> | null;
  readonly relations: readonly Readonly<SourceRelation>[];
  readonly assets: readonly SourceAsset[];
}

export interface SourceAccessPlan {
  readonly policy: Readonly<SourceAccessPolicy>;
  readonly review: Readonly<{
    planVersion: 1;
    operation: "prepare-source-access";
    targetFingerprint: string;
    exportSchema: string;
    reader:
      | Readonly<{
          mode: "managed";
          role: string;
          credentialFile: string;
          ownerRole: string;
          validForMinutes: number;
          sourceChanges: true;
        }>
      | Readonly<{
          mode: "external";
          role: string;
          credentialFile: string;
          connectionEnvironmentVariable: string;
          allowedMemberships: readonly string[];
          maximumValidForMinutes: number;
          sourceChanges: false;
        }>;
    relations: readonly Readonly<{
      source: Readonly<{ schema: string; table: string }>;
      view: string;
      targetTable: string;
      columns: readonly string[];
      orderBy: readonly string[];
      viewDefinitionSha256?: string;
      rowScope:
        | Readonly<{ kind: "approved-public" }>
        | Readonly<{
            kind: "approved-owner";
            column: string;
            valueSha256: string | undefined;
          }>;
    }>[];
    assets: readonly SourceAssetReview[];
    assetReader: Readonly<Record<string, unknown>> | null;
    denyChecks: readonly string[];
  }>;
  readonly digest: string;
}

export interface SourceRetirementPlan {
  readonly review: Readonly<{
    planVersion: 1;
    operation: "retire-source-access";
    accessMode: "managed" | "external";
    targetFingerprint: string;
    preparationDigest: string;
    exportSchema: string;
    views: readonly string[];
    relations: readonly Readonly<{
      schema: string;
      table: string;
      columns: readonly string[];
    }>[];
    migrationLedger: Readonly<{ schema: string; table: string }>;
    readerRole: string;
    ownerRole?: string;
  }>;
  readonly digest: string;
}

const isObject = (value: unknown): value is PlainObject =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const knownKeys = (
  value: PlainObject,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
};

const envKey = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !ENVIRONMENT_KEY.test(value)) {
    throw new Error(`${label} must name an uppercase environment variable.`);
  }
  return value;
};

const fingerprint = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(value, null, "\t")}\n`;
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const externalViewDefinitionFingerprint = (
  definition: string,
): string => {
  if (typeof definition !== "string" || !definition.trim()) {
    throw new Error("External view definition must be a non-empty string.");
  }
  return sha256(definition.trim());
};

export const sourceTargetFingerprint = (connectionString: string): string => {
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

export const validateSourceAccessPolicy = (
  policy: unknown,
): Readonly<SourceAccessPolicy> => {
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
  if (!isObject(policy.reader))
    throw new Error("sourcePolicy.reader must be an object.");
  const readerMode = policy.reader.mode ?? "managed";
  if (readerMode !== "managed" && readerMode !== "external") {
    throw new Error("sourcePolicy.reader.mode must be managed or external.");
  }
  knownKeys(
    policy.reader,
    readerMode === "managed"
      ? ["mode", "role", "ownerRole", "credentialFile", "validForMinutes"]
      : [
          "mode",
          "role",
          "allowedMemberships",
          "connectionEnvironmentVariable",
          "credentialFile",
          "maximumValidForMinutes",
        ],
    "sourcePolicy.reader",
  );
  let administratorEnvironmentVariable: string | undefined;
  if (readerMode === "managed") {
    administratorEnvironmentVariable = envKey(
      policy.administratorEnvironmentVariable,
      "sourcePolicy.administratorEnvironmentVariable",
    );
  } else if (policy.administratorEnvironmentVariable !== undefined) {
    throw new Error(
      "sourcePolicy.administratorEnvironmentVariable is not allowed for an external reader.",
    );
  }
  const role = identifier(policy.reader.role, "sourcePolicy.reader.role");
  let ownerRole: string | undefined;
  let validForMinutes: number | undefined;
  let connectionEnvironmentVariable: string | undefined;
  let maximumValidForMinutes: number | undefined;
  let allowedMemberships: readonly string[] = Object.freeze([]);
  if (readerMode === "managed") {
    ownerRole = identifier(
      policy.reader.ownerRole,
      "sourcePolicy.reader.ownerRole",
    );
    if (role === ownerRole)
      throw new Error("Source reader and owner roles must differ.");
    const candidateValidForMinutes = policy.reader.validForMinutes;
    if (
      typeof candidateValidForMinutes !== "number" ||
      !Number.isSafeInteger(candidateValidForMinutes) ||
      candidateValidForMinutes < 5 ||
      candidateValidForMinutes > 240
    ) {
      throw new Error(
        "sourcePolicy.reader.validForMinutes must be from 5 through 240.",
      );
    }
    validForMinutes = candidateValidForMinutes;
  } else {
    if (
      policy.reader.allowedMemberships !== undefined &&
      (!Array.isArray(policy.reader.allowedMemberships) ||
        policy.reader.allowedMemberships.length > 8)
    ) {
      throw new Error(
        "sourcePolicy.reader.allowedMemberships must contain at most 8 role names.",
      );
    }
    allowedMemberships = Object.freeze(
      (policy.reader.allowedMemberships ?? []).map(
        (membership: unknown, index: number) =>
          identifier(
            membership,
            `sourcePolicy.reader.allowedMemberships[${index}]`,
          ),
      ),
    );
    if (new Set(allowedMemberships).size !== allowedMemberships.length) {
      throw new Error(
        "sourcePolicy.reader.allowedMemberships must not contain duplicates.",
      );
    }
    if (allowedMemberships.includes(role)) {
      throw new Error(
        "sourcePolicy.reader.allowedMemberships must not include the login role.",
      );
    }
    connectionEnvironmentVariable = envKey(
      policy.reader.connectionEnvironmentVariable,
      "sourcePolicy.reader.connectionEnvironmentVariable",
    );
    const candidateMaximumValidForMinutes =
      policy.reader.maximumValidForMinutes;
    if (
      typeof candidateMaximumValidForMinutes !== "number" ||
      !Number.isSafeInteger(candidateMaximumValidForMinutes) ||
      candidateMaximumValidForMinutes < 5 ||
      candidateMaximumValidForMinutes > 240
    ) {
      throw new Error(
        "sourcePolicy.reader.maximumValidForMinutes must be from 5 through 240.",
      );
    }
    maximumValidForMinutes = candidateMaximumValidForMinutes;
  }
  const credentialParts =
    typeof policy.reader.credentialFile === "string"
      ? policy.reader.credentialFile.split(/[\\/]/u)
      : [];
  const rehearsalIndex = credentialParts.lastIndexOf(".rehearsal");
  if (
    typeof policy.reader.credentialFile !== "string" ||
    policy.reader.credentialFile.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(policy.reader.credentialFile) ||
    credentialParts.some((part) => !part || part === "." || part === "..") ||
    rehearsalIndex < 0 ||
    credentialParts[rehearsalIndex + 1] !== "secrets" ||
    rehearsalIndex + 2 >= credentialParts.length
  ) {
    throw new Error(
      "sourcePolicy.reader.credentialFile must be a project-relative file under the configured .rehearsal/secrets directory.",
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
  const relations = policy.relations.map(
    (relation: unknown, index: number): Readonly<SourceRelation> => {
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
          "viewDefinitionSha256",
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
        relation.columns.map((column: unknown, columnIndex: number) =>
          identifier(column, `${label}.columns[${columnIndex}]`),
        ),
      );
      if (
        !Array.isArray(relation.orderBy) ||
        relation.orderBy.length === 0 ||
        new Set(relation.orderBy).size !== relation.orderBy.length ||
        relation.orderBy.some(
          (column: unknown) =>
            typeof column !== "string" || !columns.includes(column),
        )
      ) {
        throw new Error(`${label}.orderBy must name unique exported columns.`);
      }
      const orderBy = Object.freeze(
        relation.orderBy.map((column: unknown, columnIndex: number) =>
          identifier(column, `${label}.orderBy[${columnIndex}]`),
        ),
      );
      let viewDefinitionSha256: string | undefined;
      if (readerMode === "external") {
        viewDefinitionSha256 = fingerprint(
          relation.viewDefinitionSha256,
          `${label}.viewDefinitionSha256`,
        );
      } else if (relation.viewDefinitionSha256 !== undefined) {
        throw new Error(
          `${label}.viewDefinitionSha256 is supported only for an external reader.`,
        );
      }
      if (!isObject(relation.rowScope))
        throw new Error(`${label}.rowScope must be an object.`);
      knownKeys(
        relation.rowScope,
        ["kind", "column", "valueEnvironmentVariable"],
        `${label}.rowScope`,
      );
      let rowScope: SourceRowScope;
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
        ...(viewDefinitionSha256 ? { viewDefinitionSha256 } : {}),
      });
    },
  );
  const assets = policy.assets ?? [];
  if (!Array.isArray(assets))
    throw new Error("sourcePolicy.assets must be an array.");
  const normalizedAssets = assets.map(
    (asset: unknown, index: number): SourceAsset => {
      const label = `sourcePolicy.assets[${index}]`;
      if (!isObject(asset)) throw new Error(`${label} must be an object.`);
      knownKeys(
        asset,
        [
          "bucket",
          "prefix",
          "prefixEnvironmentVariable",
          "rights",
          "pathMapping",
        ],
        label,
      );
      if (
        typeof asset.bucket !== "string" ||
        !/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(asset.bucket)
      ) {
        throw new Error(`${label}.bucket is invalid.`);
      }
      const hasFixedPrefix = asset.prefix !== undefined;
      const hasPrivatePrefix = asset.prefixEnvironmentVariable !== undefined;
      if (hasFixedPrefix === hasPrivatePrefix) {
        throw new Error(
          `${label} must declare exactly one of prefix or prefixEnvironmentVariable.`,
        );
      }
      if (hasFixedPrefix) {
        const prefixParts =
          typeof asset.prefix === "string"
            ? asset.prefix.replace(/\/$/u, "").split("/")
            : [];
        if (
          typeof asset.prefix !== "string" ||
          !asset.prefix ||
          asset.prefix.startsWith("/") ||
          prefixParts.some(
            (part: string) => !part || part === "." || part === "..",
          )
        ) {
          throw new Error(`${label}.prefix is unsafe.`);
        }
      } else {
        envKey(
          asset.prefixEnvironmentVariable,
          `${label}.prefixEnvironmentVariable`,
        );
      }
      if (
        asset.rights !== "approved-public" &&
        asset.rights !== "approved-owner"
      ) {
        throw new Error(`${label}.rights must be explicitly approved.`);
      }
      if (
        asset.pathMapping !== undefined &&
        (typeof asset.pathMapping !== "string" ||
          !/^[a-z][a-z0-9-]{0,62}$/u.test(asset.pathMapping))
      ) {
        throw new Error(`${label}.pathMapping is invalid.`);
      }
      if (hasPrivatePrefix && asset.rights !== "approved-owner") {
        throw new Error(
          `${label}.prefixEnvironmentVariable requires approved-owner rights.`,
        );
      }
      if (hasPrivatePrefix && asset.pathMapping === undefined) {
        throw new Error(
          `${label}.prefixEnvironmentVariable requires pathMapping.`,
        );
      }
      if (hasFixedPrefix && asset.pathMapping !== undefined) {
        throw new Error(
          `${label}.pathMapping requires prefixEnvironmentVariable so the raw identity stays out of tracked policy.`,
        );
      }
      if (hasFixedPrefix) {
        return Object.freeze({
          bucket: asset.bucket as string,
          prefix: asset.prefix as string,
          rights: asset.rights as "approved-public" | "approved-owner",
        });
      }
      return Object.freeze({
        bucket: asset.bucket as string,
        prefixEnvironmentVariable: asset.prefixEnvironmentVariable as string,
        rights: "approved-owner",
        pathMapping: asset.pathMapping as string,
      });
    },
  );
  let assetReader: Readonly<SourceAssetReader> | null = null;
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
  const reader: SourceReader =
    readerMode === "managed"
      ? Object.freeze({
          mode: "managed",
          role,
          credentialFile: policy.reader.credentialFile as string,
          ownerRole: ownerRole!,
          validForMinutes: validForMinutes!,
        })
      : Object.freeze({
          mode: "external",
          role,
          allowedMemberships,
          credentialFile: policy.reader.credentialFile as string,
          connectionEnvironmentVariable: connectionEnvironmentVariable!,
          maximumValidForMinutes: maximumValidForMinutes!,
        });
  return Object.freeze({
    accessVersion: 1,
    targetFingerprint: fingerprint(
      policy.targetFingerprint,
      "sourcePolicy.targetFingerprint",
    ),
    ...(administratorEnvironmentVariable
      ? { administratorEnvironmentVariable }
      : {}),
    reader,
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
}: {
  policy: unknown;
  environment?: NodeJS.ProcessEnv;
}): Readonly<SourceAccessPlan> => {
  const normalized = validateSourceAccessPolicy(policy);
  const credentialEnvironmentVariable =
    normalized.reader.mode === "managed"
      ? normalized.administratorEnvironmentVariable
      : normalized.reader.connectionEnvironmentVariable;
  if (!credentialEnvironmentVariable) {
    throw new Error(
      "Source policy is missing its credential environment variable.",
    );
  }
  const sourceCredential = environment[credentialEnvironmentVariable];
  if (!sourceCredential) {
    throw new Error(
      `Source preparation requires ${
        normalized.reader.mode === "managed"
          ? normalized.administratorEnvironmentVariable
          : normalized.reader.connectionEnvironmentVariable
      }; the value is read from the environment and never printed.`,
    );
  }
  const actualTarget = sourceTargetFingerprint(sourceCredential);
  if (actualTarget !== normalized.targetFingerprint) {
    throw new Error(
      "Source credential does not match the reviewed target fingerprint.",
    );
  }
  const ownerScopes: Record<string, string> = Object.fromEntries(
    normalized.relations
      .filter(
        (
          relation,
        ): relation is Readonly<SourceRelation> & {
          readonly rowScope: Extract<
            SourceRowScope,
            { kind: "approved-owner" }
          >;
        } => relation.rowScope.kind === "approved-owner",
      )
      .map((relation) => {
        const key = relation.rowScope.valueEnvironmentVariable;
        const value = environment[key];
        if (!value) throw new Error(`Source preparation requires ${key}.`);
        return [relation.view, sha256(value)];
      }),
  );
  const assetPrefixReceipts: Record<string, string> = Object.fromEntries(
    normalized.assets
      .filter(
        (
          asset,
        ): asset is Extract<
          SourceAsset,
          { prefixEnvironmentVariable: string }
        > => "prefixEnvironmentVariable" in asset,
      )
      .map((asset) => {
        const key = asset.prefixEnvironmentVariable;
        const value = environment[key];
        if (!value) throw new Error(`Source preparation requires ${key}.`);
        return [`${asset.bucket}:${asset.pathMapping}`, sha256(value)];
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
  const review: SourceAccessPlan["review"] = {
    planVersion: 1,
    operation: "prepare-source-access",
    targetFingerprint: normalized.targetFingerprint,
    exportSchema: normalized.exportSchema,
    reader:
      normalized.reader.mode === "managed"
        ? {
            mode: "managed",
            role: normalized.reader.role,
            credentialFile: normalized.reader.credentialFile,
            ownerRole: normalized.reader.ownerRole,
            validForMinutes: normalized.reader.validForMinutes,
            sourceChanges: true,
          }
        : {
            mode: "external",
            role: normalized.reader.role,
            credentialFile: normalized.reader.credentialFile,
            connectionEnvironmentVariable:
              normalized.reader.connectionEnvironmentVariable,
            allowedMemberships: normalized.reader.allowedMemberships,
            maximumValidForMinutes: normalized.reader.maximumValidForMinutes,
            sourceChanges: false,
          },
    relations: normalized.relations.map(
      (relation): SourceAccessPlan["review"]["relations"][number] => ({
        source: relation.source,
        view: relation.view,
        targetTable: relation.targetTable,
        columns: relation.columns,
        orderBy: relation.orderBy,
        ...(relation.viewDefinitionSha256
          ? { viewDefinitionSha256: relation.viewDefinitionSha256 }
          : {}),
        rowScope:
          relation.rowScope.kind === "approved-owner"
            ? {
                kind: "approved-owner",
                column: relation.rowScope.column,
                valueSha256: ownerScopes[relation.view],
              }
            : { kind: "approved-public" },
      }),
    ),
    assets: normalized.assets.map((asset) =>
      "prefixEnvironmentVariable" in asset
        ? {
            ...asset,
            prefixValueSha256:
              assetPrefixReceipts[`${asset.bucket}:${asset.pathMapping}`]!,
          }
        : asset,
    ),
    assetReader: normalized.assetReader
      ? {
          endpointFingerprint: normalized.assetReader.endpointFingerprint,
          maximumObjects: normalized.assetReader.maximumObjects,
          maximumObjectBytes: normalized.assetReader.maximumObjectBytes,
          maximumTotalBytes: normalized.assetReader.maximumTotalBytes,
        }
      : null,
    denyChecks:
      normalized.reader.mode === "managed"
        ? [
            "raw relation reads",
            "writes",
            "role creation and escalation",
            "network functions",
            "unrelated private assets",
          ]
        : [
            "all non-system readable columns match the approved views and migration ledger",
            "no relation, column, schema, or database writes",
            "role memberships exactly match the reviewed allowlist",
            "allowed groups cannot log in, escalate, switch roles, delegate membership, or inherit other roles",
            "no privileged role attributes",
            "no executable non-system security-definer functions",
            "database-enforced credential expiration",
            "unrelated private assets",
          ],
  };
  return Object.freeze({
    policy: normalized,
    review: Object.freeze(review),
    digest: sha256(canonicalJson(review)),
  });
};

export const sourceAccessPolicyFingerprint = (policy: unknown): string =>
  sha256(canonicalJson(validateSourceAccessPolicy(policy)));

export const assetEndpointFingerprint = (value: string): string => {
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

export const assertSourceAccessConfirmation = <Plan extends SourceAccessPlan>(
  plan: Plan,
  confirmation: string,
): Plan => {
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
}: {
  receipt: unknown;
  targetFingerprint: string;
}): Readonly<SourceRetirementPlan> => {
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
  const accessMode = receipt.accessMode ?? "managed";
  if (accessMode !== "managed" && accessMode !== "external") {
    throw new Error("Source access receipt mode is invalid.");
  }
  const relations = receipt.relations.map(
    (relation: unknown, index: number) => {
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
        schema: identifier(
          relation.schema,
          `receipt.relations[${index}].schema`,
        ),
        table: identifier(relation.table, `receipt.relations[${index}].table`),
        columns: relation.columns.map((column: unknown) =>
          identifier(column, `receipt.relations[${index}].columns[]`),
        ),
      };
    },
  );
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
  const review: SourceRetirementPlan["review"] = {
    planVersion: 1,
    operation: "retire-source-access",
    accessMode,
    targetFingerprint: target,
    preparationDigest: fingerprint(receipt.planDigest, "receipt.planDigest"),
    exportSchema: identifier(receipt.exportSchema, "receipt.exportSchema"),
    views: [...receipt.views]
      .map((view) => identifier(view, "receipt.views[]"))
      .sort(),
    relations,
    migrationLedger: ledger,
    readerRole: identifier(receipt.readerRole, "receipt.readerRole"),
    ...(accessMode === "managed"
      ? { ownerRole: identifier(receipt.ownerRole, "receipt.ownerRole") }
      : {}),
  };
  return Object.freeze({
    review: Object.freeze(review),
    digest: sha256(canonicalJson(review)),
  });
};
