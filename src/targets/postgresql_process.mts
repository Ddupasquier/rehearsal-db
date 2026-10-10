/** Run one PostgreSQL command in an interruptible process owned by Rehearsal. */

import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";

export const runOwnedPostgresqlSql = async ({
  containerName,
  database,
  databaseUser,
  repositoryRoot,
  sql,
}: {
  containerName: string;
  database: string;
  databaseUser: string;
  repositoryRoot: string;
  sql: string;
}): Promise<void> => {
  const cancellationSignal = getOperationCancellationSignal();
  const result = await runOwnedProcess({
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
    env: createCleanProcessEnvironment(),
    input: sql,
    stdin: "ignore",
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
  });
  throwIfOperationCancelled();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `The PostgreSQL migration failed${result.stderr.trim() ? `:\n${result.stderr.trim()}` : "."}`,
    );
  }
};
