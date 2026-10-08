import { describe, expect, it } from "vitest";
import {
  buildRuntimeManagerArguments,
  parseRuntimeInvocation,
  REHEARSAL_RUNTIME_TARGETS,
  resolveRuntimeTarget,
} from "../../../dist/src/targets/target.mjs";

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

  it("carries the exact selected config and candidate confirmation into drivers", () => {
    const arguments_ = buildRuntimeManagerArguments({
      managerPath: "/package/manage.mjs",
      action: "migrate",
      configPath: "rehearsal.alternate.config.mjs",
      confirmation: "a".repeat(64),
    });

    expect(arguments_).toEqual([
      "/package/manage.mjs",
      "migrate",
      "--config=rehearsal.alternate.config.mjs",
      `--confirm-candidates=${"a".repeat(64)}`,
    ]);
    expect(parseRuntimeInvocation(arguments_.slice(1))).toEqual({
      action: "migrate",
      configPath: "rehearsal.alternate.config.mjs",
      confirmation: "a".repeat(64),
    });
  });
});
