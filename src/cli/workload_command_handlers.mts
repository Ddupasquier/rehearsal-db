/** Inspect/recover queue metadata without needing Docker, config or a project lock. */
import {
  inspectWorkloads,
  recoverWorkloads,
  withWorkloadDiagnostics,
} from "../runtime/workload_queue.mjs";
import {
  exactCommands,
  renderedCommand,
  type CommandDefinition,
} from "./command_contract.mjs";
import { RehearsalError } from "../shared/diagnostics.mjs";

export const createWorkloadCommandHandlers =
  (): readonly CommandDefinition[] => [
    exactCommands("workloads", ["workloads"], async () =>
      renderedCommand({
        data: await withWorkloadDiagnostics(() => inspectWorkloads()),
        render: (result) =>
          [
            "LOCAL WORKLOAD QUEUE — READ ONLY",
            "Participating lifecycle phases only. Host/VM capacity is not measured.",
            ...result.entries.map(
              (entry) =>
                `${entry.command} · ${entry.phase} · owner ${entry.owner} · PID ${entry.pid}${entry.recoveryRequired ? " · recovery required" : ""}`,
            ),
            result.entries.length
              ? ""
              : "No participating workload is queued or held.",
            ...(result.recoveryDigest
              ? [
                  "A dead holder may have surviving children. Check its owned commands before recovery.",
                  `After checking: rehearsal workloads recover --confirm-workloads=${result.recoveryDigest}`,
                  "Recovery clears exactly reviewed queue metadata; it does not stop processes or change databases.",
                ]
              : []),
          ]
            .filter(Boolean)
            .join("\n"),
      }),
    ),
    exactCommands(
      "workloads-recover",
      ["workloads recover"],
      async ({ flags }) => {
        if (!flags.workloadConfirmation)
          throw new RehearsalError({
            category: "configuration_invalid",
            code: "CONFIGURATION_INVALID",
            message:
              "Inspect rehearsal workloads and review dead holders before using --confirm-workloads=<digest>. Check their owned commands first; recovery does not stop surviving children.",
          });
        return renderedCommand({
          data: await withWorkloadDiagnostics(() =>
            recoverWorkloads(flags.workloadConfirmation!),
          ),
          render: (result) =>
            `Recovered ${result.recovered} reviewed dead workload holder(s). No process, container or database was changed.`,
        });
      },
    ),
  ];
