/** Public, privacy-safe runtime status shared by runtime drivers and the CLI. */

import { isLoopbackUrl } from "../shared/process_environment.mjs";
import type { RehearsalRuntimeTargetId } from "../targets/target.mjs";

export const RUNTIME_STATUS_SCHEMA_VERSION = 1 as const;

export type RuntimeState = "running" | "stopped" | "unavailable" | "unhealthy";

export type RuntimeStateReason =
  | "container_engine_unavailable"
  | "runtime_not_running"
  | "health_check_failed";

export interface RuntimeStatusSnapshot {
  readonly schemaVersion: typeof RUNTIME_STATUS_SCHEMA_VERSION;
  readonly state: RuntimeState;
  readonly reason: RuntimeStateReason | null;
  readonly runtimeTarget: RehearsalRuntimeTargetId;
  readonly projectId: string;
  readonly endpoint:
    | Readonly<{ kind: "http"; url: string }>
    | Readonly<{
        kind: "postgresql";
        host: "127.0.0.1" | "localhost" | "::1";
        port: number;
        database: string;
      }>
    | null;
  readonly baselineGenerationId: string;
  readonly candidateSha256: string;
  readonly candidates: readonly string[];
}

const STATES = new Set<RuntimeState>([
  "running",
  "stopped",
  "unavailable",
  "unhealthy",
]);
const REASONS = new Set<RuntimeStateReason>([
  "container_engine_unavailable",
  "runtime_not_running",
  "health_check_failed",
]);
const TARGETS = new Set<RehearsalRuntimeTargetId>(["supabase", "postgresql"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Runtime status ${key} must be a non-empty string.`);
  }
  return value;
};

const parseEndpoint = (value: unknown): RuntimeStatusSnapshot["endpoint"] => {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error("Runtime status endpoint must be an object or null.");
  }
  if (value.kind === "http") {
    const url = requiredString(value, "url");
    if (!isLoopbackUrl(url)) {
      throw new Error("Runtime status refused a non-loopback HTTP endpoint.");
    }
    return { kind: "http", url };
  }
  if (value.kind === "postgresql") {
    const host = requiredString(value, "host");
    const database = requiredString(value, "database");
    const port = value.port;
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error("Runtime status refused a non-loopback PostgreSQL host.");
    }
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new Error("Runtime status PostgreSQL port is invalid.");
    }
    return {
      kind: "postgresql",
      host: host as "127.0.0.1" | "localhost" | "::1",
      port: Number(port),
      database,
    };
  }
  throw new Error("Runtime status endpoint kind is unsupported.");
};

export const parseRuntimeStatusSnapshot = (
  value: unknown,
): RuntimeStatusSnapshot => {
  if (!isRecord(value)) throw new Error("Runtime status must be an object.");
  if (value.schemaVersion !== RUNTIME_STATUS_SCHEMA_VERSION) {
    throw new Error("Runtime status schema version is unsupported.");
  }
  if (
    typeof value.state !== "string" ||
    !STATES.has(value.state as RuntimeState)
  ) {
    throw new Error("Runtime status state is unsupported.");
  }
  if (
    value.reason !== null &&
    (typeof value.reason !== "string" ||
      !REASONS.has(value.reason as RuntimeStateReason))
  ) {
    throw new Error("Runtime status reason is unsupported.");
  }
  if (
    typeof value.runtimeTarget !== "string" ||
    !TARGETS.has(value.runtimeTarget as RehearsalRuntimeTargetId)
  ) {
    throw new Error("Runtime status target is unsupported.");
  }
  const candidateSha256 = requiredString(value, "candidateSha256");
  if (!SHA256_PATTERN.test(candidateSha256)) {
    throw new Error("Runtime status candidate digest is invalid.");
  }
  if (
    !Array.isArray(value.candidates) ||
    !value.candidates.every(
      (candidate) => typeof candidate === "string" && candidate.length > 0,
    )
  ) {
    throw new Error("Runtime status candidates must be non-empty strings.");
  }
  const endpoint = parseEndpoint(value.endpoint);
  const expectedReason: RuntimeStateReason | null =
    value.state === "running"
      ? null
      : value.state === "stopped"
        ? "runtime_not_running"
        : value.state === "unavailable"
          ? "container_engine_unavailable"
          : "health_check_failed";
  if (value.reason !== expectedReason) {
    throw new Error("Runtime status reason does not match its state.");
  }
  if (value.state === "running" && endpoint === null) {
    throw new Error(
      "A running runtime status must include its local endpoint.",
    );
  }
  if (value.state !== "running" && endpoint !== null) {
    throw new Error("Only a running runtime status may include an endpoint.");
  }
  if (
    endpoint !== null &&
    ((value.runtimeTarget === "supabase" && endpoint.kind !== "http") ||
      (value.runtimeTarget === "postgresql" && endpoint.kind !== "postgresql"))
  ) {
    throw new Error("Runtime status endpoint does not match its target.");
  }
  return Object.freeze({
    schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
    state: value.state as RuntimeState,
    reason: value.reason as RuntimeStateReason | null,
    runtimeTarget: value.runtimeTarget as RehearsalRuntimeTargetId,
    projectId: requiredString(value, "projectId"),
    endpoint,
    baselineGenerationId: requiredString(value, "baselineGenerationId"),
    candidateSha256,
    candidates: Object.freeze([...value.candidates] as string[]),
  });
};

export const renderRuntimeStatusSnapshot = (
  status: RuntimeStatusSnapshot,
): string => {
  const label = status.runtimeTarget === "supabase" ? "Supabase" : "PostgreSQL";
  const location =
    status.endpoint?.kind === "http"
      ? status.endpoint.url
      : status.endpoint?.kind === "postgresql"
        ? `${status.endpoint.host}:${status.endpoint.port}`
        : null;
  const state =
    status.state === "running" && location
      ? `running ${status.runtimeTarget === "supabase" ? "at" : "on"} ${location}`
      : status.state === "unavailable"
        ? "unavailable (the container engine is not available)"
        : status.state === "unhealthy"
          ? "unhealthy (the runtime health check did not pass)"
          : "stopped";
  return [
    `Local Rehearsal ${label}: ${state}`,
    `Active sanitized baseline: ${status.baselineGenerationId}`,
    `Candidate migrations (${status.candidateSha256}): ${status.candidates.join(", ") || "none"}`,
  ].join("\n");
};

export const emitRuntimeStatusSnapshot = ({
  status,
  structured,
}: {
  status: RuntimeStatusSnapshot;
  structured: boolean;
}): void => {
  console.log(
    structured ? JSON.stringify(status) : renderRuntimeStatusSnapshot(status),
  );
};
