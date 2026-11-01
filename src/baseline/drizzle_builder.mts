/** Preserve a fully-applied native Drizzle journal without regenerating history. */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { loadRehearsalConfig } from "../project/configuration.mjs";
import {
  readDrizzleMigrationInventory,
  verifyDrizzleMigrationLedger,
} from "../runtime/migrations/drizzle_history.mjs";
import { inspectDrizzleToolchain } from "../runtime/migrations/drizzle_toolchain.mjs";
import { parseNativeMigrationBinding } from "../runtime/migrations/native_migration_contract.mjs";
import {
  parseDrizzleMigrationIdentity,
  sameMigrationCutoff,
  type MigrationCutoff,
} from "../runtime/migrations/migration_identity.mjs";
import {
  createAndActivateBaseline,
  createBaselineGenerationId,
  type BaselineStorageAsset,
} from "./artifact.mjs";
export const createDrizzleBaseline = async ({
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
  if (tool?.kind !== "drizzle" || assets.length || loaded.config.preparation)
    throw new Error(
      "Native Drizzle baseline requires explicit PostgreSQL configuration and reviewed records/ledger; hosted preparation and Storage are not qualified.",
    );
  const contents = new Map<string, Buffer>();
  const inventory = await readDrizzleMigrationInventory(
    pathToFileURL(`${loaded.paths.migrationDirectory}/`),
    {
      onBytes: (name, bytes) => {
        contents.set(name, bytes);
      },
    },
  );
  const history = verifyDrizzleMigrationLedger({
    rows: ledger,
    entries: inventory.entries,
  });
  // Refuse before consuming records or creating any artifact directory. A
  // partial copy would require a rewritten journal, which this workflow forbids.
  const last = inventory.entries.at(-1)!;
  if (
    history.length !== inventory.entries.length ||
    !sameMigrationCutoff(parseDrizzleMigrationIdentity(cutoff), {
      kind: "drizzle",
      idx: last.idx,
      when: last.when,
      tag: last.tag,
    })
  )
    throw new Error(
      "Drizzle baseline requires the complete native journal to be applied and its exact native cutoff reviewed.",
    );
  const toolchain = await inspectDrizzleToolchain({
    projectRoot: loaded.projectRoot,
    tool,
  });
  const binding = parseNativeMigrationBinding({
    ...inventory.binding,
    driver: "pg",
    driverVersion: "8.23.1",
    toolchainSha256: toolchain.sha256,
  });
  const journal = contents.get("meta/_journal.json")!;
  const drizzleHistory = {
    schemaVersion: 1 as const,
    entries: inventory.entries,
    sourceLedger: history,
    journal: {
      path: "meta/_journal.json" as const,
      sha256: inventory.binding.journalSha256,
      bytes: journal.length,
    },
  };
  const baseline = await createAndActivateBaseline({
    artifactRoot: loaded.paths.artifactDirectory,
    generationId: createBaselineGenerationId(),
    records,
    expectedTables,
    assets,
    migrationJournal: journal,
    migrationFiles: inventory.entries.map((entry) => ({
      filename: entry.filename,
      fileSha256: entry.hash,
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(contents.get(entry.filename)!),
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
      drizzleHistory,
    },
  });
  return {
    generationId: baseline.generationId,
    migrationCutoff: cutoff,
    migrationCount: inventory.entries.length,
    rowCount: baseline.rowCount,
    tableCount: Object.keys(baseline.tableCounts).length,
  };
};
