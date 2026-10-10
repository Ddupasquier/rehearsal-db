import { describe, expect, it, vi } from "vitest";
import {
  applyRuntimePersistence,
  shouldStopRuntime,
} from "../../../dist/src/runtime/persistence.mjs";

describe("runtime persistence", () => {
  it("keeps the compatibility default running", async () => {
    const stop = vi.fn();
    const outcome = await applyRuntimePersistence({
      mode: "keep-until-stop",
      operation: async () => "passed",
      stop,
    });

    expect(outcome.result).toBe("passed");
    expect(outcome.lifecycle).toEqual({
      mode: "keep-until-stop",
      runtimeState: "running",
      dataState: "preserved",
      stop: null,
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(["stop-after-run", "stop-on-application-exit"])(
    "stops owned runtimes for %s while preserving state",
    async (mode) => {
      const stop = vi.fn(async () => ({ action: "stop" }));
      const outcome = await applyRuntimePersistence({
        mode,
        operation: async () => "passed",
        stop,
      });

      expect(shouldStopRuntime(mode)).toBe(true);
      expect(outcome.lifecycle).toEqual({
        mode,
        runtimeState: "stopped",
        dataState: "preserved",
        stop: { action: "stop" },
      });
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it("stops an available runtime after a failed proof", async () => {
    const failure = new Error("proof failed");
    const stop = vi.fn(async () => ({ action: "stop" }));

    await expect(
      applyRuntimePersistence({
        mode: "stop-after-run",
        operation: async () => {
          throw failure;
        },
        stop,
      }),
    ).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not stop when startup never established an owned runtime", async () => {
    const failure = new Error("startup failed");
    const stop = vi.fn();

    await expect(
      applyRuntimePersistence({
        mode: "stop-on-application-exit",
        operation: async () => {
          throw failure;
        },
        stop,
        canStop: () => false,
      }),
    ).rejects.toBe(failure);
    expect(stop).not.toHaveBeenCalled();
  });

  it("retains both failures when automatic stop also fails", async () => {
    const proofFailure = new Error("proof failed");
    const stopFailure = new Error("stop failed");

    await expect(
      applyRuntimePersistence({
        mode: "stop-after-run",
        operation: async () => {
          throw proofFailure;
        },
        stop: async () => {
          throw stopFailure;
        },
      }),
    ).rejects.toMatchObject({
      errors: [proofFailure, stopFailure],
    });
  });
});
