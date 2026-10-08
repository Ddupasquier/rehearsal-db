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

export interface DiscoveredBaselineInputs {
  records: string[];
  ledgers: string[];
  assetManifests: string[];
}

type BaselineInputKind = keyof DiscoveredBaselineInputs;

const projectRelativePath = (projectRoot: string, path: string): string =>
  relative(projectRoot, path).split(sep).join("/");

const preference: Record<BaselineInputKind, string[]> = {
  records: [
    "rehearsal/sanitized-data.ndjson",
    "rehearsal/synthetic-data.ndjson",
  ],
  ledgers: ["rehearsal/migration-ledger.json"],
  assetManifests: ["rehearsal/assets.json"],
};

const sortCandidates = (
  kind: BaselineInputKind,
  candidates: string[],
): string[] => {
  const preferred = new Map(
    preference[kind].map((path, index) => [path, index]),
  );
  return candidates.sort((left, right) => {
    const leftRank = preferred.get(left) ?? Number.POSITIVE_INFINITY;
    const rightRank = preferred.get(right) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank || left.localeCompare(right);
  });
};

const readFirstRecord = async (path: string): Promise<unknown> => {
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

const isRecord = (value: unknown): boolean =>
  Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "table" in value &&
    typeof value.table === "string" &&
    "row" in value &&
    value.row &&
    typeof value.row === "object" &&
    !Array.isArray(value.row),
  );

const isMigrationLedger = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "version" in entry &&
      typeof entry.version === "string" &&
      "name" in entry &&
      typeof entry.name === "string" &&
      "statements" in entry &&
      Array.isArray(entry.statements),
  );

const isAssetManifest = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "bucket" in entry &&
      typeof entry.bucket === "string" &&
      "objectPath" in entry &&
      typeof entry.objectPath === "string" &&
      "file" in entry &&
      typeof entry.file === "string",
  );

const collectCandidateFiles = async (
  projectRoot: string,
): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
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
}: {
  projectRoot?: string;
} = {}): Promise<DiscoveredBaselineInputs> => {
  const result: DiscoveredBaselineInputs = {
    records: [],
    ledgers: [],
    assetManifests: [],
  };
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
