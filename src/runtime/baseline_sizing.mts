/** Verified sizing evidence, not automatic row sampling or a performance promise. */
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readBoundedShapeJson } from "../source/shape_json.mjs";
import { basename, join } from "node:path";
import {
  loadRehearsalConfig,
  type RehearsalConfigPathOptions,
} from "../project/configuration.mjs";
import {
  verifyActiveBaseline,
  resolveActiveBaselinePaths,
} from "../baseline/artifact.mjs";
import type { BaselineShapeEvidence } from "../source/shape_contract.mjs";
export const inspectBaselineSizing = async (
  options: RehearsalConfigPathOptions = {},
) => {
  const loaded = await loadRehearsalConfig(options);
  const artifactRoot = loaded.paths.artifactDirectory;
  const baseline = await verifyActiveBaseline({ artifactRoot });
  const paths = await resolveActiveBaselinePaths({ artifactRoot });
  if (basename(paths.generationDirectory) !== baseline.generationId)
    throw new Error(
      "The active baseline changed during sizing review; inspect the current generation again.",
    );
  const bytes = (await lstat(paths.dataPath)).size;
  let shape: BaselineShapeEvidence | null = null;
  if (baseline.files["shape-evidence.json"]) {
    const evidence = await readBoundedShapeJson(
      join(paths.generationDirectory, "shape-evidence.json"),
      { root: artifactRoot },
    );
    if (
      createHash("sha256").update(evidence.bytes).digest("hex") !==
      baseline.files["shape-evidence.json"]!.sha256
    )
      throw new Error("Baseline shape evidence changed during sizing review.");
    shape = evidence.value as unknown as BaselineShapeEvidence;
  }
  const sourceRows = shape
    ? shape.tables.reduce((total, table) => total + table.sourceRows, 0)
    : null;
  return Object.freeze({
    schemaVersion: 1 as const,
    generationId: baseline.generationId,
    dataSha256: baseline.files["sanitized-data.ndjson"]!.sha256,
    sanitizationPolicySha256: baseline.sanitizationPolicySha256,
    baselineRows: baseline.rowCount,
    baselineBytes: bytes,
    tables: Object.entries(baseline.tableCounts).map(([table, rows]) => ({
      table,
      rows,
    })),
    selection: shape ? "reviewed-bounded-shape" : "complete-sanitized-input",
    sourceRows,
    selectedRows: shape
      ? shape.tables.reduce((total, table) => total + table.selectedRows, 0)
      : null,
    sourceSchemaSha256: shape?.sourceSchemaSha256 ?? null,
    sourceSnapshotSha256: shape?.sourceSnapshotSha256 ?? null,
    shapePolicySha256: shape?.policySha256 ?? null,
    relationshipsChecked: shape?.relationships.length ?? null,
    requiredGoals:
      shape?.distributions.filter((goal) => goal.required).length ?? null,
    incompleteRequiredGoals:
      shape?.distributions.filter(
        (goal) => goal.required && goal.status !== "passed",
      ).length ?? null,
    copyCache: loaded.config.resources.restoreCache?.enabled
      ? "opt-in"
      : "disabled",
    limits: [
      "No rows are removed or resampled by inspection or COPY cache reuse.",
      "Size reduction is not a memory, speed or equivalent-fidelity guarantee.",
      "Review required keys, foreign-key closure, distributions and failure rows in the existing shape policy before selecting a smaller baseline.",
      "A verified immutable baseline is rechecked on every restore; stale source or privacy-policy binding refuses reuse.",
    ],
  });
};
