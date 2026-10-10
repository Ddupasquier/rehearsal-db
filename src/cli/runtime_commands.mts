/**
 * CLI orchestration for one or more isolated database runtimes and their
 * project-owned proof commands.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
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
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import { buildRehearsalPlan, runRehearsalDoctor } from "../runtime/plan.mjs";
import {
  inspectRuntimeTopologyCandidates,
  loadRuntimeTopology,
} from "../runtime/topology.mjs";
import type { RuntimeTopologyTarget } from "../runtime/topology.mjs";
import {
  RehearsalError,
  normalizeRehearsalError,
  redactDiagnosticValue,
} from "../shared/diagnostics.mjs";
import { assertInstalledPackageFingerprint } from "../shared/operation_guard.mjs";
import type { InstalledPackageFingerprint } from "../shared/operation_guard.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { buildRuntimeManagerArguments } from "../targets/target.mjs";
import {
  parseRuntimeStatusSnapshot,
  renderRuntimeStatusSnapshot,
} from "../runtime/status.mjs";
import type { RuntimeStatusSnapshot } from "../runtime/status.mjs";
import { applyRuntimePersistence } from "../runtime/persistence.mjs";
import {
  formatDuration,
  isHumanTerminal,
  promptForConfirmation,
  terminalStyle,
  useStyledPrompts,
} from "./terminal.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import type { RehearsalErrorCategory } from "../shared/diagnostics.mjs";
import type { CliSessionState } from "./command_contract.mjs";

type RuntimeTopology = Awaited<ReturnType<typeof loadRuntimeTopology>>;
type RuntimeAction =
  | "run"
  | "start"
  | "migrate"
  | "reset"
  | "status"
  | "stop"
  | "discard"
  | "verify";

interface ManagerReceipt {
  readonly action: RuntimeAction;
  readonly target: string;
  readonly durationMs: number;
  readonly output: string;
  readonly runtimeStatus?: RuntimeStatusSnapshot;
}

interface RuntimeStackResult {
  readonly topology: RuntimeTopology;
  readonly runtime:
    | ManagerReceipt
    | Readonly<{
        action: RuntimeAction;
        durationMs: number;
        output: string;
        targets: readonly ManagerReceipt[];
      }>;
}

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
  return {
    targets,
    migrations: {
      candidateCount: candidates.candidateCount,
      candidateSha256: candidates.candidateSha256,
    },
    lifecycle: {
      run: topology.primary.config.lifecycle.run,
      open: topology.primary.config.lifecycle.open,
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

const parseCommand = (source: string): [string, ...string[]] => {
  const values: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
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
  return values as [string, ...string[]];
};

const projectCommandEnvironment = (
  additional: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
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

const RUNTIME_STARTUP_FAILURE_PATTERN =
  /container\b.*\b(?:is not ready|starting|unhealthy)|health(?:check)?\b.*\b(?:failed|starting|unhealthy)|out of memory|\boom\b|no space left|resource temporarily unavailable/iu;

export const classifyManagerFailure = ({
  action,
  output,
  inferredCategory,
}: {
  action: RuntimeAction;
  output: string;
  inferredCategory: RehearsalErrorCategory;
}): RehearsalErrorCategory => {
  if (RUNTIME_STARTUP_FAILURE_PATTERN.test(output)) {
    return "runtime_dependency_failure";
  }
  if (
    action === "migrate" ||
    (action === "run" &&
      /migrateRuntime|candidate migration|migration up/iu.test(output))
  ) {
    return "migration_candidate_failure";
  }
  return inferredCategory;
};

export const parseDockerCapacity = (output: string) => {
  const [cpuText, memoryText, runningText, totalText] = output
    .trim()
    .split(/\s+/u);
  const values = [cpuText, memoryText, runningText, totalText].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [cpus, memoryBytes, runningContainers, containers] = values;
  if (
    cpus === undefined ||
    memoryBytes === undefined ||
    runningContainers === undefined ||
    containers === undefined
  )
    return null;
  return { cpus, memoryBytes, runningContainers, containers };
};

export const parseColimaMemory = (output: string) => {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("Mem:"));
  if (!line) return null;
  const columns = line.split(/\s+/u);
  const totalBytes = Number(columns[1]);
  const availableBytes = Number(columns[6]);
  if (![totalBytes, availableBytes].every(Number.isFinite)) return null;
  return { totalBytes, availableBytes };
};

const diagnosticCommand = (
  command: string,
  args: readonly string[],
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    encoding: "utf8",
    env: projectCommandEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });

const inspectContainerCapacity = () => {
  const docker = diagnosticCommand("docker", [
    "info",
    "--format",
    "{{.NCPU}} {{.MemTotal}} {{.ContainersRunning}} {{.Containers}}",
  ]);
  const capacity =
    docker.status === 0 ? parseDockerCapacity(docker.stdout) : null;
  if (!capacity) return undefined;

  const context = diagnosticCommand("docker", ["context", "show"]);
  if (context.status !== 0 || context.stdout.trim() !== "colima") {
    return { engine: "docker-compatible", ...capacity };
  }
  const memory = diagnosticCommand("colima", ["ssh", "--", "free", "-b"]);
  return {
    engine: "colima",
    ...capacity,
    ...(memory.status === 0
      ? { runtimeMemory: parseColimaMemory(memory.stdout) ?? undefined }
      : {}),
  };
};

export const topologyCommandEnvironment = (
  topology: RuntimeTopology,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    topology.targets.map((target) => [
      target.primary
        ? "REHEARSAL_PRIMARY_ENV_FILE"
        : `REHEARSAL_DEPENDENT_${target.name.toUpperCase().replaceAll("-", "_")}_ENV_FILE`,
      target.paths.applicationEnvironment,
    ]),
  );

export const topologyEnvironmentFiles = (
  topology: RuntimeTopology,
): Readonly<Record<string, string>> & { readonly primary: string } => ({
  primary: topology.primary.paths.applicationEnvironment,
  ...Object.fromEntries(
    topology.dependents.map((target) => [
      target.name,
      target.paths.applicationEnvironment,
    ]),
  ),
});

const runProjectCommand = async ({
  source,
  configuredRoot,
  label,
  project,
  environment = {},
}: {
  source: string;
  configuredRoot: string;
  label: string;
  project: string;
  environment?: NodeJS.ProcessEnv;
}) => {
  const [command, ...args] = parseCommand(source);
  const cancellationSignal = getOperationCancellationSignal();
  const result = await runOwnedProcess({
    command,
    args,
    cwd: configuredRoot,
    env: projectCommandEnvironment(environment),
    stdin: "ignore",
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
  });
  throwIfOperationCancelled();
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
      ...(result.error === undefined ? {} : { cause: result.error }),
    });
  }
  return {
    command: source,
    output: String(redactDiagnosticValue(String(result.stdout ?? "").trim())),
  };
};

export const createRuntimeCommands = ({
  packageRoot,
  projectRoot,
  managerPath,
  getActivePackageFingerprint,
}: {
  packageRoot: string;
  projectRoot: string;
  managerPath: string;
  getActivePackageFingerprint: () => InstalledPackageFingerprint | undefined;
}) => {
  const runManager = async ({
    action,
    flags,
    configPath = flags.configPath,
    confirmation = flags.confirmation,
    targetName,
  }: {
    action: RuntimeAction;
    flags: RehearsalCliFlags;
    configPath?: string;
    confirmation?: string;
    targetName?: string;
  }): Promise<ManagerReceipt> => {
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
      ...(configPath === undefined ? {} : { configPath }),
      ...(confirmation === undefined ? {} : { confirmation }),
      structuredResult: action === "status",
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
    const cancellationSignal = getOperationCancellationSignal();
    const result = await runOwnedProcess({
      command: process.execPath,
      args,
      cwd: projectRoot,
      env: projectCommandEnvironment(
        cancellationSignal ? { REHEARSAL_CANCELLABLE_OPERATION: "1" } : {},
      ),
      ...(cancellationSignal ? { signal: cancellationSignal } : {}),
    });
    throwIfOperationCancelled();
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
      const category = classifyManagerFailure({
        action,
        output: completeOutput,
        inferredCategory: inferred.category,
      });
      const startupFailure = category === "runtime_dependency_failure";
      const engineCapacity = startupFailure
        ? inspectContainerCapacity()
        : undefined;
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
        context: { action, ...(engineCapacity ? { engineCapacity } : {}) },
        refused: "The runtime was not reported as trusted.",
        suggestions: [
          "Review the concise failure above, then rerun rehearsal doctor before retrying.",
          ...(startupFailure
            ? [
                "Stop unrelated local stacks or increase Docker/Colima capacity, then retry. Rehearsal will not change engine settings or bypass service health checks.",
                "Run docker stats --no-stream to identify active containers using the shared engine.",
              ]
            : []),
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
    const runtimeStatus =
      action === "status"
        ? parseRuntimeStatusSnapshot(JSON.parse(String(result.stdout ?? "")))
        : undefined;
    return {
      action,
      target: targetName ?? "primary",
      durationMs: Math.round(durationMs * 100) / 100,
      output: runtimeStatus
        ? renderRuntimeStatusSnapshot(runtimeStatus)
        : String(redactDiagnosticValue(String(result.stdout ?? "").trim())),
      ...(runtimeStatus ? { runtimeStatus } : {}),
    };
  };

  const runRuntimeStack = async ({
    command,
    flags,
    planOptions,
    session,
  }: {
    command: RuntimeAction;
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
    session: CliSessionState;
  }): Promise<RuntimeStackResult> => {
    const topology =
      (session.runtimeTopology as RuntimeTopology | undefined) ??
      (await loadRuntimeTopology(planOptions));
    const reverse = ["stop", "discard"].includes(command);
    const targets = reverse
      ? [...topology.targets].reverse()
      : topology.targets;
    const results: ManagerReceipt[] = [];
    for (const target of targets) {
      const confirmation = (
        session.targetConfirmations as Map<string, string> | undefined
      )?.get(target.configPath);
      results.push(
        await runManager({
          action: command,
          flags,
          configPath: target.configPath,
          ...(confirmation === undefined ? {} : { confirmation }),
          ...(topology.targets.length > 1 ? { targetName: target.name } : {}),
        }),
      );
    }
    if (results.length === 1) return { topology, runtime: results[0]! };
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

  const runApplicationProof = async (
    planOptions: RehearsalConfigPathOptions,
    options: { targetName?: string; environment?: NodeJS.ProcessEnv } = {},
  ) => {
    const { config, projectRoot: configuredRoot } =
      await loadRehearsalConfig(planOptions);
    return runProjectCommand({
      source: config.application.proofCommand,
      configuredRoot,
      label: options.targetName
        ? `application proof for ${options.targetName}`
        : "application proof",
      project: config.project.name,
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    });
  };

  const prepareDependentTargets = async ({
    topology,
    environment,
  }: {
    topology: RuntimeTopology;
    environment: NodeJS.ProcessEnv;
  }) => {
    const preparations: Array<{
      target: string;
      command: string;
      output: string;
    }> = [];
    for (const target of topology.dependents) {
      if (!target.declaration?.prepareCommand) continue;
      preparations.push({
        target: target.name,
        ...(await runProjectCommand({
          source: target.declaration.prepareCommand,
          configuredRoot: topology.projectRoot,
          label: `preparation command for ${target.name}`,
          project: topology.primary.config.project.name,
          environment,
        })),
      });
    }
    return preparations;
  };

  const proveRuntimeStack = async ({
    topology,
    planOptions,
    environment,
  }: {
    topology: RuntimeTopology;
    planOptions: RehearsalConfigPathOptions;
    environment: NodeJS.ProcessEnv;
  }) => {
    const dependentProofs: Array<{
      target: string;
      command: string;
      output: string;
    }> = [];
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
      ...(topology.targets.length > 1 ? { targetName: "primary" } : {}),
      environment,
    });
    return { applicationProof, dependentProofs };
  };

  const startRuntimeApplication = async ({
    flags,
    planOptions,
    session: commandSession,
    onRuntimeStarted = () => undefined,
  }: {
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
    session: CliSessionState;
    onRuntimeStarted?: () => void;
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
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return false;
            throw error;
          }),
      ),
    );
    if (runtimeReceipts.some((present) => !present)) {
      throw new Error(
        "rehearsal open requires an existing verified runtime. Run rehearsal run first.",
      );
    }
    commandSession.runtimeTopology = topology;
    const started = await runRuntimeStack({
      command: "start",
      flags,
      planOptions,
      session: commandSession,
    });
    onRuntimeStarted();
    const verified = await runRuntimeStack({
      command: "verify",
      flags,
      planOptions,
      session: commandSession,
    });
    const preparations = await prepareDependentTargets({
      topology,
      environment: topologyCommandEnvironment(topology),
    });
    const applicationSession = await startApplicationSession({
      command: application.startCommand,
      cwd: topology.projectRoot,
      files: topologyEnvironmentFiles(topology),
      mappings: application.environmentVariables,
      readiness: application.readiness,
    });
    return {
      started: started.runtime,
      verified: verified.runtime,
      preparations,
      command: application.startCommand,
      session: applicationSession,
    };
  };

  const openRuntimeApplication = async ({
    flags,
    planOptions,
    session: commandSession,
    onReady = () => undefined,
  }: {
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
    session: CliSessionState;
    onReady?: Parameters<typeof holdApplicationSession>[0]["onReady"];
  }) => {
    const topology = await loadRuntimeTopology(planOptions);
    let runtimeStarted = false;
    const { result, lifecycle } = await applyRuntimePersistence({
      mode: topology.primary.config.lifecycle.open,
      canStop: () => runtimeStarted,
      operation: async () => {
        const active = await startRuntimeApplication({
          flags,
          planOptions,
          session: commandSession,
          onRuntimeStarted: () => {
            runtimeStarted = true;
          },
        });
        const closed = await holdApplicationSession({
          session: active.session,
          onReady,
        });
        return { active, closed };
      },
      stop: async () =>
        (
          await runRuntimeStack({
            command: "stop",
            flags,
            planOptions,
            session: commandSession,
          })
        ).runtime,
    });
    const { active, closed } = result;
    return {
      action: "open",
      started: active.started,
      verified: active.verified,
      preparations: active.preparations,
      application: {
        command: active.command,
        readiness: active.session.ready,
        stoppedBy: closed.signal,
        diagnostics: closed.diagnostics,
      },
      lifecycle,
    };
  };

  const prepareCandidateConfirmation = async ({
    command,
    flags,
    planOptions,
    session,
  }: {
    command: RuntimeAction;
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
    session: CliSessionState;
  }): Promise<boolean> => {
    if (!["run", "migrate"].includes(command) || flags.dryRun) return true;
    const summary = await topologyCandidateSummary(planOptions);
    session.runtimeTopology = summary.topology;
    session.targetConfirmations = new Map(
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
    startRuntimeApplication,
    prepareCandidateConfirmation,
    prepareDependentTargets,
    proveRuntimeStack,
    runManager,
    runRuntimeStack,
  };
};
