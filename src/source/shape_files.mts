/** Bounded JSON reads for reviewed shape declarations and immutable evidence. */

import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { BaselineManifest } from "../baseline/artifact.mjs";
import { resolveActiveBaselinePaths } from "../baseline/artifact.mjs";
import { verifyBaselineShapeEvidence } from "./shape_evidence.mjs";
import type { BaselineShapeEvidence } from "./shape_contract.mjs";
import { readBoundedShapeJson } from "./shape_json.mjs";
export { readBoundedShapeJson } from "./shape_json.mjs";

/** The caller first verifies the baseline; this verifies its optional shape receipt. */
export const readVerifiedBaselineShapeEvidence = async ({
  baseline,
  artifactRoot,
}: {
  readonly baseline: BaselineManifest;
  readonly artifactRoot: string;
}): Promise<BaselineShapeEvidence | null> => {
  const receipt = baseline.files["shape-evidence.json"];
  if (!receipt) return null;
  const paths = await resolveActiveBaselinePaths({ artifactRoot });
  if (basename(paths.generationDirectory) !== baseline.generationId) {
    throw new Error("Shape inspection encountered a changed active baseline.");
  }
  const { bytes, value } = await readBoundedShapeJson(
    join(paths.generationDirectory, "shape-evidence.json"),
    { root: paths.artifactRoot },
  );
  if (
    bytes.length !== receipt.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== receipt.sha256
  ) {
    throw new Error(
      "Shape evidence file does not match its immutable baseline receipt.",
    );
  }
  return verifyBaselineShapeEvidence(value, {
    generationId: baseline.generationId,
    baselineDataSha256: baseline.files["sanitized-data.ndjson"]!.sha256,
    privacyPolicySha256: baseline.sanitizationPolicySha256,
    ...(typeof baseline.sourceSchemaSha256 === "string"
      ? { sourceSchemaSha256: baseline.sourceSchemaSha256 }
      : {}),
  });
};
