/**
 * Stream an approved PostgreSQL export surface into a staged, verified baseline
 * using one coherent read-only snapshot. No raw row values are logged.
 */

import { createHash } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  activateBaselineGeneration,
  createAndActivateBaseline,
  createBaselineGenerationId,
  removeStagedBaselineGeneration,
} from "../baseline/artifact.mjs";
import type { BaselineStorageAsset } from "../baseline/artifact.mjs";
import {
  buildMigrationLedgerInventory,
  createMigrationReplayReceipt,
  readMigrationSourceBundle,
} from "../runtime/migration_history.mjs";
import {
  createPrivacyEngine,
  validateExecutablePrivacyPolicy,
} from "../baseline/privacy_engine.mjs";
import type {
  ExecutablePrivacyPolicy,
  PrivacyEngine,
  PrivacySourceRecord,
} from "../baseline/privacy_engine.mjs";
import type { MigrationLedgerEntry } from "../runtime/migration_history.mjs";
import {
  sourceAccessPolicyFingerprint,
  sourceTargetFingerprint,
  validateSourceAccessPolicy,
} from "./access.mjs";
import type { SourceAccessPolicy } from "./access.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const DEFAULT_LIMITS = Object.freeze({
  batchRows: 500,
  maximumRows: 1_000_000,
  maximumBytes: 2 * 1024 * 1024 * 1024,
  diskHeadroomBytes: 64 * 1024 * 1024,
});

interface SourceQueryResult {
  readonly rows: Record<string, unknown>[];
}

interface SourceClient {
  connect?(): Promise<void> | void;
  query(query: string, values?: readonly unknown[]): Promise<SourceQueryResult>;
  end?(): Promise<void> | void;
}

type SourceClientFactory = (
  connectionString: string,
) => SourceClient | Promise<SourceClient>;

interface ExtractionLimits {
  readonly batchRows: number;
  readonly maximumRows: number;
  readonly maximumBytes: number;
  readonly diskHeadroomBytes: number;
}

interface SourceSchemaColumn {
  readonly name: string;
  readonly dataType: string;
  readonly underlyingType: string;
  readonly nullable: boolean;
  readonly generated: unknown;
  readonly identity: unknown;
  readonly ordinal: number;
}

interface SourceSchemaTable {
  readonly schema: string;
  readonly name: string;
  readonly sourceView: string;
  readonly columns: readonly SourceSchemaColumn[];
}

export interface ExportEstimate {
  readonly rows: number;
  readonly bytes: number;
  readonly tables: readonly Readonly<{
    schema: string;
    name: string;
    rows: number;
    bytes: number;
  }>[];
}

interface SourceAccessReceipt {
  readonly accessMode?: "managed" | "external";
  readonly policyFingerprint?: string;
  readonly targetFingerprint?: string;
  readonly planDigest?: string;
  readonly exportSchema?: string;
  readonly views?: readonly string[];
  readonly relations?: readonly unknown[];
  readonly migrationLedger?: unknown;
  readonly readerRole?: string;
  readonly ownerRole?: string;
  readonly expiresAt: string;
}

const quoteIdentifier = (value: string): string => {
  if (!IDENTIFIER.test(value))
    throw new Error("Unsafe source extraction identifier.");
  return `"${value}"`;
};

