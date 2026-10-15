import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  parseStartupContainers,
  captureRuntimeStartupOwnership,
  selectNewStartupWorkloads,
  withRuntimeStartupCleanup,
} from "../../../dist/src/runtime/runtime_startup_ownership.mjs";
import {
  getOperationCancellationSignal,
  runWithOperationCancellation,
  throwIfOperationCancelled,
} from "../../../dist/src/shared/cancellation.mjs";

const ownerId = "e".repeat(64);
const engine = {
  context: "local-test",
  identity: "f".repeat(64),
  endpoint: "unix:///tmp/rehearsal-owned-startup-test.sock",
};
const config = {
  runtime: { projectId: "fixture-rehearsal", target: "supabase" },
  lifecycle: { run: "stop-after-run" },
};
const firstTime = "2026-10-13T00:00:00.000000000Z";
const nextTime = "2026-10-13T00:01:00.000000000Z";
const container = (
  id,
  name,
  running,
  startedAt = nextTime,
  labels = { "com.supabase.cli.project": "fixture-rehearsal" },
) => ({ id: id.repeat(64), name, running, startedAt, labels });
const lines = (items) =>
  items
    .map((item) =>
      [
        item.id,
        `/${item.name}`,
        item.running,
        item.startedAt ?? "0001-01-01T00:00:00Z",
        item.labels,
      ]
        .map(JSON.stringify)
        .join("\t"),
    )
    .join("\n");
const fixture = ({
  before = [],
  after = [],
  task = async () => {
    throw new Error("health timeout");
  },
  ...overrides
} = {}) => {
  let listCalls = 0;
  let current = before;
  const commands = [];
  const executeStop = vi.fn(async ({ args }) => {
    commands.push(args);
    const ids = args.slice(args.indexOf("5") + 1);
    current = current.map((item) =>
      ids.includes(item.id) ? { ...item, running: false } : item,
    );
    return { status: 0, stdout: "", stderr: "" };
  });
  const run = vi.fn((_program, args) => {
    commands.push(args);
    if (args.includes("ls")) {
      current = ++listCalls === 1 ? before : after;
      return { status: 0, stdout: current.map((item) => item.id).join("\n") };
    }
    const selectedIds = args.slice(args.indexOf("--format") + 2);
    return {
      status: 0,
      stdout: lines(current.filter((item) => selectedIds.includes(item.id))),
    };
  });
  return {
    executeStop,
    commands,
    run,
    options: {
      projectRoot: "/synthetic/project",
      configPath: "/synthetic/project/rehearsal.config.mjs",
      config,
      action: "start",
      ownerOperationId: ownerId,
      task: async () => {
        captureRuntimeStartupOwnership();
        return task();
      },
      run,
      executeStop,
      inspectEngine: () => engine,
      loadConfiguration: async () => ({ config }),
      inspectOwner: async () => ({
        state: "busy",
        operation: { progress: { operationId: ownerId } },
      }),
      ...overrides,
    },
  };
};

