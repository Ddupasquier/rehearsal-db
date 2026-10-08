/** Project-scoped CLI orchestration that is shared by direct and guided commands. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  applyBaselinePreparation,
  planBaselinePreparation,
  summarizeBaselinePreparation,
} from "../baseline/preparation.mjs";
import type { BaselinePreparationPlan } from "../baseline/preparation.mjs";
import {
  createIdentityClaimPlan,
  validateIdentityPolicy,
} from "../identity/claim.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import {
  applyRehearsalSetup,
  planRehearsalSetup,
  summarizeRehearsalSetup,
} from "../project/setup.mjs";
import type { RehearsalSetupPlan } from "../project/setup.mjs";
import {
  applyRehearsalCleanup,
  planRehearsalCleanup,
} from "../runtime/cleanup.mjs";
import type { RehearsalCleanupPlan } from "../runtime/cleanup.mjs";
import { runRehearsalDoctor } from "../runtime/plan.mjs";
import { loadRuntimeTopology } from "../runtime/topology.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";

type CleanupStackPlan = Readonly<{
  digest: string;
  targets: readonly Readonly<{
    name: string;
    configPath: string;
    plan: RehearsalCleanupPlan;
  }>[];
}>;

type RunManager = (input: {
  action: "discard";
  flags: RehearsalCliFlags;
  configPath?: string;
  targetName?: string;
}) => unknown;

interface ProjectCommandInput {
  readonly flags: RehearsalCliFlags;
  readonly planOptions: RehearsalConfigPathOptions;
}

const isCleanupStackPlan = (
  plan: RehearsalCleanupPlan | CleanupStackPlan,
): plan is CleanupStackPlan => "targets" in plan;

export const createProjectCommands = ({
  projectRoot,
  runManager,
}: {
  projectRoot: string;
  runManager: RunManager;
}) => {
  const runSetup = async ({
    flags,
    planOptions,
  }: ProjectCommandInput): Promise<unknown> => {
    const setupTarget =
      flags.target === "supabase" || flags.target === "postgresql"
        ? flags.target
        : undefined;
    if (flags.target !== undefined && setupTarget === undefined) {
      throw new Error("--target must be supabase or postgresql.");
    }
    const plan =
      (flags.setupPlan as RehearsalSetupPlan | undefined) ??
      (await planRehearsalSetup({
        projectRoot,
        ...(planOptions.configPath === undefined
          ? {}
          : { configPath: planOptions.configPath }),
        ...(setupTarget === undefined ? {} : { target: setupTarget }),
      }));
    if (flags.write) await applyRehearsalSetup(plan);
    const result = summarizeRehearsalSetup(plan, {
      mode: flags.write ? "written" : "preview",
    });
    if (!flags.write) return result;
    const readiness = await runRehearsalDoctor(planOptions);
    const needsBaselinePolicy = readiness.checks.some(
      (check) => check.id === "sanitization-policy" && check.status === "fail",
    );
    return {
      ...result,
      readiness,
      nextAction: [
        `Review ${result.configurationPath}.`,
        readiness.state === "READY"
          ? "Next: run rehearsal explain to review the migration plan."
          : needsBaselinePolicy
            ? flags.guided
              ? "Next: choose Prepare the script to create a reviewable policy draft."
              : "Next: run rehearsal again and choose Prepare a reviewable baseline policy draft."
            : "Next: complete the remaining readiness items shown above.",
      ].join("\n"),
    };
  };

  const runBaselinePreparation = async ({
    flags,
    planOptions,
  }: ProjectCommandInput): Promise<
    ReturnType<typeof summarizeBaselinePreparation>
  > => {
    if (!flags.recordsPath || !flags.ledgerPath) {
      throw new Error(
        "baseline prepare requires --records and --ledger input paths.",
      );
    }
    const plan =
      (flags.preparationPlan as BaselinePreparationPlan | undefined) ??
      (await planBaselinePreparation({
        ...planOptions,
        recordsPath: flags.recordsPath,
        ledgerPath: flags.ledgerPath,
      }));
    if (flags.write) await applyBaselinePreparation(plan);
    const result = summarizeBaselinePreparation(plan, {
      mode: flags.write ? "written" : "preview",
    });
    return flags.guided && flags.write
      ? {
          ...result,
          nextAction:
            "Next: choose Review the script to classify every column interactively.",
        }
      : result;
  };

  const planRuntimeStackCleanup = async ({
    flags,
    planOptions,
  }: ProjectCommandInput): Promise<RehearsalCleanupPlan | CleanupStackPlan> => {
    const topology = await loadRuntimeTopology(planOptions);
    const targets: Array<{
      name: string;
      configPath: string;
      plan: RehearsalCleanupPlan;
    }> = [];
    for (const target of topology.targets) {
      targets.push({
        name: target.name,
        configPath: target.configPath,
        plan: await planRehearsalCleanup({
          projectRoot: topology.projectRoot,
          configPath: target.configPath,
          includeRuntime: flags.includeRuntime,
          includeImages: flags.includeImages && target.primary,
        }),
      });
    }
    if (targets.length === 1) return targets[0]!.plan;
    return {
      digest: createHash("sha256")
        .update(
          JSON.stringify(
            targets.map((target) => ({
              name: target.name,
              digest: target.plan.digest,
            })),
          ),
        )
        .digest("hex"),
      targets,
    };
  };

  const runCleanup = async ({
    flags,
    planOptions,
  }: ProjectCommandInput): Promise<unknown> => {
    const plan =
      (flags.cleanupPlan as
        RehearsalCleanupPlan | CleanupStackPlan | undefined) ??
      (await planRuntimeStackCleanup({ flags, planOptions }));
    if (!flags.write) return { mode: "preview", plan };
    if (isCleanupStackPlan(plan)) {
      if (flags.cleanupConfirmation !== plan.digest) {
        throw new Error(
          "Cleanup requires the exact --confirm-cleanup digest from a fresh preview. Nothing was removed.",
        );
      }
      for (const target of plan.targets) {
        const refreshed = await planRehearsalCleanup({
          projectRoot,
          configPath: target.configPath,
          includeRuntime: target.plan.runtime.included,
          includeImages: target.plan.images.requested,
        });
        if (refreshed.digest !== target.plan.digest) {
          throw new Error(
            `Cleanup targets changed for ${target.name} after the preview. Nothing was removed; preview the cleanup again.`,
          );
        }
      }
      const appliedTargets = [];
      for (const target of plan.targets) {
        appliedTargets.push({
          name: target.name,
          applied: await applyRehearsalCleanup({
            plan: target.plan,
            confirmation: target.plan.digest,
            projectRoot,
            configPath: target.configPath,
            removeRuntime: async () => {
              runManager({
                action: "discard",
                flags,
                configPath: target.configPath,
                targetName: target.name,
              });
            },
          }),
        });
      }
      return {
        mode: "written",
        plan,
        applied: { targets: appliedTargets },
      };
    }
    const applied = await applyRehearsalCleanup({
      plan,
      ...(flags.cleanupConfirmation === undefined
        ? {}
        : { confirmation: flags.cleanupConfirmation }),
      ...planOptions,
      removeRuntime: async () => {
        runManager({ action: "discard", flags });
      },
    });
    return { mode: "written", plan, applied };
  };

  const loadIdentityClaimPlan = async ({
    flags,
    planOptions,
  }: ProjectCommandInput) => {
    const loaded = await loadRehearsalConfig(planOptions);
    if (!loaded.paths.identityPolicy) {
      throw new Error("No config.identityPolicy is configured.");
    }
    if (!flags.identityName) {
      throw new Error("Choose a declared identity with --identity=<name>.");
    }
    const policy = validateIdentityPolicy(
      JSON.parse(await readFile(loaded.paths.identityPolicy, "utf8")),
    );
    return {
      loaded,
      plan: createIdentityClaimPlan({
        policy,
        name: flags.identityName,
      }),
    };
  };

  return Object.freeze({
    loadIdentityClaimPlan,
    planRuntimeStackCleanup,
    runBaselinePreparation,
    runCleanup,
    runSetup,
  });
};