const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(value, null, "\t")}\n`;
const sha256 = (value: string | NodeJS.ArrayBufferView): string =>
  createHash("sha256").update(value).digest("hex");
const parseEstimateValue = (value: unknown): number => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !/^(?:0|[1-9]\d*)$/u.test(value))
  ) {
    return Number.NaN;
  }
  return Number(value);
};

const normalizeLimits = (
  limits: Partial<ExtractionLimits> = {},
): Readonly<ExtractionLimits> => {
  const normalized = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new Error(
        `Source extraction limit ${name} must be a positive integer.`,
      );
    }
  }
  if (normalized.batchRows > 10_000) {
    throw new Error("Source extraction batchRows may not exceed 10000.");
  }
  return Object.freeze(normalized);
};

const connect = async (
  connectionString: string,
  clientFactory?: SourceClientFactory,
): Promise<SourceClient> => {
  const client = clientFactory
    ? await clientFactory(connectionString)
    : new Client({
        connectionString,
        application_name: "rehearsal-baseline-refresh",
      });
  await client.connect?.();
  return client as unknown as SourceClient;
};

const readLedger = async (
  client: SourceClient,
  declaration: SourceAccessPolicy["migrationLedger"],
): Promise<readonly MigrationLedgerEntry[]> => {
  const result = await client.query(
    `select
      ${quoteIdentifier(declaration.versionColumn)} as version,
      ${quoteIdentifier(declaration.nameColumn)} as name,
      ${quoteIdentifier(declaration.statementsColumn)} as statements
     from ${quoteIdentifier(declaration.schema)}.${quoteIdentifier(declaration.table)}
     order by ${quoteIdentifier(declaration.versionColumn)}`,
  );
  return buildMigrationLedgerInventory(
    result.rows,
    "Approved source migration ledger",
  );
};

const inspectExportSchema = async (
  client: SourceClient,
  policy: SourceAccessPolicy,
): Promise<readonly SourceSchemaTable[]> => {
  const tables: SourceSchemaTable[] = [];
  for (const relation of policy.relations) {
    const result = await client.query(
      `select column_name as name, data_type, udt_name, is_nullable,
              is_generated, is_identity, ordinal_position
       from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [policy.exportSchema, relation.view],
    );
    const actualNames = result.rows.map((row) => String(row.name));
    if (actualNames.join("\0") !== relation.columns.join("\0")) {
      throw new Error(
        `Approved export view ${relation.view} no longer has the reviewed columns.`,
      );
    }
    tables.push({
      schema: relation.targetSchema,
      name: relation.targetTable,
      sourceView: relation.view,
      columns: result.rows.map((row) => ({
        name: String(row.name),
        dataType: String(row.data_type),
        underlyingType: String(row.udt_name),
        nullable: row.is_nullable === "YES",
        generated: row.is_generated,
        identity: row.is_identity,
        ordinal: Number(row.ordinal_position),
      })),
    });
  }
  return Object.freeze(tables);
};

const estimateExport = async (
  client: SourceClient,
  policy: SourceAccessPolicy,
): Promise<Readonly<ExportEstimate>> => {
  const tables: ExportEstimate["tables"][number][] = [];
  let rows = 0;
  let bytes = 0;
  for (const relation of policy.relations) {
    const result = await client.query(
      `select count(*)::bigint as rows,
              coalesce(sum(pg_column_size(export_row)), 0)::bigint as bytes
       from ${quoteIdentifier(policy.exportSchema)}.${quoteIdentifier(relation.view)} export_row`,
    );
    const estimate = result.rows?.[0];
    const tableRows = parseEstimateValue(estimate?.rows);
    const tableBytes = parseEstimateValue(estimate?.bytes);
    if (
      !Number.isSafeInteger(tableRows) ||
      !Number.isSafeInteger(tableBytes) ||
      tableRows < 0 ||
      tableBytes < 0 ||
      !Number.isSafeInteger(rows + tableRows) ||
      !Number.isSafeInteger(bytes + tableBytes)
    ) {
      throw new Error(
        "Source export estimate is missing, negative, or exceeds safe numeric limits.",
      );
    }
    rows += tableRows;
    bytes += tableBytes;
    tables.push({
      schema: relation.targetSchema,
      name: relation.targetTable,
      rows: tableRows,
      bytes: tableBytes,
    });
  }
  return Object.freeze({ rows, bytes, tables: Object.freeze(tables) });
};

