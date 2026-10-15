/** Read-only stack planning and candidate receipts, shared by CLI and editor contracts. */
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import { buildRehearsalPlan, runRehearsalDoctor } from "../runtime/plan.mjs";
import {
  inspectRuntimeTopologyCandidates,
  loadRuntimeTopology,
} from "../runtime/topology.mjs";
import type { RuntimeTopologyTarget } from "../runtime/topology.mjs";
import { redactDiagnosticValue } from "../shared/diagnostics.mjs";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const buildRuntimeStackPlan = async (
  planOptions: RehearsalConfigPathOptions,
) => {
  const topology = await loadRuntimeTopology(planOptions);
  if (topology.targets.length === 1) return buildRehearsalPlan(planOptions);
  const targets: Array<{
    name: string;
    declaration: RuntimeTopologyTarget["declaration"];
    plan: Awaited<ReturnType<typeof buildRehearsalPlan>>;
  }> = [];
  for (const target of topology.targets) {
    targets.push({
      name: target.name,
      declaration: target.declaration,
      plan: await buildRehearsalPlan({
        projectRoot: topology.projectRoot,
        configPath: target.configPath,
      }),
    });
  }
  const candidates = await inspectRuntimeTopologyCandidates(planOptions);
  const primaryPlan = targets[0]!.plan;
  return {
    config: primaryPlan.config,
    environment: primaryPlan.environment,
    application: primaryPlan.application,
    cleanup: primaryPlan.cleanup,
    targets,
    migrations: {
      candidateCount: candidates.candidateCount,
      candidateSha256: candidates.candidateSha256,
    },
    lifecycle: {
      run: topology.primary.config.lifecycle.run,
      open: topology.primary.config.lifecycle.open,
      openIdleTimeoutSeconds:
        topology.primary.config.lifecycle.openIdleTimeoutSeconds,
      dataOnStop: "preserved",
    },
    execution: [
      "verify every immutable baseline and migration prefix",
      "restore and migrate the primary runtime",
      "restore and migrate each dependent runtime in declared order",
      ...topology.dependents
        .filter(
          (
            target,
          ): target is RuntimeTopologyTarget & {
            declaration: NonNullable<RuntimeTopologyTarget["declaration"]>;
          } => Boolean(target.declaration?.prepareCommand),
        )
        .map(
          (target) =>
            `run ${target.name} preparation: ${target.declaration.prepareCommand}`,
        ),
      ...topology.dependents.map(
        (target) =>
          `run ${target.name} proof: ${target.config.application.proofCommand}`,
      ),
      `run primary proof: ${topology.primary.config.application.proofCommand}`,
      topology.primary.config.lifecycle.run === "stop-after-run"
        ? "stop every database target after proofs while preserving its data"
        : "keep every database target available until an explicit stop",
    ],
    guarantee:
      "Every database target is isolated by its own project ID, ports, artifact directory, and local-only safety policy. No production resources will be contacted.",
  };
};

export const runRuntimeStackDoctor = async (
  planOptions: RehearsalConfigPathOptions,
) => {
  let topology;
  try {
    topology = await loadRuntimeTopology(planOptions);
  } catch (error) {
    if (
      errorMessage(error).startsWith("No Rehearsal configuration was found")
    ) {
      return runRehearsalDoctor(planOptions);
    }
    return {
      state: "NOT READY",
      checks: [
        {
          id: "runtime-topology",
          label: "Dependent runtime isolation",
          status: "fail",
          detail: String(redactDiagnosticValue(errorMessage(error))),
          remediation:
            "Give every target a readable config with unique ports, project ID, environment file, and .rehearsal artifact directory.",
        },
      ],
      ambientHostedVariables: {
        presentButQuarantined: [],
        note: "Topology validation stopped before any runtime action.",
      },
    };
  }
  if (topology.targets.length === 1) return runRehearsalDoctor(planOptions);
  const reports = [];
  for (const target of topology.targets) {
    reports.push({
      target: target.name,
      report: await runRehearsalDoctor({
        projectRoot: topology.projectRoot,
        configPath: target.configPath,
      }),
    });
  }
  return {
    state: reports.every(({ report }) => report.state === "READY")
      ? "READY"
      : "NOT READY",
    checks: reports.flatMap(({ target, report }) =>
      report.checks.map((check) => ({
        ...check,
        id: `${target}:${check.id}`,
        label: `${target}: ${check.label}`,
      })),
    ),
    ambientHostedVariables: {
      presentButQuarantined: [
        ...new Set(
          reports.flatMap(
            ({ report }) =>
              report.ambientHostedVariables?.presentButQuarantined ?? [],
          ),
        ),
      ],
      note: "Blocked ambient values are not inherited by Rehearsal child processes.",
    },
  };
};

export const topologyCandidateSummary = async (
  planOptions: RehearsalConfigPathOptions,
) => {
  const inspection = await inspectRuntimeTopologyCandidates(planOptions);
  const targets = inspection.targets.map((target) => ({
    name: target.name,
    configPath: target.configPath,
    baselineGenerationId: target.summary.baselineGenerationId,
    candidateSha256: target.summary.candidateSha256,
    candidateCount: target.summary.candidateCount,
    candidates: target.summary.candidates,
  }));
  return {
    baselineGenerationId: targets[0]!.baselineGenerationId,
    candidateSha256: inspection.candidateSha256,
    candidateCount: inspection.candidateCount,
    candidates: targets.flatMap((target) =>
      target.candidates.map((candidate) => ({
        ...candidate,
        target: target.name,
      })),
    ),
    targets,
    topology: inspection.topology,
  };
};
