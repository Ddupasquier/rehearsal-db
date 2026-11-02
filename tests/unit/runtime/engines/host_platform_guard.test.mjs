import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  inspectHostPlatform: vi.fn(),
  loadRehearsalConfig: vi.fn(),
  loadRuntimeTopology: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../../../../dist/src/shared/host_platform.mjs", () => ({
  inspectHostPlatform: boundary.inspectHostPlatform,
}));
vi.mock(
  "../../../../dist/src/project/configuration.mjs",
  async (importOriginal) => ({
    ...(await importOriginal()),
    loadRehearsalConfig: boundary.loadRehearsalConfig,
  }),
);
vi.mock(
  "../../../../dist/src/runtime/lifecycle/topology.mjs",
  async (importOriginal) => ({
    ...(await importOriginal()),
    loadRuntimeTopology: boundary.loadRuntimeTopology,
  }),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: boundary.spawnSync,
}));

import { runRehearsalDoctor } from "../../../../dist/src/runtime/lifecycle/plan.mjs";
import { runRuntimeStackDoctor } from "../../../../dist/src/cli/runtime_planning.mjs";

describe("unsupported host doctor boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.inspectHostPlatform.mockResolvedValue({
      kind: "windows",
      supported: false,
      detail: "Native Windows runtime operations are unsupported.",
      remediation: "Use WSL2 with a Linux project filesystem.",
    });
  });

  it.each([runRehearsalDoctor, runRuntimeStackDoctor])(
    "refuses before evaluating config, topology, or child processes",
    async (runDoctor) => {
      const result = await runDoctor({ projectRoot: "/fixture/project" });
      expect(result).toMatchObject({
        state: "NOT READY",
        containerEngines: { state: "unsupported-host", selected: null },
        checks: [
          {
            id: "operating-system",
            label: "Operating-system support",
            status: "fail",
            detail: "Native Windows runtime operations are unsupported.",
            remediation: "Use WSL2 with a Linux project filesystem.",
          },
        ],
      });
      expect(boundary.loadRehearsalConfig).not.toHaveBeenCalled();
      expect(boundary.loadRuntimeTopology).not.toHaveBeenCalled();
      expect(boundary.spawnSync).not.toHaveBeenCalled();
    },
  );
});
