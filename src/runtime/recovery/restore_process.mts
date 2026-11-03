/** Stream verified restore SQL through the common bounded owned transport. */
import { runOwnedProcess } from "../../shared/owned_process.mjs";
import { withOwnedProcessDeadline } from "../../shared/owned_process_deadline.mjs";
import { getOperationCancellationSignal } from "../../shared/cancellation.mjs";
import { summarizeRestoreError } from "./restore.mjs";
export const RESTORE_PROCESS_TIMEOUT_MILLISECONDS = 900_000;
export const runOwnedRestore = async ({
  args,
  cwd,
  environment,
  input,
  timeoutMilliseconds = RESTORE_PROCESS_TIMEOUT_MILLISECONDS,
  signal = getOperationCancellationSignal(),
  runProcessImplementation = runOwnedProcess,
}: {
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  input: (signal: AbortSignal) => AsyncIterable<string>;
  timeoutMilliseconds?: number;
  signal?: AbortSignal;
  runProcessImplementation?: typeof runOwnedProcess;
}): Promise<void> => {
  if (timeoutMilliseconds > RESTORE_PROCESS_TIMEOUT_MILLISECONDS)
    throw new Error("Invalid restore process deadline.");
  await withOwnedProcessDeadline(
    { timeoutMilliseconds, ...(signal ? { signal } : {}) },
    async (activeSignal) => {
      try {
        const result = await runProcessImplementation({
          command: "docker",
          args,
          cwd,
          env: environment,
          input: input(activeSignal),
          stdin: "ignore",
          signal: activeSignal,
          cancellationGraceMs: 1_000,
          closeTimeoutMilliseconds: 1_000,
        });
        if (
          result.error ||
          result.signal ||
          result.status !== 0 ||
          activeSignal.aborted
        )
          throw new AggregateError(
            [],
            `The local Rehearsal restore failed. ${summarizeRestoreError(result.stderr)}`,
          );
      } catch (error) {
        if (error instanceof AggregateError) throw error;
        throw new AggregateError(
          [],
          "The local Rehearsal restore failed; process closure or input is unconfirmed. SQL and provider output are withheld; preserve runtime recovery.",
        );
      }
    },
  );
};
