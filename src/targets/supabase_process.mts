/** Run one Supabase migration process owned by Rehearsal. */

import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import {
  createCleanProcessEnvironment,
  type ProcessEnvironment,
} from "../shared/process_environment.mjs";

export const runOwnedSupabaseMigration = async ({
  environment,
  repositoryRoot,
  runtimeWorkdir,
}: {
  environment: ProcessEnvironment;
  repositoryRoot: string;
  runtimeWorkdir: string;
}): Promise<void> => {
  const cancellationSignal = getOperationCancellationSignal();
  const result = await runOwnedProcess({
    command: "supabase",
    args: ["migration", "up", "--local", "--workdir", runtimeWorkdir],
    cwd: repositoryRoot,
    env: createCleanProcessEnvironment({ overrides: environment }),
    stdin: "ignore",
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
  });
  throwIfOperationCancelled();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `supabase migration up failed${result.stderr.trim() ? `:\n${result.stderr.trim()}` : "."}`,
    );
  }
};
