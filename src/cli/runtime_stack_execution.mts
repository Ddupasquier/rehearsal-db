/** Receipt-bound partial-stack cleanup; never guesses which failed target was touched. */
import { withOperationCancellationShield } from "../shared/cancellation.mjs";

export const executeRuntimeTargetStack = async <Target, Receipt>({
  targets,
  execute,
  cleanupOnFailure,
  stop,
}: {
  readonly targets: readonly Target[];
  readonly execute: (target: Target) => Promise<Receipt>;
  readonly cleanupOnFailure: boolean;
  readonly stop: (target: Target) => Promise<unknown>;
}): Promise<Receipt[]> => {
  const completed: Target[] = [];
  const receipts: Receipt[] = [];
  try {
    for (const target of targets) {
      receipts.push(await execute(target));
      completed.push(target);
    }
    return receipts;
  } catch (operationError) {
    if (!cleanupOnFailure || completed.length === 0) throw operationError;
    const cleanupErrors: unknown[] = [];
    await withOperationCancellationShield(async () => {
      for (const target of [...completed].reverse()) {
        try {
          await stop(target);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    });
    if (cleanupErrors.length)
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "The runtime stack failed and one or more receipt-proven targets could not complete configured cleanup. Cleanup may be partial; inspect each target before retrying.",
      );
    throw operationError;
  }
};
