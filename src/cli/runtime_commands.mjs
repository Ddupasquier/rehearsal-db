/**
 * CLI orchestration for one or more isolated database runtimes and their
 * project-owned proof commands.
 */

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as prompts from "@clack/prompts";
import {
  holdApplicationSession,
  startApplicationSession,
  summarizeProjectCommandFailure,
} from "../application/session.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { buildRehearsalPlan, runRehearsalDoctor } from "../runtime/plan.mjs";
import {
  inspectRuntimeTopologyCandidates,
  loadRuntimeTopology,
} from "../runtime/topology.mjs";
import {
  RehearsalError,
  normalizeRehearsalError,
  redactDiagnosticValue,
} from "../shared/diagnostics.mjs";
import { assertInstalledPackageFingerprint } from "../shared/operation_guard.mjs";
import { buildRuntimeManagerArguments } from "../targets/target.mjs";
import {
  formatDuration,
  isHumanTerminal,
  promptForConfirmation,
  terminalStyle,
  useStyledPrompts,
} from "./terminal.mjs";

export const buildRuntimeStackPlan = async (planOptions) => {
  const topology = await loadRuntimeTopology(planOptions);
  if (topology.targets.length === 1) return buildRehearsalPlan(planOptions);
  const targets = [];
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
  return {
    targets,
    migrations: {
      candidateCount: candidates.candidateCount,
      candidateSha256: candidates.candidateSha256,
    },
    execution: [
      "verify every immutable baseline and migration prefix",
      "restore and migrate the primary runtime",
      "restore and migrate each dependent runtime in declared order",
      ...topology.dependents
        .filter((target) => target.declaration.prepareCommand)
        .map(
          (target) =>
            `run ${target.name} preparation: ${target.declaration.prepareCommand}`,
        ),
      ...topology.dependents.map(
        (target) =>
          `run ${target.name} proof: ${target.config.application.proofCommand}`,
      ),
      `run primary proof: ${topology.primary.config.application.proofCommand}`,
    ],
    guarantee:
      "Every database target is isolated by its own project ID, ports, artifact directory, and local-only safety policy. No production resources will be contacted.",
  };
};

