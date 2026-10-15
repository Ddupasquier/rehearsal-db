/** Run one PostgreSQL command in an interruptible process owned by Rehearsal. */

import { spawnSync } from "node:child_process";

import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import { runtimeDockerEnvironment } from "../runtime/local_docker_context.mjs";
import { captureRuntimeStartupOwnership } from "../runtime/runtime_startup_ownership.mjs";

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
  runProcessImplementation = runOwnedProcess,
}: {
  containerName: string;
  database: string;
  databaseUser: string;
  repositoryRoot: string;
  sql: string;
  migrationKind: "baseline" | "candidate";
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
      `The ${migrationKind === "candidate" ? "confirmed candidate" : "baseline"} PostgreSQL migration failed (exit ${Number.isInteger(result.status) ? result.status : "unknown"}; stderr ${result.stderrByteCount} bytes). SQL and provider output are withheld.`,
    );
  }
};
