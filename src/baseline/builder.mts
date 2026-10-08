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
} from "./artifact.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import {
  buildMigrationLedgerInventory,
  createMigrationReplayReceipt,
  readMigrationSourceBundle,
} from "../runtime/migration_history.mjs";
import { validateRuntimeSanitizationPolicy } from "./sanitization_policy.mjs";

interface SyntheticBaselineOptions {
  readonly projectRoot?: string;
  readonly configPath?: string;
  readonly recordsPath: string;
  readonly ledgerPath: string;
  readonly assetsPath?: string;
}

interface SyntheticAssetInput {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType?: string;
  readonly file: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseAssets = (value: unknown): SyntheticAssetInput[] => {
  if (!Array.isArray(value)) {
    throw new Error("Synthetic assets manifest must be an array.");
  }
  return value.map((entry, index) => {
    if (
      !isObject(entry) ||
      typeof entry.bucket !== "string" ||
      typeof entry.objectPath !== "string" ||
      typeof entry.file !== "string" ||
      (entry.contentType !== undefined && typeof entry.contentType !== "string")
    ) {
      throw new Error(`Synthetic asset ${index} has an invalid shape.`);
    }
    return {
      bucket: entry.bucket,
      objectPath: entry.objectPath,
      file: entry.file,
      ...(entry.contentType === undefined
        ? {}
        : { contentType: entry.contentType }),
    };
  });
};

const resolveProjectInput = (
  projectRoot: string,
  value: string,
  label: string,
): string => {
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

const readRecords = async function* (path: string): AsyncGenerator<unknown> {
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
}: SyntheticBaselineOptions) => {
  const loaded = await loadRehearsalConfig({
    projectRoot,
    ...(configPath === undefined ? {} : { configPath }),
  });
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
        parseAssets(
          JSON.parse(
            await readFile(
              resolveProjectInput(
                loaded.projectRoot,
                assetsPath,
                "Synthetic assets manifest path",
              ),
              "utf8",
            ),
          ),
        ).map(async (asset) => ({
          bucket: asset.bucket,
          objectPath: asset.objectPath,
          ...(asset.contentType === undefined
            ? {}
            : { contentType: asset.contentType }),
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
  const policy = validateRuntimeSanitizationPolicy(
    JSON.parse(policyBytes.toString("utf8")),
  );
  const expectedTables = policy.tables
    .filter((table) => table.sourceRows !== "EXCLUDE")
    .map((table) =>
      (table.schema ?? "public") === "public"
        ? table.name
        : `${table.schema}.${table.name}`,
    );
  if (expectedTables.length === 0) {
    throw new Error("The sanitization policy includes no restorable tables.");
  }
  const sourceMigrationHistory = buildMigrationLedgerInventory(
    JSON.parse(ledgerBytes.toString("utf8")),
    "Synthetic migration ledger",
  );
  const migrationCutoff = sourceMigrationHistory.at(-1);
  if (migrationCutoff === undefined) {
    throw new Error("The synthetic migration ledger is empty.");
  }
  if (policy.migrationCutoff !== migrationCutoff.version) {
    throw new Error(
      `The sanitization policy cutoff ${policy.migrationCutoff} does not match migration ledger cutoff ${migrationCutoff.version}.`,
    );
  }
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
      migrationCutoff: migrationCutoff.version,
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
    migrationCount: Object.keys(baseline.migrations).length,
    rowCount: baseline.rowCount,
    tableCount: Object.keys(baseline.tableCounts).length,
  };
};
