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

const services = ({
  mode = "stop-after-run",
  proofError,
  readiness = null,
} = {}) => {
  const activeTopology = topology(mode);
  activeTopology.primary.config.application.readiness = readiness;
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
  it("does not send a database-only project to an application launch after run, start or reset", async () => {
    for (const command of ["run", "start", "reset"]) {
      const [handler] = createRuntimeActionHandlers(
        services({ mode: "keep-until-stop" }),
      );
      const result = await handler.handle({ ...context(), command });
      const output = result.render("normal");
      expect(output).not.toContain("rehearsal open");
      expect(output).toContain("rehearsal verify");
      if (command === "run")
        expect(output).toContain(
          "rehearsal command is complete; the database remains running",
        );
    }
  });
  it("preserves the application-open next step when a launch readiness contract is configured", async () => {
    const [handler] = createRuntimeActionHandlers(
      services({
        readiness: {
          url: "http://127.0.0.1:5173/health",
          expectedStatus: 200,
          timeoutSeconds: 5,
        },
      }),
    );
    const result = await handler.handle({ ...context(), command: "start" });
    expect(result.render("normal")).toContain("rehearsal open");
  });
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
  it("discards after an explicitly opted-in run and reports removed rather than preserved data", async () => {
    const injected = services({ mode: "discard-after-run" });
    const [handler] = createRuntimeActionHandlers(injected);
    const result = await handler.handle(context());
    expect(
      injected.runRuntimeStack.mock.calls.map(([call]) => call.command),
    ).toEqual(["run", "discard"]);
    expect(result.data.lifecycle).toMatchObject({
      runtimeState: "removed",
      dataState: "removed",
    });
    expect(result.render("normal")).toContain("data removed");
    expect(result.render("normal")).not.toContain("data preserved");
  });
  it("discards admitted runtime after a failed proof without changing the original failure", async () => {
    const failure = new Error("proof failed");
    const injected = services({
      mode: "discard-after-run",
      proofError: failure,
    });
    const [handler] = createRuntimeActionHandlers(injected);
    await expect(handler.handle(context())).rejects.toBe(failure);
    expect(
      injected.runRuntimeStack.mock.calls.map(([call]) => call.command),
    ).toEqual(["run", "discard"]);
  });
});
