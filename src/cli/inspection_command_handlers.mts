/** Read-only readiness, support, planning, and inspection command handlers. */

import { collectRehearsalSupportReport } from "../project/support_report.mjs";
import {
  inspectRehearsalBaseline,
  inspectRehearsalMigrations,
} from "../runtime/plan.mjs";
import {
  buildRuntimeStackPlan,
  runRuntimeStackDoctor,
  topologyCandidateSummary,
} from "./runtime_commands.mjs";
import {
  renderBaseline,
  renderCandidates,
  renderDoctor,
  renderMigrations,
  renderPlan,
  renderSupportReport,
} from "./renderers.mjs";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import { inspectProjectOperationState } from "../shared/operation_guard.mjs";

export const createInspectionCommandHandlers =
  (): readonly CommandDefinition[] => [
    exactCommands("activity", ["activity"], async ({ planOptions }) => {
      const data = await inspectProjectOperationState({
        projectRoot: planOptions.projectRoot ?? process.cwd(),
      });
      return renderedCommand({
        data,
        render: (result) => {
          if (result.state === "idle") return "Rehearsal activity: idle.";
          if (result.state === "invalid") {
            return "Rehearsal activity: invalid lock state. No lock was changed; finish or diagnose the owning operation before retrying a mutation.";
          }
          const label = result.state === "busy" ? "busy" : "stale";
          return [
            `Rehearsal activity: ${label}.`,
            `Operation: ${result.operation!.kind}`,
            `Started: ${result.operation!.startedAt}`,
            result.operation!.rehearsalVersion
              ? `Rehearsal: ${result.operation!.rehearsalVersion}`
              : null,
          ]
            .filter(Boolean)
            .join("\n");
        },
      });
    }),
    exactCommands(
      "doctor",
      ["doctor"],
      async ({ guided, flags, planOptions }) => {
        const data = await runRuntimeStackDoctor(planOptions);
        return renderedCommand({
          data,
          render: (result, verbosity) =>
            renderDoctor(
              result as Parameters<typeof renderDoctor>[0],
              verbosity as Parameters<typeof renderDoctor>[1],
            ),
          status: data.state === "READY" ? "success" : "not_ready",
          ...(data.state !== "READY" && !guided ? { exitCode: 1 } : {}),
        });
      },
    ),
    exactCommands("support", ["support"], async ({ planOptions }) => {
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
      return renderedCommand({
        data,
        render: (result) =>
          renderSupportReport(
            result as Parameters<typeof renderSupportReport>[0],
          ),
      });
    }),
    {
      id: "explain",
      matches: ({ command, flags }) =>
        command === "explain" || (command === "run" && flags.dryRun),
      handle: async ({ planOptions }) => {
        const data = await buildRuntimeStackPlan(planOptions);
        return renderedCommand({
          data,
          render: (result, verbosity) =>
            renderPlan(
              result as Parameters<typeof renderPlan>[0],
              verbosity as Parameters<typeof renderPlan>[1],
            ),
        });
      },
    },
    exactCommands(
      "inspect-baseline",
      ["inspect baseline"],
      async ({ planOptions }) => {
        const data = await inspectRehearsalBaseline(planOptions);
        return renderedCommand({ data, render: renderBaseline });
      },
    ),
    exactCommands(
      "inspect-migrations",
      ["inspect migrations"],
      async ({ planOptions }) => {
        const data = await inspectRehearsalMigrations(planOptions);
        return renderedCommand({
          data,
          render: (result, verbosity) =>
            renderMigrations(
              result,
              verbosity as Parameters<typeof renderMigrations>[1],
            ),
        });
      },
    ),
    exactCommands("candidates", ["candidates"], async ({ planOptions }) => {
      const { topology: _topology, ...data } =
        await topologyCandidateSummary(planOptions);
      return renderedCommand({
        data,
        render: (result, verbosity) =>
          renderCandidates(
            result,
            verbosity as Parameters<typeof renderCandidates>[1],
          ),
      });
    }),
  ];
