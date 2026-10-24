/** Bind configured lifecycle-only admission without queuing proofs or interactive sessions. */
import type { RehearsalResourcePolicy } from "../project/configuration_contract.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
import { withWorkloadAdmission } from "../runtime/workload_queue.mjs";

export const withRuntimeWorkloadAdmission = async <Result,>({
  policy,
  command,
  json,
  execute,
}: {
  policy: RehearsalResourcePolicy["workloadQueue"];
  command: string;
  json: boolean;
  execute: () => Promise<Result>;
}): Promise<Result> => {
  if (
    !policy?.enabled ||
    (command !== "start" &&
      command !== "run" &&
      command !== "reset" &&
      command !== "migrate")
  )
    return execute();
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
    execute,
  });
};
