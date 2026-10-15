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
import { runtimeDockerEnvironment } from "../runtime/local_docker_context.mjs";

export const runOwnedSupabaseMigration = async ({
  environment,
  repositoryRoot,
  runtimeWorkdir,
  runProcessImplementation = runOwnedProcess,
}: {
  environment: ProcessEnvironment;
  repositoryRoot: string;
  runtimeWorkdir: string;
  runProcessImplementation?: typeof runOwnedProcess;
}): Promise<void> => {
  const cancellationSignal = getOperationCancellationSignal();
  const result = await runProcessImplementation({
    command: "supabase",
    args: ["migration", "up", "--local", "--workdir", runtimeWorkdir],
    cwd: repositoryRoot,
    env: createCleanProcessEnvironment({
      overrides: { ...environment, ...runtimeDockerEnvironment() },
    }),
    stdin: "ignore",
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
  });
  throwIfOperationCancelled();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `The confirmed candidate Supabase migration failed (exit ${Number.isInteger(result.status) ? result.status : "unknown"}; stderr ${result.stderrByteCount} bytes). SQL and provider output are withheld.`,
    );
  }
};
