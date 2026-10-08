/** Database runtime action handlers shared by guided and scripted CLI flows. */

import * as prompts from "@clack/prompts";
import {
  buildApplicationEnvironment,
  runHttpProofs,
  startApplicationSession,
} from "../application/session.mjs";
import {
  exactCommands,
  renderedCommand,
  silentCommand,
} from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import {
  topologyCommandEnvironment,
  topologyEnvironmentFiles,
} from "./runtime_commands.mjs";
import type { createRuntimeCommands } from "./runtime_commands.mjs";
import {
  formatDuration,
  isHumanTerminal,
  terminalStyle,
  useStyledPrompts,
} from "./terminal.mjs";

export type RuntimeAction =
  | "run"
  | "start"
  | "migrate"
  | "reset"
  | "status"
  | "stop"
  | "discard"
  | "verify";

const RUNTIME_ACTIONS: readonly RuntimeAction[] = [
  "run",
  "start",
  "migrate",
  "reset",
  "status",
  "stop",
  "discard",
  "verify",
];

type RuntimeCommands = ReturnType<typeof createRuntimeCommands>;

const isRuntimeAction = (command: string): command is RuntimeAction =>
  RUNTIME_ACTIONS.includes(command as RuntimeAction);

export const createRuntimeActionHandlers = ({
  prepareCandidateConfirmation,
  prepareDependentTargets,
  proveRuntimeStack,
  runRuntimeStack,
}: {
  prepareCandidateConfirmation: RuntimeCommands["prepareCandidateConfirmation"];
  prepareDependentTargets: RuntimeCommands["prepareDependentTargets"];
  proveRuntimeStack: RuntimeCommands["proveRuntimeStack"];
  runRuntimeStack: RuntimeCommands["runRuntimeStack"];
}): readonly CommandDefinition[] => [
  {
    ...exactCommands("runtime-action", RUNTIME_ACTIONS, async () =>
      silentCommand(),
    ),
    matches: ({ command, flags }) =>
      isRuntimeAction(command) && !(command === "run" && flags.dryRun),
    handle: async ({ command, flags, planOptions, guided, state }) => {
      if (!isRuntimeAction(command)) {
        throw new Error(`Unsupported runtime action: ${command}.`);
      }
      if (flags.dryRun && command !== "run") {
        throw new Error("--dry-run is supported only by rehearsal run.");
      }
      if (
        !(await prepareCandidateConfirmation({
          command,
          flags,
          planOptions,
          session: state,
        }))
      ) {
        return silentCommand();
      }
      const stack = await runRuntimeStack({
        command,
        flags,
        planOptions,
        session: state,
      });
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
        | Awaited<ReturnType<typeof startApplicationSession>>["ready"]
        | undefined;
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
        state.lastGuidedDetails = [
          runtime.output,
          ...preparations.map((preparation) => preparation.output),
          ...dependentProofs.map((proof) => proof.output),
          applicationProof?.output,
        ]
          .filter(Boolean)
          .join("\n");
      }
      return renderedCommand({
        data,
        render: (value) => {
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
    },
  },
];
