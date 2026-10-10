/** Explicit, non-destructive persistence policy for project-owned runtimes. */

import type {
  OpenPersistenceMode,
  RunPersistenceMode,
} from "../project/configuration_contract.mjs";
import { withOperationCancellationShield } from "../shared/cancellation.mjs";

export type RuntimePersistenceMode = RunPersistenceMode | OpenPersistenceMode;

export interface RuntimePersistenceOutcome<StopResult> {
  readonly mode: RuntimePersistenceMode;
  readonly runtimeState: "running" | "stopped";
  readonly dataState: "preserved";
  readonly stop: StopResult | null;
}

export const shouldStopRuntime = (mode: RuntimePersistenceMode): boolean =>
  mode === "stop-after-run" || mode === "stop-on-application-exit";

export const applyRuntimePersistence = async <Result, StopResult>({
  mode,
  operation,
  stop,
  canStop = () => true,
}: {
  mode: RuntimePersistenceMode;
  operation: () => Promise<Result>;
  stop: () => Promise<StopResult>;
  canStop?: () => boolean;
}): Promise<{
  result: Result;
  lifecycle: RuntimePersistenceOutcome<StopResult>;
}> => {
  let result: Result | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let stopResult: StopResult | null = null;
  let stopped = false;
  if (shouldStopRuntime(mode) && canStop()) {
    try {
      stopResult = await withOperationCancellationShield(stop);
      stopped = true;
    } catch (stopError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, stopError],
          "The Rehearsal operation failed and its owned runtime could not be stopped automatically.",
        );
      }
      throw stopError;
    }
  }

  if (operationFailed) throw operationError;
  return {
    result: result as Result,
    lifecycle: Object.freeze({
      mode,
      runtimeState: stopped ? "stopped" : "running",
      dataState: "preserved",
      stop: stopResult,
    }),
  };
};
