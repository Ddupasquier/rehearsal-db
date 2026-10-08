/** Temporary source-access and privacy-safe baseline refresh command handlers. */

import { createSourceAccessPlan } from "../source/access.mjs";
import { formatCount } from "../shared/human_output.mjs";
import {
  createRefreshWorkflow,
  loadPreparationContext,
  runSourceAccess,
  runSourceBaselineRefresh,
  runSourceRetirement,
} from "./source_commands.mjs";
import {
  formatBytes,
  renderRefreshWorkflow,
  renderSourceAccessPlan,
  renderSourceRetirement,
} from "./renderers.mjs";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";

type RefreshWorkflow = ReturnType<typeof createRefreshWorkflow>;

export const createSourceCommandHandlers = ({
  runRefreshWorkflow,
}: {
  runRefreshWorkflow: RefreshWorkflow;
}): readonly CommandDefinition[] => [
  exactCommands(
    "source-plan",
    ["source plan"],
    async ({ flags, planOptions }) => {
      const { sourcePolicy } = await loadPreparationContext(planOptions);
      const data = createSourceAccessPlan({ policy: sourcePolicy });
      return renderedCommand({
        data,
        render: renderSourceAccessPlan,
      });
    },
  ),
  exactCommands(
    "source-apply",
    ["source apply"],
    async ({ flags, planOptions }) => {
      const data = await runSourceAccess({ flags, planOptions });
      return renderedCommand({
        data,
        render: (result) =>
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
    },
  ),
  exactCommands(
    "source-retire",
    ["source retire"],
    async ({ flags, planOptions }) => {
      const data = await runSourceRetirement({ flags, planOptions });
      return renderedCommand({ data, render: renderSourceRetirement });
    },
  ),
  exactCommands(
    "baseline-refresh",
    ["baseline refresh"],
    async ({ flags, planOptions }) => {
      const data = await runSourceBaselineRefresh({ planOptions });
      return renderedCommand({
        data,
        render: (result) =>
          [
            `Activated refreshed baseline ${result.generationId}.`,
            `${formatCount(result.manifest.rowCount, "sanitized row")} across ${formatCount(Object.keys(result.manifest.tableCounts).length, "table")}.`,
            `Source estimate: ${formatCount(result.estimate.rows, "row")}, ${formatBytes(result.estimate.bytes)}.`,
            "",
            "Next: run rehearsal source retire, then rehearsal doctor.",
          ].join("\n"),
      });
    },
  ),
  exactCommands(
    "refresh",
    ["refresh"],
    async ({ flags, planOptions, state }) => {
      const data = await runRefreshWorkflow({
        flags,
        planOptions,
        session: state,
      });
      return renderedCommand({
        data,
        render: (result) =>
          renderRefreshWorkflow(
            result as Parameters<typeof renderRefreshWorkflow>[0],
          ),
      });
    },
  ),
];
