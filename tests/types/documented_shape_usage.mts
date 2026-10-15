import {
  validateBaselineShapePolicy,
  type BaselineShapePolicy,
  type BaselineShapeEvidence,
} from "@rehearsal-db/core/shape";

export const shape: BaselineShapePolicy = validateBaselineShapePolicy({
  shapeVersion: 1,
  seed: "synthetic-widgets-v1",
  maximumRows: 100,
  tables: [{ name: "widgets", key: ["id"], maximumRows: 100, rootRows: 100 }],
});

export const hasMeasuredGoals = (evidence: BaselineShapeEvidence): boolean =>
  evidence.distributions.length > 0;
