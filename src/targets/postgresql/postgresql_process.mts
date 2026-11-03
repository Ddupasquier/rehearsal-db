/** Run one PostgreSQL command in an interruptible process owned by Rehearsal. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { MigrationFileEntry } from "../../runtime/migrations/migration_history.mjs";
import {
  isMigrationWorkspacePath,
  parseMigrationFailureSource,
  type MigrationFailureSource,
} from "../../runtime/migrations/migration_failure_source.mjs";

import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../../shared/cancellation.mjs";
import { withOwnedProcessDeadline } from "../../shared/owned_process_deadline.mjs";
import { runOwnedProcess } from "../../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
import { runtimeDockerEnvironment } from "../../runtime/engines/local_docker_context.mjs";
import { captureRuntimeStartupOwnership } from "../../runtime/lifecycle/runtime_startup_ownership.mjs";
import {
  diagnoseMigrationFailure,
  renderMigrationFailureDiagnostic,
} from "../../runtime/migrations/migration_failure.mjs";

export const POSTGRESQL_COMMAND_BUDGETS = Object.freeze({
  metadata: 10_000,
  sql: 120_000,
  migration: 120_000,
  startup: 120_000,
  cleanup: 45_000,
  restore: 900_000,
});
export type PostgresqlCommandPurpose = keyof typeof POSTGRESQL_COMMAND_BUDGETS;
export class PostgresqlTransportError extends AggregateError {
  constructor() {
    super(
      [],
      "The local PostgreSQL command transport failed or was interrupted. Runtime state is unconfirmed; preserve its resources and recovery files before retrying. Provider output and command arguments are withheld.",
    );
    this.name = "PostgresqlTransportError";
  }
}
export const postgresqlTransportFailure = () => new PostgresqlTransportError();

/** One finite budget, including owned TERM/KILL retirement; cancellation remains observable. */
export const withPostgresqlDeadline = async <T,>(
  purpose: PostgresqlCommandPurpose,
  operation: (signal: AbortSignal) => Promise<T>,
  {
    signal = getOperationCancellationSignal(),
    timeoutMilliseconds = POSTGRESQL_COMMAND_BUDGETS[purpose],
  }: { signal?: AbortSignal; timeoutMilliseconds?: number } = {},
): Promise<T> => {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > POSTGRESQL_COMMAND_BUDGETS[purpose]
  )
    throw postgresqlTransportFailure();
  try {
    return await withOwnedProcessDeadline(
      { timeoutMilliseconds, ...(signal ? { signal } : {}) },
      operation,
    );
  } catch (error) {
    if (
      error instanceof AggregateError &&
      !(error instanceof PostgresqlTransportError)
    )
      throw postgresqlTransportFailure();
    throw error;
  }
};

export interface PostgresqlCommandOptions {
  readonly cwd: string;
  readonly capture?: boolean;
  readonly input?: string | AsyncIterable<string>;
  readonly allowFailure?: boolean;
  readonly purpose?: PostgresqlCommandPurpose;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runProcessImplementation?: typeof runOwnedProcess;
}
export const runPostgresqlCommand = async (
  command: string,
  args: readonly string[],
  {
    cwd,
    input,
    allowFailure = false,
    purpose = "metadata",
    timeoutMilliseconds,
    signal,
    environment,
    runProcessImplementation = runOwnedProcess,
  }: PostgresqlCommandOptions,
) => {
  if (
    command === "docker" &&
    (["run", "start"].includes(args[0] ?? "") ||
      (args[0] === "container" && args[1] === "rm"))
  )
    captureRuntimeStartupOwnership();
  return withPostgresqlDeadline(
    purpose,
    async (activeSignal) => {
      let result;
      try {
        result = await runProcessImplementation({
          command,
          args,
          cwd,
          env:
            environment ??
            createCleanProcessEnvironment({
              overrides: command === "docker" ? runtimeDockerEnvironment() : {},
            }),
          ...(input === undefined ? {} : { input }),
          stdin: "ignore",
          signal: activeSignal,
          cancellationGraceMs: 1_000,
          closeTimeoutMilliseconds: 1_000,
          maxOutputBytes:
            purpose === "metadata" ? 1024 * 1024 : 16 * 1024 * 1024,
        });
      } catch {
        throw postgresqlTransportFailure();
      }
      // A signalled, failed-to-spawn, timed-out or overflowing client is never an ordinary negative probe.
      if (
        activeSignal.aborted ||
        result.error ||
        result.signal ||
        !Number.isInteger(result.status)
      )
        throw postgresqlTransportFailure();
      if (!allowFailure && result.status !== 0)
        throw postgresqlTransportFailure();
      return result;
    },
    {
      ...(signal ? { signal } : {}),
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    },
  );
};

