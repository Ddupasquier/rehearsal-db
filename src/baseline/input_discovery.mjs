/**
 * Discover likely project-owned baseline inputs without exposing their values.
 * Discovery is bounded, ignores generated/private directories, and only sniffs
 * small JSON or NDJSON files before returning project-relative paths.
 */

import { open, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".rehearsal",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const maximumDepth = 4;
const maximumFiles = 2_000;
const maximumJsonBytes = 2 * 1024 * 1024;
const maximumNdjsonProbeBytes = 64 * 1024;

const projectRelativePath = (projectRoot, path) =>
  relative(projectRoot, path).split(sep).join("/");

const preference = {
  records: [
    "rehearsal/sanitized-data.ndjson",
    "rehearsal/synthetic-data.ndjson",
  ],
  ledgers: ["rehearsal/migration-ledger.json"],
  assetManifests: ["rehearsal/assets.json"],
};

const sortCandidates = (kind, candidates) => {
  const preferred = new Map(
    preference[kind].map((path, index) => [path, index]),
  );
  return candidates.sort((left, right) => {
    const leftRank = preferred.get(left) ?? Number.POSITIVE_INFINITY;
    const rightRank = preferred.get(right) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank || left.localeCompare(right);
  });
};

const readFirstRecord = async (path) => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximumNdjsonProbeBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const probe = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = probe.split(/\r?\n/u);
    for (const line of lines) {
      if (!line.trim()) continue;
      return JSON.parse(line);
    }
  } finally {
    await handle.close();
  }
  return undefined;
};

const isRecord = (value) =>
  Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.table === "string" &&
    value.row &&
    typeof value.row === "object" &&
    !Array.isArray(value.row),
  );

const isMigrationLedger = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.version === "string" &&
      typeof entry.name === "string" &&
      Array.isArray(entry.statements),
  );

const isAssetManifest = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.bucket === "string" &&
      typeof entry.objectPath === "string" &&
      typeof entry.file === "string",
  );

const collectCandidateFiles = async (projectRoot) => {
  const files = [];
  const visit = async (directory, depth) => {
    if (depth > maximumDepth || files.length >= maximumFiles) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maximumFiles) return;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || ![".json", ".ndjson"].includes(extname(path))) {
        continue;
      }
      files.push(path);
    }
  };
  await visit(projectRoot, 0);
  return files;
};

export const discoverBaselineInputFiles = async ({
  projectRoot = process.cwd(),
} = {}) => {
  const result = { records: [], ledgers: [], assetManifests: [] };
  for (const path of await collectCandidateFiles(projectRoot)) {
    const pathStats = await stat(path).catch(() => undefined);
    if (!pathStats?.isFile()) continue;
    const relativePath = projectRelativePath(projectRoot, path);
    try {
      if (extname(path) === ".ndjson") {
        if (isRecord(await readFirstRecord(path))) {
          result.records.push(relativePath);
        }
        continue;
      }
      if (pathStats.size > maximumJsonBytes) continue;
      const value = JSON.parse(await readFile(path, "utf8"));
      if (isMigrationLedger(value)) result.ledgers.push(relativePath);
      else if (isAssetManifest(value)) result.assetManifests.push(relativePath);
    } catch {
      // Invalid or unreadable files are not candidates; explicit validation will
      // provide actionable errors if the user enters one manually.
    }
  }
  return {
    records: sortCandidates("records", result.records),
    ledgers: sortCandidates("ledgers", result.ledgers),
    assetManifests: sortCandidates("assetManifests", result.assetManifests),
  };
};
