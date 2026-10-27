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

it("keeps Drizzle native identities and journal order without inventing timestamp versions", () => {
  const entries = [
    {
      nativeIdentity: {
        kind: "drizzle",
        idx: 0,
        when: 1720000000000,
        tag: "z_init",
      },
      name: "z_init",
      filename: "z_init.sql",
      sha256: "a".repeat(64),
      status: "represented_by_baseline",
    },
    {
      nativeIdentity: {
        kind: "drizzle",
        idx: 1,
        when: 1720000001000,
        tag: "a_index",
      },
      name: "a_index",
      filename: "a_index.sql",
      sha256: "b".repeat(64),
      status: "candidate",
    },
  ];
  const plan = migrationReviewEntries("primary", entries);
  expect(plan.map((entry) => entry.filename)).toEqual([
    "z_init.sql",
    "a_index.sql",
  ]);
  expect(plan[1]).toMatchObject({
    id: "primary:drizzle:1:1720000001000:a_index",
    dependsOn: ["primary:drizzle:0:1720000000000:z_init"],
    required: true,
    nativeIdentity: entries[1].nativeIdentity,
  });
  for (const entry of plan) {
    expect(entry).not.toHaveProperty("version");
    expect(entry).not.toHaveProperty("timestamp");
  }
});
