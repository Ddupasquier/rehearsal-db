import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  failure: null,
  cleanup: null,
  nonceSeen: undefined,
  guardFailure: false,
}));
vi.mock("../../../../dist/src/project/configuration.mjs", () => ({
  loadRehearsalConfig: async () => {
    state.nonceSeen = process.env.REHEARSAL_NATIVE_FAILURE_NONCE;
    return {
      projectRoot: "/synthetic",
      configPath: "/synthetic/rehearsal.config.mjs",
      config: {
        runtime: { target: "postgresql" },
        postgresql: { migrationTool: { kind: "knex" } },
      },
    };
  },
}));
vi.mock("../../../../dist/src/targets/driver.mjs", () => ({
  runRuntimeTarget: async () => {
    throw state.failure;
  },
}));
vi.mock(
  "../../../../dist/src/runtime/lifecycle/runtime_manager_guards.mjs",
  () => ({
    guardRuntimeManagerAction: async () => {
      if (state.guardFailure) throw state.failure;
    },
  }),
);
vi.mock(
  "../../../../dist/src/runtime/lifecycle/runtime_startup_ownership.mjs",
  () => ({
    withRuntimeStartupCleanup: async ({ task }) => {
      try {
        return await task();
      } catch (error) {
        if (state.cleanup)
          throw new AggregateError(
            [error, state.cleanup],
            "private aggregation",
          );
        throw error;
      }
    },
  }),
);
const originalNonce = process.env.REHEARSAL_NATIVE_FAILURE_NONCE;
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  state.guardFailure = false;
  state.cleanup = null;
  if (originalNonce === undefined)
    delete process.env.REHEARSAL_NATIVE_FAILURE_NONCE;
  else process.env.REHEARSAL_NATIVE_FAILURE_NONCE = originalNonce;
});
it("consumes the nonce before project evaluation and emits exactly one final original/cleanup frame", async () => {
  const diagnostic =
    await import("../../../../dist/src/runtime/migrations/knex_failure_diagnostic.mjs");
  state.failure = diagnostic.markKnexFailure(new Error("PRIVATE_ORIGINAL"), {
    phase: "worker",
    stage: "worker-create",
    reason: "unclassified",
  });
  state.cleanup = diagnostic.markKnexFailure(new Error("PRIVATE_CLEANUP"), {
    phase: "lifecycle",
    stage: "cleanup",
    reason: "cleanup-unconfirmed",
  });
  const nonce = "c".repeat(64);
  process.env.REHEARSAL_NATIVE_FAILURE_NONCE = nonce;
  const emitted = [];
  vi.spyOn(process.stderr, "write").mockImplementation((bytes) => {
    emitted.push(String(bytes));
    return true;
  });
  let failure;
  try {
    await import("../../../../dist/scripts/runtime/manage_database.mjs");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors[0]).toBe(state.failure);
  expect(state.nonceSeen).toBeUndefined();
  expect(process.env.REHEARSAL_NATIVE_FAILURE_NONCE).toBeUndefined();
  expect(emitted).toHaveLength(1);
  const frame = diagnostic.readKnexFailureFrame(emitted.join(""), nonce);
  expect(frame.nativeFailure).toMatchObject({
    primary: {
      phase: "worker",
      stage: "worker-create",
      reason: "unclassified",
    },
    cleanup: {
      phase: "lifecycle",
      stage: "cleanup",
      reason: "cleanup-unconfirmed",
    },
  });
  expect(emitted.join("")).not.toContain("PRIVATE");
});

it("covers known Knex admission before target import without rewriting the thrown error", async () => {
  const diagnostic =
    await import("../../../../dist/src/runtime/migrations/knex_failure_diagnostic.mjs");
  state.failure = new Error("PRIVATE_ADMISSION");
  state.guardFailure = true;
  const nonce = "d".repeat(64);
  process.env.REHEARSAL_NATIVE_FAILURE_NONCE = nonce;
  const emitted = [];
  vi.spyOn(process.stderr, "write").mockImplementation((bytes) => {
    emitted.push(String(bytes));
    return true;
  });
  await expect(
    import("../../../../dist/scripts/runtime/manage_database.mjs"),
  ).rejects.toBe(state.failure);
  expect(
    diagnostic.readKnexFailureFrame(emitted.join(""), nonce).nativeFailure
      .primary,
  ).toEqual({ phase: "lifecycle", stage: "admission", reason: "unclassified" });
  expect(emitted).toHaveLength(1);
  expect(state.nonceSeen).toBeUndefined();
});

it("identifies unclassified target execution separately from pre-target admission", async () => {
  const diagnostic =
    await import("../../../../dist/src/runtime/migrations/knex_failure_diagnostic.mjs");
  state.failure = new Error("PRIVATE_TARGET_FAILURE");
  const nonce = "e".repeat(64);
  process.env.REHEARSAL_NATIVE_FAILURE_NONCE = nonce;
  const emitted = [];
  vi.spyOn(process.stderr, "write").mockImplementation((bytes) => {
    emitted.push(String(bytes));
    return true;
  });
  await expect(
    import("../../../../dist/scripts/runtime/manage_database.mjs"),
  ).rejects.toBe(state.failure);
  expect(
    diagnostic.readKnexFailureFrame(emitted.join(""), nonce).nativeFailure
      .primary,
  ).toEqual({ phase: "lifecycle", stage: "lifecycle", reason: "unclassified" });
  expect(emitted).toHaveLength(1);
  expect(emitted.join("")).not.toContain("PRIVATE");
});
