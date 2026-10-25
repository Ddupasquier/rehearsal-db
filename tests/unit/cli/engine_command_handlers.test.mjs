import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createEngineCommandHandlers,
  withEngineCommandCancellation,
} from "../../../dist/src/cli/engine_command_handlers.mjs";
import { createCliSessionState } from "../../../dist/src/cli/command_contract.mjs";
import { parseArguments } from "../../../dist/src/cli/arguments.mjs";

const safety = {
  globalContextSwitchRequested: false,
  dataDeletionRequested: false,
  forceRequested: false,
  enginesStarted: false,
};
const engine = {
  backend: "colima",
  profile: "default",
  context: "colima",
  endpointIdentity: "a".repeat(64),
  daemonId: "fixture-daemon",
  bootId: "11111111-1111-4111-8111-111111111111",
  vmIdentity: "b".repeat(64),
};
const context = (command, args = []) => ({
  command,
  flags: parseArguments(args).flags,
  planOptions: {
    projectRoot: "/unconfigured-workspace",
    configPath: "not-evaluated.mjs",
  },
  guided: false,
  state: createCliSessionState(),
});
const execute = (services, command, args) =>
  createEngineCommandHandlers(services)
    .find((handler) => handler.matches(context(command, args)))
    .handle(context(command, args));
const outcome = (status, profileStopped, vmProcessAbsent) => ({
  schemaVersion: 1,
  status,
  reason:
    status === "stopped"
      ? "shutdown-confirmed"
      : status === "already-stopped"
        ? "profile-stopped"
        : status === "cancelled"
          ? "cancelled-before-dispatch"
          : "shutdown-unconfirmed",
  engine: status === "stopped" || vmProcessAbsent ? engine : null,
  confirmed: { profileStopped, vmProcessAbsent },
  selectionAfter: null,
  safety,
});

describe("configuration-independent engine CLI", () => {
  it("returns unavailable status as an observation without planning or stopping a VM", async () => {
    const inspect = vi.fn(async () => ({
      schemaVersion: 1,
      selected: {
        state: "unavailable",
        context: "default",
        endpointIdentity: "a".repeat(64),
        daemonId: null,
      },
      colimaDefault: {
        profile: "default",
        state: "unknown",
        shutdownSupported: false,
        reason: "ownership-unverified",
      },
      safety,
    }));
    const plan = vi.fn(),
      stop = vi.fn();
    const result = await execute({ inspect, plan, stop }, "engine status");
    expect(result.status).toBe("success");
    expect(result.data.selected.state).toBe("unavailable");
    expect(inspect).toHaveBeenCalledWith({ cwd: "/unconfigured-workspace" });
    expect(plan).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it("previews shared impact without applying, including with --write alone", async () => {
    const data = {
      schemaVersion: 1,
      action: "engine-stop",
      state: "review-required",
      reason: "ready",
      consentDigest: "a".repeat(64),
      engine,
      impact: {
        runningCount: 1,
        containers: [
          {
            id: "b".repeat(64),
            name: "shared-database",
            state: "running",
            restartCount: 0,
            startedAt: "2026-10-25T00:00:00Z",
            finishedAt: "0001-01-01T00:00:00Z",
          },
        ],
      },
      safety,
    };
    const plan = vi.fn(async () => data),
      stop = vi.fn();
    const result = await execute({ plan, stop }, "engine stop", ["--write"]);
    expect(result.data).toBe(data);
    expect(result.status).toBe("success");
    expect(result.render("normal")).toContain("shared-database");
    expect(result.render("normal")).toContain(
      `--confirm-engine-stop=${"a".repeat(64)}`,
    );
    expect(stop).not.toHaveBeenCalled();
  });
  it("rejects a malformed confirmation before any apply service", async () => {
    const stop = vi.fn();
    await expect(
      execute({ stop }, "engine stop", ["--confirm-engine-stop=invalid"]),
    ).rejects.toMatchObject({ category: "configuration_invalid", exitCode: 2 });
    expect(stop).not.toHaveBeenCalled();
  });
  it("never applies a dry run and refuses a misleading project target selector", async () => {
    const plan = vi.fn(async () => ({
        schemaVersion: 1,
        action: "engine-stop",
        state: "blocked",
        reason: "coordination-active",
        engine: null,
        impact: null,
        consentDigest: null,
        safety,
      })),
      stop = vi.fn();
    await execute({ plan, stop }, "engine stop", [
      "--dry-run",
      `--confirm-engine-stop=${"c".repeat(64)}`,
    ]);
    expect(plan).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    await expect(
      execute({ plan, stop }, "engine stop", [
        "--target=primary",
        `--confirm-engine-stop=${"c".repeat(64)}`,
      ]),
    ).rejects.toMatchObject({ category: "configuration_invalid" });
    expect(stop).not.toHaveBeenCalled();
  });
  it.each([
    ["stopped", true, true, "success", 0],
    ["stopped", true, false, "error", 1],
    ["already-stopped", true, false, "not_ready", 1],
    ["already-stopped", true, true, "success", 0],
    ["unknown", false, false, "error", 1],
    ["refused", false, false, "error", 1],
    ["cancelled", false, false, "error", 130],
  ])(
    "preserves %s proof flags (%s/%s) in the public result",
    async (status, profile, processExited, envelopeStatus, exitCode) => {
      const data = outcome(status, profile, processExited),
        stop = vi.fn(async () => data);
      const result = await execute({ stop }, "engine stop", [
        `--confirm-engine-stop=${"c".repeat(64)}`,
      ]);
      if (status === "stopped" && (!profile || !processExited))
        expect(result.data).toMatchObject({
          status: "unknown",
          reason: "shutdown-unconfirmed",
        });
      else expect(result.data).toBe(data);
      expect(result.status).toBe(envelopeStatus);
      expect(result.exitCode).toBe(exitCode);
      expect(stop.mock.calls[0][0]).toMatchObject({
        cwd: "/unconfigured-workspace",
        confirmDigest: "c".repeat(64),
      });
      expect(stop.mock.calls[0][0].signal.aborted).toBe(false);
      if (!profile || !processExited)
        expect(result.render("normal")).toContain("not established");
    },
  );
  it("retains typed post-dispatch uncertainty on cancellation and retires only its listeners", async () => {
    const target = new EventEmitter(),
      existing = vi.fn();
    target.on("SIGTERM", existing);
    const data = outcome("unknown", false, false);
    const result = await withEngineCommandCancellation(async (signal) => {
      target.emit("SIGTERM");
      expect(signal.aborted).toBe(true);
      return data;
    }, target);
    expect(result).toBe(data);
    expect(existing).toHaveBeenCalledOnce();
    expect(target.listenerCount("SIGTERM")).toBe(1);
    for (const event of ["SIGINT", "SIGHUP", "SIGTSTP"])
      expect(target.listenerCount(event)).toBe(0);
    await expect(
      withEngineCommandCancellation(async () => {
        throw Error("failure");
      }, target),
    ).rejects.toThrow("failure");
    expect(target.listenerCount("SIGTERM")).toBe(1);
  });
  it("never reports confirmed shutdown without the reviewed engine identity", async () => {
    const data = { ...outcome("stopped", true, true), engine: null };
    const result = await execute({ stop: async () => data }, "engine stop", [
      `--confirm-engine-stop=${"c".repeat(64)}`,
    ]);
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({
      status: "unknown",
      reason: "shutdown-unconfirmed",
      confirmed: { profileStopped: false, vmProcessAbsent: false },
    });
    expect(result.render("normal")).toContain("not established");
  });
});
