/** Coordinate configured runtime stacks separately from application sessions/proofs. */
import { randomUUID } from "node:crypto";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import {
  loadRuntimeTopology,
  selectRuntimeTargets,
} from "../runtime/lifecycle/topology.mjs";
import {
  runtimeCompletionAction,
  assertRuntimeCompletionAllowed,
} from "../runtime/lifecycle/persistence.mjs";
import { releaseOwnedColimaWhenIdle } from "../runtime/engines/container_engine_ownership.mjs";
import { inspectRehearsalResources } from "../runtime/resources/resource_inventory.mjs";
import { assertLocalDockerContext } from "../runtime/engines/local_docker_context.mjs";
import { runtimeConfigurationSha256 } from "../runtime/lifecycle/configuration_binding.mjs";
import {
  assertResourcePolicyAllowsStartup,
  evaluateResourcePolicy,
} from "../runtime/resources/resource_policy.mjs";
import type { RuntimeStatusSnapshot } from "../runtime/lifecycle/status.mjs";
import { executeRuntimeTargetStack } from "./runtime_stack_execution.mjs";
import { withRuntimeWorkloadAdmission } from "./runtime_workload_admission.mjs";
import { assertRuntimeWorkloadCapacity } from "../runtime/resources/workload_capacity.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import type { CliSessionState } from "./command_contract.mjs";
type RuntimeTopology = Awaited<ReturnType<typeof loadRuntimeTopology>>;
export type RuntimeAction =
  | "run"
  | "start"
  | "migrate"
  | "reset"
  | "status"
  | "stop"
  | "discard"
  | "verify";

export interface ManagerReceipt {
  readonly action: RuntimeAction;
  readonly target: string;
  readonly durationMs: number;
  readonly output: string;
  readonly runtimeStatus?: RuntimeStatusSnapshot;
}

export interface RuntimeStackResult {
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

interface ManagerInvocation {
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
}
export const createRuntimeStackRunner =
  (runManager: (options: ManagerInvocation) => Promise<ManagerReceipt>) =>
  async ({
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
    let admittedEngine:
      { context: string; identity: string; daemonId: string } | undefined;
    const executeStack = async (): Promise<RuntimeStackResult> => {
      const reverse = ["stop", "discard"].includes(command);
      if (
        ["start", "run", "reset"].includes(command) &&
        topology.primary.config.resources.maximumBytes !== null
      ) {
        assertResourcePolicyAllowsStartup(
          evaluateResourcePolicy({
            inventory: await inspectRehearsalResources(planOptions),
            policy: topology.primary.config.resources,
          }),
        );
      }
      const selectedTargets = selectRuntimeTargets(
        topology.targets,
        flags.target,
        command,
      );
      if (["run", "start"].includes(command)) {
        const mode =
          command === "run"
            ? topology.primary.config.lifecycle.run
            : topology.primary.config.lifecycle.open;
        for (const target of selectedTargets)
          assertRuntimeCompletionAllowed(mode, target.config.runtime.protected);
      }
      const completionAction = runtimeCompletionAction(
        command === "run"
          ? topology.primary.config.lifecycle.run
          : topology.primary.config.lifecycle.open,
      );
      const targets = reverse
        ? [...selectedTargets].reverse()
        : selectedTargets;
      const engine =
        command === "status"
          ? null
          : assertLocalDockerContext({
              cwd: topology.projectRoot,
              ...(admittedEngine ? { context: admittedEngine.context } : {}),
            });
      if (admittedEngine && engine?.identity !== admittedEngine.identity)
        throw new Error(
          "The measured capacity engine changed before execution; no runtime action was started.",
        );
      const engineBinding = engine
        ? {
            dockerContext: engine.context,
            dockerIdentity: engine.identity,
            ...(admittedEngine
              ? { dockerDaemonId: admittedEngine.daemonId }
              : {}),
          }
        : {};
      const operationId = randomUUID();
      const results = await executeRuntimeTargetStack({
        targets,
        cleanupOnFailure:
          command === "run"
            ? runtimeCompletionAction(topology.primary.config.lifecycle.run) !==
              null
            : command === "start" &&
              runtimeCompletionAction(
                topology.primary.config.lifecycle.open,
              ) !== null,
        execute: async (target) => {
          const confirmation = (
            session.targetConfirmations as Map<string, string> | undefined
          )?.get(target.configPath);
          return runManager({
            action: command,
            flags,
            configPath: target.configPath,
            ...(confirmation === undefined ? {} : { confirmation }),
            ...(topology.targets.length > 1 ? { targetName: target.name } : {}),
            operationId,
            ...engineBinding,
            configSha256: runtimeConfigurationSha256(target.config),
          });
        },
        stop: (target) =>
          runManager({
            action: completionAction ?? "stop",
            flags,
            configPath: target.configPath,
            targetName: target.name,
            operationId,
            ...engineBinding,
            configSha256: runtimeConfigurationSha256(target.config),
          }),
      });
      const release = ["stop", "discard"].includes(command)
        ? await releaseOwnedColimaWhenIdle({
            projectRoot: topology.projectRoot,
            targets: topology.targets,
          })
        : null;
      const withRelease = (receipt: ManagerReceipt): ManagerReceipt =>
        release
          ? {
              ...receipt,
              output: [receipt.output, release.message]
                .filter(Boolean)
                .join("\n"),
            }
          : receipt;
      if (results.length === 1)
        return { topology, runtime: withRelease(results[0]!) };
      return {
        topology,
        runtime: {
          action: command,
          durationMs:
            Math.round(
              results.reduce((total, result) => total + result.durationMs, 0) *
                100,
            ) / 100,
          output: [
            results
              .map((result) => `[${result.target}]\n${result.output}`)
              .join("\n\n"),
            release?.message,
          ]
            .filter(Boolean)
            .join("\n\n"),
          targets: results,
        },
      };
    };
    return withRuntimeWorkloadAdmission({
      policy: topology.primary.config.resources.workloadQueue,
      command,
      json: flags.json,
      execute: executeStack,
      ...(topology.primary.config.resources.capacityAdmission?.enabled
        ? {
            capacityCheck: async () => {
              admittedEngine = await assertRuntimeWorkloadCapacity({
                policy: topology.primary.config.resources.capacityAdmission!,
                projectRoot: topology.projectRoot,
                targets: selectRuntimeTargets(
                  topology.targets,
                  flags.target,
                  command,
                ),
              });
            },
          }
        : {}),
    });
  };
