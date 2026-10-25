import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  applyRuntimePersistence,
  shouldStopRuntime,
  runtimeCompletionAction,
  assertRuntimeCompletionAllowed,
} from "../../../dist/src/runtime/persistence.mjs";
import {
  getOperationCancellationSignal,
  runWithOperationCancellation,
} from "../../../dist/src/shared/cancellation.mjs";

describe("runtime persistence", () => {
  it.each(["SIGINT", "SIGTSTP"])(
    "retains runtime cleanup failure when %s arrives after a successful application close",
    async (signal) => {
      const signals = new EventEmitter();
      const stopFailure = new Error("owned runtime stop failed");
      const operation = runWithOperationCancellation({
        signalTarget: signals,
        input: null,
        task: () =>
          applyRuntimePersistence({
            mode: "stop-on-application-exit",
            operation: async () => "closed normally",
            stop: async () => {
              expect(getOperationCancellationSignal()).toBeUndefined();
              signals.emit(signal);
              throw stopFailure;
            },
          }),
      });
      const failure = await operation.catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toEqual([
        expect.objectContaining({
          category: "operation_cancelled",
          code: "OPERATION_CANCELLED",
          context: { signal },
        }),
        stopFailure,
      ]);
      expect(signals.eventNames()).toEqual([]);
    },
  );

  it.each(["SIGINT", "SIGTSTP"])(
    "still reports %s cancellation after successful shielded runtime cleanup",
    async (signal) => {
      const signals = new EventEmitter();
      const stop = vi.fn(async () => {
        signals.emit(signal);
        return "stopped";
      });
      await expect(
        runWithOperationCancellation({
          signalTarget: signals,
          input: null,
          task: () =>
            applyRuntimePersistence({
              mode: "stop-on-application-exit",
              operation: async () => "closed normally",
              stop,
            }),
        }),
      ).rejects.toMatchObject({
        category: "operation_cancelled",
        code: "OPERATION_CANCELLED",
        exitCode: 130,
        context: { signal },
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(signals.eventNames()).toEqual([]);
    },
  );

  it("preserves an ordinary cleanup failure without introducing cancellation", async () => {
    const failure = new Error("owned runtime stop failed");
    await expect(
      applyRuntimePersistence({
        mode: "stop-on-application-exit",
        operation: async () => "closed normally",
        stop: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

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
  it.each(["discard-after-run", "discard-on-application-exit"])(
    "truthfully removes runtime/data for explicit %s",
    async (mode) => {
      const cleanup = vi.fn(async () => ({ action: "discard" }));
      const outcome = await applyRuntimePersistence({
        mode,
        operation: async () => "complete",
        stop: cleanup,
      });
      expect(runtimeCompletionAction(mode)).toBe("discard");
      expect(outcome.lifecycle).toMatchObject({
        runtimeState: "removed",
        dataState: "removed",
        stop: { action: "discard" },
      });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(() => assertRuntimeCompletionAllowed(mode, true)).toThrow(
        /protected runtime/,
      );
      expect(() => assertRuntimeCompletionAllowed(mode, false)).not.toThrow();
    },
  );
  it("cleans after failed or cancelled work, aggregates discard faults, and skips unowned preflight failure", async () => {
    const operationError = new Error("cancelled operation"),
      cleanupError = new Error("discard failed");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    await expect(
      applyRuntimePersistence({
        mode: "discard-after-run",
        operation: async () => {
          throw operationError;
        },
        stop: cleanup,
      }),
    ).rejects.toMatchObject({ errors: [operationError, cleanupError] });
    cleanup.mockClear();
    await expect(
      applyRuntimePersistence({
        mode: "discard-after-run",
        operation: async () => {
          throw operationError;
        },
        stop: cleanup,
        canStop: () => false,
      }),
    ).rejects.toBe(operationError);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs opt-in discard cleanup under the cancellation shield", async () => {
    const signals = new EventEmitter();
    const cleanup = vi.fn(async () => {
      expect(getOperationCancellationSignal()).toBeUndefined();
      return { action: "discard" };
    });
    await expect(
      runWithOperationCancellation({
        signalTarget: signals,
        input: null,
        task: () =>
          applyRuntimePersistence({
            mode: "discard-on-application-exit",
            operation: async () => {
              signals.emit("SIGINT");
              throw getOperationCancellationSignal().reason;
            },
            stop: cleanup,
          }),
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CANCELLED", exitCode: 130 });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(signals.eventNames()).toEqual([]);
  });
});
