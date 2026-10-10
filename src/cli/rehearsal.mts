#!/usr/bin/env node
/**
 * Purpose: Parse one CLI request, protect project mutations, and delegate to
 * the typed command registry shared by scripted and guided flows.
 * Run: `npm run rehearsal -- doctor` or `npm run rehearsal -- explain`.
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import {
  normalizeRehearsalError,
  renderHumanError,
  serializeRehearsalError,
} from "../shared/diagnostics.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
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
import { usage } from "./basic_command_handlers.mjs";
import { createCliCommandRegistry } from "./cli_commands.mjs";
import {
  createCliSessionState,
  resetCommandSessionState,
} from "./command_contract.mjs";
import { createCommandEmitter } from "./command_output.mjs";
import { createGuidedHome } from "./guided.mjs";
import { createProjectCommands } from "./project_commands.mjs";
import {
  buildRuntimeStackPlan,
  createRuntimeCommands,
  runRuntimeStackDoctor,
  topologyCandidateSummary,
  topologyCommandEnvironment,
} from "./runtime_commands.mjs";
import {
  buildRefreshWorkflowPlan,
  createRefreshWorkflow,
} from "./source_commands.mjs";
import { installGuidedExitShortcut, useStyledPrompts } from "./terminal.mjs";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectRoot = process.cwd();
const managerPath = join(
  packageRoot,
  "dist/scripts/runtime/manage_database.mjs",
);
const state = createCliSessionState();
let activePackageFingerprint: InstalledPackageFingerprint | null = null;

const runtimeCommands = createRuntimeCommands({
  packageRoot,
  projectRoot,
  managerPath,
  getActivePackageFingerprint: () => activePackageFingerprint ?? undefined,
});
const projectCommands = createProjectCommands({
  projectRoot,
  runManager: runtimeCommands.runManager,
});
const runRefreshWorkflow = createRefreshWorkflow({
  runRuntimeStack: runtimeCommands.runRuntimeStack,
  prepareDependentTargets: runtimeCommands.prepareDependentTargets,
  topologyCommandEnvironment,
});
const commandRegistry = createCliCommandRegistry({
  projectRoot,
  projectCommands,
  runtimeCommands,
  runRefreshWorkflow,
});
const emitCommand = createCommandEmitter({
  startedAt: new Date(),
  startedMs: performance.now(),
});
const runGuidedHome = createGuidedHome({
  projectRoot,
  topologyCandidateSummary,
  buildRefreshWorkflowPlan,
  planRuntimeStackCleanup: projectCommands.planRuntimeStackCleanup,
  getLastGuidedDetails: () => state.lastGuidedDetails,
  session: state,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  const result = await commandRegistry.execute({
    command,
    flags,
    planOptions,
    guided,
    state,
  });
  if (!result) {
    throw new Error(`Unknown Rehearsal command: ${command}.\n\n${usage()}`);
  }
  const exitCode = emitCommand({ command, flags, result });
  if (exitCode !== undefined) process.exitCode = exitCode;
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
    ? await acquireProjectOperation({
        projectRoot,
        command: guided ? "guide" : command,
      })
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
        resetCommandSessionState(state);
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
  if (wantsJson) {
    console.log(
      JSON.stringify(serializeRehearsalError(failure, { debug }), null, 2),
    );
  } else {
    console.error(renderHumanError(failure, { debug }));
  }
  process.exitCode = failure.exitCode;
}
