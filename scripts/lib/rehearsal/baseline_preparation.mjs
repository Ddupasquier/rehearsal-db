/**
 * Purpose: Inspect explicit local synthetic records and migration evidence, then
 * create a fail-closed sanitization-policy draft for human review.
 */

import { createReadStream } from "node:fs";
import { access, mkdir, open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadRehearsalConfig } from "./configuration.mjs";
import { buildMigrationLedgerInventory } from "./migration_history.mjs";

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;

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
    const table = tables.get(record.table) ?? {
      name: record.table,
      rowCount: 0,
      columns: new Set(),
    };
    table.rowCount += 1;
    for (const column of columns) table.columns.add(column);
    tables.set(record.table, table);
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
        name: table.name,
        rowCount: table.rowCount,
        columns: [...table.columns].sort(),
      })),
  };
};

const renderPolicyDraft = ({ migrationCutoff, tables }) =>
  `${JSON.stringify(
    {
      policyVersion: 1,
      draft: true,
      migrationCutoff,
      tables: tables.map((table) => ({
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
  const [inspection, ledgerRows] = await Promise.all([
    inspectSyntheticRecords(records),
    readFile(ledger, "utf8").then(JSON.parse),
  ]);
  const migrationHistory = buildMigrationLedgerInventory(
    ledgerRows,
    "Synthetic migration ledger",
  );
  const destination = loaded.paths.sanitizationPolicy;
  if (await pathExists(destination)) {
    throw new Error(
      `Rehearsal baseline preparation will not overwrite ${relative(loaded.projectRoot, destination)}.`,
    );
  }
  const migrationCutoff = migrationHistory.at(-1).version;
  return {
    projectRoot: loaded.projectRoot,
    destination,
    destinationRelative: relative(loaded.projectRoot, destination),
    recordsPath: relative(loaded.projectRoot, records),
    ledgerPath: relative(loaded.projectRoot, ledger),
    migrationCutoff,
    migrationCount: migrationHistory.length,
    rowCount: inspection.rowCount,
    tables: inspection.tables,
    content: renderPolicyDraft({
      migrationCutoff,
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
