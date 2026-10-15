/** Human explanation of verified aggregates only, never source literals. */

import type {
  BaselineShapeEvidence,
  ShapeBucketEvidence,
} from "../source/shape_contract.mjs";

const explanations: Record<ShapeBucketEvidence["reason"], string> = {
  "within-tolerance": "within the reviewed tolerance",
  "outside-tolerance": "distribution changed more than allowed",
  "missing-required-source-class": "required class missing from the source",
  "insufficient-selected-class": "too few source representatives were selected",
  "insufficient-sanitized-class":
    "too few representatives remain after sanitization",
  "privacy-cohort": "private cohort cannot be reported safely",
};

export const renderBaselineShape = (
  shape: BaselineShapeEvidence | null | undefined,
): readonly string[] => {
  if (!shape)
    return ["Shape: not measured; no distribution-preservation claim is made."];
  return [
    "",
    "REVIEWED BASELINE SHAPE",
    `Algorithm: ${shape.algorithm} · Rehearsal ${shape.rehearsalVersion}`,
    `Row budget: ${shape.maximumRows}; source cap: ${shape.maximumSourceRows} rows / ${shape.maximumSourceBytes} bytes`,
    `Shape policy SHA-256: ${shape.policySha256}`,
    `Source snapshot SHA-256: ${shape.sourceSnapshotSha256}`,
    `Shape evidence SHA-256: ${shape.evidenceSha256}`,
    "Rows: approved source / selected source / sanitized baseline",
    ...shape.tables.map(
      (table) =>
        `  ${table.schema}.${table.table}: ${table.sourceRows} / ${table.selectedRows} / ${table.emittedRows}`,
    ),
    `Relationships: ${shape.relationships.length} reviewed relationship(s) verified after sanitization`,
    ...shape.distributions.flatMap((goal) => [
      `  ${goal.id}: ${goal.status.toUpperCase()} (${goal.required ? "required" : "advisory"}; allowed difference ${(goal.tolerance * 100).toFixed(1)} percentage points)`,
      ...goal.buckets.map(
        (bucket) =>
          `    ${bucket.bucket}: ${bucket.suppressed ? "counts hidden" : `${bucket.sourceCount} / ${bucket.selectedSourceCount} / ${bucket.baselineCount}; ${bucket.disposition}`} — ${explanations[bucket.reason]}`,
      ),
    ]),
    ...shape.warnings.map((warning) => `Warning: ${warning}`),
    "Limits: measured reviewed goals are not production equivalence.",
    ...shape.limitations.map((limitation) => `  ${limitation}`),
  ];
};
