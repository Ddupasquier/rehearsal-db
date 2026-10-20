/** Summarize provider startup evidence without retaining container logs or secrets. */
import {
  classifyPortStartupFailure,
  portStartupGuidance,
} from "./port_start_failure.mjs";

const SERVICE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  db: "database",
  auth: "auth",
  storage: "storage",
  rest: "postgrest",
  kong: "gateway",
  inbucket: "mail",
  studio: "studio",
  realtime: "realtime",
  edge_runtime: "edge-functions",
  analytics: "analytics",
  imgproxy: "image-transforms",
  pg_meta: "database-metadata",
  pooler: "pooler",
  vector: "log-collector",
});

const REASONS = Object.freeze([
  ["out_of_memory", /out of memory|oom[- ]killed|memory allocation failed/iu],
  ["disk_full", /no space left on device|disk quota exceeded/iu],
  ["image_architecture", /exec format error/iu],
  ["image_pull", /failed to pull|pull access denied|manifest unknown/iu],
  [
    "engine_unavailable",
    /cannot connect to (?:the )?docker daemon|docker daemon is not running/iu,
  ],
  [
    "health_check",
    /container is not (?:ready|running)|health.?check.*(?:failed|timeout|timed out)|unexpected status [1-5][0-9]{2}/iu,
  ],
] as const);

/** Only fixed reason codes and allowlisted service/state names leave this boundary. */
export const summarizeSupabaseStartupFailure = ({
  output,
  status,
  processErrorCode,
}: {
  output: string;
  status: number | null;
  processErrorCode?: string;
}): string => {
  const bounded =
    `${output.slice(0, 64 * 1024)}\n${output.slice(-64 * 1024)}`.replace(
      /\u001b\[[0-?]*[ -/]*[@-~]/gu,
      "",
    );
  const reasons = new Set<string>();
  if (processErrorCode === "ENOENT") reasons.add("cli_unavailable");
  if (processErrorCode === "ETIMEDOUT") reasons.add("process_timeout");
  if (processErrorCode === "ENOBUFS") reasons.add("provider_output_limit");
  const portFailure = classifyPortStartupFailure(bounded);
  if (portFailure) reasons.add(portFailure);
  for (const [code, pattern] of REASONS)
    if (pattern.test(bounded)) reasons.add(code);
  const services = new Set<string>();
  for (const line of bounded.split("\n")) {
    const match = line
      .trim()
      .match(
        /^(?:Error:\s*)?supabase_([a-z_]+)_[a-z0-9-]+\s+(?:container is not (?:ready|running):\s*(starting|unhealthy|exited|dead|created|paused|restarting)|unexpected status ([1-5][0-9]{2}))\s*$/iu,
      );
    const service = match?.[1]
      ? SERVICE_NAMES[match[1].toLowerCase()]
      : undefined;
    if (service)
      services.add(
        `${service}=${match?.[2]?.toLowerCase() ?? `http_${match?.[3]}`}`,
      );
  }
  return [
    `Supabase startup failed (${Number.isInteger(status) ? `exit ${status}` : "process failure"}).`,
    `Reported startup evidence: ${reasons.size ? [...reasons].join(", ") : "unknown; provider supplied no recognized safe failure detail"}.`,
    ...(services.size
      ? [`Reported service states: ${[...services].slice(0, 16).join(", ")}.`]
      : []),
    ...(portFailure ? [portStartupGuidance(portFailure, "supabase")] : []),
    "Provider logs, paths, environment values and connection URLs are omitted. This summary does not establish the underlying cause.",
  ].join("\n");
};
