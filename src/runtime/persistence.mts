/** Explicit persistence policy; destructive completion is separately opted in. */

import type {
  OpenPersistenceMode,
  RunPersistenceMode,
} from "../project/configuration_contract.mjs";
import {
  getOperationCancellationSignal,
  withOperationCancellationShield,
} from "../shared/cancellation.mjs";

export type RuntimePersistenceMode = RunPersistenceMode | OpenPersistenceMode;

export interface RuntimePersistenceOutcome<StopResult> {
  readonly mode: RuntimePersistenceMode;
  readonly runtimeState: "running" | "stopped" | "removed";
  readonly dataState: "preserved" | "removed";
  readonly stop: StopResult | null;
}

export const shouldStopRuntime = (mode: RuntimePersistenceMode): boolean =>
  mode === "stop-after-run" || mode === "stop-on-application-exit";

export const runtimeCompletionAction = (
  mode: RuntimePersistenceMode,
): "stop" | "discard" | null =>
  mode === "discard-after-run" || mode === "discard-on-application-exit"
    ? "discard"
    : shouldStopRuntime(mode)
      ? "stop"
      : null;

export const assertRuntimeCompletionAllowed = (
  mode: RuntimePersistenceMode,
  protectedRuntime: boolean,
): void => {
  if (runtimeCompletionAction(mode) === "discard" && protectedRuntime)
    throw new Error(
      "Automatic discard is refused for a protected runtime. Choose a data-preserving lifecycle or explicitly unprotect the disposable runtime before execution.",
    );
};

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
  if (runtimeCompletionAction(mode) !== null && canStop()) {
    try {
      stopResult = await withOperationCancellationShield(stop);
      stopped = true;
    } catch (stopError) {
      // The shield has unwound here. A later interruption must not let the
      // outer cancellation owner replace a real cleanup fault with clean130.
      const cancellation = getOperationCancellationSignal();
      if (operationFailed || cancellation?.aborted) {
        throw new AggregateError(
          [operationFailed ? operationError : cancellation!.reason, stopError],
          "The Rehearsal operation failed and its owned runtime could not complete its configured automatic cleanup.",
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
      runtimeState: stopped
        ? runtimeCompletionAction(mode) === "discard"
          ? "removed"
          : "stopped"
        : "running",
      dataState:
        stopped && runtimeCompletionAction(mode) === "discard"
          ? "removed"
          : "preserved",
      stop: stopResult,
    }),
  };
};
