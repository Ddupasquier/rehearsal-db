/** Closed, bounded telemetry schema. No application output, errors, paths, or environment values. */

export const OPERATION_PROGRESS_PHASES = Object.freeze([
  "runtime-lifecycle",
  "dependent-preparation",
  "application-start",
  "application-proof",
  "http-proof",
  "runtime-verification",
  "cleanup",
  "interactive-session",
  "source-preparation",
  "identity-association",
] as const);
export type OperationProgressPhase = (typeof OPERATION_PROGRESS_PHASES)[number];
export type OperationProgressState =
  "running" | "completed" | "failed" | "cancelled";
export type OperationProgressEventCode =
  | "operation.started"
  | "operation.completed"
  | "operation.failed"
  | "operation.cancelled"
  | "stage.started"
  | "stage.completed"
  | "stage.failed"
  | "stage.cancelled";

export interface OperationProgressStage {
  readonly id: number;
  readonly phase: OperationProgressPhase;
  readonly target: string | null;
  readonly state: OperationProgressState;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMilliseconds: number;
}

export interface OperationProgressEvent {
  readonly sequence: number;
  readonly code: OperationProgressEventCode;
  readonly phase: OperationProgressPhase | null;
  readonly target: string | null;
  readonly at: string;
}

export interface OperationProgressSnapshot {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly state: OperationProgressState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMilliseconds: number;
  readonly currentStage: OperationProgressStage | null;
  readonly completedStages: readonly OperationProgressStage[];
  readonly events: readonly OperationProgressEvent[];
  readonly truncated: Readonly<{ stages: boolean; events: boolean }>;
}

export interface RecentOperationProgress {
  readonly kind: string;
  readonly rehearsalVersion: string | null;
  readonly progress: OperationProgressSnapshot;
}

export const MAX_OPERATION_PROGRESS_STAGES = 20;
export const MAX_OPERATION_PROGRESS_EVENTS = 40;
export const MAX_RECENT_OPERATION_PROGRESS = 20;
const STATES = ["running", "completed", "failed", "cancelled"];
const CODES = [
  "operation.started",
  "operation.completed",
  "operation.failed",
  "operation.cancelled",
  "stage.started",
  "stage.completed",
  "stage.failed",
  "stage.cancelled",
];
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const target = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(value));
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));
const phase = (value: unknown): value is OperationProgressPhase =>
  typeof value === "string" &&
  OPERATION_PROGRESS_PHASES.includes(value as OperationProgressPhase);

const validStage = (value: unknown): value is OperationProgressStage =>
  object(value) &&
  keys(value, [
    "id",
    "phase",
    "target",
    "state",
    "startedAt",
    "endedAt",
    "durationMilliseconds",
  ]) &&
  integer(value.id) &&
  value.id > 0 &&
  phase(value.phase) &&
  target(value.target) &&
  typeof value.state === "string" &&
  STATES.includes(value.state) &&
  timestamp(value.startedAt) &&
  (value.state === "running"
    ? value.endedAt === null
    : timestamp(value.endedAt)) &&
  integer(value.durationMilliseconds);

const validEvent = (value: unknown): value is OperationProgressEvent =>
  object(value) &&
  keys(value, ["sequence", "code", "phase", "target", "at"]) &&
  integer(value.sequence) &&
  value.sequence > 0 &&
  typeof value.code === "string" &&
  CODES.includes(value.code) &&
  target(value.target) &&
  timestamp(value.at) &&
  (value.code.startsWith("operation.")
    ? value.phase === null && value.target === null
    : phase(value.phase));

export const parseOperationProgressSnapshot = (
  value: unknown,
): OperationProgressSnapshot => {
  if (
    !object(value) ||
    !keys(value, [
      "schemaVersion",
      "operationId",
      "state",
      "startedAt",
      "updatedAt",
      "elapsedMilliseconds",
      "currentStage",
      "completedStages",
      "events",
      "truncated",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.operationId) ||
    typeof value.state !== "string" ||
    !STATES.includes(value.state) ||
    !timestamp(value.startedAt) ||
    !timestamp(value.updatedAt) ||
    !integer(value.elapsedMilliseconds) ||
    (value.currentStage !== null && !validStage(value.currentStage)) ||
    !Array.isArray(value.completedStages) ||
    value.completedStages.length > MAX_OPERATION_PROGRESS_STAGES ||
    value.completedStages.some(
      (stage) => !validStage(stage) || stage.state !== "completed",
    ) ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_OPERATION_PROGRESS_EVENTS ||
    value.events.some((event) => !validEvent(event)) ||
    !object(value.truncated) ||
    !keys(value.truncated, ["stages", "events"]) ||
    typeof value.truncated.stages !== "boolean" ||
    typeof value.truncated.events !== "boolean"
  ) {
    throw new Error(
      "Operation progress is invalid or exceeds its bounded safe schema.",
    );
  }
  const stages = value.completedStages as OperationProgressStage[];
  const events = value.events as OperationProgressEvent[];
  const currentStage = value.currentStage as OperationProgressStage | null;
  if (
    new Set(stages.map((stage) => stage.id)).size !== stages.length ||
    events.some(
      (event, index) =>
        index > 0 && event.sequence <= events[index - 1]!.sequence,
    )
  )
    throw new Error("Operation progress order or stage identity is invalid.");
  if (
    (value.state === "completed" && value.currentStage !== null) ||
    (value.state === "running" &&
      value.currentStage !== null &&
      value.currentStage.state !== "running") ||
    (value.state !== "running" &&
      value.currentStage !== null &&
      value.currentStage.state === "running")
  )
    throw new Error("Operation progress state is contradictory.");
  if (
    currentStage !== null &&
    stages.some((stage) => stage.id === currentStage.id)
  )
    throw new Error(
      "The current operation stage duplicates completed history.",
    );
  return value as unknown as OperationProgressSnapshot;
};

export const refreshLiveOperationProgress = (
  snapshot: OperationProgressSnapshot,
  now = Date.now(),
): OperationProgressSnapshot =>
  snapshot.state !== "running"
    ? snapshot
    : Object.freeze({
        ...snapshot,
        elapsedMilliseconds: Math.max(
          snapshot.elapsedMilliseconds,
          Math.max(0, now - Date.parse(snapshot.startedAt)),
        ),
        currentStage:
          snapshot.currentStage === null
            ? null
            : Object.freeze({
                ...snapshot.currentStage,
                durationMilliseconds: Math.max(
                  snapshot.currentStage.durationMilliseconds,
                  Math.max(
                    0,
                    now - Date.parse(snapshot.currentStage.startedAt),
                  ),
                ),
              }),
      });
