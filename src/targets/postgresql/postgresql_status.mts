/** Inspect one owned PostgreSQL runtime without mutating it. */

import {
  parseRuntimeStatusSnapshot,
  RUNTIME_STATUS_SCHEMA_VERSION,
} from "../../runtime/lifecycle/status.mjs";
import type { RuntimeStatusSnapshot } from "../../runtime/lifecycle/status.mjs";
import { hasMatchingRuntimeMarker } from "../../runtime/lifecycle/lifecycle_engine.mjs";

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
}

export const inspectPostgresqlRuntimeStatus = async ({
  runCommand,
  containerName,
  databaseUser,
  database,
  databasePort,
  projectId,
  runtimeMarkerPath,
  baselineDataSha256,
  image,
  baselineGenerationId,
  candidateSha256,
  candidates,
}: {
  runCommand: (
    command: string,
    args: readonly string[],
    options?: { readonly capture?: boolean; readonly allowFailure?: boolean },
  ) => CommandResult | Promise<CommandResult>;
  containerName: string;
  databaseUser: string;
  database: string;
  databasePort: number;
  projectId: string;
  runtimeMarkerPath: string;
  baselineDataSha256: string;
  image: string;
  baselineGenerationId: string;
  candidateSha256: string;
  candidates: readonly string[];
}): Promise<RuntimeStatusSnapshot> => {
  const verifiedRuntimeAvailable = await hasMatchingRuntimeMarker({
    path: runtimeMarkerPath,
    expected: {
      target: "postgresql",
      generationId: baselineGenerationId,
      dataSha256: baselineDataSha256,
      image,
    },
    validate: (marker) =>
      typeof marker.databasePassword === "string" &&
      marker.databasePassword.length >= 32,
  });
  const succeeds = async (
    command: string,
    args: readonly string[],
  ): Promise<boolean> =>
    (await runCommand(command, args, { allowFailure: true })).status === 0;
  const engineAvailable = await succeeds("docker", ["info"]);
  const containerIds = engineAvailable
    ? await runCommand(
        "docker",
        [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `name=^/${containerName}$`,
          "--format",
          "{{.ID}}",
        ],
        { capture: true },
      )
    : null;
  if (
    containerIds &&
    (containerIds.status !== 0 ||
      (containerIds.stdout.trim() !== "" &&
        !/^[a-f0-9]{64}$/u.test(containerIds.stdout.trim())))
  )
    throw new Error(
      "PostgreSQL runtime presence is unconfirmed; no stopped state was inferred.",
    );
  const containerExists = Boolean(containerIds?.stdout.trim());
  const running = containerExists
    ? await runCommand(
        "docker",
        [
          "inspect",
          "--format",
          "{{.State.Running}}",
          containerIds!.stdout.trim(),
        ],
        { capture: true },
      )
    : null;
  if (
    running &&
    (running.status !== 0 || !["true", "false"].includes(running.stdout.trim()))
  )
    throw new Error(
      "PostgreSQL runtime state is unconfirmed; no stopped state was inferred.",
    );
  const containerRunning = running?.stdout.trim() === "true";
  const healthy =
    containerRunning &&
    (await succeeds("docker", [
      "exec",
      containerName,
      "pg_isready",
      "--username",
      databaseUser,
      "--dbname",
      database,
    ]));
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
    verifiedRuntimeAvailable,
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
