/** Owned embedded-file lifecycle. Guards are cooperative, not a same-user OS sandbox. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { loadRehearsalConfig } from "../../project/configuration.mjs";
import {
  sqliteCandidatePlan,
  readSqliteBaseline,
} from "../../baseline/producers/sqlite_baseline.mjs";
import { runRuntimeLifecycle } from "../../runtime/lifecycle/lifecycle_engine.mjs";
import { runtimeConfigurationSha256 } from "../../runtime/lifecycle/configuration_binding.mjs";
import { inspectProjectOperationState } from "../../shared/operation_guard.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../../shared/cancellation.mjs";
import { runOwnedProcess } from "../../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
import {
  runSqliteWorkerJob,
  SqliteWorkerFailure,
} from "./sqlite_worker_process.mjs";
import type {
  SqliteHistoryEntry,
  SqliteWorkerResult,
} from "./sqlite_worker_contract.mjs";
import type { RuntimeInvocation } from "../target.mjs";
import type { RuntimeStatusSnapshot } from "../../runtime/lifecycle/status.mjs";
import {
  sqliteOwnedDirectory,
  sqliteProjectPath,
  sqliteFileIdentity,
  sqliteIdentity,
  assertSqliteFile,
  readSqliteBytes,
  parseSqliteJson,
  writeSqliteJson,
  sameSqliteIdentity,
  sqliteSha256,
  sqliteError,
  unlinkSqliteFile,
} from "./sqlite_files.mjs";
import type { SqliteFileIdentity } from "./sqlite_files.mjs";
type Loaded = Awaited<ReturnType<typeof loadRehearsalConfig>>;
export interface VerifiedSqliteRuntimeReceipt {
  readonly history: readonly SqliteHistoryEntry[];
  readonly candidateSha256: string;
  readonly baselineGenerationId: string;
}
interface Marker {
  readonly version: 1;
  readonly target: "sqlite";
  readonly projectId: string;
  readonly configurationSha256: string;
  readonly baselineGenerationId: string;
  readonly databaseIdentity: SqliteFileIdentity;
  readonly history: readonly SqliteHistoryEntry[];
  readonly schemaSha256: string;
  readonly state: "running" | "stopped" | "dirty";
  readonly workerClosure: "confirmed" | "pending" | "unconfirmed";
  readonly sidecars: Readonly<Record<string, SqliteFileIdentity>>;
  readonly environmentIdentity: SqliteFileIdentity | null;
  readonly environmentSha256: string | null;
}
const OWNERSHIP = () =>
  sqliteError(
    "SQLITE_OWNERSHIP_UNPROVEN",
    "SQLite ownership or open-handle evidence is unavailable; existing files were preserved.",
  );
const DIRTY = () =>
  sqliteError(
    "SQLITE_RUNTIME_DIRTY",
    "The SQLite runtime requires an explicit reviewed reset before use.",
  );
const validIdentity = (value: unknown): value is SqliteFileIdentity =>
  !!value &&
  typeof value === "object" &&
  ["dev", "ino", "birthtimeNs"].every(
    (k) =>
      k in value &&
      typeof (value as Record<string, unknown>)[k] === "string" &&
      /^[0-9]+$/u.test(String((value as Record<string, unknown>)[k])),
  );
const historyEqual = (
  a: readonly SqliteHistoryEntry[],
  b: readonly SqliteHistoryEntry[],
) => JSON.stringify(a) === JSON.stringify(b);
const assertParentOperation = async (projectRoot: string) => {
  const expected = process.env.REHEARSAL_OWNER_OPERATION_ID;
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) throw OWNERSHIP();
  const state = await inspectProjectOperationState({ projectRoot });
  if (
    state.state !== "busy" ||
    state.operation?.progress?.operationId !== expected
  )
    throw OWNERSHIP();
};
/** A successful empty lsof result is distinct from unavailable or truncated evidence. */
const assertNoOpenHandles = async (paths: readonly string[]): Promise<void> => {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw OWNERSHIP();
  const result = await runOwnedProcess({
    command: process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
    args: ["-nP", "-t", "--", ...paths],
    cwd: process.cwd(),
    env: createCleanProcessEnvironment(),
    stdin: "ignore",
    signal: AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(getOperationCancellationSignal()
        ? [getOperationCancellationSignal()!]
        : []),
    ]),
    maxOutputBytes: 65536,
    cancellationGraceMs: 1000,
    closeTimeoutMilliseconds: 1000,
  }).catch((error: unknown) => {
    if (error instanceof AggregateError)
      throw new SqliteWorkerFailure("cleanup-unconfirmed");
    throw OWNERSHIP();
  });
  if (result.error instanceof AggregateError)
    throw new SqliteWorkerFailure("cleanup-unconfirmed");
  if (
    result.error ||
    result.signal ||
    result.stderrByteCount ||
    result.stdoutByteCount ||
    result.status !== 1
  )
    throw OWNERSHIP();
};
export interface SqliteRuntimeDependencies {
  /** Explicit synthetic-fixture seam. The actual manager always uses parent lock proof. */
  readonly assertOperationOwner?: (projectRoot: string) => Promise<void>;
  readonly assertNoOpenHandles?: (paths: readonly string[]) => Promise<void>;
}
const executeSqliteRuntimeInternal = async (
  loaded: Loaded,
  invocation: RuntimeInvocation,
  dependencies: SqliteRuntimeDependencies = {},
  observeReceipt?: (receipt: VerifiedSqliteRuntimeReceipt) => void,
): Promise<RuntimeStatusSnapshot> => {
  if (!loaded.config.sqlite || loaded.config.runtime.target !== "sqlite")
    throw sqliteError(
      "SQLITE_BACKEND_UNAVAILABLE",
      "The SQLite backend is not configured.",
    );
  const config = loaded.config.sqlite;
  const configurationSha256 = runtimeConfigurationSha256(loaded.config);
  const initialPlan = sqliteCandidatePlan(loaded);
  const assertOperation =
    dependencies.assertOperationOwner ?? assertParentOperation;
  const assertClosed = dependencies.assertNoOpenHandles ?? assertNoOpenHandles;
  const rootPath = join(loaded.paths.runtimeWorkdir, "sqlite");
  const databasePath = join(rootPath, "database.sqlite");
  const markerPath = join(rootPath, "runtime.json");
  const environmentPath = loaded.paths.applicationEnvironment;
  const mutating = [
    "reset",
    "run",
    "start",
    "migrate",
    "stop",
    "discard",
  ].includes(invocation.action);
  const inputs = async () => {
    throwIfOperationCancelled();
    if (mutating) await assertOperation(loaded.projectRoot);
    const current = await loadRehearsalConfig({
      projectRoot: loaded.projectRoot,
      configPath: loaded.configPath,
    });
    const plan = sqliteCandidatePlan(current);
    if (
      runtimeConfigurationSha256(current.config) !== configurationSha256 ||
      plan.candidateSha256 !== initialPlan.candidateSha256
    )
      throw sqliteError(
        "SQLITE_OPERATION_FAILED",
        "SQLite reviewed inputs changed; existing runtime data was retained.",
      );
    return plan;
  };
  const runWorker = (job: Parameters<typeof runSqliteWorkerJob>[0]) =>
    runSqliteWorkerJob(job, {
      timeoutMs: config.timeoutSeconds * 1000,
      ...(getOperationCancellationSignal()
        ? { signal: getOperationCancellationSignal()! }
        : {}),
    });
  const markerWitnesses = new WeakMap<
    Marker,
    { identity: SqliteFileIdentity; sha256: string }
  >();
  const assertMarker = (marker: Marker) => {
    const witness = markerWitnesses.get(marker);
    if (!witness) throw OWNERSHIP();
    assertSqliteFile(markerPath, witness.identity);
    if (
      sqliteSha256(readSqliteBytes(markerPath, 512 * 1024)) !== witness.sha256
    )
      throw OWNERSHIP();
  };
  const writeMarker = (marker: Marker, previous?: Marker) => {
    if (previous) assertMarker(previous);
    writeSqliteJson(markerPath, marker, !previous);
  };
  const readMarker = (recovery = false): Marker => {
    sqliteProjectPath(loaded.projectRoot, markerPath);
    const markerIdentity = sqliteFileIdentity(markerPath);
    const markerBytes = readSqliteBytes(markerPath, 512 * 1024);
    const marker = parseSqliteJson<Marker>(markerBytes);
    if (
      !marker ||
      typeof marker !== "object" ||
      Array.isArray(marker) ||
      marker.version !== 1 ||
      marker.target !== "sqlite" ||
      typeof marker.baselineGenerationId !== "string" ||
      !/^sqlite-[0-9]{13}-[a-f0-9-]{36}$/u.test(marker.baselineGenerationId) ||
      marker.projectId !== loaded.config.runtime.projectId ||
      typeof marker.configurationSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(marker.configurationSha256) ||
      (!recovery &&
        (marker.configurationSha256 !== configurationSha256 ||
          marker.baselineGenerationId !== initialPlan.baseline.generationId)) ||
      !validIdentity(marker.databaseIdentity) ||
      !Array.isArray(marker.history) ||
      marker.history.length > 1000 ||
      marker.history.some(
        (entry) =>
          !entry ||
          typeof entry.filename !== "string" ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(entry.sha256),
      ) ||
      (!recovery &&
        (!historyEqual(
          marker.history,
          initialPlan.files
            .slice(0, marker.history.length)
            .map(({ filename, sha256 }) => ({ filename, sha256 })),
        ) ||
          marker.history.length < initialPlan.baseline.history.length)) ||
      typeof marker.schemaSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(marker.schemaSha256) ||
      !["running", "stopped", "dirty"].includes(marker.state) ||
      !["confirmed", "pending", "unconfirmed"].includes(marker.workerClosure) ||
      (marker.state !== "dirty" && marker.workerClosure !== "confirmed") ||
      !marker.sidecars ||
      typeof marker.sidecars !== "object" ||
      Array.isArray(marker.sidecars) ||
      Object.keys(marker.sidecars).some(
        (suffix) =>
          !["-wal", "-shm", "-journal"].includes(suffix) ||
          !validIdentity(marker.sidecars[suffix]),
      ) ||
      (marker.environmentIdentity !== null &&
        !validIdentity(marker.environmentIdentity)) ||
      (marker.environmentSha256 !== null &&
        (typeof marker.environmentSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(marker.environmentSha256)))
    )
      throw OWNERSHIP();
    assertSqliteFile(databasePath, marker.databaseIdentity);
    assertSqliteFile(markerPath, markerIdentity);
    markerWitnesses.set(marker, {
      identity: markerIdentity,
      sha256: sqliteSha256(markerBytes),
    });
    return marker;
  };
  const withDirectory = async <T,>(
    task: (directory: ReturnType<typeof sqliteOwnedDirectory>) => Promise<T>,
    create = false,
  ) => {
    const directory = sqliteOwnedDirectory(
      loaded.projectRoot,
      rootPath,
      loaded.config,
      create,
    );
    try {
      return await task(directory);
    } finally {
      directory.close();
    }
  };
  const sidecarPresent = (
    marker: Marker,
    suffix: string,
    identity: SqliteFileIdentity,
  ): boolean => {
    try {
      assertSqliteFile(databasePath + suffix, identity);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT" &&
        suffix === "-journal" &&
        marker.workerClosure === "confirmed"
      )
        return false;
      throw error;
    }
  };
  const presentPaths = (marker: Marker) => [
    databasePath,
    ...Object.entries(marker.sidecars)
      .filter(([suffix, identity]) => sidecarPresent(marker, suffix, identity))
      .map(([suffix]) => databasePath + suffix),
  ];
  const retireSidecars = (marker: Marker) => {
    for (const [suffix, identity] of Object.entries(marker.sidecars))
      if (sidecarPresent(marker, suffix, identity))
        unlinkSqliteFile(databasePath + suffix, identity);
  };
  const restoredMarker = (
    baselineGenerationId: string,
    result: SqliteWorkerResult,
  ): Marker => ({
    version: 1,
    target: "sqlite",
    projectId: loaded.config.runtime.projectId,
    configurationSha256,
    baselineGenerationId,
    databaseIdentity: sqliteFileIdentity(databasePath),
    history: result.history,
    schemaSha256: result.schemaSha256,
    state: "running",
    workerClosure: "confirmed",
    sidecars: {},
    environmentIdentity: null,
    environmentSha256: null,
  });
  const assertLeaves = (marker: Marker | null) => {
    if (marker && marker.workerClosure !== "confirmed")
      throw new SqliteWorkerFailure("cleanup-unconfirmed");
    sqliteProjectPath(loaded.projectRoot, rootPath);
    const allowed = new Set([
      "owner.json",
      ...(marker
        ? [
            "database.sqlite",
            "runtime.json",
            ...Object.keys(marker.sidecars).map(
              (suffix) => `database.sqlite${suffix}`,
            ),
          ]
        : []),
    ]);
    if (fs.readdirSync(rootPath).some((name) => !allowed.has(name)))
      throw OWNERSHIP();
    if (marker) {
      assertSqliteFile(databasePath, marker.databaseIdentity);
      for (const [suffix, identity] of Object.entries(marker.sidecars))
        sidecarPresent(marker, suffix, identity);
    }
  };
  const assertEnvironment = (marker: Marker | null) => {
    sqliteProjectPath(loaded.projectRoot, environmentPath, true);
    if (!fs.existsSync(environmentPath)) {
      if (marker?.environmentIdentity) throw OWNERSHIP();
      return;
    }
    if (!marker?.environmentIdentity || marker.environmentSha256 === null)
      throw OWNERSHIP();
    assertSqliteFile(environmentPath, marker.environmentIdentity);
    if (
      sqliteSha256(readSqliteBytes(environmentPath, 512 * 1024)) !==
      marker.environmentSha256
    )
      throw OWNERSHIP();
  };
  const removeEnvironment = (marker: Marker): Marker => {
    assertEnvironment(marker);
    if (marker.environmentIdentity)
      unlinkSqliteFile(environmentPath, marker.environmentIdentity);
    return { ...marker, environmentIdentity: null, environmentSha256: null };
  };
  const enableEnvironment = (marker: Marker): Marker => {
    assertEnvironment(marker);
    if (/[\r\n"\\]/u.test(databasePath)) throw OWNERSHIP();
    const bytes = `SQLITE_DATABASE_PATH=${JSON.stringify(databasePath)}\n`;
    if (marker.environmentIdentity) {
      if (marker.environmentSha256 !== sqliteSha256(bytes)) throw OWNERSHIP();
      return marker;
    }
    fs.mkdirSync(dirname(environmentPath), { recursive: true, mode: 0o700 });
    sqliteProjectPath(loaded.projectRoot, dirname(environmentPath));
    fs.writeFileSync(environmentPath, bytes, { flag: "wx", mode: 0o600 });
    return {
      ...marker,
      environmentIdentity: sqliteFileIdentity(environmentPath),
      environmentSha256: sqliteSha256(bytes),
    };
  };
  const verifyMarker = async (
    marker: Marker,
    exclusive = false,
  ): Promise<SqliteWorkerResult> => {
    assertMarker(marker);
    assertEnvironment(marker);
    if (marker.workerClosure !== "confirmed")
      throw new SqliteWorkerFailure("cleanup-unconfirmed");
    if (marker.state === "dirty") throw DIRTY();
    const result = await runWorker({
      operation: "verify",
      databasePath,
      expectedHistory: marker.history,
      maximumBytes: config.maximumBytes,
      ...(exclusive ? { exclusive: true } : {}),
    });
    if (result.schemaSha256 !== marker.schemaSha256) throw DIRTY();
    assertSqliteFile(databasePath, marker.databaseIdentity);
    assertMarker(marker);
    assertEnvironment(marker);
    return result;
  };
  const closed = async (marker: Marker) => {
    if (marker.workerClosure !== "confirmed")
      throw new SqliteWorkerFailure("cleanup-unconfirmed");
    assertLeaves(marker);
    await assertClosed(presentPaths(marker));
    if (marker.state !== "dirty") {
      assertMarker(marker);
      await runWorker({
        operation: "verify",
        databasePath,
        expectedHistory: marker.history,
        maximumBytes: config.maximumBytes,
        exclusive: true,
      });
      assertMarker(marker);
    }
    assertLeaves(marker);
  };
  const reset = async () => {
    await inputs();
    if (
      !invocation.confirmation ||
      invocation.confirmation !== initialPlan.candidateSha256
    )
      throw sqliteError(
        "SQLITE_OPERATION_FAILED",
        "SQLite reset requires the exact reviewed candidate confirmation.",
      );
    await withDirectory(async (directory) => {
      let previous: Marker | null = fs.existsSync(markerPath)
        ? readMarker(true)
        : null;
      assertLeaves(previous);
      assertEnvironment(previous);
      if (previous) await closed(previous);
      const baseline = readSqliteBaseline(loaded);
      const staged = join(rootPath, `.staged-${randomUUID()}.sqlite`);
      fs.copyFileSync(baseline.database, staged, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staged, 0o600);
      const stagedIdentity = sqliteFileIdentity(staged);
      const result = await runWorker({
        operation: "verify",
        databasePath: staged,
        maximumBytes: config.maximumBytes,
        expectedHistory: baseline.manifest.history,
      });
      if (
        sqliteSha256(readSqliteBytes(staged, config.maximumBytes)) !==
          baseline.manifest.databaseSha256 ||
        result.schemaSha256 !== baseline.manifest.schemaSha256
      )
        throw OWNERSHIP();
      await inputs();
      directory.assertOwned();
      assertSqliteFile(staged, stagedIdentity);
      // A staged file is the only additional leaf this operation created.
      if (
        fs
          .readdirSync(rootPath)
          .some(
            (name) =>
              name !== staged.slice(rootPath.length + 1) &&
              ![
                "owner.json",
                ...(previous
                  ? [
                      "database.sqlite",
                      "runtime.json",
                      ...Object.keys(previous.sidecars).map(
                        (s) => `database.sqlite${s}`,
                      ),
                    ]
                  : []),
              ].includes(name),
          )
      )
        throw OWNERSHIP();
      if (previous) {
        assertMarker(previous);
        await assertClosed(presentPaths(previous));
        assertSqliteFile(databasePath, previous.databaseIdentity);
        retireSidecars(previous);
        const priorMarker = previous;
        previous = removeEnvironment(previous);
        // Keep the prior exact file as recovery evidence until new marker activation succeeds.
        const retained = join(rootPath, `.previous-${randomUUID()}.sqlite`);
        fs.linkSync(databasePath, retained);
        fs.unlinkSync(databasePath);
        try {
          fs.linkSync(staged, databasePath);
          fs.unlinkSync(staged);
          let marker = restoredMarker(baseline.manifest.generationId, result);
          marker = enableEnvironment(marker);
          writeMarker(marker, priorMarker);
          await inputs();
          directory.assertOwned();
          unlinkSqliteFile(retained, previous.databaseIdentity);
        } catch (error) {
          throw error;
        }
      } else {
        fs.linkSync(staged, databasePath);
        fs.unlinkSync(staged);
        let marker = restoredMarker(baseline.manifest.generationId, result);
        marker = enableEnvironment(marker);
        writeMarker(marker);
      }
      directory.assertOwned();
      await inputs();
    }, true);
  };
  const start = async () => {
    await inputs();
    await withDirectory(async (directory) => {
      let marker = readMarker();
      assertLeaves(marker);
      await verifyMarker(marker);
      await inputs();
      directory.assertOwned();
      const previous = marker;
      marker = enableEnvironment(marker);
      writeMarker({ ...marker, state: "running" }, previous);
    });
  };
  const verify = async () => {
    await inputs();
    await withDirectory(async (directory) => {
      const marker = readMarker();
      assertLeaves(marker);
      await verifyMarker(marker);
      await inputs();
      directory.assertOwned();
      assertMarker(marker);
      observeReceipt?.({
        history: marker.history.map(({ filename, sha256 }) => ({
          filename,
          sha256,
        })),
        candidateSha256: initialPlan.candidateSha256,
        baselineGenerationId: marker.baselineGenerationId,
      });
    });
  };
  const migrate = async () => {
    await inputs();
    if (invocation.confirmation !== initialPlan.candidateSha256)
      throw sqliteError(
        "SQLITE_OPERATION_FAILED",
        "SQLite migrations require the exact reviewed candidate confirmation.",
      );
    await withDirectory(async (directory) => {
      const marker = readMarker();
      assertLeaves(marker);
      await verifyMarker(marker);
      await inputs();
      directory.assertOwned();
      const migrations = initialPlan.files.slice(marker.history.length);
      if (!migrations.length) return;
      const journalPath = databasePath + "-journal";
      const journalFd = fs.openSync(
        journalPath,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
        0o600,
      );
      let journalIdentity: SqliteFileIdentity;
      try {
        journalIdentity = sqliteIdentity(
          fs.fstatSync(journalFd, { bigint: true }),
        );
        assertSqliteFile(journalPath, journalIdentity);
      } catch (error) {
        fs.closeSync(journalFd);
        throw error;
      }
      let workerClosed = true,
        dirty: Marker | undefined;
      try {
        writeMarker(
          {
            ...marker,
            state: "dirty",
            workerClosure: "pending",
            sidecars: { "-journal": journalIdentity },
          },
          marker,
        );
        dirty = readMarker();
        workerClosed = false;
        const result = await runWorker({
          operation: "migrate",
          databasePath,
          expectedJournal: journalIdentity,
          expectedHistory: marker.history,
          maximumBytes: config.maximumBytes,
          migrations,
        });
        workerClosed = true;
        writeMarker({ ...dirty, workerClosure: "confirmed" }, dirty);
        dirty = readMarker();
        const expected = initialPlan.files.map(({ filename, sha256 }) => ({
          filename,
          sha256,
        }));
        if (!historyEqual(result.history, expected)) throw DIRTY();
        await inputs();
        directory.assertOwned();
        assertLeaves(dirty);
        assertEnvironment(marker);
        const verified = await runWorker({
          operation: "verify",
          databasePath,
          maximumBytes: config.maximumBytes,
          expectedHistory: expected,
        });
        if (verified.schemaSha256 !== result.schemaSha256) throw DIRTY();
        await inputs();
        directory.assertOwned();
        assertLeaves(dirty);
        assertEnvironment(marker);
        // DELETE-mode transactions remove the original journal on completion.
        if (sidecarPresent(dirty, "-journal", journalIdentity))
          throw OWNERSHIP();
        writeMarker(
          {
            ...marker,
            history: expected,
            schemaSha256: verified.schemaSha256,
            workerClosure: "confirmed",
            sidecars: {},
          },
          dirty,
        );
      } catch (error) {
        if (error instanceof SqliteWorkerFailure)
          workerClosed = !error.cleanupUnconfirmed;
        if (dirty) {
          try {
            writeMarker(
              {
                ...dirty,
                workerClosure: workerClosed ? "confirmed" : "unconfirmed",
              },
              dirty,
            );
          } catch {
            /* Original failure stays primary; pending/unknown receipt refuses recovery. */
          }
        }
        throw error;
      } finally {
        // Unknown worker closure never grants journal retirement. In the actual
        // isolated manager this handle remains held until process termination.
        if (workerClosed) fs.closeSync(journalFd);
      }
    });
  };
  const stop = async () => {
    await inputs();
    await withDirectory(async (directory) => {
      const marker = readMarker();
      assertLeaves(marker);
      const stopped = removeEnvironment(marker);
      directory.assertOwned();
      writeMarker(
        { ...stopped, state: marker.state === "dirty" ? "dirty" : "stopped" },
        marker,
      );
    });
  };
  const discard = async () => {
    await inputs();
    if (invocation.confirmation !== initialPlan.candidateSha256)
      throw sqliteError(
        "SQLITE_OPERATION_FAILED",
        "SQLite discard requires the exact reviewed candidate confirmation.",
      );
    await withDirectory(async (directory) => {
      const marker = readMarker(true);
      await closed(marker);
      assertEnvironment(marker);
      await inputs();
      directory.assertOwned();
      assertMarker(marker);
      removeEnvironment(marker);
      retireSidecars(marker);
      unlinkSqliteFile(databasePath, marker.databaseIdentity);
      const receipt = sqliteFileIdentity(markerPath);
      unlinkSqliteFile(markerPath, receipt);
      directory.assertOwned();
      const owner = join(rootPath, "owner.json");
      unlinkSqliteFile(owner, sqliteFileIdentity(owner));
      fs.rmdirSync(rootPath);
    });
  };
  let snapshot: RuntimeStatusSnapshot | undefined;
  const status = async () => {
    let marker: Marker | null = null;
    if (fs.existsSync(rootPath))
      await withDirectory(async (directory) => {
        marker = readMarker();
        directory.assertOwned();
      });
    const current = marker as Marker | null;
    const bindingSha256 = sqliteSha256(
      JSON.stringify({
        projectId: loaded.config.runtime.projectId,
        configurationSha256,
        baselineGenerationId: initialPlan.baseline.generationId,
        databaseIdentity: current?.databaseIdentity ?? null,
      }),
    );
    snapshot = {
      schemaVersion: 2,
      runtimeTarget: "sqlite",
      projectId: loaded.config.runtime.projectId,
      state:
        current?.state === "running"
          ? "running"
          : current?.state === "dirty"
            ? "unhealthy"
            : "stopped",
      reason:
        current?.state === "dirty"
          ? "health_check_failed"
          : current?.state === "running"
            ? null
            : "runtime_not_running",
      verifiedRuntimeAvailable: current !== null && current.state !== "dirty",
      endpoint:
        current?.state === "running"
          ? { kind: "embedded-file", bindingSha256 }
          : null,
      baselineGenerationId: initialPlan.baseline.generationId,
      candidateSha256: initialPlan.candidateSha256,
      candidates: initialPlan.candidates.map((file) => file.filename),
    };
  };
  try {
    await runRuntimeLifecycle({
      action: invocation.action,
      protected: loaded.config.runtime.protected,
      operations: {
        reset,
        start,
        status,
        candidates: status,
        migrate,
        verify,
        stop,
        discard,
      },
    });
    if (!snapshot) await status();
    return snapshot!;
  } catch (error) {
    if (error instanceof SqliteWorkerFailure) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("SQLITE_")
    )
      throw error;
    throw sqliteError(
      "SQLITE_OPERATION_FAILED",
      "The SQLite operation did not complete; retained recovery must be reviewed.",
    );
  }
};

