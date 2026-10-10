/** Inspect one owned Supabase runtime without mutating it. */

import {
  parseRuntimeStatusSnapshot,
  RUNTIME_STATUS_SCHEMA_VERSION,
} from "../runtime/status.mjs";
import type { RuntimeStatusSnapshot } from "../runtime/status.mjs";
import type { ProcessEnvironment } from "../shared/process_environment.mjs";
import {
  localCommandSucceeds,
  readLocalSupabaseEnvironment,
  runLocalCommand,
} from "./supabase_environment.mjs";

export const inspectSupabaseRuntimeStatus = async ({
  cwd,
  runtimeWorkdir,
  projectId,
  loadServiceEnvironment,
  baselineGenerationId,
  candidateSha256,
  candidates,
}: {
  cwd: string;
  runtimeWorkdir: string;
  projectId: string;
  loadServiceEnvironment: () => Promise<ProcessEnvironment>;
  baselineGenerationId: string;
  candidateSha256: string;
  candidates: readonly string[];
}): Promise<RuntimeStatusSnapshot> => {
  const engineAvailable = localCommandSucceeds("docker", ["info"], { cwd });
  const serviceEnvironment = engineAvailable
    ? await loadServiceEnvironment()
    : {};
  const runningContainers = engineAvailable
    ? runLocalCommand(
        "docker",
        [
          "ps",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--format",
          "{{.ID}}",
        ],
        { capture: true, cwd },
      )
        .split("\n")
        .filter(Boolean).length
    : 0;
  const healthy =
    runningContainers > 0 &&
    localCommandSucceeds("supabase", ["status", "--workdir", runtimeWorkdir], {
      cwd,
      environment: serviceEnvironment,
    });
  const state = !engineAvailable
    ? "unavailable"
    : runningContainers === 0
      ? "stopped"
      : healthy
        ? "running"
        : "unhealthy";
  const local = healthy
    ? readLocalSupabaseEnvironment({
        cwd,
        workdir: runtimeWorkdir,
        environment: serviceEnvironment,
      })
    : null;
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
    runtimeTarget: "supabase",
    projectId,
    endpoint:
      state === "running" && local ? { kind: "http", url: local.apiUrl } : null,
    baselineGenerationId,
    candidateSha256,
    candidates,
  });
};
