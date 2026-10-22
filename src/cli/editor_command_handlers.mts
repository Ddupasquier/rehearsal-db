/** Versioned, read-only contracts for editor review; never a second runtime engine. */
import { inspectMigrationReviewPlan } from "../runtime/migration_plan.mjs";
import {
  inspectMigrationInsights,
  renderMigrationInsights,
} from "../runtime/migration_insights.mjs";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import {
  applyStopStalePlan,
  inspectStopStalePlan,
  stopReviewedStaleTarget,
} from "../runtime/stale_environment_plan.mjs";
import {
  inspectConfigurationMetadata,
  reviewConfigurationProposal,
} from "../project/configuration_review.mjs";
export const createEditorCommandHandlers = (): readonly CommandDefinition[] => [
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
