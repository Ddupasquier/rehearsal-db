/** Initial Knex baseline requires every source native filename already applied. */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { loadRehearsalConfig } from "../project/configuration.mjs";
import {
  readKnexMigrationInventory,
  verifyKnexMigrationLedger,
  parseKnexMigrationIdentity,
} from "../runtime/migrations/knex_history.mjs";
import { inspectKnexToolchain } from "../runtime/migrations/knex_toolchain.mjs";
import { KNEX_WORKER_POLICY_SHA256 } from "../runtime/migrations/knex_isolation_contract.mjs";
import { parseNativeMigrationBinding } from "../runtime/migrations/native_migration_contract.mjs";
import {
  createAndActivateBaseline,
  createBaselineGenerationId,
  type BaselineStorageAsset,
} from "./artifact.mjs";
import type { MigrationCutoff } from "../runtime/migrations/migration_identity.mjs";
export const createKnexBaseline = async ({
  loaded,
  records,
  ledger,
  policyBytes,
  cutoff,
  expectedTables,
  assets,
}: {
  loaded: Awaited<ReturnType<typeof loadRehearsalConfig>>;
  records: AsyncIterable<unknown>;
  ledger: unknown;
  policyBytes: Buffer;
  cutoff: MigrationCutoff;
  expectedTables: string[];
  assets: BaselineStorageAsset[];
}) => {
  const tool = loaded.config.postgresql?.migrationTool;
  if (tool?.kind !== "knex" || assets.length || loaded.config.preparation)
    throw new Error(
      "Knex baseline requires reviewed PostgreSQL records and native ledger; hosted preparation/Storage are unsupported.",
    );
  const contents = new Map<string, Buffer>();
  const inventory = await readKnexMigrationInventory(
    pathToFileURL(`${loaded.paths.migrationDirectory}/`),
    {
      onBytes: (name, bytes) => {
        contents.set(name, bytes);
      },
    },
  );
  const history = verifyKnexMigrationLedger({
    rows: ledger,
    entries: inventory.entries,
  });
  if (
    history.length !== inventory.entries.length ||
    parseKnexMigrationIdentity(cutoff).name !==
      inventory.entries.at(-1)!.filename
  )
    throw new Error(
      "Knex baseline requires the complete source history applied before any rows or artifact writes; historical checksums remain unavailable.",
    );
  const toolchain = await inspectKnexToolchain({
    projectRoot: loaded.projectRoot,
    tool,
  });
  const binding = parseNativeMigrationBinding({
    schemaVersion: 1,
    kind: "knex",
    version: "3.3.0",
    driver: "pg",
    driverVersion: "8.23.1",
    provider: "postgresql",
    bundleSha256: inventory.bundleSha256,
    codeFiles: inventory.files,
    toolchainSha256: toolchain.sha256,
    isolationPolicySha256: KNEX_WORKER_POLICY_SHA256,
    historicalFileChecksums: "unavailable",
    ledger: { schema: "public", table: "knex_migrations" },
  });
  const baseline = await createAndActivateBaseline({
    artifactRoot: loaded.paths.artifactDirectory,
    generationId: createBaselineGenerationId(),
    records,
    expectedTables,
    assets,
    migrationFiles: inventory.entries.map((x) => ({
      filename: x.filename,
      fileSha256: x.fileSha256,
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(contents.get(x.filename)!),
    })),
    migrationSupportFiles: inventory.files
      .filter((x) => x.filename.includes("/"))
      .map((x) => ({
        filename: x.filename,
        fileSha256: x.fileSha256,
        content: contents.get(x.filename)!,
      })),
    metadata: {
      migrationCutoff: cutoff,
      migrationHistorySha256: createHash("sha256")
        .update(JSON.stringify({ binding, history }))
        .digest("hex"),
      sanitizationPolicySha256: createHash("sha256")
        .update(policyBytes)
        .digest("hex"),
      nativeMigrations: binding,
      knexHistory: {
        schemaVersion: 1,
        entries: inventory.entries,
        files: inventory.files,
        sourceLedger: history,
        historicalFileChecksums: "unavailable",
      },
    },
  });
  return {
    historicalFileChecksums: "unavailable" as const,
    generationId: baseline.generationId,
    migrationCutoff: cutoff,
    migrationCount: inventory.entries.length,
    rowCount: baseline.rowCount,
    tableCount: Object.keys(baseline.tableCounts).length,
  };
};
