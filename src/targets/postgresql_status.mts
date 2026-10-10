/** Inspect one owned PostgreSQL runtime without mutating it. */

import {
  parseRuntimeStatusSnapshot,
  RUNTIME_STATUS_SCHEMA_VERSION,
} from "../runtime/status.mjs";
import type { RuntimeStatusSnapshot } from "../runtime/status.mjs";

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
}

export const inspectPostgresqlRuntimeStatus = ({
  runCommand,
  containerName,
  databaseUser,
  database,
  databasePort,
  projectId,
  baselineGenerationId,
  candidateSha256,
  candidates,
}: {
  runCommand: (
    command: string,
    args: readonly string[],
    options?: { readonly capture?: boolean; readonly allowFailure?: boolean },
  ) => CommandResult;
  containerName: string;
  databaseUser: string;
  database: string;
  databasePort: number;
  projectId: string;
  baselineGenerationId: string;
  candidateSha256: string;
  candidates: readonly string[];
}): RuntimeStatusSnapshot => {
  const succeeds = (command: string, args: readonly string[]): boolean =>
    runCommand(command, args, { allowFailure: true }).status === 0;
  const engineAvailable = succeeds("docker", ["info"]);
  const containerExists =
    engineAvailable &&
    succeeds("docker", ["container", "inspect", containerName]);
  const containerRunning =
    containerExists &&
    runCommand(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerName],
      { capture: true },
    ).stdout.trim() === "true";
  const healthy =
    containerRunning &&
    succeeds("docker", [
      "exec",
      containerName,
      "pg_isready",
      "--username",
      databaseUser,
      "--dbname",
      database,
    ]);
  const state = !engineAvailable
    ? "unavailable"
    : !containerRunning
      ? "stopped"
      : healthy
        ? "running"
        : "unhealthy";
  return parseRuntimeStatusSnapshot({
    schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
    state,
    reason:
      state === "unavailable"
        ? "container_engine_unavailable"
        : state === "stopped"
          ? "runtime_not_running"
          : state === "unhealthy"
            ? "health_check_failed"
            : null,
    runtimeTarget: "postgresql",
    projectId,
    endpoint:
      state === "running"
        ? {
            kind: "postgresql",
            host: "127.0.0.1",
            port: databasePort,
            database,
          }
        : null,
    baselineGenerationId,
    candidateSha256,
    candidates,
  });
};
