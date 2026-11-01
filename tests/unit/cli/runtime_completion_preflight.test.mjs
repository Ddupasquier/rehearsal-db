import { describe, expect, it, vi } from "vitest";
vi.mock("../../../dist/src/cli/runtime_workload_admission.mjs", () => ({
  withRuntimeWorkloadAdmission: ({ execute }) => execute(),
}));
vi.mock("../../../dist/src/runtime/engines/local_docker_context.mjs", () => ({
  assertLocalDockerContext: vi.fn(() => ({
    context: "owned",
    endpoint: "unix:///synthetic/owned.sock",
    identity: "a".repeat(64),
  })),
}));
vi.mock("../../../dist/src/runtime/lifecycle/topology.mjs", () => ({
  loadRuntimeTopology: vi.fn(),
  selectRuntimeTargets: (targets) => targets,
}));
import { assertLocalDockerContext } from "../../../dist/src/runtime/engines/local_docker_context.mjs";
import { createRuntimeStackRunner } from "../../../dist/src/cli/runtime_stack_runner.mjs";
const topology = (protectedRuntime = false) => {
  const primary = {
    name: "primary",
    configPath: "/synthetic/primary.mjs",
    config: {
      lifecycle: {
        run: "discard-after-run",
        open: "discard-on-application-exit",
      },
      resources: { maximumBytes: null },
      runtime: { protected: protectedRuntime },
    },
    paths: {},
  };
  return {
    projectRoot: "/synthetic",
    primary,
    targets: [primary],
    dependents: [],
  };
};
const request = (value, command = "run") => ({
  command,
  flags: { json: true },
  planOptions: { projectRoot: "/synthetic" },
  session: { runtimeTopology: value },
});
describe("destructive completion preflight and ownership", () => {
  it.each(["run", "start"])(
    "refuses protected %s before engine or manager execution",
    async (command) => {
      vi.mocked(assertLocalDockerContext).mockClear();
      const manager = vi.fn();
      await expect(
        createRuntimeStackRunner(manager)(request(topology(true), command)),
      ).rejects.toThrow(/protected runtime/);
      expect(manager).not.toHaveBeenCalled();
      expect(assertLocalDockerContext).not.toHaveBeenCalled();
    },
  );
  it("discards only receipt-proven completed predecessors after stack failure", async () => {
    const value = topology();
    value.targets.push({
      ...value.primary,
      name: "dependent",
      configPath: "/synthetic/dependent.mjs",
    });
    const failure = new Error("dependent failed");
    const manager = vi.fn(async (options) => {
      if (options.action === "run" && options.targetName === "dependent")
        throw failure;
      return {
        action: options.action,
        target: options.targetName,
        durationMs: 1,
        output: "completed",
      };
    });
    await expect(
      createRuntimeStackRunner(manager)(request(value)),
    ).rejects.toBe(failure);
    expect(manager.mock.calls.map(([o]) => [o.action, o.targetName])).toEqual([
      ["run", "primary"],
      ["run", "dependent"],
      ["discard", "primary"],
    ]);
  });
});
