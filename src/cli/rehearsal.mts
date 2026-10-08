#!/usr/bin/env node
/**
 * Purpose: Run the versioned, project-configured Rehearsal developer CLI for
 * initialization, readiness, planning, inspection, and verified local execution.
 * Run: `npm run rehearsal -- doctor` or `npm run rehearsal -- explain`.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import {
  createRehearsalResult,
  normalizeRehearsalError,
  REHEARSAL_VERSION,
  renderHumanError,
  serializeRehearsalError,
} from "../shared/diagnostics.mjs";
import type { RehearsalStatus } from "../shared/diagnostics.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import {
  inspectRehearsalBaseline,
  inspectRehearsalMigrations,
  runRehearsalDoctor,
} from "../runtime/plan.mjs";
import { createSyntheticBaselineFromFiles } from "../baseline/builder.mjs";
import { inspectBaselineInputFiles } from "../baseline/preparation.mjs";
import { formatCount } from "../shared/human_output.mjs";
import { collectRehearsalSupportReport } from "../project/support_report.mjs";
import { createPrivacyKey } from "../baseline/privacy_engine.mjs";
import { createSourceAccessPlan } from "../source/access.mjs";
import {
  buildApplicationEnvironment,
  runHttpProofs,
  startApplicationSession,
} from "../application/session.mjs";
import { applyIdentityClaim } from "../identity/claim.mjs";
import { createSupabaseStorageTransfer } from "../identity/storage.mjs";
import {
  acquireProjectOperation,
  assertInstalledPackageFingerprint,
  createInstalledPackageFingerprint,
} from "../shared/operation_guard.mjs";
import type {
  InstalledPackageFingerprint,
  ProjectOperation,
} from "../shared/operation_guard.mjs";
import {
  commandMutatesProject,
  parseArguments,
  resetGuidedFlags,
} from "./arguments.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import {
  formatDuration,
  installGuidedExitShortcut,
  isHumanTerminal,
  terminalStyle,
  useStyledPrompts,
} from "./terminal.mjs";
import { createGuidedHome } from "./guided.mjs";
import {
  buildRefreshWorkflowPlan,
  createRefreshWorkflow,
  loadPreparationContext,
  runSourceAccess,
  runSourceBaselineRefresh,
  runSourceRetirement,
} from "./source_commands.mjs";
import {
  buildRuntimeStackPlan,
  createRuntimeCommands,
  runRuntimeStackDoctor,
  topologyCandidateSummary,
  topologyCommandEnvironment,
  topologyEnvironmentFiles,
} from "./runtime_commands.mjs";
import {
  renderBaseline,
  renderBaselineInputInspection,
  renderBaselinePreparation,
  renderCandidates,
  renderCleanup,
  renderDoctor,
  formatBytes,
  renderIdentityPlan,
  renderInit,
  renderMigrations,
  renderPlan,
  renderRefreshWorkflow,
  renderSetup,
  renderSourceAccessPlan,
  renderSourceRetirement,
  renderSupportReport,
} from "./renderers.mjs";
import { runRehearsalInit } from "./init_command.mjs";
import { createProjectCommands } from "./project_commands.mjs";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectRoot = process.cwd();
let activePackageFingerprint: InstalledPackageFingerprint | null = null;
const commandStartedAt = new Date();
const commandStartedMs = performance.now();
const managerPath = join(
  packageRoot,
  "dist/scripts/runtime/manage_database.mjs",
);
let lastGuidedDetails: string | undefined;

type RuntimeAction =
  | "run"
  | "start"
  | "migrate"
  | "reset"
  | "status"
  | "stop"
  | "discard"
  | "verify";

const isRuntimeAction = (command: string): command is RuntimeAction =>
  [
    "run",
    "start",
    "migrate",
    "reset",
    "status",
    "stop",
    "discard",
    "verify",
  ].includes(command);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const {
  openRuntimeApplication,
  prepareCandidateConfirmation,
  prepareDependentTargets,
  proveRuntimeStack,
  runManager,
  runRuntimeStack,
} = createRuntimeCommands({
  packageRoot,
  projectRoot,
  managerPath,
  getActivePackageFingerprint: () => activePackageFingerprint ?? undefined,
});

const {
  loadIdentityClaimPlan,
  planRuntimeStackCleanup,
  runBaselinePreparation,
  runCleanup,
  runSetup,
} = createProjectCommands({ projectRoot, runManager });

type OutputRenderer = (...arguments_: never[]) => string;

const emit = ({
  command,
  data,
  flags,
  render,
  status = "success",
}: {
  command: string;
  data: unknown;
  flags: RehearsalCliFlags;
  render: OutputRenderer;
  status?: RehearsalStatus;
}): void => {
  const result = createRehearsalResult({
    command,
    status,
    data,
    startedAt: commandStartedAt,
    durationMs: Math.round((performance.now() - commandStartedMs) * 100) / 100,
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    const renderOutput = render as unknown as (
      value: unknown,
      verbosity: RehearsalCliFlags["verbosity"],
    ) => string;
    console.log(renderOutput(data, flags.verbosity));
  }
};

const usage = () => `Usage: rehearsal <command> [options]

Commands:
  version                     Print the installed Rehearsal version
  guide                       Open the interactive, state-aware home screen
  setup [--target=] [--write] Preview or create safe first-run scaffolding
  init [--write]              Preview or explicitly write safe starter config
  baseline prepare --records= --ledger= [--write] Create a fail-closed policy draft
  baseline create --records= --ledger= [--assets=] Create a baseline from safe local inputs
  privacy key [--write]       Preview or create the owner-only pseudonym key
  source plan                 Preview exact, temporary source access
  source apply --confirm-source-access= Apply the reviewed source-access plan
  source retire [--confirm-source-retirement=] Preview or retire exact source access
  baseline refresh            Replace only the baseline from a reviewed source
  refresh [--confirm-refresh=] Replace the database copy, reset locally, and remove old copies
  identity plan --identity=   Preview an approved local identity association
  identity claim --identity= --confirm-identity= Apply the exact local association
  doctor                     Check whether Rehearsal is safe and ready
  support                    Print a safe, copy-ready support report
  explain                    Show the immutable execution plan
  run --dry-run              Alias the exact explain plan without mutations
  run --confirm-candidates=  Execute reset, migration, and verification locally
  open                       Start the runtime and keep the application open
  candidates                 Show the exact pending migration digest
  inspect baseline           Show verified baseline provenance
  inspect migrations         Classify represented, applied, and candidate migrations
  start                      Start an existing verified local runtime
  migrate --confirm-candidates= Apply the exact candidate suffix without resetting
  reset                      Restore and verify the immutable local baseline
  status                     Report the disposable local runtime state
  stop                       Stop only this project's local runtime
  discard                    Remove only this project's disposable runtime
  cleanup [--include-runtime] [--include-images] [--write] [--confirm-cleanup=]
                             Preview or apply conservative disk cleanup
  verify                     Verify the current local Rehearsal runtime

Options: --help, -h --version, -V --json --verbose --debug --plain
         --config=<path> --target=supabase|postgresql
         --confirm-source-access=<digest> --confirm-source-retirement=<digest>
         --confirm-refresh=<digest>`;

const runRefreshWorkflow = createRefreshWorkflow({
  runRuntimeStack,
  prepareDependentTargets,
  topologyCommandEnvironment,
});

const runGuidedHome = createGuidedHome({
  projectRoot,
  topologyCandidateSummary,
  buildRefreshWorkflowPlan,
  planRuntimeStackCleanup,
  getLastGuidedDetails: () => lastGuidedDetails,
});

const executeCommand = async ({
  command,
  flags,
  planOptions,
  guided,
}: {
  command: string;
  flags: RehearsalCliFlags;
  planOptions: RehearsalConfigPathOptions;
  guided: boolean;
}): Promise<void> => {
  if (command === "version" || flags.version) {
    if (flags.json) {
      console.log(
        JSON.stringify(
          { name: "@rehearsal-db/core", version: REHEARSAL_VERSION },
          null,
          2,
        ),
      );
    } else console.log(REHEARSAL_VERSION);
    return;
  }
  if (command === "help" || flags.help) {
    console.log(usage());
    return;
  }
  if (command === "setup") {
    const data = await runSetup({ flags, planOptions });
    emit({ command, data, flags, render: renderSetup });
    return;
  }
  if (command === "init") {
    const data = await runRehearsalInit({ projectRoot, flags });
    emit({ command, data, flags, render: renderInit });
    return;
  }
  if (command === "baseline prepare") {
    const data = await runBaselinePreparation({ flags, planOptions });
    emit({
      command,
      data,
      flags,
      render: (result: typeof data) => renderBaselinePreparation(result, flags),
    });
    return;
  }
  if (command === "baseline create") {
    if (!flags.recordsPath || !flags.ledgerPath) {
      throw new Error(
        "baseline create requires --records and --ledger input paths.",
      );
    }
    const baselineInput = {
      ...planOptions,
      recordsPath: flags.recordsPath,
      ledgerPath: flags.ledgerPath,
      ...(flags.assetsPath === undefined
        ? {}
        : { assetsPath: flags.assetsPath }),
    };
    await inspectBaselineInputFiles(baselineInput);
    const data = await createSyntheticBaselineFromFiles(baselineInput);
    emit({
      command,
      data,
      flags,
      render: (baseline: typeof data) =>
        [
          `Activated synthetic baseline ${baseline.generationId}: ${formatCount(baseline.rowCount, "row")} across ${formatCount(baseline.tableCount, "table")}; ${formatCount(baseline.migrationCount, "migration")} through ${baseline.migrationCutoff}.`,
          "",
          flags.guided
            ? "Next: choose Run a rehearsal when you are ready."
            : "Next: run rehearsal doctor to check readiness.",
        ].join("\n"),
    });
    return;
  }
  if (command === "privacy key") {
    const { loaded } = await loadPreparationContext(planOptions);
    if (!loaded.paths.privacyKey) {
      throw new Error("No config.preparation.privacyKey is configured.");
    }
    const privacyKeyPath = loaded.paths.privacyKey;
    const data = flags.write
      ? {
          mode: "written" as const,
          path: relative(loaded.projectRoot, privacyKeyPath),
          ...(await createPrivacyKey(privacyKeyPath)),
        }
      : {
          mode: "preview" as const,
          path: relative(loaded.projectRoot, privacyKeyPath),
        };
    emit({
      command,
      data,
      flags,
      render: (result: typeof data) =>
        result.mode === "preview"
          ? `PRIVACY KEY — PREVIEW\n\nWould create ${result.path} with owner-only permissions.\nNothing was written. Rerun with --write after reviewing the path.`
          : `Created owner-only privacy key at ${result.path}.\nFingerprint: ${result.fingerprint}\nThe key is excluded from source control and must not be shared.`,
    });
    return;
  }
  if (command === "source plan") {
    const { sourcePolicy } = await loadPreparationContext(planOptions);
    const data = createSourceAccessPlan({ policy: sourcePolicy });
    emit({ command, data, flags, render: renderSourceAccessPlan });
    return;
  }
  if (command === "source apply") {
    const data = await runSourceAccess({ flags, planOptions });
    emit({
      command,
      data,
      flags,
      render: (result: typeof data) =>
        result.mode === "preview"
          ? renderSourceAccessPlan(result.plan)
          : [
              "SOURCE ACCESS — READY",
              `${result.receipt.accessMode === "external" ? "External" : "Temporary"} reader expires: ${result.receipt.expiresAt}`,
              result.receipt.accessMode === "external"
                ? "Rehearsal made no source-side changes."
                : "Rehearsal created only the reviewed temporary source access.",
              `Local credential: ${result.credentialFile}`,
              "",
              "Next: run rehearsal baseline refresh, then retire source access.",
            ].join("\n"),
    });
    return;
  }
  if (command === "source retire") {
    const data = await runSourceRetirement({ flags, planOptions });
    emit({ command, data, flags, render: renderSourceRetirement });
    return;
  }
  if (command === "baseline refresh") {
    const data = await runSourceBaselineRefresh({ planOptions });
    emit({
      command,
      data,
      flags,
      render: (result: typeof data) =>
        [
          `Activated refreshed baseline ${result.generationId}.`,
          `${formatCount(result.manifest.rowCount, "sanitized row")} across ${formatCount(Object.keys(result.manifest.tableCounts).length, "table")}.`,
          `Source estimate: ${formatCount(result.estimate.rows, "row")}, ${formatBytes(result.estimate.bytes)}.`,
          "",
          "Next: run rehearsal source retire, then rehearsal doctor.",
        ].join("\n"),
    });
    return;
  }
  if (command === "refresh") {
    const data = await runRefreshWorkflow({ flags, planOptions });
    emit({ command, data, flags, render: renderRefreshWorkflow });
    return;
  }
  if (command === "identity plan" || command === "identity claim") {
    const { loaded, plan } = await loadIdentityClaimPlan({
      flags,
      planOptions,
    });
    if (command === "identity plan" || !flags.identityConfirmation) {
      emit({
        command,
        data: { mode: "preview", plan },
        flags,
        render: renderIdentityPlan,
      });
      return;
    }
    const runtimeEnvironment = parseEnv(
      await readFile(loaded.paths.applicationEnvironment, "utf8"),
    );
    if (!runtimeEnvironment.DATABASE_URL) {
      throw new Error("The local runtime environment has no DATABASE_URL.");
    }
    const needsStorageTransfer = plan.identity.assets.some(
      (asset) => asset.rewritePath,
    );
    if (
      needsStorageTransfer &&
      (!runtimeEnvironment.SUPABASE_URL ||
        !runtimeEnvironment.SUPABASE_SERVICE_ROLE_KEY)
    ) {
      throw new Error(
        "Identity asset transfer requires local Supabase URL and service-role credentials.",
      );
    }
    const storageTransfer = needsStorageTransfer
      ? createSupabaseStorageTransfer({
          url: runtimeEnvironment.SUPABASE_URL!,
          serviceRoleKey: runtimeEnvironment.SUPABASE_SERVICE_ROLE_KEY!,
        })
      : undefined;
    const result = await applyIdentityClaim({
      plan,
      confirmation: flags.identityConfirmation,
      connectionString: runtimeEnvironment.DATABASE_URL,
      ...(storageTransfer === undefined ? {} : { storageTransfer }),
    });
    emit({
      command,
      data: { mode: "written", plan, result },
      flags,
      render: renderIdentityPlan,
    });
    return;
  }
  if (command === "doctor") {
    const data = await runRuntimeStackDoctor(planOptions);
    emit({
      command,
      data,
      flags,
      render: renderDoctor,
      status: data.state === "READY" ? "success" : "not_ready",
    });
    if (data.state !== "READY" && !guided) process.exitCode = 1;
    return;
  }
  if (command === "support") {
    const data = await collectRehearsalSupportReport(planOptions, {
      runDoctor: async (options) => {
        const report = await runRuntimeStackDoctor(options);
        const targetAliases = new Map<string, string>();
        const aliasFor = (name: string): string => {
          if (!targetAliases.has(name)) {
            targetAliases.set(name, `runtime-${targetAliases.size + 1}`);
          }
          return targetAliases.get(name)!;
        };
        return {
          ...report,
          checks: report.checks.map((check) => {
            const separator = check.id.indexOf(":");
            if (separator === -1) return check;
            const target = check.id.slice(0, separator);
            const alias = aliasFor(target);
            return {
              ...check,
              id: `${alias}:${check.id.slice(separator + 1)}`,
              label: check.label.replace(`${target}:`, `${alias}:`),
            };
          }),
        };
      },
    });
    emit({ command, data, flags, render: renderSupportReport });
    return;
  }
  if (command === "cleanup") {
    const data = await runCleanup({ flags, planOptions });
    emit({ command, data, flags, render: renderCleanup });
    return;
  }
  if (command === "explain" || (command === "run" && flags.dryRun)) {
    const data = await buildRuntimeStackPlan(planOptions);
    emit({ command, data, flags, render: renderPlan });
    return;
  }
  if (command === "inspect baseline") {
    const data = await inspectRehearsalBaseline(planOptions);
    emit({ command, data, flags, render: renderBaseline });
    return;
  }
  if (command === "inspect migrations") {
    const data = await inspectRehearsalMigrations(planOptions);
    emit({ command, data, flags, render: renderMigrations });
    return;
  }
  if (command === "candidates") {
    const { topology: _topology, ...data } =
      await topologyCandidateSummary(planOptions);
    emit({ command, data, flags, render: renderCandidates });
    return;
  }
  if (command === "open") {
    if (flags.dryRun) {
      throw new Error("--dry-run is supported only by rehearsal run.");
    }
    const data = await openRuntimeApplication({
      flags,
      planOptions,
      onReady: (ready) => {
        const lines = [
          `Application: ${ready.url}`,
          "The verified database runtime stays running and keeps your local changes.",
          guided
            ? "Press Ctrl+C to close the app and return here, or Ctrl+Z to exit Rehearsal."
            : "Press Ctrl+C or Ctrl+Z to close the app. Rehearsal will leave the database runtime running.",
        ];
        if (useStyledPrompts(flags)) {
          prompts.note(lines.join("\n"), "SANDBOX READY");
        } else if (!flags.json) {
          console.log(["", "SANDBOX READY", ...lines, ""].join("\n"));
        }
      },
    });
    if (guided && data.application.stoppedBy === "SIGTSTP") {
      flags.exitGuidedSession = true;
    }
    if (guided) {
      lastGuidedDetails = [
        data.started.output,
        data.verified.output,
        ...data.preparations.map((preparation) => preparation.output),
      ]
        .filter(Boolean)
        .join("\n");
    }
    emit({
      command,
      data,
      flags,
      render: (result: typeof data) =>
        [
          "SANDBOX APP CLOSED",
          `Application stopped after ${result.application.stoppedBy}.`,
          "The database runtime and its local database and Storage changes were preserved.",
          "Run rehearsal open to return, rehearsal verify to check it, or rehearsal stop to stop the databases.",
        ].join("\n"),
    });
    return;
  }
  if (isRuntimeAction(command)) {
    if (flags.dryRun && command !== "run") {
      throw new Error("--dry-run is supported only by rehearsal run.");
    }
    if (
      !(await prepareCandidateConfirmation({ command, flags, planOptions }))
    ) {
      return;
    }
    const stack = await runRuntimeStack({ command, flags, planOptions });
    const { runtime, topology } = stack;
    const stackEnvironment = topologyCommandEnvironment(topology);
    const preparations = ["run", "reset", "migrate"].includes(command)
      ? prepareDependentTargets({
          topology,
          environment: stackEnvironment,
        })
      : [];
    let applicationProof:
      | Awaited<ReturnType<typeof proveRuntimeStack>>["applicationProof"]
      | undefined;
    let dependentProofs: Awaited<
      ReturnType<typeof proveRuntimeStack>
    >["dependentProofs"] = [];
    let httpProofResults: Awaited<ReturnType<typeof runHttpProofs>> = [];
    let applicationReadiness:
      Awaited<ReturnType<typeof startApplicationSession>>["ready"] | undefined;
    if (command === "run") {
      const applicationConfig = topology.primary.config.application;
      const mappedApplicationEnvironment = Object.keys(
        applicationConfig.environmentVariables,
      ).length
        ? await buildApplicationEnvironment({
            files: topologyEnvironmentFiles(topology),
            mappings: applicationConfig.environmentVariables,
          })
        : {};
      const proofEnvironment = {
        ...stackEnvironment,
        ...mappedApplicationEnvironment,
      };
      const proofLabel =
        topology.targets.length > 1
          ? "project-owned dependent and application proofs"
          : "project-owned application proof";
      const proofSpinner = useStyledPrompts(flags) ? prompts.spinner() : null;
      if (proofSpinner) {
        proofSpinner.start(`Running the ${proofLabel}.`);
      } else if (isHumanTerminal(flags)) {
        console.log(
          `${terminalStyle(flags, "36", "→")} Running the ${proofLabel}.`,
        );
      }
      let applicationSession:
        Awaited<ReturnType<typeof startApplicationSession>> | undefined;
      try {
        if (applicationConfig.readiness) {
          applicationSession = await startApplicationSession({
            command: applicationConfig.startCommand,
            cwd: topology.projectRoot,
            files: topologyEnvironmentFiles(topology),
            mappings: applicationConfig.environmentVariables,
            readiness: applicationConfig.readiness,
          });
          applicationReadiness = applicationSession.ready;
        }
        ({ applicationProof, dependentProofs } = await proveRuntimeStack({
          topology,
          planOptions,
          environment: proofEnvironment,
        }));
        if (applicationConfig.httpProofs.length) {
          httpProofResults = await runHttpProofs({
            checks: applicationConfig.httpProofs,
          });
        }
      } catch (error) {
        if (proofSpinner) proofSpinner.stop("A project proof failed.");
        throw error;
      } finally {
        await applicationSession?.stop();
      }
      if (proofSpinner) {
        proofSpinner.stop("Project proofs passed.");
      } else if (isHumanTerminal(flags)) {
        console.log(
          `${terminalStyle(flags, "32", "✓")} Project proofs passed.`,
        );
      }
    }
    const data =
      command === "run"
        ? {
            runtime,
            preparations,
            dependentProofs,
            applicationProof,
            applicationReadiness,
            httpProofResults,
          }
        : preparations.length
          ? { ...runtime, preparations }
          : runtime;
    if (guided) {
      lastGuidedDetails = [
        runtime.output,
        ...preparations.map((preparation) => preparation.output),
        ...dependentProofs.map((proof) => proof.output),
        applicationProof?.output,
      ]
        .filter(Boolean)
        .join("\n");
    }
    emit({
      command,
      data,
      flags,
      render: (value: typeof data) => {
        const runtimeResult = "runtime" in value ? value.runtime : value;
        const renderedPreparations =
          "preparations" in value ? value.preparations : [];
        const renderedDependentProofs =
          "dependentProofs" in value ? value.dependentProofs : [];
        const renderedApplicationProof =
          "applicationProof" in value ? value.applicationProof : undefined;
        const renderedApplicationReadiness =
          "applicationReadiness" in value
            ? value.applicationReadiness
            : undefined;
        const renderedHttpProofResults =
          "httpProofResults" in value ? value.httpProofResults : [];
        const nextAction = {
          run: "Next: run rehearsal open for hands-on testing, then rehearsal verify.",
          start:
            "Next: run rehearsal open for hands-on testing or rehearsal status.",
          migrate: "Next: run rehearsal verify to prove the current runtime.",
          reset: "Next: run rehearsal open or rehearsal verify.",
          status: "Next: run rehearsal verify, reset, stop, or discard.",
          stop: "Next: run rehearsal start when you want to resume.",
          discard:
            "The disposable runtime was removed; the immutable baseline remains.",
          verify:
            "Next: continue testing, reset to the baseline, or stop the runtime.",
        }[runtimeResult.action];
        if (guided) {
          const title =
            runtimeResult.action === "run"
              ? "REHEARSAL PASSED"
              : "ACTION COMPLETE";
          return [
            title,
            `✓ ${runtimeResult.action} completed in ${formatDuration(runtimeResult.durationMs)}`,
            ...renderedPreparations.map(
              (preparation) =>
                `✓ ${preparation.target} preparation passed: ${preparation.command}`,
            ),
            ...renderedDependentProofs.map(
              (proof) => `✓ ${proof.target} proof passed: ${proof.command}`,
            ),
            renderedApplicationProof
              ? `✓ Application proof passed: ${renderedApplicationProof.command}`
              : null,
            renderedApplicationReadiness
              ? `✓ Application became ready at ${renderedApplicationReadiness.url}`
              : null,
            ...renderedHttpProofResults.map(
              (proof) => `✓ ${proof.kind} HTTP proof passed: ${proof.name}`,
            ),
            "",
            "Technical output is available from Show details in the guide.",
          ]
            .filter(Boolean)
            .join("\n");
        }
        return [
          runtimeResult.output ||
            `Rehearsal ${runtimeResult.action} completed.`,
          ...renderedPreparations.map(
            (preparation) =>
              `${preparation.target} preparation passed: ${preparation.command}`,
          ),
          ...renderedDependentProofs.map(
            (proof) => `${proof.target} proof passed: ${proof.command}`,
          ),
          renderedApplicationProof
            ? `Application proof passed: ${renderedApplicationProof.command}`
            : null,
          renderedApplicationReadiness
            ? `Application readiness passed: ${renderedApplicationReadiness.url}`
            : null,
          ...renderedHttpProofResults.map(
            (proof) => `${proof.kind} HTTP proof passed: ${proof.name}`,
          ),
          nextAction ? "" : null,
          nextAction,
        ]
          .filter((entry) => entry !== null)
          .join("\n");
      },
    });
    return;
  }
  throw new Error(`Unknown Rehearsal command: ${command}.\n\n${usage()}`);
};

const main = async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2));
  const command = positionals.join(" ") || "help";
  const planOptions: RehearsalConfigPathOptions = {
    projectRoot,
    ...(flags.configPath === undefined ? {} : { configPath: flags.configPath }),
  };
  const wantsAutomaticGuide =
    positionals.length === 0 &&
    !flags.help &&
    !flags.json &&
    process.stdin.isTTY &&
    process.stdout.isTTY;
  const guided = command === "guide" || wantsAutomaticGuide;
  const mutating = commandMutatesProject({ command, flags, guided });
  const operation: ProjectOperation | null = mutating
    ? await acquireProjectOperation({ projectRoot, command })
    : null;
  if (operation) {
    activePackageFingerprint = createInstalledPackageFingerprint({
      packageRoot,
    });
  }
  try {
    if (!guided) {
      await executeCommand({ command, flags, planOptions, guided: false });
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "The guided home screen requires an interactive terminal. Run rehearsal --help to list scriptable commands.",
      );
    }
    flags.guided = true;
    const installExitShortcut = () =>
      installGuidedExitShortcut(flags, {
        beforeExit: () => operation?.releaseSync(),
      });
    let removeGuidedExitShortcut: (() => void) | null = installExitShortcut();
    if (useStyledPrompts(flags)) {
      prompts.intro("REHEARSAL · Safe local migration testing");
    }
    try {
      while (true) {
        resetGuidedFlags(flags);
        const selected = await runGuidedHome({ flags, planOptions });
        if (!selected) break;
        if (selected === "home") continue;
        const opensApplication = selected === "open";
        if (opensApplication) {
          removeGuidedExitShortcut?.();
          removeGuidedExitShortcut = null;
        }
        try {
          await executeCommand({
            command: selected,
            flags,
            planOptions,
            guided: true,
          });
        } finally {
          if (opensApplication) {
            removeGuidedExitShortcut = installExitShortcut();
          }
        }
        if (flags.exitGuidedSession) break;
      }
    } finally {
      removeGuidedExitShortcut?.();
    }
    if (useStyledPrompts(flags)) {
      prompts.outro("See you at the next rehearsal.");
    } else {
      console.log("See you at the next rehearsal.");
    }
  } finally {
    if (operation) {
      try {
        assertInstalledPackageFingerprint({
          packageRoot,
          expected: activePackageFingerprint!,
        });
      } finally {
        activePackageFingerprint = null;
        await operation.release();
      }
    }
  }
};

try {
  await main();
} catch (error) {
  const failure = normalizeRehearsalError(error, {
    expected: "a safe, versioned, local-only Rehearsal operation",
    actual: errorMessage(error),
    refused: "No further Rehearsal action was performed.",
    suggestions: ["Run rehearsal doctor for actionable readiness checks."],
  });
  const wantsJson = process.argv.includes("--json");
  const debug = process.argv.includes("--debug");
  if (wantsJson)
    console.log(
      JSON.stringify(serializeRehearsalError(failure, { debug }), null, 2),
    );
  else console.error(renderHumanError(failure, { debug }));
  process.exitCode = failure.exitCode;
}
