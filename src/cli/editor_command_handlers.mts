import { inspectMigrationSource } from "../runtime/migrations/migration_source_inspection.mjs";
/** Versioned, read-only contracts for editor review; never a second runtime engine. */
import { inspectMigrationReviewPlan } from "../runtime/migrations/migration_plan.mjs";
import {
  inspectMigrationInsights,
  renderMigrationInsights,
} from "../runtime/migrations/migration_insights.mjs";
import {
  inspectMigrationImpact,
  measureMigrationImpact,
  renderMigrationImpact,
} from "../runtime/migrations/migration_impact.mjs";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import {
  applyStopStalePlan,
  inspectStopStalePlan,
  stopReviewedStaleTarget,
} from "../runtime/recovery/stale_environment_plan.mjs";
import {
  inspectConfigurationMetadata,
  reviewConfigurationProposal,
} from "../project/configuration_review.mjs";
export const createEditorCommandHandlers = (): readonly CommandDefinition[] => [
  exactCommands(
    "migration-source",
    ["inspect source"],
    async ({ planOptions, flags }) => {
      const data = await inspectMigrationSource(planOptions, {
        target: flags.target,
        nativeIdentity: flags.nativeIdentity,
        sourceSha256: flags.sourceSha256,
        candidateSha256: flags.candidateSha256,
      });
      return renderedCommand({
        data,
        render: (result) =>
          `REVIEWED SOURCE — READ ONLY\n${result.target}: ${result.workspaceRelativePath}\nSHA-256: ${result.sha256}\nThis reference does not attribute an SDK failure or statement position.`,
      });
    },
  ),

  exactCommands(
    "migration-impact-preview",
    ["inspect impact"],
    async ({ planOptions, flags }) => {
      const data = await inspectMigrationImpact(planOptions, flags.target);
      return renderedCommand({ data, render: renderMigrationImpact });
    },
  ),
  exactCommands(
    "migration-impact-measurement",
    ["measure impact"],
    async ({ planOptions, flags }) => {
      const data = await measureMigrationImpact({
        options: planOptions,
        targetName: flags.target,
        confirmation: flags.confirmation,
      });
      const incomplete = ["partial", "unknown"].includes(
        data.measurementStatus,
      );
      return renderedCommand({
        data,
        render: renderMigrationImpact,
        status: incomplete ? "not_ready" : "success",
        ...(incomplete ? { exitCode: 1 } : {}),
      });
    },
  ),
  exactCommands(
    "migration-insights",
    ["inspect insights"],
    async ({ planOptions }) => {
      const data = await inspectMigrationInsights(planOptions);
      return renderedCommand({ data, render: renderMigrationInsights });
    },
  ),
  exactCommands(
    "configuration",
    ["configuration", "configuration review"],
    async ({ command, planOptions, flags }) => {
      const data =
        command === "configuration review"
          ? await reviewConfigurationProposal(
              planOptions,
              flags.proposalPath ??
                (() => {
                  throw new Error(
                    "configuration review requires --proposal=PROJECT_LOCAL_JSON.",
                  );
                })(),
            )
          : await inspectConfigurationMetadata(planOptions);
      return renderedCommand({
        data,
        render: (result) =>
          `CONFIGURATION — READ ONLY\nActive configuration: ${result.path}\nSource fingerprint: ${result.sourceSha256}\nNo configuration was written and no proposed command was executed. Use --json for field validation and review evidence.`,
      });
    },
  ),
  exactCommands("migration-plan", ["inspect plan"], async ({ planOptions }) => {
    const data = await inspectMigrationReviewPlan(planOptions);
    return renderedCommand({
      data,
      render: (result) =>
        `MIGRATION REVIEW — READ ONLY\n${result.candidateCount} required candidates\nExact approval digest: ${result.candidateSha256}\nSQL safety is not inferred. Use --json for the ordered history, dependencies, and warnings.`,
    });
  }),
  exactCommands(
    "stop-stale",
    ["stop-stale"],
    async ({ planOptions, flags }) => {
      const plan = await inspectStopStalePlan(planOptions);
      if (flags.write)
        throw new Error(
          "stop-stale uses --confirm-stop=EXACT_DIGEST, not --write. No environment was stopped.",
        );
      const stopped = flags.stopConfirmation
        ? await applyStopStalePlan({
            preview: plan,
            confirmation: flags.stopConfirmation,
            refresh: () => inspectStopStalePlan(planOptions),
            stop: async (target) => {
              await stopReviewedStaleTarget({
                projectRoot: planOptions.projectRoot ?? process.cwd(),
                plan,
                target,
              });
            },
          })
        : [];
      const data = {
        mode: flags.stopConfirmation ? "stopped" : "preview",
        plan,
        stopped,
      };
      return renderedCommand({
        data,
        render: (result) =>
          [
            `STALE ENVIRONMENTS — ${result.mode.toUpperCase()}`,
            ...result.plan.targets.map(
              (target) =>
                `${target.displayName} (${target.target}) · ${target.containers.length} containers · last observable activity ${target.lastObservableActivityAt}`,
            ),
            result.plan.activityLimitation,
            `Exact confirmation: --confirm-stop=${result.plan.digest}`,
            "Database and Storage contents, volumes, images, and the shared engine are preserved.",
          ].join("\n"),
      });
    },
  ),
];
