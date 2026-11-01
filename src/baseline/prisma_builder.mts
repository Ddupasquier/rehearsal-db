/** Native Prisma synthetic/imported baseline: preserve original files and successful ledger. */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { loadRehearsalConfig } from "../project/configuration.mjs";
import {
  readPrismaMigrationInventory,
  verifyPrismaMigrationLedger,
} from "../runtime/migrations/prisma_history.mjs";
import { inspectPrismaToolchain } from "../runtime/migrations/prisma_toolchain.mjs";
import { parseNativeMigrationBinding } from "../runtime/migrations/native_migration_contract.mjs";
import {
  createAndActivateBaseline,
  createBaselineGenerationId,
  type BaselineStorageAsset,
} from "./artifact.mjs";

export const createPrismaBaseline = async ({
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
  cutoff: import("../runtime/migrations/migration_identity.mjs").MigrationCutoff;
  expectedTables: string[];
  assets: BaselineStorageAsset[];
}) => {
  const tool = loaded.config.postgresql?.migrationTool;
  if (
    !tool ||
    tool.kind !== "prisma" ||
    typeof cutoff !== "string" ||
    assets.length ||
    loaded.config.preparation
  )
    throw new Error(
      "Native Prisma baseline requires explicit PostgreSQL tool configuration and reviewed local records/ledger; hosted preparation and Storage are not qualified.",
    );
  const contents = new Map<string, Buffer>();
  const inventory = await readPrismaMigrationInventory(
    pathToFileURL(`${loaded.paths.migrationDirectory}/`),
    {
      onBytes: (name, bytes) => {
        contents.set(name, bytes);
      },
    },
  );
  const history = verifyPrismaMigrationLedger({
    rows: ledger,
    entries: inventory.entries,
  });
  if (history.at(-1)!.migration_name.slice(0, 14) !== cutoff)
    throw new Error(
      "Native Prisma ledger cutoff must exactly match the reviewed sanitization policy.",
    );
  const toolchain = await inspectPrismaToolchain({
    projectRoot: loaded.projectRoot,
    packageDirectory: tool.packageDirectory,
  });
  const binding = parseNativeMigrationBinding({
    ...inventory.binding,
    toolchainSha256: toolchain.sha256,
  });
  const migrationFiles = inventory.entries
    .slice(0, history.length)
    .map((entry) => {
      const bytes = contents.get(entry.filename)!;
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (!Buffer.from(content).equals(bytes))
        throw new Error(
          "Native migration SQL must preserve exact UTF-8 bytes.",
        );
      return { ...entry, content };
    });
  const baseline = await createAndActivateBaseline({
    artifactRoot: loaded.paths.artifactDirectory,
    generationId: createBaselineGenerationId(),
    records,
    expectedTables,
    assets,
    migrationFiles,
    migrationLock: contents.get("migration_lock.toml")!,
    metadata: {
      migrationCutoff: cutoff,
      migrationHistorySha256: createHash("sha256")
        .update(JSON.stringify({ binding, history }))
        .digest("hex"),
      sanitizationPolicySha256: createHash("sha256")
        .update(policyBytes)
        .digest("hex"),
      nativeMigrations: binding,
      sourceNativeMigrationHistory: history,
    },
  });
  return {
    generationId: baseline.generationId,
    migrationCutoff: cutoff,
    migrationCount: migrationFiles.length,
    rowCount: baseline.rowCount,
    tableCount: Object.keys(baseline.tableCounts).length,
  };
};
