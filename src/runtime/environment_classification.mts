/** Orthogonal, read-only environment facts. None of these annotations authorizes an action. */
import type { EnvironmentProvenance } from "./resource_provenance.mjs";

export interface EnvironmentClassification {
  readonly schemaVersion: 1;
  readonly role: "configured-environment";
  readonly dataPersistence: "preserved-on-stop";
  readonly presence: {
    readonly state: "created" | "not-created" | "unknown";
    readonly reason:
      | "owned-resources-observed"
      | "no-owned-resources-observed"
      | "ownership-inspection-unavailable";
  };
  readonly receipt: {
    readonly state: "compatible" | "incompatible" | "unknown";
    readonly reason:
      | "supported-receipt-format-and-provider"
      | "receipt-invalid"
      | "receipt-unavailable"
      | "provider-not-recorded"
      | "receipt-binding-mismatch";
    readonly scope: "format-and-provider-only";
  };
  readonly review: ObservableEnvironmentReview;
}

export interface ObservableEnvironmentReview {
  readonly state: "due" | "not-due" | "disabled" | "unknown";
  readonly reason:
    | "observable-cutoff-exceeded"
    | "recent-observable-activity"
    | "not-running"
    | "cutoff-disabled"
    | "ownership-inspection-unavailable"
    | "observable-activity-unavailable";
  readonly staleAfterSeconds: number | null;
  readonly lastObservableActivityAt: string | null;
}

export const observableContainerTime = (
  value: unknown,
  now: Date,
): string | null => {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    timestamp > 0 &&
    timestamp <= now.getTime()
    ? value
    : null;
};

/** Shared with the exact stop-stale planner; resource age never proves user/database inactivity. */
export const evaluateObservableEnvironmentReview = ({
  inspectionAvailable,
  staleAfterSeconds,
  containers,
  now,
}: {
  readonly inspectionAvailable: boolean;
  readonly staleAfterSeconds: number | null;
  readonly containers: readonly {
    readonly running: boolean | undefined;
    readonly startedAt: unknown;
    readonly finishedAt: unknown;
  }[];
  readonly now: Date;
}): ObservableEnvironmentReview => {
  const result = (
    state: ObservableEnvironmentReview["state"],
    reason: ObservableEnvironmentReview["reason"],
    lastObservableActivityAt: string | null = null,
  ): ObservableEnvironmentReview => ({
    state,
    reason,
    staleAfterSeconds,
    lastObservableActivityAt,
  });
  if (!inspectionAvailable)
    return result("unknown", "ownership-inspection-unavailable");
  if (staleAfterSeconds === null) return result("disabled", "cutoff-disabled");
  if (
    !Number.isSafeInteger(staleAfterSeconds) ||
    staleAfterSeconds < 1 ||
    !Number.isFinite(now.getTime()) ||
    containers.some((entry) => typeof entry.running !== "boolean")
  )
    return result("unknown", "observable-activity-unavailable");
  if (!containers.some((entry) => entry.running === true))
    return result("not-due", "not-running");
  const observed = containers.map((entry) => ({
    running: entry.running,
    startedAt: observableContainerTime(entry.startedAt, now),
    finishedAt: observableContainerTime(entry.finishedAt, now),
  }));
  if (observed.some((entry) => entry.running && entry.startedAt === null))
    return result("unknown", "observable-activity-unavailable");
  const last = observed
    .flatMap((entry) => [entry.startedAt, entry.finishedAt])
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  if (!last) return result("unknown", "observable-activity-unavailable");
  return now.getTime() - Date.parse(last) >= staleAfterSeconds * 1000
    ? result("due", "observable-cutoff-exceeded", last)
    : result("not-due", "recent-observable-activity", last);
};

export const classifyConfiguredEnvironment = ({
  inspectionAvailable,
  containerCount,
  volumeCount,
  provenance,
  providerRecorded,
  staleAfterSeconds,
  containers,
  now,
}: {
  readonly inspectionAvailable: boolean;
  readonly containerCount: number;
  readonly volumeCount: number;
  readonly provenance: EnvironmentProvenance;
  readonly providerRecorded: boolean;
  readonly staleAfterSeconds: number | null;
  readonly containers: Parameters<
    typeof evaluateObservableEnvironmentReview
  >[0]["containers"];
  readonly now: Date;
}): EnvironmentClassification => {
  const available =
    inspectionAvailable &&
    [containerCount, volumeCount].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    );
  const presence: EnvironmentClassification["presence"] = !available
    ? { state: "unknown", reason: "ownership-inspection-unavailable" }
    : containerCount > 0 || volumeCount > 0
      ? { state: "created", reason: "owned-resources-observed" }
      : { state: "not-created", reason: "no-owned-resources-observed" };
  const receiptState = (
    state: EnvironmentClassification["receipt"]["state"],
    reason: EnvironmentClassification["receipt"]["reason"],
  ): EnvironmentClassification["receipt"] => ({
    state,
    reason,
    scope: "format-and-provider-only",
  });
  const receipt =
    provenance.runtimeReason === "receipt-invalid"
      ? receiptState("incompatible", "receipt-invalid")
      : !provenance.runtime
        ? receiptState("unknown", "receipt-unavailable")
        : provenance.runtime.migrationReason ===
            "receipt-does-not-match-baseline"
          ? receiptState("incompatible", "receipt-binding-mismatch")
          : !providerRecorded
            ? receiptState("unknown", "provider-not-recorded")
            : receiptState(
                "compatible",
                "supported-receipt-format-and-provider",
              );
  return {
    schemaVersion: 1,
    role: "configured-environment",
    dataPersistence: "preserved-on-stop",
    presence,
    receipt,
    review: evaluateObservableEnvironmentReview({
      inspectionAvailable: available,
      staleAfterSeconds,
      containers,
      now,
    }),
  };
};
