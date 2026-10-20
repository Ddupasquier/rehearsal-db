/** Run one PostgreSQL command in an interruptible process owned by Rehearsal. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { MigrationFileEntry } from "../runtime/migration_history.mjs";
import {
  isMigrationWorkspacePath,
  parseMigrationFailureSource,
  type MigrationFailureSource,
} from "../runtime/migration_failure_source.mjs";

import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import { runtimeDockerEnvironment } from "../runtime/local_docker_context.mjs";
import { captureRuntimeStartupOwnership } from "../runtime/runtime_startup_ownership.mjs";
import {
  diagnoseMigrationFailure,
  renderMigrationFailureDiagnostic,
} from "../runtime/migration_failure.mjs";

export const runPostgresqlCommand = (
  command: string,
  args: readonly string[],
  {
    cwd,
    capture = false,
    input,
    allowFailure = false,
  }: {
    readonly cwd: string;
    readonly capture?: boolean;
    readonly input?: string;
    readonly allowFailure?: boolean;
  },
) => {
  if (
    command === "docker" &&
    (["run", "start"].includes(args[0] ?? "") ||
      (args[0] === "container" && args[1] === "rm"))
  )
    captureRuntimeStartupOwnership();
  const piped = capture || input !== undefined || allowFailure;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    env: createCleanProcessEnvironment({
      overrides: command === "docker" ? runtimeDockerEnvironment() : {},
    }),
    maxBuffer: 16 * 1024 * 1024,
    stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  throwIfOperationCancelled();
  if (!allowFailure && result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result;
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
  const cancellationSignal = getOperationCancellationSignal();
  const result = await runProcessImplementation({
    command: "docker",
    args: [
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      "VERBOSITY=sqlstate",
      "--username",
      databaseUser,
      "--dbname",
      database,
    ],
    cwd: repositoryRoot,
    env: createCleanProcessEnvironment({
      overrides: runtimeDockerEnvironment(),
    }),
    input: sql,
    stdin: "ignore",
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
  });
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
