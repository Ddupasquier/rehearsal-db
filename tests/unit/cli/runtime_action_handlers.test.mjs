import { describe, expect, it, vi } from "vitest";
import { parseArguments } from "../../../dist/src/cli/arguments.mjs";
import { createCliSessionState } from "../../../dist/src/cli/command_contract.mjs";
import { createRuntimeActionHandlers } from "../../../dist/src/cli/runtime_action_handlers.mjs";

const topology = (mode = "stop-after-run") => {
  const primary = {
    name: "primary",
    primary: true,
    paths: { applicationEnvironment: "/tmp/runtime.env" },
    config: {
      lifecycle: { run: mode, open: "keep-until-stop" },
      application: {
        startCommand: "npm run dev",
        proofCommand: "npm test",
        environmentVariables: {},
        readiness: null,
        httpProofs: [],
      },
    },
  };
  return {
    projectRoot: "/tmp/rehearsal-runtime-handler",
    primary,
    dependents: [],
    targets: [primary],
  };
};

const context = () => ({
  command: "run",
  flags: parseArguments(["--plain"]).flags,
  planOptions: { projectRoot: "/tmp/rehearsal-runtime-handler" },
  guided: false,
  state: createCliSessionState(),
});

const services = ({ mode = "stop-after-run", proofError } = {}) => {
  const activeTopology = topology(mode);
  const runRuntimeStack = vi.fn(async ({ command }) => ({
    topology: activeTopology,
    runtime: {
      action: command,
      durationMs: 1,
      output: `${command} complete`,
    },
  }));
  return {
    prepareCandidateConfirmation: vi.fn(async () => true),
    prepareDependentTargets: vi.fn(async () => []),
    proveRuntimeStack: vi.fn(async () => {
      if (proofError) throw proofError;
      return {
        applicationProof: { command: "npm test", output: "passed" },
        dependentProofs: [],
      };
    }),
    runRuntimeStack,
  };
};

describe("runtime action lifecycle policy", () => {
  it("stops after a successful run and reports preserved data", async () => {
    const injected = services();
    const [handler] = createRuntimeActionHandlers(injected);
    const result = await handler.handle(context());

    expect(
      injected.runRuntimeStack.mock.calls.map(([call]) => call.command),
    ).toEqual(["run", "stop"]);
    expect(result.data.lifecycle).toMatchObject({
      mode: "stop-after-run",
      runtimeState: "stopped",
      dataState: "preserved",
    });
    expect(result.render("normal")).toContain(
      "runtime was stopped with its database and Storage changes preserved",
    );
  });

  it("stops the runtime when a project proof fails", async () => {
    const failure = new Error("proof failed");
    const injected = services({ proofError: failure });
    const [handler] = createRuntimeActionHandlers(injected);

    await expect(handler.handle(context())).rejects.toBe(failure);
    expect(
      injected.runRuntimeStack.mock.calls.map(([call]) => call.command),
    ).toEqual(["run", "stop"]);
  });

  it("preserves the compatibility default until an explicit stop", async () => {
    const injected = services({ mode: "keep-until-stop" });
    const [handler] = createRuntimeActionHandlers(injected);
    const result = await handler.handle(context());

    expect(injected.runRuntimeStack).toHaveBeenCalledOnce();
    expect(result.data.lifecycle.runtimeState).toBe("running");
  });
});
