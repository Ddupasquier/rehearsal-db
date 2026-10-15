/** Public opt-in shape contract. Source credentials and raw rows are never evidence. */

export {
  validateBaselineShapePolicy,
  shapePolicySha256,
} from "./shape_policy.mjs";
export { sampleShapeGraph, shapeKeySha256 } from "./shape_sampler.mjs";
export { shapeKeyContextFromSchema } from "./shape_keys.mjs";
export type { ShapeKeyContext, ShapeSourceSchemaTable } from "./shape_keys.mjs";
export {
  createBaselineShapeEvidence,
  verifyBaselineShapeEvidence,
} from "./shape_evidence.mjs";
export { readVerifiedBaselineShapeEvidence } from "./shape_files.mjs";
export type {
  BaselineShapePolicy,
  BaselineShapeEvidence,
  ShapeRecord,
  ShapeDistribution,
  ShapeJointDistribution,
  ShapeGoal,
  ShapeTable,
  ShapeRelationship,
} from "./shape_contract.mjs";
