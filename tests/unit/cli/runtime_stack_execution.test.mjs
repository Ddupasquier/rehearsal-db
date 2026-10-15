import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { executeRuntimeTargetStack } from "../../../dist/src/cli/runtime_stack_execution.mjs";
import {
  getOperationCancellationSignal,
  runWithOperationCancellation,
  throwIfOperationCancelled,
} from "../../../dist/src/shared/cancellation.mjs";

const targets = [
  { name: "primary" },
  { name: "publication" },
  { name: "third" },
];

describe("receipt-bound partial runtime stack cleanup", () => {
  it("returns real successful receipts without cleanup during the stack phase", async () => {
    const stop = vi.fn();
    const result = await executeRuntimeTargetStack({
      targets,
      cleanupOnFailure: true,
      execute: async (target) => ({ target: target.name }),
      stop,
    });
    expect(result.map((receipt) => receipt.target)).toEqual([
      "primary",
      "publication",
      "third",
    ]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops only completed predecessors after a second-target failure", async () => {
    const failure = new Error("dependent target failed");
    const touched = [];
    const stopped = [];
    await expect(
      executeRuntimeTargetStack({
        targets,
        cleanupOnFailure: true,
        execute: async (target) => {
          touched.push(target.name);
          if (target.name === "publication") throw failure;
          return target;
        },
        stop: async (target) => {
          stopped.push(target.name);
        },
      }),
    ).rejects.toBe(failure);
    expect(touched).toEqual(["primary", "publication"]);
    expect(stopped).toEqual(["primary"]);
    expect(stopped).not.toContain("third");
  });

  it("does not stop declared or pre-existing targets after a rejected first preflight", async () => {
    const failure = new Error("preflight refused before work");
    const stop = vi.fn();
    await expect(
      executeRuntimeTargetStack({
        targets,
        cleanupOnFailure: true,
        execute: async () => {
          throw failure;
        },
        stop,
      }),
    ).rejects.toBe(failure);
    expect(stop).not.toHaveBeenCalled();
  });

  it("continues reverse-order teardown and retains original and cleanup failures", async () => {
    const original = new Error("third failed");
    const cleanup = new Error("publication stop failed");
    const stopped = [];
    let caught;
    try {
      await executeRuntimeTargetStack({
        targets,
        cleanupOnFailure: true,
        execute: async (target) => {
          if (target.name === "third") throw original;
          return target;
        },
        stop: async (target) => {
          stopped.push(target.name);
          if (target.name === "publication") throw cleanup;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(stopped).toEqual(["publication", "primary"]);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toEqual([original, cleanup]);
  });

  it("preserves the explicitly requested persistent policy after failure", async () => {
    const failure = new Error("dependent failed");
    const stop = vi.fn();
    await expect(
      executeRuntimeTargetStack({
        targets,
        cleanupOnFailure: false,
        execute: async (target) => {
          if (target.name === "publication") throw failure;
          return target;
        },
        stop,
      }),
    ).rejects.toBe(failure);
    expect(stop).not.toHaveBeenCalled();
  });

  it("shields only owned teardown after interruption and does not advance to a later target", async () => {
    const signals = new EventEmitter();
    const touched = [];
    const stopped = [];
    await expect(
      runWithOperationCancellation({
        signalTarget: signals,
        task: () =>
          executeRuntimeTargetStack({
            targets,
            cleanupOnFailure: true,
            execute: async (target) => {
              touched.push(target.name);
              if (target.name === "publication") {
                signals.emit("SIGINT");
                throwIfOperationCancelled();
              }
              return target;
            },
            stop: async (target) => {
              expect(getOperationCancellationSignal()).toBeUndefined();
              signals.emit("SIGINT");
              stopped.push(target.name);
            },
          }),
      }),
    ).rejects.toMatchObject({ category: "operation_cancelled" });
    expect(touched).toEqual(["primary", "publication"]);
    expect(stopped).toEqual(["primary"]);
  });
});