const assertCapacity = async ({
  artifactRoot,
  estimate,
  limits,
  availableBytes,
}: {
  artifactRoot: string;
  estimate: ExportEstimate;
  limits: ExtractionLimits;
  availableBytes: number;
}): Promise<void> => {
  if (estimate.rows > limits.maximumRows) {
    throw new Error(
      `Approved source contains ${estimate.rows} rows; the configured limit is ${limits.maximumRows}.`,
    );
  }
  if (estimate.bytes > limits.maximumBytes) {
    throw new Error(
      "Approved source estimate exceeds the configured byte limit.",
    );
  }
  await mkdir(dirname(artifactRoot), { recursive: true, mode: 0o700 });
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error("Available baseline disk capacity could not be measured.");
  }
  const available = availableBytes;
  const required = estimate.bytes * 2 + limits.diskHeadroomBytes;
  if (available < required) {
    throw new Error(
      `Baseline refresh needs approximately ${required} free bytes but only ${available} are available.`,
    );
  }
};

const actualAvailableBytes = async (artifactRoot: string): Promise<number> => {
  const stats = await statfs(dirname(artifactRoot));
  return Number(stats.bavail) * Number(stats.bsize);
};

const assertPolicyCoverage = (
  privacyPolicy: ExecutablePrivacyPolicy,
  sourceSchema: readonly SourceSchemaTable[],
): void => {
  const selected = new Map(
    sourceSchema.map((table) => [
      `${table.schema}.${table.name}`,
      table.columns.map((column) => column.name),
    ]),
  );
  const classified = new Map(
    privacyPolicy.tables.map((table) => [
      `${table.schema ?? "public"}.${table.name}`,
      table.columns.map((column) => column.name),
    ]),
  );
  if (selected.size !== classified.size) {
    throw new Error(
      "Privacy policy table coverage does not match the approved source scope.",
    );
  }
  for (const [table, columns] of selected) {
    const decisions = classified.get(table);
    if (
      !decisions ||
      columns.slice().sort().join("\0") !== decisions.slice().sort().join("\0")
    ) {
      throw new Error(
        `Privacy policy coverage changed for source table ${table}.`,
      );
    }
  }
};

const streamSanitizedRecords = async function* ({
  client,
  sourcePolicy,
  privacyEngine,
  limits,
  progress,
}: {
  client: SourceClient;
  sourcePolicy: SourceAccessPolicy;
  privacyEngine: Readonly<PrivacyEngine>;
  limits: ExtractionLimits;
  progress?: (state: { table: string; rows: number; bytes: number }) => void;
}): AsyncGenerator<PrivacySourceRecord> {
  let totalRows = 0;
  let totalBytes = 0;
  for (const [index, relation] of sourcePolicy.relations.entries()) {
    const cursor = `rehearsal_export_${index}`;
    const columns = relation.columns.map(quoteIdentifier).join(", ");
    const orderBy = relation.orderBy.map(quoteIdentifier).join(", ");
    await client.query(
      `declare ${quoteIdentifier(cursor)} no scroll cursor for
       select ${columns}
       from ${quoteIdentifier(sourcePolicy.exportSchema)}.${quoteIdentifier(relation.view)}
       order by ${orderBy}`,
    );
    try {
      while (true) {
        const batch = await client.query(
          `fetch forward ${limits.batchRows} from ${quoteIdentifier(cursor)}`,
        );
        if (
          !Array.isArray(batch?.rows) ||
          batch.rows.length > limits.batchRows
        ) {
          throw new Error(
            "Source reader returned a malformed or oversized cursor batch.",
          );
        }
        if (batch.rows.length === 0) break;
        for (const row of batch.rows) {
          const sanitized = privacyEngine.sanitize({
            schema: relation.targetSchema,
            table: relation.targetTable,
            row,
          });
          if (!sanitized) continue;
          totalRows += 1;
          totalBytes += Buffer.byteLength(JSON.stringify(sanitized));
          if (
            totalRows > limits.maximumRows ||
            totalBytes > limits.maximumBytes
          ) {
            throw new Error(
              "Source stream exceeded its reviewed extraction boundary.",
            );
          }
          yield sanitized;
        }
        progress?.({
          table: relation.targetTable,
          rows: totalRows,
          bytes: totalBytes,
        });
      }
    } finally {
      await client
        .query(`close ${quoteIdentifier(cursor)}`)
        .catch(() => undefined);
    }
  }
};

