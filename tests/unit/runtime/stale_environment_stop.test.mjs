import { describe, expect, it } from "vitest";
import {
  createStopStalePlan,
  stopReviewedStaleTarget,
} from "../../../dist/src/runtime/stale_environment_plan.mjs";
import {
  assertLocalDockerContext,
  DOCKER_CONTEXT_TLS_FORMAT,
} from "../../../dist/src/runtime/local_docker_context.mjs";

const root = "/tmp/synthetic-stale-stop";
const id = "a".repeat(64);
const original = {
  Id: id,
  Config: { Labels: { "com.rehearsal-db.project": "owned-test" } },
  State: {
    Running: true,
    StartedAt: "2026-10-13T09:00:00Z",
    FinishedAt: "0001-01-01T00:00:00Z",
  },
};
const metadata = (_program, args) => ({
  status: 0,
  stdout: args.includes(
    "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
  )
    ? "false"
    : args[1] === "show"
      ? "local-test"
      : JSON.stringify("unix:///tmp/stale-stop-test.sock"),
});
const engine = assertLocalDockerContext({
  runner: metadata,
  inheritedEnvironment: {},
});
const preview = () =>
  createStopStalePlan({
    projectRoot: root,
    engineIdentity: engine.identity,
    context: engine.context,
    now: new Date("2026-10-13T12:00:00Z"),
    containers: [original],
    targets: [
      {
        name: "primary",
        configPath: "rehearsal.config.mjs",
        config: {
          resources: { staleAfterSeconds: 60 },
          runtime: {
            projectId: "owned-test",
            target: "postgresql",
            displayName: "Sandbox",
          },
        },
      },
    ],
  });

describe("exact stale container stopping", () => {
  it("stops only reviewed immutable full IDs under the verified endpoint and preserves containers", async () => {
    const plan = preview();
    let stopped = false;
    const calls = [];
    const run = (program, args, _cwd, environment) => {
      if (args[0] !== "context")
        expect(environment.DOCKER_HOST).toBe(
          "unix:///tmp/stale-stop-test.sock",
        );
      return args[0] === "context"
        ? metadata(program, args)
        : {
            status: 0,
            stdout: JSON.stringify([
              { ...original, State: { ...original.State, Running: !stopped } },
            ]),
          };
    };
    await stopReviewedStaleTarget({
      projectRoot: root,
      plan,
      target: plan.targets[0],
      run,
      execute: async (options) => {
        calls.push(options);
        stopped = true;
        return {
          status: 0,
          signal: null,
          stdout: id,
          stderr: "",
          stdoutByteCount: 64,
          stderrByteCount: 0,
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "--host",
      "unix:///tmp/stale-stop-test.sock",
      "container",
      "stop",
      id,
    ]);
    expect(calls[0].env.DOCKER_CONTEXT).toBeUndefined();
    expect(calls[0].args.join(" ")).not.toMatch(/rm|prune|discard/u);
  });
  it("refuses replacement, foreign labels, changed activity, or changed engine before stop", async () => {
    const plan = preview();
    let mutations = 0;
    for (const container of [
      { ...original, Id: "b".repeat(64) },
      {
        ...original,
        Config: { Labels: { "com.rehearsal-db.project": "foreign" } },
      },
      {
        ...original,
        State: { ...original.State, StartedAt: "2026-10-13T10:00:00Z" },
      },
    ]) {
      await expect(
        stopReviewedStaleTarget({
          projectRoot: root,
          plan,
          target: plan.targets[0],
          run: (program, args) =>
            args[0] === "context"
              ? metadata(program, args)
              : { status: 0, stdout: JSON.stringify([container]) },
          execute: async () => {
            mutations++;
            throw new Error("No mutation expected");
          },
        }),
      ).rejects.toThrow();
    }
    await expect(
      stopReviewedStaleTarget({
        projectRoot: root,
        plan,
        target: plan.targets[0],
        run: (_command, args) => ({
          status: 0,
          stdout: args.includes(DOCKER_CONTEXT_TLS_FORMAT)
            ? "false"
            : JSON.stringify("unix:///tmp/different.sock"),
        }),
        execute: async () => {
          mutations++;
          throw new Error();
        },
      }),
    ).rejects.toThrow("endpoint changed");
    expect(mutations).toBe(0);
  });
  it("reports failure or immediate resume without deleting or stopping other IDs", async () => {
    const plan = preview();
    const commands = [];
    const run = (program, args) =>
      args[0] === "context"
        ? metadata(program, args)
        : { status: 0, stdout: JSON.stringify([original]) };
    await expect(
      stopReviewedStaleTarget({
        projectRoot: root,
        plan,
        target: plan.targets[0],
        run,
        execute: async (options) => {
          commands.push(options.args);
          return {
            status: 1,
            signal: null,
            stdout: "",
            stderr: "withheld",
            stdoutByteCount: 0,
            stderrByteCount: 8,
          };
        },
      }),
    ).rejects.toThrow("did not complete");
    await expect(
      stopReviewedStaleTarget({
        projectRoot: root,
        plan,
        target: plan.targets[0],
        run,
        execute: async (options) => {
          commands.push(options.args);
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutByteCount: 0,
            stderrByteCount: 0,
          };
        },
      }),
    ).rejects.toThrow("resumed");
    expect(
      commands.every((args) => args.at(-1) === id && args.includes("stop")),
    ).toBe(true);
  });
});
