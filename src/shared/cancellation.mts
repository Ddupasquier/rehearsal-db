/** Cooperative cancellation state for one mutating CLI operation. */

import type { EventEmitter } from "node:events";
import { RehearsalError } from "./diagnostics.mjs";

export const OPERATION_CANCELLATION_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGTSTP",
] as const;
export type OperationCancellationSignal =
  (typeof OPERATION_CANCELLATION_SIGNALS)[number];

type SignalTarget = Pick<EventEmitter, "prependListener" | "removeListener">;

const CANCELLABLE_COMMANDS = new Set(["migrate", "refresh", "reset", "run"]);

let activeSignal: AbortSignal | undefined;
let shieldDepth = 0;

export const supportsOperationCancellation = (command: string): boolean =>
  CANCELLABLE_COMMANDS.has(command);

export const createOperationCancelledError = (
  signal: OperationCancellationSignal,
): RehearsalError =>
  new RehearsalError({
    category: "operation_cancelled",
    code: "OPERATION_CANCELLED",
    message: `The Rehearsal operation was cancelled by ${signal}.`,
    expected: "the owned operation to finish or roll back before exiting",
    actual: `interrupted by ${signal}`,
    context: { signal },
    refused: "No further operation phase was started.",
    suggestions: [
      "Run rehearsal activity, then rehearsal status and rehearsal verify before retrying.",
    ],
  });

export const isOperationCancelled = (error: unknown): boolean =>
  error instanceof RehearsalError && error.category === "operation_cancelled";

export const getOperationCancellationSignal = (): AbortSignal | undefined =>
  shieldDepth > 0 ? undefined : activeSignal;

export const throwIfOperationCancelled = (): void => {
  const signal = getOperationCancellationSignal();
  if (signal?.aborted) throw signal.reason;
};

export const reachOperationCancellationCheckpoint = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfOperationCancelled();
};

export const withOperationCancellationShield = async <Value,>(
  task: () => Promise<Value>,
): Promise<Value> => {
  shieldDepth += 1;
  try {
    return await task();
  } finally {
    shieldDepth -= 1;
  }
};

export const runWithOperationCancellation = async <Value,>({
  task,
  signalTarget = process,
}: {
  task: (signal: AbortSignal) => Promise<Value>;
  signalTarget?: SignalTarget;
}): Promise<Value> => {
  if (activeSignal) {
    throw new Error("A cancellable Rehearsal operation is already active.");
  }
  const controller = new AbortController();
  activeSignal = controller.signal;
  const handlers = new Map(
    OPERATION_CANCELLATION_SIGNALS.map((signal) => [
      signal,
      () => {
        if (!controller.signal.aborted) {
          controller.abort(createOperationCancelledError(signal));
        }
      },
    ]),
  );
  for (const [signal, handler] of handlers) {
    signalTarget.prependListener(signal, handler);
  }
  try {
    const result = await task(controller.signal);
    throwIfOperationCancelled();
    return result;
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof AggregateError)) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    for (const [signal, handler] of handlers) {
      signalTarget.removeListener(signal, handler);
    }
    activeSignal = undefined;
    shieldDepth = 0;
  }
};
