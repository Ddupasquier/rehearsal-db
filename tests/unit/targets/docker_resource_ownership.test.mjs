import { describe, expect, it } from "vitest";
import {
  assertDockerResourceLabels,
  assertOwnedSupabaseResourceInspection,
} from "../../../dist/src/targets/docker_resource_ownership.mjs";

describe("Docker resource ownership labels", () => {
  it("accepts only the exact expected provider/project ownership", () => {
    expect(() =>
      assertDockerResourceLabels({
        labels: {
          "com.supabase.cli.project": "safe",
          "unrelated.label": "value",
        },
        expectedLabel: "com.supabase.cli.project",
        projectId: "safe",
      }),
    ).not.toThrow();
    for (const labels of [
      null,
      [],
      {},
      { "com.supabase.cli.project": "foreign" },
      {
        "com.supabase.cli.project": "safe",
        "com.rehearsal-db.project": "foreign",
      },
    ]) {
      expect(() =>
        assertDockerResourceLabels({
          labels,
          expectedLabel: "com.supabase.cli.project",
          projectId: "safe",
        }),
      ).toThrow("ownership");
    }
  });
  it("refuses missing, truncated, malformed and conflicting inspection before mutation", () => {
    const output = JSON.stringify({ "com.supabase.cli.project": "safe" });
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output: `${output}\n${output}\n`,
        count: 2,
        projectId: "safe",
      }),
    ).not.toThrow();
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output,
        count: 2,
        projectId: "safe",
      }),
    ).toThrow("incomplete");
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output: "not-json",
        count: 1,
        projectId: "safe",
      }),
    ).toThrow("malformed");
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output: JSON.stringify({
          "com.supabase.cli.project": "safe",
          "com.rehearsal-db.project": "foreign",
        }),
        count: 1,
        projectId: "safe",
      }),
    ).toThrow("conflicting");
  });
});
