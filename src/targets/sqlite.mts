/** SQLite driver entry. Native work stays in bounded workers; no Docker discovery. */
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { parseRuntimeInvocation } from "./target.mjs";
import { guardRuntimeManagerAction } from "../runtime/lifecycle/runtime_manager_guards.mjs";
import { emitRuntimeStatusSnapshot } from "../runtime/lifecycle/status.mjs";
import { SqliteWorkerFailure } from "./sqlite/sqlite_worker_process.mjs";
import { executeSqliteRuntime } from "./sqlite/sqlite_manager.mjs";
const invocation = parseRuntimeInvocation();
try {
  const loaded = await loadRehearsalConfig({
    ...(invocation.configPath === undefined
      ? {}
      : { configPath: invocation.configPath }),
  });
  await guardRuntimeManagerAction(loaded, invocation.action);
  const status = await executeSqliteRuntime(loaded, invocation);
  emitRuntimeStatusSnapshot({
    status,
    structured: invocation.structuredResult,
  });
} catch (error) {
  const code =
    error instanceof SqliteWorkerFailure
      ? error.code
      : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          [
            "SQLITE_OWNERSHIP_UNPROVEN",
            "SQLITE_RUNTIME_DIRTY",
            "SQLITE_OPERATION_FAILED",
            "SQLITE_BACKEND_UNAVAILABLE",
          ].includes(error.code)
        ? error.code
        : "SQLITE_OPERATION_FAILED";
  process.stderr.write(
    `${code}: SQLite operation refused or failed; private details withheld.\n`,
  );
  process.exitCode = 1;
}
