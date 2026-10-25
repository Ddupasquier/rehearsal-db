import { afterEach, describe, expect, it, vi } from "vitest";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("../../../dist/src/runtime/engine_discovery.mjs", () => ({
  inspectContainerEngineOptions: inspect,
}));
import { probeContainerEngineWithoutStarting } from "../../../dist/src/project/project_discovery_metadata.mjs";

afterEach(() => inspect.mockReset());

describe("legacy discovery reachability contract", () => {
  it.each([
    ["ready", "running"],
    ["unavailable", "unavailable"],
    ["selection-required", "stopped"],
    ["unsupported-host", "stopped"],
  ])(
    "maps %s without mistaking an unresolved selection for a running engine",
    async (state, expected) => {
      inspect.mockResolvedValue({ state });
      expect(await probeContainerEngineWithoutStarting()).toBe(expected);
      expect(inspect).toHaveBeenCalledTimes(1);
    },
  );
});
