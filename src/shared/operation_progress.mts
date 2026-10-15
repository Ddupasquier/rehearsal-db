/** Explicit async-context telemetry for one owned operation; never captures raw output. */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { ProjectOperation } from "./operation_guard.mjs";
import { isOperationCancelled } from "./cancellation.mjs";
import {
  MAX_OPERATION_PROGRESS_EVENTS,
  MAX_OPERATION_PROGRESS_STAGES,
  OPERATION_PROGRESS_PHASES,
  parseOperationProgressSnapshot,
  type OperationProgressEvent,
  type OperationProgressEventCode,
  type OperationProgressPhase,
  type OperationProgressSnapshot,
  type OperationProgressStage,
  type OperationProgressState,
} from "./operation_progress_contract.mjs";
export type {
  OperationProgressSnapshot,
  OperationProgressStage,
  OperationProgressEvent,
} from "./operation_progress_contract.mjs";

interface RunningStage {
  readonly stage: OperationProgressStage;
  readonly startedMs: number;
}
interface ProgressContext {
  readonly operation: ProjectOperation;
  readonly startedMs: number;
  readonly initialElapsed: number;
  readonly now: () => Date;
  state: OperationProgressState;
  sequence: number;
  stageId: number;
  completed: OperationProgressStage[];
  active: RunningStage[];
  lastFailed: OperationProgressStage | null;
  events: OperationProgressEvent[];
  stageTruncated: boolean;
  eventTruncated: boolean;
  writes: Promise<void>;
}
const contexts = new AsyncLocalStorage<ProgressContext>();
export const getOwnedOperationProgressId = (): string | null =>
  contexts.getStore()?.operation.id ?? null;

const appendEvent = (
  context: ProgressContext,
  code: OperationProgressEventCode,
  stage: OperationProgressStage | null = null,
): void => {
  context.sequence += 1;
  context.events.push(
    Object.freeze({
      sequence: context.sequence,
      code,
      phase: stage?.phase ?? null,
      target: stage?.target ?? null,
      at: context.now().toISOString(),
    }),
  );
  if (context.events.length > MAX_OPERATION_PROGRESS_EVENTS) {
    context.events.shift();
    context.eventTruncated = true;
  }
};

const snapshot = (context: ProgressContext): OperationProgressSnapshot => {
  const running = context.active.at(-1);
  const current =
    context.state === "running" && running
      ? Object.freeze({
          ...running.stage,
          durationMilliseconds: Math.max(
            0,
            Math.round(performance.now() - running.startedMs),
          ),
        })
      : context.state === "failed" || context.state === "cancelled"
        ? context.lastFailed
        : null;
  return Object.freeze({
    schemaVersion: 1,
    operationId: context.operation.id,
    state: context.state,
    startedAt: context.operation.startedAt,
    updatedAt: context.now().toISOString(),
    elapsedMilliseconds: Math.max(
      0,
      Math.round(
        context.initialElapsed + performance.now() - context.startedMs,
      ),
    ),
    currentStage: current,
    completedStages: Object.freeze([...context.completed]),
    events: Object.freeze([...context.events]),
    truncated: Object.freeze({
      stages: context.stageTruncated,
      events: context.eventTruncated,
    }),
  });
};

const publish = async (context: ProgressContext): Promise<void> => {
  const value = parseOperationProgressSnapshot(snapshot(context));
  context.writes = context.writes.then(() =>
    context.operation.writeProgress(value),
  );
  await context.writes;
};

export const withOperationProgress = async <Value,>({
  operation,
  task,
  now = () => new Date(),
}: {
  readonly operation: ProjectOperation | null;
  readonly task: () => Promise<Value>;
  readonly now?: () => Date;
}): Promise<Value> => {
  if (operation === null) return task();
  if (contexts.getStore())
    throw new Error(
      "An operation progress context is already active in this async task.",
    );
  const context: ProgressContext = {
    operation,
    startedMs: performance.now(),
    initialElapsed: Math.max(
      0,
      now().getTime() - Date.parse(operation.startedAt),
    ),
    now,
    state: "running",
    sequence: 0,
    stageId: 0,
    completed: [],
    active: [],
    lastFailed: null,
    events: [],
    stageTruncated: false,
    eventTruncated: false,
    writes: Promise.resolve(),
  };
  return contexts.run(context, async () => {
    appendEvent(context, "operation.started");
    await publish(context);
    try {
      const result = await task();
      if (context.active.length > 0)
        throw new Error(
          "An operation cannot finish while owned progress stages are still running.",
        );
      context.state = "completed";
      appendEvent(context, "operation.completed");
      await publish(context);
      return result;
    } catch (error) {
      context.state = isOperationCancelled(error) ? "cancelled" : "failed";
      appendEvent(
        context,
        context.state === "cancelled"
          ? "operation.cancelled"
          : "operation.failed",
      );
      try {
        await publish(context);
      } catch {
        /* Preserve the actual operation error; unavailable telemetry is not fabricated. */
      }
      throw error;
    }
  });
};

export const trackOperationStage = async <Value,>(
  {
    phase,
    target = null,
  }: {
    readonly phase: OperationProgressPhase;
    readonly target?: string | null;
  },
  task: () => Promise<Value>,
): Promise<Value> => {
  const context = contexts.getStore();
  if (!context) return task();
  if (
    context.state !== "running" ||
    !OPERATION_PROGRESS_PHASES.includes(phase) ||
    (target !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(target)) ||
    context.active.length >= 10
  )
    throw new Error(
      "Operation stage metadata is unsafe or exceeds its concurrency bound.",
    );
  const stage: OperationProgressStage = Object.freeze({
    id: ++context.stageId,
    phase,
    target,
    state: "running",
    startedAt: context.now().toISOString(),
    endedAt: null,
    durationMilliseconds: 0,
  });
  const running: RunningStage = { stage, startedMs: performance.now() };
  context.active.push(running);
  appendEvent(context, "stage.started", stage);
  await publish(context);
  const finish = (state: "completed" | "failed" | "cancelled") => {
    context.active = context.active.filter((entry) => entry !== running);
    const ended = Object.freeze({
      ...stage,
      state,
      endedAt: context.now().toISOString(),
      durationMilliseconds: Math.max(
        0,
        Math.round(performance.now() - running.startedMs),
      ),
    });
    if (state === "completed") {
      context.completed.push(ended);
      if (context.completed.length > MAX_OPERATION_PROGRESS_STAGES) {
        context.completed.shift();
        context.stageTruncated = true;
      }
    } else context.lastFailed = ended;
    appendEvent(
      context,
      state === "completed"
        ? "stage.completed"
        : state === "cancelled"
          ? "stage.cancelled"
          : "stage.failed",
      ended,
    );
  };
  let result: Value;
  try {
    result = await task();
  } catch (error) {
    finish(isOperationCancelled(error) ? "cancelled" : "failed");
    try {
      await publish(context);
    } catch {
      /* No arbitrary error text enters progress. */
    }
    throw error;
  }
  finish("completed");
  await publish(context);
  return result;
};
