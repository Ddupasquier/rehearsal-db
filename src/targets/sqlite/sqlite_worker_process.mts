/** Own the native child, absolute deadline and private bounded stdin. */
import { spawn } from "node:child_process";
import { monitorSqliteWorkerMemory } from "./sqlite_worker_memory.mjs";
import type { SqliteMemoryFailure } from "./sqlite_worker_memory.mjs";
import { fileURLToPath } from "node:url";
import { runOwnedProcess } from "../../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
import { SQLITE_WORKER_MAXIMUM_INPUT_BYTES } from "./sqlite_worker_contract.mjs";
import type {
  SqliteWorkerJob,
  SqliteWorkerResult,
  SqliteHistoryEntry,
} from "./sqlite_worker_contract.mjs";
export type {
  SQLitePrivacyPolicy,
  SqliteWorkerJob,
  SqliteWorkerResult,
  SqliteHistoryEntry,
} from "./sqlite_worker_contract.mjs";
export type SqliteWorkerFailureKind =
  | "memory-observation"
  | "memory-limit"
  | "backend-unavailable"
  | "cleanup-unconfirmed"
  | "cancelled"
  | "deadline"
  | "transport"
  | "output-limit"
  | "operation"
  | "result"
  | "input";
const failureCodes = {
  "memory-observation": "SQLITE_WORKER_MEMORY_OBSERVATION_FAILED",
  "memory-limit": "SQLITE_WORKER_MEMORY_LIMIT",
  "backend-unavailable": "SQLITE_BACKEND_UNAVAILABLE",
  "cleanup-unconfirmed": "SQLITE_WORKER_CLEANUP_UNCONFIRMED",
  cancelled: "SQLITE_WORKER_CANCELLED",
  deadline: "SQLITE_WORKER_DEADLINE",
  transport: "SQLITE_WORKER_TRANSPORT_FAILED",
  "output-limit": "SQLITE_WORKER_OUTPUT_LIMIT",
  operation: "SQLITE_OPERATION_FAILED",
  result: "SQLITE_WORKER_RESULT_INVALID",
  input: "SQLITE_WORKER_INPUT_INVALID",
} as const;
export class SqliteWorkerFailure extends Error {
  readonly code: string;
  readonly cleanupUnconfirmed: boolean;
  constructor(
    readonly kind: SqliteWorkerFailureKind,
    readonly cancelled = false,
    readonly deadlineExceeded = false,
  ) {
    super(
      kind === "operation"
        ? "SQLite worker refused or failed; private diagnostics withheld; recovery retained."
        : kind === "cancelled"
          ? "SQLite worker cancelled; recovery retained."
          : kind === "deadline"
            ? "SQLite worker interrupted by its deadline; recovery retained."
            : kind === "input"
              ? "Invalid SQLite worker deadline or bounded input."
              : `SQLite worker ${kind}; private diagnostics withheld; recovery retained.`,
    );
    this.name = "SqliteWorkerFailure";
    this.code = failureCodes[kind];
    this.cleanupUnconfirmed = kind === "cleanup-unconfirmed";
  }
}
export const runSqliteWorkerJob = async (
  job: SqliteWorkerJob,
  {
    timeoutMs = 120_000,
    signal,
  }: { timeoutMs?: number; signal?: AbortSignal } = {},
  processRunner: typeof runOwnedProcess = runOwnedProcess,
): Promise<SqliteWorkerResult> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new SqliteWorkerFailure("input");
  let input: string;
  try {
    input = JSON.stringify(job);
  } catch {
    throw new SqliteWorkerFailure("input");
  }
  if (Buffer.byteLength(input) > SQLITE_WORKER_MAXIMUM_INPUT_BYTES)
    throw new SqliteWorkerFailure("input");
  if (signal?.aborted) throw new SqliteWorkerFailure("cancelled", true);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    major < 24 ||
    (major === 24 && minor < 12)
  )
    throw new SqliteWorkerFailure("backend-unavailable");
  const controller = new AbortController();
  let deadlineExceeded = false;
  let memoryFailure: SqliteMemoryFailure | undefined;
  let memoryMonitor: ReturnType<typeof monitorSqliteWorkerMemory> | undefined;
  const stopSampling = () => {
    void memoryMonitor?.stop();
  };
  controller.signal.addEventListener("abort", stopSampling, { once: true });
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    abort();
  }, timeoutMs);
  try {
    const failure = (kind: SqliteWorkerFailureKind) =>
      new SqliteWorkerFailure(kind, signal?.aborted === true, deadlineExceeded);
    const interrupted = () =>
      failure(signal?.aborted ? "cancelled" : "deadline");
    const result = await processRunner({
      spawnImplementation: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        memoryMonitor = monitorSqliteWorkerMemory(child, (kind) => {
          if (kind === "cleanup-unconfirmed") memoryFailure = kind;
          else memoryFailure ??= kind;
          controller.abort();
        });
        return child;
      }) as typeof spawn,
      command: process.execPath,
      args: [
        "--max-old-space-size=128",
        "--disable-warning=ExperimentalWarning",
        fileURLToPath(new URL("./sqlite_worker.mjs", import.meta.url)),
      ],
      cwd: process.cwd(),
      env: createCleanProcessEnvironment({
        overrides:
          process.env.ELECTRON_RUN_AS_NODE === "1"
            ? { ELECTRON_RUN_AS_NODE: "1" }
            : {},
      }),
      input,
      stdin: "ignore",
      signal: controller.signal,
      cancellationGraceMs: 1_000,
      closeTimeoutMilliseconds: 1_000,
      maxOutputBytes: 512 * 1024,
    }).catch((error: unknown) => {
      if (error instanceof AggregateError) throw failure("cleanup-unconfirmed");
      if (
        error instanceof Error &&
        error.message === "Owned process output exceeded the safe byte limit."
      )
        throw failure("output-limit");
      // An arbitrary rejection carries no closure receipt; retain uncertainty.
      throw failure("cleanup-unconfirmed");
    });
    await memoryMonitor?.stop();
    if (result.error instanceof AggregateError)
      throw failure("cleanup-unconfirmed");
    if (memoryFailure) throw failure(memoryFailure);
    if (controller.signal.aborted || signal?.aborted) throw interrupted();
    if (result.error || result.signal) throw failure("transport");
    if (
      result.status === 1 &&
      result.stderrByteCount === 0 &&
      result.stdout === '{"sqliteWorkerFailure":"backend-unavailable"}'
    )
      throw failure("backend-unavailable");
    if (
      result.status === 1 &&
      result.stderrByteCount === 0 &&
      result.stdout === '{"sqliteWorkerFailure":"memory-limit"}'
    )
      throw failure("memory-limit");
    if (
      result.error ||
      result.status !== 0 ||
      result.signal ||
      result.stderrByteCount
    )
      throw failure("operation");
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw failure("result");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).sort().join(",") !==
        "history,rowCount,schemaSha256,sqliteVersion,tableCount" ||
      !("sqliteVersion" in value) ||
      value.sqliteVersion !== "3.53.4" ||
      !("tableCount" in value) ||
      !Number.isSafeInteger(value.tableCount) ||
      Number(value.tableCount) < 0 ||
      Number(value.tableCount) > 256 ||
      !("rowCount" in value) ||
      !Number.isSafeInteger(value.rowCount) ||
      Number(value.rowCount) < 0 ||
      Number(value.rowCount) > 100_000 ||
      !("schemaSha256" in value) ||
      typeof value.schemaSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.schemaSha256)
    )
      throw failure("result");
    if (
      !("history" in value) ||
      !Array.isArray(value.history) ||
      value.history.length > 1000 ||
      value.history.some(
        (entry: unknown) =>
          typeof entry !== "object" ||
          entry === null ||
          Object.keys(entry).sort().join(",") !== "filename,sha256" ||
          !("filename" in entry) ||
          typeof entry.filename !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,250}\.sql$/u.test(entry.filename) ||
          !("sha256" in entry) ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(entry.sha256),
      )
    )
      throw failure("result");
    if (
      new Set(value.history.map((entry: SqliteHistoryEntry) => entry.filename))
        .size !== value.history.length
    )
      throw failure("result");
    return value as SqliteWorkerResult;
  } finally {
    await memoryMonitor?.stop();
    controller.signal.removeEventListener("abort", stopSampling);
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (memoryFailure === "cleanup-unconfirmed")
      throw new SqliteWorkerFailure(
        "cleanup-unconfirmed",
        signal?.aborted === true,
        deadlineExceeded,
      );
  }
};