/** Keep private filesystem/native errors out of the manager API as well as CLI output. */
export const executeSqliteRuntime = async (
  ...args: Parameters<typeof executeSqliteRuntimeInternal>
): Promise<RuntimeStatusSnapshot> => {
  try {
    return await executeSqliteRuntimeInternal(...args);
  } catch (error) {
    if (error instanceof SqliteWorkerFailure) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "SQLITE_OWNERSHIP_UNPROVEN",
        "SQLITE_RUNTIME_DIRTY",
        "SQLITE_OPERATION_FAILED",
        "SQLITE_BACKEND_UNAVAILABLE",
      ].includes(error.code)
    )
      throw error;
    throw sqliteError(
      "SQLITE_OPERATION_FAILED",
      "The SQLite operation did not complete; retained recovery must be reviewed.",
    );
  }
};

/** Inspection claims application only after the real worker journal/schema proof. */
export const readVerifiedSqliteRuntimeReceipt = async (
  loaded: Loaded,
): Promise<VerifiedSqliteRuntimeReceipt | null> => {
  let receipt: VerifiedSqliteRuntimeReceipt | null = null;
  try {
    await executeSqliteRuntimeInternal(
      loaded,
      {
        action: "verify",
        configPath: undefined,
        confirmation: undefined,
        structuredResult: true,
      },
      {},
      (value) => {
        receipt = value;
      },
    );
    return receipt;
  } catch (error) {
    if (error instanceof SqliteWorkerFailure && error.cleanupUnconfirmed)
      throw error;
    const cancellation = getOperationCancellationSignal();
    if (cancellation?.aborted) throw cancellation.reason;
    if (error instanceof SqliteWorkerFailure && error.kind === "cancelled")
      throw error;
    return null;
  }
};
