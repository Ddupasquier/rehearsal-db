/**
 * Build a synthetic baseline from explicit project-owned local files. This module does
 * not connect to a hosted source or decide which values are safe.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  createAndActivateBaseline,
  createBaselineGenerationId,
} from "./baseline_artifact.mjs";
import { loadRehearsalConfig } from "./configuration.mjs";
import {
  buildMigrationLedgerInventory,
  createMigrationReplayReceipt,
  readMigrationSourceBundle,
} from "./migration_history.mjs";

const resolveProjectInput = (projectRoot, value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  const path = resolve(projectRoot, value);
  const owned = relative(projectRoot, path);
  if (
    owned === "" ||
    owned === ".." ||
    owned.startsWith(`..${sep}`) ||
    isAbsolute(owned)
  ) {
    throw new Error(`${label} must be a file inside the project root.`);
  }
  return path;
};

const readRecords = async function* (path) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error("Synthetic baseline input contains invalid NDJSON.", {
        cause: error,
      });
    }
    yield record;
  }
};

export const createSyntheticBaselineFromFiles = async ({
  projectRoot = process.cwd(),
  configPath,
  recordsPath,
  ledgerPath,
  assetsPath,
}) => {
  const loaded = await loadRehearsalConfig({ projectRoot, configPath });
  const records = resolveProjectInput(
    loaded.projectRoot,
    recordsPath,
    "Synthetic records path",
  );
  const ledger = resolveProjectInput(
    loaded.projectRoot,
    ledgerPath,
    "Migration ledger path",
  );
  const [policyBytes, ledgerBytes] = await Promise.all([
    readFile(loaded.paths.sanitizationPolicy),
    readFile(ledger),
  ]);
  const assets = assetsPath
    ? await Promise.all(
        JSON.parse(
          await readFile(
            resolveProjectInput(
              loaded.projectRoot,
              assetsPath,
              "Synthetic assets manifest path",
            ),
            "utf8",
          ),
        ).map(async (asset) => ({
          bucket: asset.bucket,
          objectPath: asset.objectPath,
          contentType: asset.contentType,
          content: await readFile(
            resolveProjectInput(
              loaded.projectRoot,
              asset.file,
              "Synthetic asset file path",
            ),
          ),
        })),
      )
    : [];
  const policy = JSON.parse(policyBytes.toString("utf8"));
  if (!Array.isArray(policy.tables)) {
    throw new Error("The configured sanitization policy does not list tables.");
  }
  const expectedTables = policy.tables
    .filter((table) => table.sourceRows !== "EXCLUDE")
    .map((table) => table.name);
  if (expectedTables.length === 0) {
    throw new Error("The sanitization policy includes no restorable tables.");
  }
  const sourceMigrationHistory = buildMigrationLedgerInventory(
    JSON.parse(ledgerBytes.toString("utf8")),
    "Synthetic migration ledger",
  );
  const migrationFiles = await readMigrationSourceBundle({
    directory: new URL(
      "./",
      pathToFileURL(`${loaded.paths.migrationDirectory}${sep}`),
    ),
    sourceLedger: sourceMigrationHistory,
  });
  const migrationReceipt = createMigrationReplayReceipt({
    files: migrationFiles,
    ledger: sourceMigrationHistory,
  });
  const generationId = createBaselineGenerationId();
  const baseline = await createAndActivateBaseline({
    artifactRoot: loaded.paths.artifactDirectory,
    generationId,
    records: readRecords(records),
    metadata: {
      migrationCutoff: sourceMigrationHistory.at(-1).version,
      migrationHistorySha256: migrationReceipt.historySha256,
      sanitizationPolicySha256: createHash("sha256")
        .update(policyBytes)
        .digest("hex"),
      sourceMigrationHistory,
    },
    expectedTables,
    migrationFiles,
    assets,
  });
  return {
    generationId,
    migrationCutoff: baseline.migrationCutoff,
    migrationCount: baseline.migrationCount,
    rowCount: baseline.rowCount,
    tableCount: baseline.tableCount,
  };
};
