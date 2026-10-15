import { describe, expect, it } from "vitest";
import {
  validateBaselineShapePolicy,
  shapePolicySha256,
} from "../../../dist/src/source/shape.mjs";

const mixed = () => ({
  shapeVersion: 1,
  seed: "normalized-mixed-v1",
  maximumRows: 100,
  tables: [
    { name: "parents", key: ["id"], maximumRows: 50, rootRows: 10 },
    { name: "children", key: ["id"], maximumRows: 50 },
  ],
  relationships: [
    {
      id: "parent_child",
      parent: { table: "parents", columns: ["id"] },
      child: { table: "children", columns: ["parent_id"] },
      nullable: true,
      includeChildren: true,
      maximumChildrenPerParent: 5,
      maximumRows: 50,
    },
  ],
  distributions: [
    ...[
      "null",
      "boolean",
      "number",
      "timestamp",
      "string-length",
      "array-length",
      "empty",
      "number-extrema",
      "timestamp-extrema",
      "string-length-extrema",
      "array-length-extrema",
    ].map((kind, index) => ({
      id: `goal_${index}`,
      table: "parents",
      column: "value",
      kind,
      required: false,
      tolerance: 0.1,
    })),
    {
      id: "category",
      table: "parents",
      column: "status",
      kind: "enum",
      values: ["active", "draft"],
      includeOther: true,
      required: false,
      tolerance: 0.1,
      requiredBuckets: ["category-0"],
    },
    {
      id: "fanout",
      table: "parents",
      kind: "relationship-fanout",
      relationship: "parent_child",
      required: false,
      tolerance: 0.1,
    },
  ],
  jointDistributions: [
    {
      id: "joint",
      table: "parents",
      goals: ["category", "fanout"],
      required: false,
      tolerance: 0.1,
      requiredBuckets: ["joint-0"],
    },
  ],
});

describe("shape policy normalized roundtrip", () => {
  it("revalidates every normalized kind, default, optional null and computed joint count idempotently", () => {
    const first = validateBaselineShapePolicy(mixed());
    const second = validateBaselineShapePolicy(first);
    const third = validateBaselineShapePolicy(
      JSON.parse(JSON.stringify(second)),
    );
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(shapePolicySha256(third)).toBe(shapePolicySha256(first));
  });
  it("does not accept meaningful enum/fan-out fields on other kinds or forged computed joint metadata", () => {
    const normalized = validateBaselineShapePolicy(mixed());
    for (const changed of [
      { ...normalized.distributions[0], values: ["active"] },
      { ...normalized.distributions[0], includeOther: true },
      { ...normalized.distributions[0], relationship: "parent_child" },
      { ...normalized.distributions[0], kind: "unknown" },
    ])
      expect(() =>
        validateBaselineShapePolicy({
          ...normalized,
          distributions: [changed],
          jointDistributions: [],
        }),
      ).toThrow();
    expect(() =>
      validateBaselineShapePolicy({
        ...normalized,
        jointDistributions: [
          { ...normalized.jointDistributions[0], bucketCount: 1 },
        ],
      }),
    ).toThrow("contradicts");
    expect(() =>
      validateBaselineShapePolicy({
        ...normalized,
        distributions: [{ ...normalized.distributions.at(-1), column: "id" }],
        jointDistributions: [],
      }),
    ).toThrow("not a column");
  });
});
