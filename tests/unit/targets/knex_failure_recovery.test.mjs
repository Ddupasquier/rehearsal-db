import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ fail: false, written: [] }));
vi.mock("node:fs/promises", () => ({
  writeFile: async (path, bytes, options) => {
    state.written.push({ path, bytes, options });
    if (state.fail) throw Error("PRIVATE_DISK_FAILURE");
  },
}));
import {
  retainKnexResetFailure,
  assertKnexFirstStartResourcesAbsent,
} from "../../../dist/src/targets/knex_failure_recovery.mjs";
import {
  runWithOperationCancellation,
  throwIfOperationCancelled,
} from "../../../dist/src/shared/cancellation.mjs";
afterEach(() => {
  state.fail = false;
  state.written = [];
});
const options = {
  runtimeWorkdir: "/owned/private/runtime",
  baselineGenerationId: "owned-generation",
  migrationTool: undefined,
};
it("attempts exact owned stop even when failure receipt write fails, preserving the original recovery fault", async () => {
  state.fail = true;
  let stops = 0,
    error;
  try {
    await retainKnexResetFailure({
      ...options,
      stopOwnedContainer: () => {
        stops++;
      },
    });
  } catch (e) {
    error = e;
  }
  expect(stops).toBe(1);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toHaveLength(1);
  expect(String(error.errors[0])).toMatch(/receipt could not be written/);
  expect(String(error.errors[0])).not.toContain("PRIVATE_DISK_FAILURE");
});
it("reports both write and stop failures without data removal or raw callback errors", async () => {
  state.fail = true;
  let error;
  try {
    await retainKnexResetFailure({
      ...options,
      stopOwnedContainer: () => {
        throw Error("PRIVATE_ENGINE_FAILURE");
      },
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toHaveLength(2);
  expect(error.errors.map(String).join(" ")).not.toContain("PRIVATE_");
  expect(state.written[0].options).toEqual({ mode: 0o600, flag: "wx" });
});
it("shields only owned recording/stop from operation cancellation and still returns cancellation to its caller", async () => {
  const signals = new EventEmitter();
  let stops = 0;
  await expect(
    runWithOperationCancellation({
      input: null,
      signalTarget: signals,
      task: async () => {
        signals.emit("SIGINT");
        await retainKnexResetFailure({
          ...options,
          stopOwnedContainer: () => {
            throwIfOperationCancelled();
            stops++;
          },
        });
      },
    }),
  ).rejects.toThrow();
  expect(stops).toBe(1);
  expect(state.written).toHaveLength(1);
});
it("missing marker allows only positively absent resources; retained volumes, shells and unknown metadata cannot auto-reset", () => {
  const names = {
    containerName: "owned-postgresql",
    volumeName: "owned-postgresql-data",
    endpoint: "unix:///owned/socket",
  };
  expect(() =>
    assertKnexFirstStartResourcesAbsent({ ...names, run: () => "" }),
  ).not.toThrow();
  for (const [containers, volumes] of [
    ["a".repeat(64) + "\towned-postgresql", ""],
    ["", "owned-postgresql-data"],
    ["unclassified", ""],
    ["", "invalid/private"],
  ])
    expect(() =>
      assertKnexFirstStartResourcesAbsent({
        ...names,
        run: (args) => (args[2] === "ps" ? containers : volumes),
      }),
    ).toThrow(/Data was preserved/);
  expect(() =>
    assertKnexFirstStartResourcesAbsent({
      ...names,
      run: () => {
        throw Error("PRIVATE_ENGINE_FAILURE");
      },
    }),
  ).toThrow(/Data was preserved/);
});
