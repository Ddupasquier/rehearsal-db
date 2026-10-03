/**
 * Purpose: Inspect explicit local synthetic records and migration evidence, then
 * create a fail-closed sanitization-policy draft for human review.
 */

import { createReadStream } from "node:fs";
import { access, lstat, mkdir, open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { buildMigrationLedgerInventory } from "../runtime/migration_history.mjs";

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const storageBucketPattern = /^[a-z0-9][a-z0-9.-]{0,99}$/u;

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

const pathExists = (path) =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });

const assertRegularInput = async (path, label) => {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist.`);
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular project-local file.`);
  }
};

const inspectSyntheticRecords = async (path) => {
  const tables = new Map();
  let rowCount = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error("Synthetic baseline input contains invalid NDJSON.", {
        cause: error,
      });
    }
    if (
      !record ||
      !identifierPattern.test(record.schema ?? "public") ||
      !identifierPattern.test(record.table ?? "") ||
      !record.row ||
      typeof record.row !== "object" ||
      Array.isArray(record.row)
    ) {
      throw new Error("A synthetic baseline record has an invalid shape.");
    }
    const columns = Object.keys(record.row);
    if (
      columns.length === 0 ||
      columns.some((column) => !identifierPattern.test(column))
    ) {
      throw new Error(
        `Synthetic baseline table ${record.table} has invalid or empty columns.`,
      );
    }
    const schema = record.schema ?? "public";
    const key =
      schema === "public" ? record.table : `${schema}.${record.table}`;
    const table = tables.get(key) ?? {
      schema,
      name: record.table,
      rowCount: 0,
      columns: new Set(),
    };
    table.rowCount += 1;
    for (const column of columns) table.columns.add(column);
    tables.set(key, table);
    rowCount += 1;
  }
  if (rowCount === 0) {
    throw new Error("Synthetic baseline input contains no records.");
  }
  return {
    rowCount,
    tables: [...tables.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((table) => ({
        schema: table.schema,
        name: table.name,
        rowCount: table.rowCount,
        columns: [...table.columns].sort(),
      })),
  };
};

const inspectAssetManifest = async (path, projectRoot) => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("Storage asset manifest contains invalid JSON.", {
      cause: error,
    });
  }
  if (!Array.isArray(manifest)) {
    throw new Error("Storage asset manifest must be a JSON array.");
  }
  const destinations = new Set();
  for (const [index, asset] of manifest.entries()) {
    if (
      !asset ||
      typeof asset !== "object" ||
      Array.isArray(asset) ||
      !storageBucketPattern.test(asset.bucket ?? "") ||
      typeof asset.objectPath !== "string" ||
      !asset.objectPath ||
      asset.objectPath
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..") ||
      typeof asset.file !== "string" ||
      !asset.file.trim() ||
      (asset.contentType !== undefined && typeof asset.contentType !== "string")
    ) {
      throw new Error(
        `Storage asset manifest entry ${index + 1} has an invalid shape.`,
      );
    }
    const destination = `${asset.bucket}/${asset.objectPath}`;
    if (destinations.has(destination)) {
      throw new Error(`Duplicate Storage asset destination: ${destination}.`);
    }
    destinations.add(destination);
    const assetFile = resolveProjectInput(
      projectRoot,
      asset.file,
      `Storage asset file in entry ${index + 1}`,
    );
    await assertRegularInput(
      assetFile,
      `Storage asset file in entry ${index + 1}`,
    );
  }
  return { assetCount: manifest.length };
};