export const refreshPostgresqlBaseline = async ({
  connectionString,
  sourcePolicy: sourcePolicyInput,
  sourceAccessReceipt,
  privacyPolicyBytes,
  privacyKey,
  artifactRoot,
  migrationDirectory,
  limits: limitInput,
  availableBytes,
  clientFactory,
  progress,
  assets = [],
}: {
  connectionString: string;
  sourcePolicy: unknown;
  sourceAccessReceipt: SourceAccessReceipt;
  privacyPolicyBytes: Uint8Array | string;
  privacyKey: Uint8Array | string;
  artifactRoot: string;
  migrationDirectory: string;
  limits?: Partial<ExtractionLimits>;
  availableBytes?: number;
  clientFactory?: SourceClientFactory;
  progress?: (state: { table: string; rows: number; bytes: number }) => void;
  assets?: Iterable<BaselineStorageAsset> | AsyncIterable<BaselineStorageAsset>;
}) => {
  const sourcePolicy = validateSourceAccessPolicy(sourcePolicyInput);
  if (
    sourceTargetFingerprint(connectionString) !== sourcePolicy.targetFingerprint
  ) {
    throw new Error(
      "Source reader credential does not match the reviewed target.",
    );
  }
  const expectedReceiptShape = {
    accessMode: sourcePolicy.reader.mode,
    exportSchema: sourcePolicy.exportSchema,
    views: sourcePolicy.relations.map((relation) => relation.view).sort(),
    relations: sourcePolicy.relations.map((relation) => ({
      ...relation.source,
      columns: relation.columns,
    })),
    migrationLedger: sourcePolicy.migrationLedger,
    readerRole: sourcePolicy.reader.role,
    ownerRole:
      sourcePolicy.reader.mode === "managed"
        ? sourcePolicy.reader.ownerRole
        : null,
  };
  const actualReceiptShape = {
    accessMode: sourceAccessReceipt?.accessMode ?? "managed",
    exportSchema: sourceAccessReceipt?.exportSchema,
    views: [...(sourceAccessReceipt?.views ?? [])].sort(),
    relations: sourceAccessReceipt?.relations,
    migrationLedger: sourceAccessReceipt?.migrationLedger,
    readerRole: sourceAccessReceipt?.readerRole,
    ownerRole: sourceAccessReceipt?.ownerRole ?? null,
  };
  const policyFingerprint = sourceAccessPolicyFingerprint(sourcePolicy);
  if (
    sourceAccessReceipt?.targetFingerprint !== sourcePolicy.targetFingerprint ||
    !/^[a-f0-9]{64}$/u.test(sourceAccessReceipt?.planDigest ?? "") ||
    (sourcePolicy.reader.mode === "external" &&
      sourceAccessReceipt?.policyFingerprint !== policyFingerprint) ||
    (sourceAccessReceipt?.policyFingerprint !== undefined &&
      sourceAccessReceipt.policyFingerprint !== policyFingerprint) ||
    new Date(sourceAccessReceipt.expiresAt).valueOf() <= Date.now() ||
    JSON.stringify(actualReceiptShape) !== JSON.stringify(expectedReceiptShape)
  ) {
    throw new Error(
      "Source reader receipt is missing, mismatched, or expired.",
    );
  }
  const privacyPolicy = validateExecutablePrivacyPolicy(
    JSON.parse(Buffer.from(privacyPolicyBytes).toString("utf8")),
  );
  const privacyEngine = createPrivacyEngine({
    policy: privacyPolicy,
    key: privacyKey,
  });
  const limits = normalizeLimits(limitInput);
  const client = await connect(connectionString, clientFactory);
  let generationId: string | undefined;
  let transactionOpen = false;
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    transactionOpen = true;
    const [sourceLedger, sourceSchema] = await Promise.all([
      readLedger(client, sourcePolicy.migrationLedger),
      inspectExportSchema(client, sourcePolicy),
    ]);
    assertPolicyCoverage(privacyPolicy, sourceSchema);
    const finalSourceMigration = sourceLedger.at(-1);
    if (!finalSourceMigration) {
      throw new Error("Approved source migration ledger is empty.");
    }
    if (privacyPolicy.migrationCutoff !== finalSourceMigration.version) {
      throw new Error(
        "Privacy policy cutoff does not match the coherent source ledger.",
      );
    }
    const migrationFiles = await readMigrationSourceBundle({
      directory: new URL("./", pathToFileURL(`${migrationDirectory}/`)),
      sourceLedger,
    });
    const migrationReceipt = createMigrationReplayReceipt({
      files: migrationFiles,
      ledger: sourceLedger,
    });
    const estimate = await estimateExport(client, sourcePolicy);
    await assertCapacity({
      artifactRoot,
      estimate,
      limits,
      availableBytes:
        availableBytes ?? (await actualAvailableBytes(artifactRoot)),
    });
    generationId = createBaselineGenerationId();
    const schemaSha256 = sha256(canonicalJson(sourceSchema));
    const policySha256 = sha256(privacyPolicyBytes);
    const manifest = await createAndActivateBaseline({
      artifactRoot,
      generationId,
      activate: false,
      records: streamSanitizedRecords({
        client,
        sourcePolicy,
        privacyEngine,
        limits,
        ...(progress ? { progress } : {}),
      }),
      metadata: {
        migrationCutoff: finalSourceMigration.version,
        migrationHistorySha256: migrationReceipt.historySha256,
        sanitizationPolicySha256: policySha256,
        sourceMigrationHistory: sourceLedger,
        sourceReceiptSha256: sha256(
          canonicalJson({
            targetFingerprint: sourceAccessReceipt.targetFingerprint,
            planDigest: sourceAccessReceipt.planDigest,
            policyFingerprint: sourceAccessReceipt.policyFingerprint ?? null,
            expiresAt: sourceAccessReceipt.expiresAt,
          }),
        ),
        sourceSchemaSha256: schemaSha256,
        privacyKeyFingerprint: privacyEngine.keyFingerprint,
        extraction: {
          rowsEstimated: estimate.rows,
          bytesEstimated: estimate.bytes,
          batchRows: limits.batchRows,
        },
      },
      expectedTables: privacyPolicy.tables
        .filter((table) => table.sourceRows !== "EXCLUDE")
        .map((table) =>
          (table.schema ?? "public") === "public"
            ? table.name
            : `${table.schema}.${table.name}`,
        ),
      migrationFiles,
      assets,
    });
    const observer = await connect(connectionString, clientFactory);
    try {
      const [latestLedger, latestSchema] = await Promise.all([
        readLedger(observer, sourcePolicy.migrationLedger),
        inspectExportSchema(observer, sourcePolicy),
      ]);
      if (
        sha256(canonicalJson(latestLedger)) !==
          sha256(canonicalJson(sourceLedger)) ||
        sha256(canonicalJson(latestSchema)) !== schemaSha256
      ) {
        throw new Error(
          "Source schema or migration ledger changed during baseline preparation.",
        );
      }
    } finally {
      await observer.end?.();
    }
    await client.query("commit");
    transactionOpen = false;
    await activateBaselineGeneration({ artifactRoot, generationId });
    return { generationId, manifest, estimate };
  } catch (error) {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    if (generationId) {
      await removeStagedBaselineGeneration({
        artifactRoot,
        generationId,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end?.();
  }
};
