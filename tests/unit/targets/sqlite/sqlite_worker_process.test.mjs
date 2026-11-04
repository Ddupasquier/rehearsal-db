import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
import {
  runSqliteWorkerJob,
  SqliteWorkerFailure,
} from "../../../../dist/src/targets/sqlite/sqlite_worker_process.mjs";
const canary = "PRIVATE_SQLITE_TRANSPORT_CANARY";
const job = { operation: "probe", maximumBytes: 64 * 1024 * 1024 };
const success = {
  sqliteVersion: "3.53.4",
  tableCount: 0,
  rowCount: 0,
  schemaSha256: "a".repeat(64),
  history: [],
};
const result = (overrides = {}) => ({
  status: 0,
  signal: null,
  stdout: JSON.stringify(success),
  stderr: "",
  stdoutByteCount: Buffer.byteLength(JSON.stringify(success)),
  stderrByteCount: 0,
  ...overrides,
});
const failure = async (run, options = {}) => {
  try {
    await runSqliteWorkerJob(job, options, run);
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteWorkerFailure);
    expect(error.message).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(error.cause).toBeUndefined();
    return error;
  }
  throw new Error("Expected worker refusal");
};
const [major, minor] = process.versions.node.split(".").map(Number);
const supportedRuntime = major >= 24 && (major !== 24 || minor >= 12);
describe.skipIf(!supportedRuntime)("private SQLite worker transport", () => {
  it("preserves Electron Node mode only for its owned native worker", async () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("NODE_OPTIONS", "--require=untrusted");
    await runSqliteWorkerJob(job, {}, async (input) => {
      expect(input.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(input.env.NODE_OPTIONS).toBeUndefined();
      return result();
    });
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "arbitrary");
    await runSqliteWorkerJob(job, {}, async (input) => {
      expect(input.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      return result();
    });
  });
  it("uses the actual supervised runner envelope and returns only a valid closed result", async () => {
    let observed;
    expect(
      await runSqliteWorkerJob(job, {}, async (input) => {
        observed = input;
        return result();
      }),
    ).toEqual(success);
    expect(JSON.parse(observed.input)).toEqual(job);
    expect(observed.stdin).toBe("ignore");
    expect(observed.maxOutputBytes).toBe(512 * 1024);
    expect(observed.cancellationGraceMs).toBe(1000);
    expect(observed.env.NODE_OPTIONS).toBeUndefined();
  });
  it.each(["returned", "rejected"])(
    "preserves %s aggregate cleanup uncertainty",
    async (kind) => {
      const aggregate = new AggregateError([new Error(canary)], canary);
      const error = await failure(async () => {
        if (kind === "rejected") throw aggregate;
        return result({ error: aggregate });
      });
      expect(error).toMatchObject({
        code: "SQLITE_WORKER_CLEANUP_UNCONFIRMED",
        kind: "cleanup-unconfirmed",
        cleanupUnconfirmed: true,
      });
    },
  );
  it("retains cleanup uncertainty when cancellation also occurs", async () => {
    const controller = new AbortController();
    const error = await failure(
      async () => {
        controller.abort(canary);
        return result({ error: new AggregateError([], canary) });
      },
      { signal: controller.signal },
    );
    expect(error).toMatchObject({
      code: "SQLITE_WORKER_CLEANUP_UNCONFIRMED",
      cancelled: true,
      cleanupUnconfirmed: true,
    });
  });
  it("does not reinterpret an unknown rejection as established closure", async () => {
    expect(
      await failure(async () => {
        throw new Error(canary);
      }),
    ).toMatchObject({ cleanupUnconfirmed: true });
  });
  it("distinguishes the exact backend refusal from arbitrary nonzero and spoofed tokens", async () => {
    expect(
      await failure(async () =>
        result({
          status: 1,
          stdout: '{"sqliteWorkerFailure":"backend-unavailable"}',
        }),
      ),
    ).toMatchObject({
      kind: "backend-unavailable",
      code: "SQLITE_BACKEND_UNAVAILABLE",
      cleanupUnconfirmed: false,
    });
    for (const stdout of [
      canary,
      '{"sqliteWorkerFailure":"backend-unavailable","extra":true}',
    ])
      expect(
        await failure(async () => result({ status: 1, stdout })),
      ).toMatchObject({ kind: "operation", code: "SQLITE_OPERATION_FAILED" });
  });
  it("does not allow a token to override transport or stderr evidence", async () => {
    expect(
      await failure(async () =>
        result({
          status: 1,
          error: new Error(canary),
          stdout: '{"sqliteWorkerFailure":"backend-unavailable"}',
        }),
      ),
    ).toMatchObject({ kind: "transport" });
    expect(
      await failure(async () =>
        result({
          status: 1,
          stderr: canary,
          stderrByteCount: canary.length,
          stdout: '{"sqliteWorkerFailure":"backend-unavailable"}',
        }),
      ),
    ).toMatchObject({ kind: "operation" });
  });
  it("retains separate cancellation and absolute deadline classifications", async () => {
    const wait = async (input) =>
      new Promise((resolve) =>
        input.signal.addEventListener(
          "abort",
          () => resolve(result({ status: null, signal: "SIGTERM" })),
          { once: true },
        ),
      );
    expect(await failure(wait, { timeoutMs: 5 })).toMatchObject({
      kind: "deadline",
      deadlineExceeded: true,
      cancelled: false,
    });
    const controller = new AbortController();
    const pending = failure(wait, { signal: controller.signal });
    controller.abort(canary);
    expect(await pending).toMatchObject({
      kind: "cancelled",
      cancelled: true,
      deadlineExceeded: false,
    });
  });
  it("keeps output-limit refusal separate from cleanup uncertainty", async () => {
    expect(
      await failure(async () => {
        throw new Error("Owned process output exceeded the safe byte limit.");
      }),
    ).toMatchObject({ kind: "output-limit", cleanupUnconfirmed: false });
  });
  it.each([
    canary,
    JSON.stringify({ ...success, extra: canary }),
    JSON.stringify({ ...success, tableCount: 257 }),
  ])("withholds invalid result payloads %#", async (stdout) => {
    expect(await failure(async () => result({ stdout }))).toMatchObject({
      kind: "result",
      code: "SQLITE_WORKER_RESULT_INVALID",
    });
  });
});

it.skipIf(supportedRuntime)(
  "reports a known unsupported host runtime without dispatch",
  async () => {
    let called = false;
    await expect(
      runSqliteWorkerJob(job, {}, async () => {
        called = true;
        return result();
      }),
    ).rejects.toMatchObject({
      kind: "backend-unavailable",
      code: "SQLITE_BACKEND_UNAVAILABLE",
    });
    expect(called).toBe(false);
  },
);
