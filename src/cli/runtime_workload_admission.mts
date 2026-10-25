/** Bind configured lifecycle-only admission without queuing proofs or interactive sessions. */
import type { RehearsalResourcePolicy } from "../project/configuration_contract.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
import { withWorkloadAdmission } from "../runtime/workload_queue.mjs";

export const withRuntimeWorkloadAdmission = async <Result,>({
  policy,
  command,
  json,
  execute,
  capacityCheck,
}: {
  policy: RehearsalResourcePolicy["workloadQueue"];
  command: string;
  json: boolean;
  execute: () => Promise<Result>;
  capacityCheck?: () => Promise<void>;
}): Promise<Result> => {
  if (
    command !== "start" &&
    command !== "run" &&
    command !== "reset" &&
    command !== "migrate"
  )
    return execute();
  if (!policy?.enabled) {
    if (capacityCheck)
      throw new Error(
        "Measured capacity admission requires the shared lifecycle queue.",
      );
    return execute();
  }
  const signal = getOperationCancellationSignal();
  return withWorkloadAdmission({
    enabled: true,
    command,
    waitTimeoutSeconds: policy.waitTimeoutSeconds ?? 30,
    ...(signal ? { signal } : {}),
    onWaiting: () => {
      if (!json)
        process.stderr.write(
          "Waiting for another participating local Rehearsal runtime phase. Ctrl+C cancels this request.\n",
        );
    },
    execute: async () => {
      signal?.throwIfAborted();
      await capacityCheck?.();
      signal?.throwIfAborted();
      return execute();
    },
  });
};
