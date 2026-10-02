import { describe, expect, it } from "vitest";
import {
  REHEARSAL_RUNTIME_TARGETS,
  resolveRuntimeTarget,
} from "../../scripts/lib/runtime/runtime_target.mjs";

describe("Rehearsal runtime target", () => {
  it("keeps existing configurations on the Supabase driver", () => {
    expect(resolveRuntimeTarget()).toEqual({
      id: "supabase",
      label: "Supabase",
    });
    expect(REHEARSAL_RUNTIME_TARGETS).toEqual(["supabase", "postgresql"]);
  });

  it("fails closed instead of loading an unknown driver", () => {
    expect(resolveRuntimeTarget("postgresql")).toEqual({
      id: "postgresql",
      label: "PostgreSQL",
    });
    expect(() => resolveRuntimeTarget("mysql")).toThrow(
      "Unsupported Rehearsal runtime target: mysql",
    );
  });
});