export const inspectBaselineInputFiles = async ({
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
  const assets = assetsPath
    ? resolveProjectInput(
        loaded.projectRoot,
        assetsPath,
        "Storage asset manifest path",
      )
    : undefined;
  await Promise.all([
    assertRegularInput(records, "Synthetic records path"),
    assertRegularInput(ledger, "Migration ledger path"),
    ...(assets
      ? [assertRegularInput(assets, "Storage asset manifest path")]
      : []),
  ]);
  let ledgerRows;
  try {
    ledgerRows = JSON.parse(await readFile(ledger, "utf8"));
  } catch (error) {
    throw new Error("Migration ledger contains invalid JSON.", {
      cause: error,
    });
  }
  const [inspection, assetInspection] = await Promise.all([
    inspectSyntheticRecords(records),
    assets
      ? inspectAssetManifest(assets, loaded.projectRoot)
      : Promise.resolve({ assetCount: 0 }),
  ]);
  const migrationHistory = buildMigrationLedgerInventory(
    ledgerRows,
    "Synthetic migration ledger",
  );
  return {
    projectRoot: loaded.projectRoot,
    recordsPath: relative(loaded.projectRoot, records),
    ledgerPath: relative(loaded.projectRoot, ledger),
    assetsPath: assets ? relative(loaded.projectRoot, assets) : undefined,
    migrationHistory,
    migrationCutoff: migrationHistory.at(-1).version,
    migrationCount: migrationHistory.length,
    rowCount: inspection.rowCount,
    tables: inspection.tables,
    assetCount: assetInspection.assetCount,
  };
};

const renderPolicyDraft = ({ migrationCutoff, tables }) =>
  `${JSON.stringify(
    {
      policyVersion: 1,
      draft: true,
      migrationCutoff,
      tables: tables.map((table) => ({
        ...(table.schema === "public" ? {} : { schema: table.schema }),
        name: table.name,
        group: "synthetic",
        sourceRows: "STREAM AND SANITIZE",
        columns: table.columns.map((name) => ({
          name,
          action: "REVIEW REQUIRED",
          generated: "REVIEW REQUIRED",
          identity: "REVIEW REQUIRED",
          foreignKey: "REVIEW REQUIRED",
        })),
      })),
    },
    null,
    2,
  )}\n`;

export const planBaselinePreparation = async ({
  projectRoot = process.cwd(),
  configPath,
  recordsPath,
  ledgerPath,
}) => {
  const loaded = await loadRehearsalConfig({ projectRoot, configPath });
  const inspection = await inspectBaselineInputFiles({
    projectRoot: loaded.projectRoot,
    configPath,
    recordsPath,
    ledgerPath,
  });
  const destination = loaded.paths.sanitizationPolicy;
  if (await pathExists(destination)) {
    throw new Error(
      `Rehearsal baseline preparation will not overwrite ${relative(loaded.projectRoot, destination)}.`,
    );
  }
  return {
    projectRoot: loaded.projectRoot,
    destination,
    destinationRelative: relative(loaded.projectRoot, destination),
    recordsPath: inspection.recordsPath,
    ledgerPath: inspection.ledgerPath,
    migrationCutoff: inspection.migrationCutoff,
    migrationCount: inspection.migrationCount,
    rowCount: inspection.rowCount,
    tables: inspection.tables,
    content: renderPolicyDraft({
      migrationCutoff: inspection.migrationCutoff,
      tables: inspection.tables,
    }),
  };
};

export const applyBaselinePreparation = async (plan) => {
  if (await pathExists(plan.destination)) {
    throw new Error(
      `Rehearsal baseline preparation will not overwrite ${plan.destinationRelative}.`,
    );
  }
  await mkdir(dirname(plan.destination), { recursive: true, mode: 0o700 });
  const handle = await open(plan.destination, "wx", 0o600);
  try {
    await handle.writeFile(plan.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const summarizeBaselinePreparation = (plan, { mode }) => ({
  mode,
  destination: plan.destinationRelative,
  recordsPath: plan.recordsPath,
  ledgerPath: plan.ledgerPath,
  migrationCutoff: plan.migrationCutoff,
  migrationCount: plan.migrationCount,
  rowCount: plan.rowCount,
  tables: plan.tables,
  nextAction:
    mode === "written"
      ? `Review every REVIEW REQUIRED decision in ${plan.destinationRelative}, remove draft only after review, then create the baseline.`
      : "Review this schema-only summary, then rerun with --write to create the draft.",
});
