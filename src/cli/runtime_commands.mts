import { randomBytes } from "node:crypto";
import { readKnexFailureFrame } from "../runtime/knex_failure_diagnostic.mjs";
/** Orchestrate isolated database runtimes and project-owned application proofs. */
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
import type { ApplicationSession } from "../application/session.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import { topologyCandidateSummary } from "./runtime_planning.mjs";
export {
  buildRuntimeStackPlan,
  runRuntimeStackDoctor,
  topologyCandidateSummary,
} from "./runtime_planning.mjs";
import {
  inspectRuntimeTopologyCandidates,
  loadRuntimeTopology,
  selectRuntimeTargets,
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
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  getOwnedOperationProgressId,
  trackOperationStage,
} from "../shared/operation_progress.mjs";
import { buildRuntimeManagerArguments } from "../targets/target.mjs";
import {
  parseRuntimeStatusSnapshot,
  renderRuntimeStatusSnapshot,
} from "../runtime/status.mjs";
import {
  applyRuntimePersistence,
  runtimeCompletionAction,
  assertRuntimeCompletionAllowed,
} from "../runtime/persistence.mjs";
import {
  createRuntimeStackRunner,
  type ManagerReceipt,
  type RuntimeAction,
} from "./runtime_stack_runner.mjs";
import {
  summarizeRuntimeManagerFailure,
  runtimePortFailureGuidance,
} from "./runtime_failure_summary.mjs";
import { readManagerMigrationFailure } from "../runtime/migration_failure.mjs";
import { runtimeConfigurationSha256 } from "../runtime/configuration_binding.mjs";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "../runtime/local_docker_context.mjs";
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
): NodeJS.ProcessEnv =>
  createCleanProcessEnvironment({ overrides: additional });

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
  if (
    /^(?:Error:\s*)?The baseline (?:PostgreSQL|Supabase) migration failed \(/mu.test(
      output,
    )
  )
    return "baseline_invalid";
  if (
    /^(?:Error:\s*)?The confirmed candidate (?:PostgreSQL|Supabase) migration failed \(/mu.test(
      output,
    )
  )
    return "migration_candidate_failure";
  if (
    RUNTIME_STARTUP_FAILURE_PATTERN.test(output) ||
    /(?:PostgreSQL|Supabase) startup failed \(/u.test(output) ||
    /^Error:\s*supabase start(?:\s|$)/imu.test(output)
  ) {
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
  environment: NodeJS.ProcessEnv = projectCommandEnvironment(),
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    maxBuffer: 65536,
  });

const inspectContainerCapacity = (
  reviewed?: ReturnType<typeof assertLocalDockerContext>,
) => {
  let selected: ReturnType<typeof assertLocalDockerContext>;
  let environment: NodeJS.ProcessEnv;
  try {
    selected = reviewed ?? assertLocalDockerContext();
    environment = scopedDockerEnvironment({
      inheritedEnvironment: {
        ...process.env,
        DOCKER_CONFIG: selected.dockerConfig,
      },
    });
  } catch {
    return undefined;
  }
  const docker = diagnosticCommand(
    "docker",
    [
      "--host",
      selected.endpoint,
      "info",
      "--format",
      "{{.NCPU}} {{.MemTotal}} {{.ContainersRunning}} {{.Containers}}",
    ],
    environment,
  );
  const capacity =
    docker.status === 0 ? parseDockerCapacity(docker.stdout) : null;
  if (!capacity) return undefined;

  // Engine capacity is not VM resident/free memory. A context name cannot bind a guest.
  return {
    engine: "docker-compatible",
    context: selected.context,
    ...capacity,
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
  resolveEngineSelection = assertLocalDockerContext,
  inspectEngineCapacity = inspectContainerCapacity,
}: {
  packageRoot: string;
  projectRoot: string;
  managerPath: string;
  getActivePackageFingerprint: () => InstalledPackageFingerprint | undefined;
  resolveEngineSelection?: typeof assertLocalDockerContext;
  inspectEngineCapacity?: typeof inspectContainerCapacity;
}) => {
  const executeManager = async ({
    action,
    flags,
    configPath = flags.configPath,
    confirmation = flags.confirmation,
    targetName,
    operationId,
    dockerContext,
    dockerIdentity,
    dockerDaemonId,
    configSha256,
  }: {
    action: RuntimeAction;
    flags: RehearsalCliFlags;
    configPath?: string;
    confirmation?: string;
    targetName?: string;
    operationId?: string;
    dockerContext?: string;
    dockerIdentity?: string;
    dockerDaemonId?: string;
    configSha256?: string;
  }): Promise<ManagerReceipt> => {
    const engineSelection = resolveEngineSelection({
      cwd: projectRoot,
      ...(dockerContext ? { context: dockerContext } : {}),
    });
    if (
      dockerIdentity !== undefined &&
      engineSelection.identity !== dockerIdentity
    )
      throw new Error(
        "The reviewed Docker endpoint changed before launch; no manager was started.",
      );
    const configurationSha256 =
      configSha256 ??
      runtimeConfigurationSha256(
        (
          await loadRehearsalConfig({
            projectRoot,
            ...(configPath === undefined ? {} : { configPath }),
          })
        ).config,
      );
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
    // VS Code extensions launch the package CLI through Electron's executable in
    // Node mode. Preserve that mode only for Rehearsal's nested Node manager;
    // project-owned application commands continue to receive the reduced
    // project environment above.
    const nativeFailureNonce = randomBytes(32).toString("hex");
    const managerEnvironment: NodeJS.ProcessEnv = {
      REHEARSAL_NATIVE_FAILURE_NONCE: nativeFailureNonce,
      ...(getOwnedOperationProgressId()
        ? { REHEARSAL_OWNER_OPERATION_ID: getOwnedOperationProgressId()! }
        : {}),
      ...(cancellationSignal ? { REHEARSAL_CANCELLABLE_OPERATION: "1" } : {}),
      ...(operationId ? { REHEARSAL_OPERATION_ID: operationId } : {}),
      REHEARSAL_DOCKER_CONTEXT: engineSelection.context,
      REHEARSAL_DOCKER_IDENTITY: engineSelection.identity,
      ...(engineSelection.dockerConfig
        ? { DOCKER_CONFIG: engineSelection.dockerConfig }
        : {}),
      ...(dockerDaemonId ? { REHEARSAL_DOCKER_DAEMON_ID: dockerDaemonId } : {}),
      REHEARSAL_CONFIGURATION_SHA256: configurationSha256,
      ...(process.env.ELECTRON_RUN_AS_NODE === "1"
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {}),
    };
    const result = await runOwnedProcess({
      command: process.execPath,
      args,
      cwd: projectRoot,
      env: projectCommandEnvironment(managerEnvironment),
      ...(cancellationSignal ? { signal: cancellationSignal } : {}),
      cancellationGraceMs: 45_000,
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
      const nativeDiagnostic = readKnexFailureFrame(
        completeOutput,
        nativeFailureNonce,
      );
      const conciseOutput = summarizeRuntimeManagerFailure(
        nativeDiagnostic.output,
      );
      const inferred = normalizeRehearsalError(
        new Error(conciseOutput || `Rehearsal ${action} failed.`),
      );
      const category = classifyManagerFailure({
        action,
        output: conciseOutput,
        inferredCategory: inferred.category,
      });
      const startupFailure = category === "runtime_dependency_failure";
      const migrationFailure = readManagerMigrationFailure(
        nativeDiagnostic.output,
      );
      const portGuidance = runtimePortFailureGuidance(conciseOutput);
      const engineCapacity =
        startupFailure && portGuidance.length === 0
          ? inspectEngineCapacity(engineSelection)
          : undefined;
      throw new RehearsalError({
        category,
        code: `MANAGER_${action.toUpperCase()}_FAILED`,
        message: `The local Rehearsal ${action} operation did not complete.${migrationFailure ? ` ${migrationFailure.summary}` : ""}`,
        expected: "the isolated runtime operation to finish and verify",
        actual: conciseOutput || `exit ${result.status}`,
        context: {
          action,
          target: targetName ?? "primary",
          ...(migrationFailure ? { migrationFailure } : {}),
          ...(nativeDiagnostic.nativeFailure
            ? { nativeFailure: nativeDiagnostic.nativeFailure }
            : {}),
          ...(engineCapacity ? { engineCapacity } : {}),
        },
        refused: "The runtime was not reported as trusted.",
        suggestions: [
          ...(migrationFailure?.suggestions ?? []),
          ...portGuidance,
          "Review the concise failure above, then rerun rehearsal doctor before retrying.",
          ...(startupFailure && portGuidance.length === 0
            ? [
                "If startup evidence confirms a resource shortage, stop only stacks you own or increase Docker/Colima capacity, then retry. Rehearsal will not change engine settings or bypass service health checks.",
                "Run docker stats --no-stream to identify active containers using the shared engine.",
              ]
            : []),
          "Use --debug only when the safe diagnostic detail is needed.",
        ],
        cause: new Error(conciseOutput || `exit ${result.status}`),
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
        : String(
            redactDiagnosticValue(
              readKnexFailureFrame(
                String(result.stdout ?? ""),
                nativeFailureNonce,
              ).output.trim(),
            ),
          ),
      ...(runtimeStatus ? { runtimeStatus } : {}),
    };
  };

  const runManager = (
    options: Parameters<typeof executeManager>[0],
  ): Promise<ManagerReceipt> =>
    options.action === "status"
      ? executeManager(options)
      : trackOperationStage(
          {
            phase:
              options.action === "verify"
                ? "runtime-verification"
                : ["stop", "discard"].includes(options.action)
                  ? "cleanup"
                  : "runtime-lifecycle",
            target: options.targetName ?? "primary",
          },
          () => executeManager(options),
        );

  const runRuntimeStack = createRuntimeStackRunner(runManager);

  const runApplicationProof = async (
    planOptions: RehearsalConfigPathOptions,
    options: { targetName?: string; environment?: NodeJS.ProcessEnv } = {},
  ) => {
    const { config, projectRoot: configuredRoot } =
      await loadRehearsalConfig(planOptions);
    return trackOperationStage(
      { phase: "application-proof", target: options.targetName ?? "primary" },
      () =>
        runProjectCommand({
          source: config.application.proofCommand,
          configuredRoot,
          label: options.targetName
            ? `application proof for ${options.targetName}`
            : "application proof",
          project: config.project.name,
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        }),
    );
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
      const prepareCommand = target.declaration?.prepareCommand;
      if (!prepareCommand) continue;
      preparations.push({
        target: target.name,
        ...(await trackOperationStage(
          { phase: "dependent-preparation", target: target.name },
          () =>
            runProjectCommand({
              source: prepareCommand,
              configuredRoot: topology.projectRoot,
              label: `preparation command for ${target.name}`,
              project: topology.primary.config.project.name,
              environment,
            }),
        )),
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
    throwIfOperationCancelled();
    const application = topology.primary.config.application;
    const readiness = application.readiness;
    if (!readiness) {
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
    const applicationSession = await trackOperationStage(
      { phase: "application-start", target: "primary" },
      () =>
        startApplicationSession({
          command: application.startCommand,
          cwd: topology.projectRoot,
          files: topologyEnvironmentFiles(topology),
          mappings: application.environmentVariables,
          readiness,
        }),
    );
    try {
      throwIfOperationCancelled();
    } catch (error) {
      try {
        await applicationSession.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Application handoff was cancelled and its owned process could not be stopped.",
        );
      }
      throw error;
    }
    return {
      started: started.runtime,
      verified: verified.runtime,
      preparations,
      command: application.startCommand,
      applicationUrl: topology.primary.config.runtime.applicationUrl,
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
    onReady?: (
      ready: ApplicationSession["ready"] & { readonly applicationUrl: string },
    ) => void;
  }) => {
    const topology = await loadRuntimeTopology(planOptions);
    throwIfOperationCancelled();
    for (const target of topology.targets)
      assertRuntimeCompletionAllowed(
        topology.primary.config.lifecycle.open,
        target.config.runtime.protected,
      );
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
        const closed = await trackOperationStage(
          { phase: "interactive-session", target: "primary" },
          () =>
            holdApplicationSession({
              session: active.session,
              onReady: (ready) => {
                onReady({ ...ready, applicationUrl: active.applicationUrl });
                if (
                  isHumanTerminal(flags) &&
                  topology.primary.config.lifecycle.openIdleTimeoutSeconds !==
                    null
                )
                  console.log(
                    `Idle shutdown is enabled after ${topology.primary.config.lifecycle.openIdleTimeoutSeconds}s of application-declared inactivity. Unknown activity preserves the running sandbox.`,
                  );
              },
              activity: topology.primary.config.application.activity,
              idleTimeoutSeconds:
                topology.primary.config.lifecycle.openIdleTimeoutSeconds,
              onActivityAvailability: (available) => {
                if (isHumanTerminal(flags))
                  console.log(
                    available
                      ? "Application activity is verified; foreground idle monitoring is active."
                      : "Idle shutdown is paused: application activity is unavailable or invalid. The sandbox remains running; review the configured activity route.",
                  );
              },
            }),
        );
        return { active, closed };
      },
      stop: async () =>
        (
          await runRuntimeStack({
            command:
              runtimeCompletionAction(topology.primary.config.lifecycle.open) ??
              "stop",
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
        stoppedBy:
          closed.reason === "idle-timeout" ? "idle-timeout" : closed.signal,
        closeReason: closed.reason,
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
    selectRuntimeTargets(
      (await loadRuntimeTopology(planOptions)).targets,
      flags.target,
      command,
    );
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
