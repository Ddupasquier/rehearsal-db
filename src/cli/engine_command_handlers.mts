/** Configuration-independent engine review and explicit, bounded VM shutdown. */
import {
  inspectEngineLifecycle,
  planEngineShutdown,
  shutdownEngine,
  ENGINE_LIFECYCLE_REASON_LABELS,
} from "../runtime/engines/engine_lifecycle.mjs";
import { RehearsalError } from "../shared/diagnostics.mjs";
import { fileURLToPath } from "node:url";
import {
  createInstalledPackageFingerprint,
  assertInstalledPackageFingerprint,
} from "../shared/operation_guard.mjs";
import { OPERATION_CANCELLATION_SIGNALS } from "../shared/cancellation.mjs";
import {
  exactCommands,
  renderedCommand,
  type CommandDefinition,
} from "./command_contract.mjs";

interface SignalTarget {
  on(event: string, handler: () => void): unknown;
  removeListener(event: string, handler: () => void): unknown;
}

/** Unlike project cancellation, preserve the engine's typed post-dispatch uncertainty. */
export const withEngineCommandCancellation = async <Value,>(
  task: (signal: AbortSignal) => Promise<Value>,
  target: SignalTarget = process,
): Promise<Value> => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  for (const event of OPERATION_CANCELLATION_SIGNALS) target.on(event, cancel);
  try {
    return await task(controller.signal);
  } finally {
    for (const event of OPERATION_CANCELLATION_SIGNALS)
      target.removeListener(event, cancel);
  }
};

export const createEngineCommandHandlers = (
  services: {
    inspect?: typeof inspectEngineLifecycle;
    plan?: typeof planEngineShutdown;
    stop?: typeof shutdownEngine;
  } = {},
): readonly CommandDefinition[] => [
  exactCommands("engine-status", ["engine status"], async ({ planOptions }) => {
    const data = await (services.inspect ?? inspectEngineLifecycle)({
      cwd: planOptions.projectRoot ?? process.cwd(),
    });
    return renderedCommand({
      data,
      render: (value) =>
        `ENGINE STATUS\nSelected engine: ${value.selected?.state ?? "unknown"}.\nColima default VM: ${value.colimaDefault.state}.\n${ENGINE_LIFECYCLE_REASON_LABELS[value.colimaDefault.reason]}`,
    });
  }),
  exactCommands(
    "engine-stop",
    ["engine stop"],
    async ({ flags, planOptions }) => {
      const cwd = planOptions.projectRoot ?? process.cwd();
      if (flags.target !== undefined)
        throw new RehearsalError({
          category: "configuration_invalid",
          code: "CONFIGURATION_INVALID",
          message:
            "VM shutdown affects the whole reviewed engine; --target cannot limit it to one project target.",
          refused: "No engine shutdown was requested.",
        });
      if (flags.engineStopConfirmation === undefined || flags.dryRun) {
        const data = await (services.plan ?? planEngineShutdown)({ cwd });
        return renderedCommand({
          data,
          render: (value) => {
            const impact = value.impact
              ? `${value.impact.runningCount} running container(s) are affected by whole-VM shutdown.\n${value.impact.containers.map((container) => `  ${container.name}: ${container.state}`).join("\n")}\n`
              : "Affected workload inspection is unavailable.\n";
            return `VM SHUTDOWN — REVIEW\n${ENGINE_LIFECYCLE_REASON_LABELS[value.reason]}\n${impact}Databases, volumes and images are not deleted.\n${value.state === "review-required" && value.consentDigest ? `After reviewing all shared workloads, rerun engine stop --confirm-engine-stop=${value.consentDigest}.` : "No VM shutdown was requested."}`;
          },
        });
      }
      if (!/^[a-f0-9]{64}$/u.test(flags.engineStopConfirmation))
        throw new RehearsalError({
          category: "configuration_invalid",
          code: "CONFIGURATION_INVALID",
          message:
            "VM shutdown requires the exact 64-character digest from engine stop preview.",
          refused: "No engine shutdown was requested.",
        });
      const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const expected = createInstalledPackageFingerprint({ packageRoot });
      const observed = await withEngineCommandCancellation(async (signal) => {
        assertInstalledPackageFingerprint({ packageRoot, expected });
        try {
          return await (services.stop ?? shutdownEngine)({
            cwd,
            confirmDigest: flags.engineStopConfirmation!,
            signal,
          });
        } finally {
          assertInstalledPackageFingerprint({ packageRoot, expected });
        }
      });
      const confirmed =
        (observed.status === "stopped" ||
          observed.status === "already-stopped") &&
        observed.engine !== null &&
        observed.confirmed.profileStopped &&
        observed.confirmed.vmProcessAbsent;
      const data =
        observed.status === "stopped" && !confirmed
          ? {
              ...observed,
              status: "unknown" as const,
              reason: "shutdown-unconfirmed" as const,
              confirmed: { profileStopped: false, vmProcessAbsent: false },
            }
          : observed;
      return renderedCommand({
        data,
        status: confirmed
          ? "success"
          : data.status === "already-stopped"
            ? "not_ready"
            : "error",
        exitCode: confirmed ? 0 : data.status === "cancelled" ? 130 : 1,
        render: (value) =>
          `VM shutdown: ${value.status}.\n${ENGINE_LIFECYCLE_REASON_LABELS[value.reason]}\n${confirmed ? "The reviewed Colima profile is stopped and its captured VM process has exited." : "A confirmed VM process exit was not established by this request."}\nNo database, volume or image deletion was requested.`,
      });
    },
  ),
];