export const postgresqlPsqlArguments = ({
  containerName,
  database,
  databaseUser,
  purpose = "sql",
}: {
  containerName: string;
  database: string;
  databaseUser: string;
  purpose?: "sql" | "migration" | "restore";
}) => [
  "exec",
  "--interactive",
  "--env",
  "PGCONNECT_TIMEOUT=5",
  "--env",
  `PGOPTIONS=-c statement_timeout=${POSTGRESQL_COMMAND_BUDGETS[purpose]} -c lock_timeout=10000 -c idle_in_transaction_session_timeout=120000`,
  containerName,
  "psql",
  "--quiet",
  "--no-psqlrc",
  "--no-align",
  "--tuples-only",
  "--set",
  "ON_ERROR_STOP=1",
  "--set",
  "VERBOSITY=sqlstate",
  "--username",
  databaseUser,
  "--dbname",
  database,
];
/** Custom project adapters retain their existing synchronous callback only. */
export const runPostgresqlAdapterSql = (
  args: readonly string[],
  sql: string,
  cwd: string,
  spawnImplementation: typeof spawnSync = spawnSync,
): string => {
  throwIfOperationCancelled();
  const result = spawnImplementation("docker", args, {
    cwd,
    encoding: "utf8",
    input: sql,
    env: createCleanProcessEnvironment({
      overrides: runtimeDockerEnvironment(),
    }),
    timeout: POSTGRESQL_COMMAND_BUDGETS.sql,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  throwIfOperationCancelled();
  if (result.error || result.signal || result.status !== 0)
    throw postgresqlTransportFailure();
  return result.stdout;
};

export const runOwnedPostgresqlSql = async ({
  containerName,
  database,
  databaseUser,
  repositoryRoot,
  sql,
  migrationKind,
  migrationSource,
  runProcessImplementation = runOwnedProcess,
}: {
  containerName: string;
  database: string;
  databaseUser: string;
  repositoryRoot: string;
  sql: string;
  migrationKind: "baseline" | "candidate";
  migrationSource?: MigrationFailureSource;
  runProcessImplementation?: typeof runOwnedProcess;
}): Promise<void> => {
  const result = await runPostgresqlCommand(
    "docker",
    postgresqlPsqlArguments({
      containerName,
      database,
      databaseUser,
      purpose: "migration",
    }),
    {
      cwd: repositoryRoot,
      input: sql,
      purpose: "migration",
      allowFailure: true,
      runProcessImplementation,
    },
  );
  throwIfOperationCancelled();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `The ${migrationKind === "candidate" ? "confirmed candidate" : "baseline"} PostgreSQL migration failed (exit ${Number.isInteger(result.status) ? result.status : "unknown"}; stderr ${result.stderrByteCount} bytes). SQL and provider output are withheld.\n${renderMigrationFailureDiagnostic({ ...diagnoseMigrationFailure({ provider: "postgresql", stderr: result.stderr }), ...(migrationSource === undefined ? {} : { source: parseMigrationFailureSource(migrationSource) }) })}`,
    );
  }
};

export const runOwnedPostgresqlMigration = async ({
  migration,
  directory,
  migrationKind,
  ...options
}: Omit<
  Parameters<typeof runOwnedPostgresqlSql>[0],
  "sql" | "migrationSource"
> & { migration: MigrationFileEntry; directory: string }): Promise<void> => {
  const path = join(directory, migration.filename);
  const canonicalPath = await realpath(path);
  const bytes = await readFile(canonicalPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== migration.fileSha256)
    throw new Error(
      "The reviewed migration file changed before execution. Review the new exact plan before retrying; no migration SQL was started.",
    );
  const sql = bytes.toString("utf8");
  if (!Buffer.from(sql, "utf8").equals(bytes))
    throw new Error(
      "The reviewed migration file is not valid UTF-8. Save it as UTF-8 and review the new exact plan before retrying; no migration SQL was started.",
    );
  const canonicalRoot = await realpath(options.repositoryRoot);
  const local = relative(canonicalRoot, canonicalPath).split(sep).join("/");
  let migrationSource: MigrationFailureSource | undefined;
  try {
    migrationSource = parseMigrationFailureSource({
      schemaVersion: 1,
      kind: migrationKind,
      filename: migration.filename,
      sha256,
      workspaceRelativePath:
        migrationKind === "candidate" && isMigrationWorkspacePath(local)
          ? local
          : null,
      line: null,
      column: null,
      evidence: "owned_execution_input",
    });
  } catch {
    /* Unsupported names omit telemetry, not previously permitted SQL execution. */
  }
  await runOwnedPostgresqlSql({
    ...options,
    migrationKind,
    sql,
    ...(migrationSource === undefined ? {} : { migrationSource }),
  });
};
