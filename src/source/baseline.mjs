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
import {
  buildMigrationLedgerInventory,
  createMigrationReplayReceipt,
  readMigrationSourceBundle,
} from "../runtime/migration_history.mjs";
import {
  createPrivacyEngine,
  validateExecutablePrivacyPolicy,
} from "../baseline/privacy_engine.mjs";
import {
  sourceTargetFingerprint,
  validateSourceAccessPolicy,
} from "./access.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const DEFAULT_LIMITS = Object.freeze({
  batchRows: 500,
  maximumRows: 1_000_000,
  maximumBytes: 2 * 1024 * 1024 * 1024,
  diskHeadroomBytes: 64 * 1024 * 1024,
});

const quoteIdentifier = (value) => {
  if (!IDENTIFIER.test(value ?? ""))
    throw new Error("Unsafe source extraction identifier.");
  return `"${value}"`;
};

const canonicalJson = (value) => `${JSON.stringify(value, null, "\t")}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const normalizeLimits = (limits = {}) => {
  const normalized = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 1) {
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

const connect = async (connectionString, clientFactory) => {
  const client = clientFactory
    ? await clientFactory(connectionString)
    : new Client({
        connectionString,
        application_name: "rehearsal-baseline-refresh",
      });
  await client.connect?.();
  return client;
};

const readLedger = async (client, declaration) => {
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

const inspectExportSchema = async (client, policy) => {
  const tables = [];
  for (const relation of policy.relations) {
    const result = await client.query(
      `select column_name as name, data_type, udt_name, is_nullable,
              is_generated, is_identity, ordinal_position
       from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [policy.exportSchema, relation.view],
    );
    const actualNames = result.rows.map((row) => row.name);
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
        name: row.name,
        dataType: row.data_type,
        underlyingType: row.udt_name,
        nullable: row.is_nullable === "YES",
        generated: row.is_generated,
        identity: row.is_identity,
        ordinal: Number(row.ordinal_position),
      })),
    });
  }
  return Object.freeze(tables);
};

const estimateExport = async (client, policy) => {
  const tables = [];
  let rows = 0;
  let bytes = 0;
  for (const relation of policy.relations) {
    const result = await client.query(
      `select count(*)::bigint as rows,
              coalesce(sum(pg_column_size(export_row)), 0)::bigint as bytes
       from ${quoteIdentifier(policy.exportSchema)}.${quoteIdentifier(relation.view)} export_row`,
    );
    const tableRows = Number(result.rows[0].rows);
    const tableBytes = Number(result.rows[0].bytes);
    if (!Number.isSafeInteger(tableRows) || !Number.isSafeInteger(tableBytes)) {
      throw new Error("Source export estimate exceeds safe numeric limits.");
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
}) => {
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

const actualAvailableBytes = async (artifactRoot) => {
  const stats = await statfs(dirname(artifactRoot));
  return Number(stats.bavail) * Number(stats.bsize);
};

const assertPolicyCoverage = (privacyPolicy, sourceSchema) => {
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
}) {
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
    exportSchema: sourcePolicy.exportSchema,
    views: sourcePolicy.relations.map((relation) => relation.view).sort(),
    relations: sourcePolicy.relations.map((relation) => ({
      ...relation.source,
      columns: relation.columns,
    })),
    migrationLedger: sourcePolicy.migrationLedger,
    readerRole: sourcePolicy.reader.role,
    ownerRole: sourcePolicy.reader.ownerRole,
  };
  const actualReceiptShape = {
    exportSchema: sourceAccessReceipt?.exportSchema,
    views: [...(sourceAccessReceipt?.views ?? [])].sort(),
    relations: sourceAccessReceipt?.relations,
    migrationLedger: sourceAccessReceipt?.migrationLedger,
    readerRole: sourceAccessReceipt?.readerRole,
    ownerRole: sourceAccessReceipt?.ownerRole,
  };
  if (
    sourceAccessReceipt?.targetFingerprint !== sourcePolicy.targetFingerprint ||
    !/^[a-f0-9]{64}$/u.test(sourceAccessReceipt?.planDigest ?? "") ||
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
  let generationId;
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
    if (privacyPolicy.migrationCutoff !== sourceLedger.at(-1).version) {
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
        progress,
      }),
      metadata: {
        migrationCutoff: sourceLedger.at(-1).version,
        migrationHistorySha256: migrationReceipt.historySha256,
        sanitizationPolicySha256: policySha256,
        sourceMigrationHistory: sourceLedger,
        sourceReceiptSha256: sha256(
          canonicalJson({
            targetFingerprint: sourceAccessReceipt.targetFingerprint,
            planDigest: sourceAccessReceipt.planDigest,
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
