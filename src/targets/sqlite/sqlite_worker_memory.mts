/** Sample one owned child lifetime; RSS observation is not a hard memory ceiling. */
import type { ChildProcess } from "node:child_process";
import { runOwnedProcess } from "../../shared/owned_process.mjs";
export const SQLITE_WORKER_RSS_BUDGET_BYTES = 256 * 1024 * 1024;
export const SQLITE_WORKER_RSS_INTERVAL_MS = 100;
export type SqliteMemoryFailure =
  "memory-limit" | "memory-observation" | "cleanup-unconfirmed";
export interface SqliteMemorySample {
  readonly pid: number;
  readonly group: number;
  readonly uid: number;
  readonly rssBytes: number;
}
export const readSqliteMemorySample = async (
  pid: number,
  signal: AbortSignal,
): Promise<SqliteMemorySample> => {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("SQLite memory observation unavailable.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 1000);
  try {
    const result = await runOwnedProcess({
      command: "/bin/ps",
      args: [
        "-p",
        String(pid),
        "-o",
        "pid=",
        "-o",
        "pgid=",
        "-o",
        "uid=",
        "-o",
        "rss=",
      ],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdin: "ignore",
      signal: controller.signal,
      cancellationGraceMs: 100,
      closeTimeoutMilliseconds: 100,
      maxOutputBytes: 4096,
    });
    if (result.error instanceof AggregateError) throw result.error;
    if (
      controller.signal.aborted ||
      result.error ||
      result.status !== 0 ||
      result.signal ||
      result.stderrByteCount
    )
      throw new Error("SQLite memory observation unavailable.");
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(result.stdout);
    if (!match) throw new Error("SQLite memory observation unavailable.");
    const values = match.slice(1).map(Number);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error("SQLite memory observation unavailable.");
    return {
      pid: values[0]!,
      group: values[1]!,
      uid: values[2]!,
      rssBytes: values[3]! * 1024,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};
export const monitorSqliteWorkerMemory = (
  child: ChildProcess,
  fail: (kind: SqliteMemoryFailure) => void,
  sample = readSqliteMemorySample,
): { stop: () => Promise<void> } => {
  let stopped = false,
    exited = child.exitCode !== null || child.signalCode !== null;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const onExit = () => {
    exited = true;
    // A read-only sample already has its own finite deadline. Let it close
    // naturally instead of racing normal worker exit with sampler signalling.
    if (timer) clearTimeout(timer);
    wake?.();
  };
  child.once("exit", onExit);
  child.once("error", onExit);
  const pending = (async () => {
    while (!stopped && !exited) {
      try {
        const pid = child.pid;
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0)
          throw new Error();
        const value = await sample(pid, controller.signal);
        if (stopped || exited) break;
        if (
          value.pid !== pid ||
          value.group !== pid ||
          value.uid !== process.getuid?.() ||
          !Number.isSafeInteger(value.rssBytes) ||
          value.rssBytes < 0
        )
          throw new Error();
        if (value.rssBytes > SQLITE_WORKER_RSS_BUDGET_BYTES) {
          fail("memory-limit");
          break;
        }
      } catch (error) {
        if (error instanceof AggregateError) fail("cleanup-unconfirmed");
        else if (!stopped && !exited) fail("memory-observation");
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, SQLITE_WORKER_RSS_INTERVAL_MS);
      });
      wake = undefined;
      timer = undefined;
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      // Stop scheduling; drain the one already-bounded sample without churn.
      if (timer) clearTimeout(timer);
      wake?.();
      await pending;
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
    },
  };
};