export const runRuntimeStackDoctor = async (planOptions) => {
  let topology;
  try {
    topology = await loadRuntimeTopology(planOptions);
  } catch (error) {
    if (
      String(error?.message ?? error).startsWith(
        "No Rehearsal configuration was found",
      )
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
          detail: redactDiagnosticValue(String(error?.message ?? error)),
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

export const topologyCandidateSummary = async (planOptions) => {
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
    baselineGenerationId: targets[0].baselineGenerationId,
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

const parseCommand = (source) => {
  const values = [];
  let current = "";
  let quote = null;
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) {
      if (current) values.push(current);
      current = "";
    } else current += character;
  }
  if (quote)
    throw new Error("Application proof command contains an unmatched quote.");
  if (current) values.push(current);
  if (values.length === 0)
    throw new Error("Application proof command is empty.");
  return values;
};

const projectCommandEnvironment = (additional = {}) => ({
  ...Object.fromEntries(
    [
      "CI",
      "COLORTERM",
      "FORCE_COLOR",
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  ),
  ...additional,
});

export const topologyCommandEnvironment = (topology) =>
  Object.fromEntries(
    topology.targets.map((target) => [
      target.primary
        ? "REHEARSAL_PRIMARY_ENV_FILE"
        : `REHEARSAL_DEPENDENT_${target.name.toUpperCase().replaceAll("-", "_")}_ENV_FILE`,
      target.paths.applicationEnvironment,
    ]),
  );

export const topologyEnvironmentFiles = (topology) =>
  Object.fromEntries(
    topology.targets.map((target) => [
      target.primary ? "primary" : target.name,
      target.paths.applicationEnvironment,
    ]),
  );

const runProjectCommand = ({
  source,
  configuredRoot,
  label,
  project,
  environment = {},
}) => {
  const [command, ...args] = parseCommand(source);
  const result = spawnSync(command, args, {
    cwd: configuredRoot,
    encoding: "utf8",
    env: projectCommandEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new RehearsalError({
      category: "application_proof_failure",
      code: "PROJECT_COMMAND_FAILED",
      message: `The configured ${label} did not pass.`,
      expected: `${source} exits successfully`,
      actual: summarizeProjectCommandFailure(result),
      context: { project, label },
      refused:
        "Rehearsal did not report the local runtime stack as fully verified.",
      suggestions: [
        "Run the command directly in the same project and correct the failure.",
      ],
      cause: result.error,
    });
  }
  return {
    command: source,
    output: redactDiagnosticValue(String(result.stdout ?? "").trim()),
  };
};

export const createRuntimeCommands = ({
  packageRoot,
  projectRoot,
  managerPath,
  getActivePackageFingerprint,
}) => {
  const runManager = ({
    action,
    flags,
    configPath = flags.configPath,
    confirmation = flags.confirmation,
    targetName,
  }) => {
    const fingerprint = getActivePackageFingerprint();
    if (fingerprint) {
      assertInstalledPackageFingerprint({
        packageRoot,
        expected: fingerprint,
      });
    }
    const args = buildRuntimeManagerArguments({
      managerPath,
      action,
      configPath,
      confirmation,
    });
    const runtimeStartedMs = performance.now();
    const actionDescription = {
      run: "Restoring the baseline and applying reviewed migrations",
      start: "Starting the disposable local runtime",
      migrate: "Applying reviewed migrations to the current runtime",
      reset: "Restoring the immutable baseline",
      status: "Inspecting the disposable local runtime",
      stop: "Stopping the disposable local runtime",
      discard: "Removing the disposable local runtime",
      verify: "Verifying the current local runtime",
    }[action];
    const describedAction = targetName
      ? `${actionDescription} for ${targetName}`
      : actionDescription;
    const spinner = useStyledPrompts(flags) ? prompts.spinner() : null;
    if (spinner) {
      spinner.start(`${describedAction}. This can take a moment.`);
    } else if (isHumanTerminal(flags)) {
      console.log(
        `\n${terminalStyle(flags, "1;36", action === "run" ? "REHEARSING" : "REHEARSAL")}\n${terminalStyle(flags, "36", "→")} ${describedAction}. This can take a moment.`,
      );
    }
    const result = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: "utf8",
      env: projectCommandEnvironment(),
      stdio: ["inherit", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    const currentFingerprint = getActivePackageFingerprint();
    if (currentFingerprint) {
      assertInstalledPackageFingerprint({
        packageRoot,
        expected: currentFingerprint,
      });
    }
    if (result.error) {
      if (spinner) spinner.stop(`${describedAction} did not complete.`);
      throw result.error;
    }
    if (result.status !== 0) {
      if (spinner) spinner.stop(`${describedAction} did not complete.`);
      const completeOutput = [
        String(result.stdout ?? ""),
        String(result.stderr ?? ""),
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
      const inferred = normalizeRehearsalError(
        new Error(completeOutput || `Rehearsal ${action} failed.`),
      );
      const category =
        action === "migrate" ||
        (action === "run" &&
          /migrateRuntime|candidate migration|migration up/iu.test(
            completeOutput,
          ))
          ? "migration_candidate_failure"
          : inferred.category;
      const conciseOutput = completeOutput
        .replaceAll(String.fromCodePoint(27), "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-8)
        .join("\n")
        .slice(-2_000);
      throw new RehearsalError({
        category,
        code: `MANAGER_${action.toUpperCase()}_FAILED`,
        message: `The local Rehearsal ${action} operation did not complete.`,
        expected: "the isolated runtime operation to finish and verify",
        actual: conciseOutput || `exit ${result.status}`,
        context: { action },
        refused: "The runtime was not reported as trusted.",
        suggestions: [
          "Review the concise failure above, then rerun rehearsal doctor before retrying.",
          "Use --debug only when the safe diagnostic detail is needed.",
        ],
        cause: new Error(completeOutput || `exit ${result.status}`),
      });
    }
    const durationMs = performance.now() - runtimeStartedMs;
    if (spinner) {
      spinner.stop(
        `${describedAction} completed in ${formatDuration(durationMs)}.`,
      );
    } else if (isHumanTerminal(flags)) {
      console.log(
        `${terminalStyle(flags, "32", "✓")} Local runtime step completed in ${formatDuration(durationMs)}.`,
      );
    }
    return {
      action,
      target: targetName ?? "primary",
      durationMs: Math.round(durationMs * 100) / 100,
      output: redactDiagnosticValue(String(result.stdout ?? "").trim()),
    };
  };

  const runRuntimeStack = async ({ command, flags, planOptions }) => {
    const topology =
      flags.runtimeTopology ?? (await loadRuntimeTopology(planOptions));
    const reverse = ["stop", "discard"].includes(command);
    const targets = reverse
      ? [...topology.targets].reverse()
      : topology.targets;
    const results = targets.map((target) =>
      runManager({
        action: command,
        flags,
        configPath: target.configPath,
        confirmation: flags.targetConfirmations?.get(target.configPath),
        targetName: topology.targets.length > 1 ? target.name : undefined,
      }),
    );
    if (results.length === 1) return { topology, runtime: results[0] };
    return {
      topology,
      runtime: {
        action: command,
        durationMs:
          Math.round(
            results.reduce((total, result) => total + result.durationMs, 0) *
              100,
          ) / 100,
        output: results
          .map((result) => `[${result.target}]\n${result.output}`)
          .join("\n\n"),
        targets: results,
      },
    };
  };

  const runApplicationProof = async (planOptions, options = {}) => {
    const { config, projectRoot: configuredRoot } =
      await loadRehearsalConfig(planOptions);
    return runProjectCommand({
      source: config.application.proofCommand,
      configuredRoot,
      label: options.targetName
        ? `application proof for ${options.targetName}`
        : "application proof",
      project: config.project.name,
      environment: options.environment,
    });
  };

  const prepareDependentTargets = ({ topology, environment }) =>
    topology.dependents.flatMap((target) => {
      if (!target.declaration.prepareCommand) return [];
      return [
        {
          target: target.name,
          ...runProjectCommand({
            source: target.declaration.prepareCommand,
            configuredRoot: topology.projectRoot,
            label: `preparation command for ${target.name}`,
            project: topology.primary.config.project.name,
            environment,
          }),
        },
      ];
    });

  const proveRuntimeStack = async ({ topology, planOptions, environment }) => {
    const dependentProofs = [];
    for (const target of topology.dependents) {
      dependentProofs.push({
        target: target.name,
        ...(await runApplicationProof(
          { ...planOptions, configPath: target.configPath },
          { targetName: target.name, environment },
        )),
      });
    }
    const applicationProof = await runApplicationProof(planOptions, {
      targetName: topology.targets.length > 1 ? "primary" : undefined,
      environment,
    });
    return { applicationProof, dependentProofs };
  };

  const openRuntimeApplication = async ({
    flags,
    planOptions,
    onReady = () => undefined,
  }) => {
    const topology = await loadRuntimeTopology(planOptions);
    const application = topology.primary.config.application;
    if (!application.readiness) {
      throw new Error(
        "rehearsal open requires config.application.readiness so it can confirm the local application is usable.",
      );
    }
    const runtimeReceipts = await Promise.all(
      topology.targets.map((target) =>
        access(join(target.paths.runtimeWorkdir, "baseline.json"))
          .then(() => true)
          .catch((error) => {
            if (error?.code === "ENOENT") return false;
            throw error;
          }),
      ),
    );
    if (runtimeReceipts.some((present) => !present)) {
      throw new Error(
        "rehearsal open requires an existing verified runtime. Run rehearsal run first.",
      );
    }
    flags.runtimeTopology = topology;
    const started = await runRuntimeStack({
      command: "start",
      flags,
      planOptions,
    });
    const verified = await runRuntimeStack({
      command: "verify",
      flags,
      planOptions,
    });
    const preparations = prepareDependentTargets({
      topology,
      environment: topologyCommandEnvironment(topology),
    });
    const session = await startApplicationSession({
      command: application.startCommand,
      cwd: topology.projectRoot,
      files: topologyEnvironmentFiles(topology),
      mappings: application.environmentVariables,
      readiness: application.readiness,
    });
    const closed = await holdApplicationSession({ session, onReady });
    return {
      action: "open",
      started: started.runtime,
      verified: verified.runtime,
      preparations,
      application: {
        command: application.startCommand,
        readiness: session.ready,
        stoppedBy: closed.signal,
        diagnostics: closed.diagnostics,
      },
    };
  };

  const prepareCandidateConfirmation = async ({
    command,
    flags,
    planOptions,
  }) => {
    if (!["run", "migrate"].includes(command) || flags.dryRun) return true;
    const summary = await topologyCandidateSummary(planOptions);
    flags.runtimeTopology = summary.topology;
    flags.targetConfirmations = new Map(
      summary.targets.map((target) => [
        target.configPath,
        target.candidateSha256,
      ]),
    );
    if (summary.candidateCount === 0) return true;
    if (flags.confirmation === summary.candidateSha256) return true;
    const interactive =
      !flags.json && process.stdin.isTTY && process.stdout.isTTY;
    if (!interactive || flags.confirmation) {
      throw new RehearsalError({
        category: "migration_candidate_failure",
        code: "CANDIDATE_CONFIRMATION_REQUIRED",
        message: flags.confirmation
          ? "The candidate migration confirmation does not match the current candidate set."
          : "Candidate migration confirmation is required in noninteractive use.",
        expected: summary.candidateSha256,
        actual: flags.confirmation ?? "missing",
        context: {
          command,
          candidateCount: summary.candidateCount,
          candidates: summary.candidates.map(
            (migration) => `${migration.target}: ${migration.filename}`,
          ),
        },
        refused:
          "Rehearsal did not reset, start, or modify the disposable runtime.",
        suggestions: [
          "Run rehearsal candidates, review every file, then pass the current digest with --confirm-candidates=.",
        ],
      });
    }
    console.log(
      [
        "",
        terminalStyle(
          flags,
          "1",
          `${summary.candidateCount} candidate migration${summary.candidateCount === 1 ? "" : "s"}`,
        ),
        "",
        ...summary.candidates.map((migration) =>
          summary.targets.length > 1
            ? `  → ${migration.target}: ${migration.filename}`
            : `  → ${migration.filename}`,
        ),
        "",
        `Candidate set: ${summary.candidateSha256.slice(0, 12)}`,
        "",
        `Rehearsal will apply only this exact set to ${summary.targets.length === 1 ? "the disposable local runtime" : "the isolated local runtime stack"}.`,
      ].join("\n"),
    );
    const accepted = await promptForConfirmation(
      `Apply exactly ${summary.candidateCount === 1 ? "this migration" : "these migrations"}?`,
      flags,
    );
    if (!accepted) {
      console.log("No changes made.");
      return false;
    }
    flags.confirmation = summary.candidateSha256;
    return true;
  };

  return {
    openRuntimeApplication,
    prepareCandidateConfirmation,
    prepareDependentTargets,
    proveRuntimeStack,
    runManager,
    runRuntimeStack,
  };
};
