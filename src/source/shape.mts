/** Public opt-in shape contract. Source credentials and raw rows are never evidence. */

export {
  validateBaselineShapePolicy,
  shapePolicySha256,
} from "./shaping/shape_policy.mjs";
export { sampleShapeGraph, shapeKeySha256 } from "./shaping/shape_sampler.mjs";
export { shapeKeyContextFromSchema } from "./shaping/shape_keys.mjs";
export type {
  ShapeKeyContext,
  ShapeSourceSchemaTable,
} from "./shaping/shape_keys.mjs";
export {
  createBaselineShapeEvidence,
  verifyBaselineShapeEvidence,
} from "./shaping/shape_evidence.mjs";
export { readVerifiedBaselineShapeEvidence } from "./shaping/shape_files.mjs";
export type {
  BaselineShapePolicy,
  BaselineShapeEvidence,
  ShapeRecord,
  ShapeDistribution,
  ShapeJointDistribution,
  ShapeGoal,
  ShapeTable,
  ShapeRelationship,
} from "./shaping/shape_contract.mjs";
