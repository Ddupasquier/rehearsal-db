import { describe, expect, it } from "vitest";
import { migrationReviewEntries } from "../../../dist/src/runtime/migration_plan.mjs";
const migration = (version, status) => ({
  version,
  name: "change",
  filename: `${version}_change.sql`,
  sha256: "a".repeat(64),
  status,
});
describe("editor migration plan", () => {
  it("keeps exact history and target-scoped required predecessors without guessing SQL", () => {
    const result = migrationReviewEntries("publication", [
      migration("20260101000000", "represented_by_baseline"),
      migration("20260101000001", "candidate"),
      migration("20260101000002", "candidate"),
    ]);
    expect(result[0].required).toBe(false);
    expect(result[1]).toMatchObject({
      required: true,
      dependsOn: ["publication:20260101000000"],
      warnings: ["sql_safety_not_inferred"],
    });
    expect(result[2].dependsOn).toEqual(["publication:20260101000001"]);
  });
  it("accepts empty plans and bounds large histories", () => {
    expect(migrationReviewEntries("primary", [])).toEqual([]);
    expect(() =>
      migrationReviewEntries(
        "primary",
        Array.from({ length: 10001 }, () =>
          migration("20260101000000", "candidate"),
        ),
      ),
    ).toThrow("bounded");
  });
});
