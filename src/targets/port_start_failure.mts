import type { SpawnSyncReturns } from "node:child_process";

export type PortStartupFailure = "port_in_use" | "port_unavailable";
type StartupCommandResult = Pick<
  SpawnSyncReturns<string>,
  "status" | "stdout" | "stderr" | "error"
>;

/** Recognized bind evidence, never an assertion about the host's root cause. */
export const classifyPortStartupFailure = (
  output: string,
): PortStartupFailure | null => {
  const bounded =
    `${output.slice(0, 64 * 1024)}\n${output.slice(-64 * 1024)}`.replace(
      /\u001b\[[0-?]*[ -/]*[@-~]/gu,
      "",
    );
  if (
    /address already in use|port is already allocated|only one usage of each socket address/iu.test(
      bounded,
    )
  )
    return "port_in_use";
  if (
    /ports? (?:are|is) not available|\b(?:bind|listen)\b[^\n]{0,400}(?:forbidden by its access permissions|permission denied|access is denied|cannot assign requested address|WSAEACCES)|\bsocket\b[^\n]{0,400}forbidden by its access permissions/iu.test(
      bounded,
    )
  )
    return "port_unavailable";
  return null;
};

/** All advice is fixed text: provider output, port numbers and names stay private. */
export const portStartupGuidance = (
  evidence: PortStartupFailure,
  target: "postgresql" | "supabase",
): string =>
  [
    evidence === "port_in_use"
      ? "Port guidance: the provider reported an allocated or occupied local port."
      : "Port guidance: the provider could not bind a requested local port. This does not prove an existing listener or a Windows port reservation; an exclusion or host access policy is possible.",
    target === "postgresql"
      ? "Review runtime.databasePort in the active Rehearsal config and choose a different available local port before retrying."
      : "Review runtime.apiPort, runtime.databasePort and runtime.studioPort in the active Rehearsal config and the matching ports in the dedicated Supabase config; choose an available local port block before retrying.",
    ...(evidence === "port_unavailable"
      ? [
          "For a Windows/WSL Docker host, inspect exclusions in Windows PowerShell (read-only): netsh interface ipv4 show excludedportrange protocol=tcp",
        ]
      : []),
    "Do not kill unknown listeners or change Windows excluded/reserved port ranges to make these ports fit.",
  ].join("\n");

/** Preserve startup failure without echoing Docker arguments, credentials or logs. */
export const assertPostgresqlStartupResult = (
  result: StartupCommandResult,
): void => {
  if (!result.error && result.status === 0) return;
  const portFailure = classifyPortStartupFailure(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  const processCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const processEvidence =
    processCode === "ENOENT"
      ? "docker_unavailable"
      : processCode === "ETIMEDOUT"
        ? "process_timeout"
        : processCode === "ENOBUFS"
          ? "provider_output_limit"
          : null;
  throw new Error(
    [
      `PostgreSQL startup failed (${Number.isInteger(result.status) ? `exit ${result.status}` : "process failure"}).`,
      `Reported startup evidence: ${portFailure ?? processEvidence ?? "unknown; provider supplied no recognized safe failure detail"}.`,
      ...(portFailure ? [portStartupGuidance(portFailure, "postgresql")] : []),
      "Provider logs, command arguments, paths, environment values and connection URLs are omitted. This summary does not establish the underlying cause.",
    ].join("\n"),
  );
};

/** The injected runner retains cancellation and runtime ownership enforcement. */
export const runPostgresqlStartupCommand = (
  runCommand: (
    command: string,
    args: readonly string[],
    options: { capture: boolean; allowFailure: boolean },
  ) => StartupCommandResult,
  args: readonly string[],
): void =>
  assertPostgresqlStartupResult(
    runCommand("docker", args, { capture: true, allowFailure: true }),
  );