describe("exact failed-start workload cleanup", () => {
  it("preserves originally running workloads while stopping only a new owned service", async () => {
    const running = container("a", "database", true, firstTime);
    const newer = container("b", "auth", true);
    const injected = fixture({ before: [running], after: [running, newer] });
    await expect(withRuntimeStartupCleanup(injected.options)).rejects.toThrow(
      "health timeout",
    );
    expect(injected.executeStop).toHaveBeenCalledOnce();
    expect(injected.executeStop.mock.calls[0][0].args).toEqual([
      "--host",
      engine.endpoint,
      "container",
      "stop",
      "--time",
      "5",
      newer.id,
    ]);
    expect(JSON.stringify(injected.commands)).not.toMatch(
      /prune|volume|remove/u,
    );
  });

  it("stops a previously stopped container only after a distinct proven startup", async () => {
    const old = container("a", "database", false, firstTime);
    const active = { ...old, running: true, startedAt: nextTime };
    const injected = fixture({ before: [old], after: [active] });
    await expect(withRuntimeStartupCleanup(injected.options)).rejects.toThrow(
      "health timeout",
    );
    expect(injected.executeStop.mock.calls[0][0].args.at(-1)).toBe(old.id);
  });

  it("protects replacement containers for originally running names and persistent rollback", async () => {
    const running = container("a", "database", true, firstTime);
    const replacement = container("b", "database", true);
    expect(selectNewStartupWorkloads([running], [replacement])).toEqual([]);
    const injected = fixture({
      before: [running],
      after: [replacement],
      action: "run",
      config: { ...config, lifecycle: { run: "keep-until-stop" } },
    });
    await expect(withRuntimeStartupCleanup(injected.options)).rejects.toThrow(
      "health timeout",
    );
    expect(injected.run).not.toHaveBeenCalled();
    expect(injected.executeStop).not.toHaveBeenCalled();
  });

  it.each(["foreign", "conflicting", "unknown-time"])(
    "refuses ambiguous %s evidence without stopping any container",
    async (problem) => {
      const unsafe = container("b", "database", true);
      if (problem === "foreign")
        unsafe.labels = { "com.supabase.cli.project": "other-rehearsal" };
      if (problem === "conflicting")
        unsafe.labels["com.rehearsal-db.project"] = "other-rehearsal";
      if (problem === "unknown-time") unsafe.startedAt = null;
      const injected = fixture({ after: [unsafe] });
      await expect(
        withRuntimeStartupCleanup(injected.options),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(injected.executeStop).not.toHaveBeenCalled();
    },
  );

  it.each(["context", "configuration", "owner"])(
    "retains workloads when %s changes during startup",
    async (problem) => {
      let engineReads = 0;
      let configReads = 0;
      let ownerReads = 0;
      const injected = fixture({
        after: [container("b", "database", true)],
        inspectEngine: () =>
          ++engineReads > 3 && problem === "context"
            ? { ...engine, identity: "0".repeat(64) }
            : engine,
        loadConfiguration: async () => ({
          config:
            ++configReads > 1 && problem === "configuration"
              ? {
                  ...config,
                  runtime: {
                    ...config.runtime,
                    projectId: "changed-rehearsal",
                  },
                }
              : config,
        }),
        inspectOwner: async () => ({
          state: "busy",
          operation: {
            progress: {
              operationId:
                ++ownerReads > 1 && problem === "owner"
                  ? "0".repeat(64)
                  : ownerId,
            },
          },
        }),
      });
      await expect(
        withRuntimeStartupCleanup(injected.options),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(injected.executeStop).not.toHaveBeenCalled();
    },
  );

  it("does not execute startup when initial engine ownership is unavailable", async () => {
    const task = vi.fn();
    const injected = fixture({ task, run: () => ({ status: 1, stdout: "" }) });
    await expect(withRuntimeStartupCleanup(injected.options)).rejects.toThrow(
      "Container engine startup ownership is unavailable",
    );
    expect(task).not.toHaveBeenCalled();
    expect(injected.executeStop).not.toHaveBeenCalled();
  });

  it("shields exact cleanup after cancellation and retains the cancellation outcome", async () => {
    const signals = new EventEmitter();
    const injected = fixture({
      after: [container("b", "database", true)],
      task: async () => {
        signals.emit("SIGINT");
        throwIfOperationCancelled();
      },
    });
    const originalStop = injected.executeStop;
    injected.options.executeStop = async (options) => {
      expect(getOperationCancellationSignal()).toBeUndefined();
      return originalStop(options);
    };
    await expect(
      runWithOperationCancellation({
        signalTarget: signals,
        task: () => withRuntimeStartupCleanup(injected.options),
      }),
    ).rejects.toMatchObject({ category: "operation_cancelled" });
    expect(originalStop).toHaveBeenCalledOnce();
  });

  it("checks a pending interruption before reporting completed startup", async () => {
    const signals = new EventEmitter();
    const injected = fixture({
      after: [container("b", "database", true)],
      task: async () => {
        signals.emit("SIGINT");
        return "started";
      },
    });
    await expect(
      runWithOperationCancellation({
        signalTarget: signals,
        task: () => withRuntimeStartupCleanup(injected.options),
      }),
    ).rejects.toMatchObject({ category: "operation_cancelled" });
    expect(injected.executeStop).toHaveBeenCalledOnce();
  });

  it("captures lazily after actual engine availability without booting it for inspection", async () => {
    const failure = new Error("later health timeout");
    let available = false;
    const injected = fixture({ after: [container("b", "database", true)] });
    const read = injected.options.run;
    injected.options.run = (...args) => {
      expect(available).toBe(true);
      return read(...args);
    };
    injected.options.task = async () => {
      available = true;
      captureRuntimeStartupOwnership();
      throw failure;
    };
    await expect(withRuntimeStartupCleanup(injected.options)).rejects.toBe(
      failure,
    );
    expect(injected.executeStop).toHaveBeenCalledOnce();
  });

  it("reports actual startup success without cleanup and refuses raw or duplicate metadata", async () => {
    const injected = fixture({ task: async () => "ready" });
    await expect(withRuntimeStartupCleanup(injected.options)).resolves.toBe(
      "ready",
    );
    expect(injected.executeStop).not.toHaveBeenCalled();
    const owned = container("a", "database", true);
    expect(() =>
      parseStartupContainers({
        output: lines([owned, owned]),
        ids: [owned.id, owned.id],
        projectId: "fixture-rehearsal",
        provider: "supabase",
      }),
    ).toThrow("incomplete");
  });
});
