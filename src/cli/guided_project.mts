/** Read-only project state for guided navigation; no setup or runtime mutations. */
import { access, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  findRehearsalConfigPath,
  inspectDetectedProject,
  loadRehearsalConfig,
} from "../project/configuration.mjs";
import type {
  DetectedProject,
  RehearsalConfigPathOptions,
} from "../project/configuration.mjs";
import type { RuntimeTopologyTarget } from "../runtime/lifecycle/topology.mjs";
import { validateRuntimeSanitizationPolicy } from "../baseline/sanitization_policy.mjs";
import { inspectRehearsalNodeRuntime } from "../project/setup.mjs";
import { redactDiagnosticValue } from "../shared/diagnostics.mjs";
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export interface TopologySummary {
  readonly topology: {
    readonly dependents: readonly unknown[];
    readonly targets: readonly RuntimeTopologyTarget[];
  };
}

export interface GuidedState {
  readonly detected: DetectedProject;
  readonly node: ReturnType<typeof inspectRehearsalNodeRuntime>;
  readonly config: "missing" | "invalid" | "valid";
  readonly target?: "supabase" | "postgresql" | "sqlite";
  readonly configPath?: string;
  readonly configError?: string;
  readonly baseline: boolean;
  readonly policy?: "missing" | "needs-review" | "reviewed";
  readonly policyPath?: string;
  readonly policyAbsolutePath?: string;
  readonly migrationSummary?: TopologySummary;
  readonly refreshConfigured?: boolean;
  readonly identityConfigured?: boolean;
  readonly dependentCount?: number;
  readonly runtime: boolean;
}

const pathExists = (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    });

export const inspectGuidedProject = async ({
  projectRoot,
  planOptions,
  topologyCandidateSummary,
}: {
  projectRoot: string;
  planOptions: RehearsalConfigPathOptions;
  topologyCandidateSummary: (
    options: RehearsalConfigPathOptions,
  ) => Promise<TopologySummary>;
}): Promise<GuidedState> => {
  const detected = await inspectDetectedProject({ projectRoot });
  const node = inspectRehearsalNodeRuntime();
  let configPath;
  try {
    configPath = await findRehearsalConfigPath(planOptions);
  } catch (error) {
    if (!errorMessage(error).startsWith("No Rehearsal configuration")) {
      throw error;
    }
  }
  if (!configPath) {
    return {
      detected,
      node,
      config: "missing",
      target: detected.hasSupabaseConfig ? "supabase" : "postgresql",
      baseline: false,
      runtime: false,
    };
  }
  let loaded;
  try {
    loaded = await loadRehearsalConfig(planOptions);
  } catch (error) {
    return {
      detected,
      node,
      config: "invalid",
      configPath,
      configError: String(redactDiagnosticValue(errorMessage(error))),
      baseline: false,
      runtime: false,
    };
  }
  let migrationSummary;
  let topology;
  try {
    const summary = await topologyCandidateSummary(planOptions);
    migrationSummary = summary;
    topology = summary.topology;
  } catch {
    // The doctor command owns the detailed, safely redacted explanation.
  }
  let policy: GuidedState["policy"] = "missing";
  if (await pathExists(loaded.paths.sanitizationPolicy)) {
    try {
      if (loaded.config.runtime.target === "sqlite") {
        if (!migrationSummary)
          throw new Error(
            "A verified SQLite baseline is required before guided execution.",
          );
      } else
        validateRuntimeSanitizationPolicy(
          JSON.parse(await readFile(loaded.paths.sanitizationPolicy, "utf8")),
        );
      policy = "reviewed";
    } catch {
      policy = "needs-review";
    }
  }
  return {
    detected,
    node,
    config: "valid",
    target: loaded.config.runtime.target,
    configPath,
    baseline: Boolean(migrationSummary),
    policy,
    policyPath: relative(projectRoot, loaded.paths.sanitizationPolicy),
    policyAbsolutePath: loaded.paths.sanitizationPolicy,
    ...(migrationSummary === undefined ? {} : { migrationSummary }),
    refreshConfigured: Boolean(loaded.config.preparation),
    identityConfigured: Boolean(loaded.paths.identityPolicy),
    dependentCount: topology?.dependents.length ?? 0,
    runtime: topology
      ? (
          await Promise.all(
            topology.targets.map((target) =>
              pathExists(
                join(
                  target.paths.runtimeWorkdir,
                  ...(target.config.runtime.target === "sqlite"
                    ? ["sqlite", "runtime.json"]
                    : ["baseline.json"]),
                ),
              ),
            ),
          )
        ).every(Boolean)
      : await pathExists(
          join(
            loaded.paths.runtimeWorkdir,
            ...(loaded.config.runtime.target === "sqlite"
              ? ["sqlite", "runtime.json"]
              : ["baseline.json"]),
          ),
        ),
  };
};
