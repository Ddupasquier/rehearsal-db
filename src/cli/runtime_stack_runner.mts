/** Coordinate configured runtime stacks separately from application sessions/proofs. */
import { randomUUID } from "node:crypto";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import {
  loadRuntimeTopology,
  selectRuntimeTargets,
} from "../runtime/topology.mjs";
import { shouldStopRuntime } from "../runtime/persistence.mjs";
import { releaseOwnedColimaWhenIdle } from "../runtime/container_engine_ownership.mjs";
import { inspectRehearsalResources } from "../runtime/resource_inventory.mjs";
import { assertLocalDockerContext } from "../runtime/local_docker_context.mjs";
import { runtimeConfigurationSha256 } from "../runtime/configuration_binding.mjs";
import {
  assertResourcePolicyAllowsStartup,
  evaluateResourcePolicy,
} from "../runtime/resource_policy.mjs";
import type { RuntimeStatusSnapshot } from "../runtime/status.mjs";
import { executeRuntimeTargetStack } from "./runtime_stack_execution.mjs";
import { withRuntimeWorkloadAdmission } from "./runtime_workload_admission.mjs";
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
      const targets = reverse
        ? [...selectedTargets].reverse()
        : selectedTargets;
      const engine =
        command === "status"
          ? null
          : assertLocalDockerContext({ cwd: topology.projectRoot });
      const engineBinding = engine
        ? { dockerContext: engine.context, dockerIdentity: engine.identity }
        : {};
      const operationId = randomUUID();
      const results = await executeRuntimeTargetStack({
        targets,
        cleanupOnFailure:
          command === "run"
            ? shouldStopRuntime(topology.primary.config.lifecycle.run)
            : command === "start" &&
              shouldStopRuntime(topology.primary.config.lifecycle.open),
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
            action: "stop",
            flags,
            configPath: target.configPath,
            targetName: target.name,
            operationId,
            ...engineBinding,
            configSha256: runtimeConfigurationSha256(target.config),
          }),
      });
      const release = ["stop", "discard"].includes(command)
        ? releaseOwnedColimaWhenIdle({
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
    });
  };
