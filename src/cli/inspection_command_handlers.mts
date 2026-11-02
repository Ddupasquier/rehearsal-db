import { inspectBaselineSizing } from "../runtime/resources/baseline_sizing.mjs";
/** Read-only readiness, support, planning, and inspection command handlers. */

import { collectRehearsalSupportReport } from "../project/support_report.mjs";
import { discoverProjectProfile } from "../project/project_discovery.mjs";
import {
  inspectRehearsalBaseline,
  inspectRehearsalMigrations,
} from "../runtime/lifecycle/plan.mjs";
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
import { inspectRehearsalResources } from "../runtime/resources/resource_inventory.mjs";

const formatBytes = (bytes: number): string =>
  `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export const createInspectionCommandHandlers =
  (): readonly CommandDefinition[] => [
    exactCommands(
      "baseline-sizing",
      ["inspect sizing"],
      async ({ planOptions }) => {
        const data = await inspectBaselineSizing(planOptions);
        return renderedCommand({
          data,
          render: (value) =>
            `BASELINE SIZING — READ ONLY\n${value.baselineRows} sanitized rows; ${value.baselineBytes} bytes.\nSelection: ${value.selection}. No rows or runtime data changed.\nUse --json for exact shape/input bindings and fidelity limits.`,
        });
      },
    ),
    exactCommands("discover", ["discover"], async ({ planOptions }) => {
      const data = await discoverProjectProfile({
        projectRoot: planOptions.projectRoot ?? process.cwd(),
      });
      return renderedCommand({
        data,
        render: (result) =>
          [
            `PROJECT PROFILE — READ ONLY`,
            `Detected: ${result.detected.length}`,
            `Suggested: ${result.suggested.length}`,
            `Your decision: ${result.decisions.length}`,
            `Configuration: ${result.configuration.state.replaceAll("_", " ")}`,
            "",
            "Run rehearsal discover --json for evidence and proposed configuration fields.",
          ].join("\n"),
      });
    }),
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
      "environments",
      ["environments", "resources"],
      async ({ planOptions, command }) => {
        const data = await inspectRehearsalResources(planOptions, {
          includeDetails: command === "resources",
        });
        return renderedCommand({
          data,
          render: (result) => {
            const disk = result.engine.disk;
            const lines = [
              result.catalog === undefined
                ? "REHEARSAL ENVIRONMENTS — READ ONLY"
                : "REHEARSAL LOCAL RESOURCES — READ ONLY",
              `Docker engine: ${result.engine.state}${result.engine.context ? ` (${result.engine.context})` : ""}`,
              disk
                ? `Docker disk: ${disk.usedPercent}% used · ${formatBytes(disk.availableBytes)} free of ${formatBytes(disk.totalBytes)}`
                : "Docker disk: not measurable through this engine",
              "",
              ...result.environments.flatMap((entry) => [
                `${entry.displayName} (${entry.target}) · ${entry.provider} · ${entry.state}${entry.protected ? " · protected" : ""}`,
                `  Project ID: ${entry.projectId}`,
                `  Containers: ${entry.runningContainerCount}/${entry.containerCount} running · volumes: ${entry.volumeCount} · ${entry.retention}`,
                `  Owned disk: ${entry.diskUsageBytes === null ? "not measurable" : formatBytes(entry.diskUsageBytes)}${entry.lastActivityAt ? ` · last activity: ${entry.lastActivityAt}` : ""}`,
                `  Live use: ${entry.cpuPercent === null ? "CPU unavailable" : `${entry.cpuPercent.toFixed(2)}% CPU`} · ${entry.memoryUsageBytes === null ? "memory unavailable" : `${formatBytes(entry.memoryUsageBytes)} memory`}`,
                `  Cleanup: ${entry.cleanupEligibility.replaceAll("-", " ")}`,
              ]),
            ];
            if (result.catalog) {
              lines.push(
                "",
                "Images",
                ...result.catalog.images.flatMap((image) => [
                  `${image.service} · ${image.state} · ${formatBytes(image.bytes)}`,
                  `  ${image.id}`,
                  `  ${image.tags.join(", ")}`,
                  `  ${image.reason}`,
                ]),
                "",
                "Data volumes",
                ...result.catalog.volumes.flatMap((volume) => [
                  `${volume.name} · ${volume.purpose} · ${volume.state}`,
                  `  ${volume.bytes === null ? "Size unavailable" : formatBytes(volume.bytes)} · ${volume.reason}`,
                ]),
                "",
                "Other containers — read only",
                ...result.catalog.otherContainers.map(
                  (container) =>
                    `${container.name} · ${container.running ? "running" : "stopped"} · ${container.reason}`,
                ),
              );
            }
            if (result.stale.digest) {
              lines.push(
                "",
                `${result.stale.stoppedCount} stopped environment(s) can be reviewed with rehearsal cleanup --include-runtime.`,
                "No container or volume was changed.",
              );
            }
            return lines.join("\n");
          },
        });
      },
    ),
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
