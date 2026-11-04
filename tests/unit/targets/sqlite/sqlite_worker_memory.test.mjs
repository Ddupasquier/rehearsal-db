import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  monitorSqliteWorkerMemory,
  SQLITE_WORKER_RSS_BUDGET_BYTES,
} from "../../../../dist/src/targets/sqlite/sqlite_worker_memory.mjs";
import { runOwnedProcess } from "../../../../dist/src/shared/owned_process.mjs";
const child = () =>
  Object.assign(new EventEmitter(), {
    pid: 987654,
    exitCode: null,
    signalCode: null,
  });
const sample = (c, rssBytes = 1) => ({
  pid: c.pid,
  group: c.pid,
  uid: process.getuid(),
  rssBytes,
});
afterEach(() => vi.useRealTimers());
it("accepts the exact sampled budget, serializes samples and retires on exit", async () => {
  vi.useFakeTimers();
  const c = child(),
    fail = vi.fn();
  let finish;
  const read = vi.fn(() => new Promise((r) => (finish = r)));
  const m = monitorSqliteWorkerMemory(c, fail, read);
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(1);
  finish(sample(c, SQLITE_WORKER_RSS_BUDGET_BYTES));
  await vi.advanceTimersByTimeAsync(99);
  expect(read).toHaveBeenCalledTimes(1);
  c.emit("exit", 0);
  await m.stop();
  expect(fail).not.toHaveBeenCalled();
});
it.each(["over", "pid", "group", "uid", "unreadable"])(
  "refuses live %s observation without raw diagnostics",
  async (kind) => {
    const c = child(),
      fail = vi.fn();
    const m = monitorSqliteWorkerMemory(c, fail, async () => {
      if (kind === "unreadable") throw Error("PRIVATE_CANARY");
      const value = sample(c);
      if (kind === "over") value.rssBytes = SQLITE_WORKER_RSS_BUDGET_BYTES + 1;
      else value[kind]++;
      return value;
    });
    await m.stop();
    // stop must not manufacture failure; separately let the actual live observation settle.
    const n = monitorSqliteWorkerMemory(c, fail, async () => {
      if (kind === "unreadable") throw Error("PRIVATE_CANARY");
      const value = sample(c);
      if (kind === "over") value.rssBytes = SQLITE_WORKER_RSS_BUDGET_BYTES + 1;
      else value[kind]++;
      return value;
    });
    await new Promise((r) => setImmediate(r));
    await n.stop();
    expect(fail).toHaveBeenLastCalledWith(
      kind === "over" ? "memory-limit" : "memory-observation",
    );
    expect(JSON.stringify(fail.mock.calls)).not.toContain("PRIVATE");
  },
);
it("does not turn an exit or cancelled sampler into a live observation failure", async () => {
  const c = child(),
    fail = vi.fn();
  let reject;
  const m = monitorSqliteWorkerMemory(
    c,
    fail,
    () => new Promise((_, r) => (reject = r)),
  );
  c.emit("exit", 0);
  reject(Error("PRIVATE"));
  await m.stop();
  expect(fail).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "samples an actual bounded native allocation and closes only the owned process",
  async () => {
    const controller = new AbortController();
    let m, reason;
    const watchdog = setTimeout(() => controller.abort(), 4000);
    const result = await runOwnedProcess({
      command: process.execPath,
      args: [
        "-e",
        "const b=Buffer.alloc(300*1024*1024,1);setInterval(()=>b[0],1000)",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdin: "ignore",
      signal: controller.signal,
      cancellationGraceMs: 100,
      closeTimeoutMilliseconds: 1000,
      spawnImplementation: (...args) => {
        const c = spawn(...args);
        m = monitorSqliteWorkerMemory(c, (kind) => {
          reason = kind;
          controller.abort();
        });
        return c;
      },
    });
    clearTimeout(watchdog);
    await m.stop();
    expect(reason).toBe("memory-limit");
    expect(result.error).toBeUndefined();
    expect(result.signal).toBe("SIGTERM");
  },
  10000,
);

it("retains sampler cleanup uncertainty even after owned worker exit", async () => {
  const c = child(),
    fail = vi.fn();
  let reject;
  const m = monitorSqliteWorkerMemory(
    c,
    fail,
    () => new Promise((_, r) => (reject = r)),
  );
  c.emit("exit", 0);
  reject(new AggregateError([Error("PRIVATE_CANARY")], "PRIVATE"));
  await m.stop();
  expect(fail).toHaveBeenCalledWith("cleanup-unconfirmed");
  expect(JSON.stringify(fail.mock.calls)).not.toContain("PRIVATE");
});
it("worker exit and stop naturally drain the already-bounded sample without abort", async () => {
  const c = child(),
    fail = vi.fn();
  let finish, observedSignal;
  const m = monitorSqliteWorkerMemory(c, fail, (_, signal) => {
    observedSignal = signal;
    return new Promise((resolve) => (finish = resolve));
  });
  c.emit("exit", 0);
  let stopped = false;
  const ending = m.stop().then(() => (stopped = true));
  await new Promise((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  expect(observedSignal.aborted).toBe(false);
  finish(sample(c));
  await ending;
  expect(fail).not.toHaveBeenCalled();
  expect(c.listenerCount("exit")).toBe(0);
  expect(c.listenerCount("error")).toBe(0);
});
// Successful native jobs require the same exact binding/API tuple as production.
const [major, minor] = process.versions.node.split(".").map(Number);
let qualifiedSqlite = false;
if (major > 24 || (major === 24 && minor >= 12)) {
  let db;
  try {
    const sqlite = await import("node:sqlite");
    db = new sqlite.DatabaseSync(":memory:");
    qualifiedSqlite =
      typeof sqlite.backup === "function" &&
      typeof db.setAuthorizer === "function" &&
      typeof db.enableDefensive === "function" &&
      db.prepare("SELECT sqlite_version() AS version").get().version ===
        "3.53.4";
  } finally {
    db?.close();
  }
}
const memoryPlatform =
  process.platform === "darwin" || process.platform === "linux";
it.skipIf(!memoryPlatform || !qualifiedSqlite)(
  "repeated short actual probes drain every sample without closure uncertainty",
  async () => {
    const { runSqliteWorkerJob } =
      await import("../../../../dist/src/targets/sqlite/sqlite_worker_process.mjs");
    for (let index = 0; index < 12; index++)
      await expect(
        runSqliteWorkerJob({
          operation: "probe",
          maximumBytes: 64 * 1024 * 1024,
        }),
      ).resolves.toMatchObject({ sqliteVersion: "3.53.4", rowCount: 0 });
  },
  10000,
);

it.skipIf(!memoryPlatform || qualifiedSqlite)(
  "refuses an unqualified native binding instead of claiming successful short-worker coverage",
  async () => {
    const { runSqliteWorkerJob } =
      await import("../../../../dist/src/targets/sqlite/sqlite_worker_process.mjs");
    await expect(
      runSqliteWorkerJob({
        operation: "probe",
        maximumBytes: 64 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      kind: "backend-unavailable",
      code: "SQLITE_BACKEND_UNAVAILABLE",
      cleanupUnconfirmed: false,
    });
  },
);
