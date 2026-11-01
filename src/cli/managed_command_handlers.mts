/** Explicitly synthetic managed-protocol prototype; no hosted execution or upload. */
import {
  exactCommands,
  renderedCommand,
  type CommandDefinition,
} from "./command_contract.mjs";
import {
  managedPrototypeExample,
  planManagedPrototype,
  readManagedPrototypeRequest,
  executeManagedPrototype,
  recoverManagedPrototype,
} from "../runtime/managed/managed_prototype.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
const tenant = "synthetic-tenant";
export const createManagedCommandHandlers =
  (): readonly CommandDefinition[] => [
    exactCommands("managed-example", ["managed example"], async () =>
      renderedCommand({
        data: managedPrototypeExample(),
        render: (value) => JSON.stringify(value, null, 2),
      }),
    ),
    exactCommands("managed-plan", ["managed plan"], async ({ flags }) => {
      if (!flags.proposalPath)
        throw new Error(
          "managed plan requires --proposal=<synthetic-request.json>.",
        );
      const data = planManagedPrototype(
        await readManagedPrototypeRequest(flags.proposalPath),
        tenant,
      );
      return renderedCommand({
        data,
        render: (value) =>
          `SYNTHETIC LOCAL PROTOCOL — no upload or hosted execution.\nReviewed consent: ${value.consentSha256}`,
      });
    }),
    exactCommands("managed-recover", ["managed recover"], async ({ flags }) => {
      if (!flags.proposalPath || !flags.managedConfirmation)
        throw new Error(
          "managed recover requires the exact retained recovery receipt and its reviewed --confirm-managed digest.",
        );
      const data = await recoverManagedPrototype({
        input: await readManagedPrototypeRequest(flags.proposalPath),
        consentSha256: flags.managedConfirmation,
      });
      return renderedCommand({
        data,
        render: (value) =>
          `Synthetic owned recovery: ${value.cleanup}. No processes stopped or databases changed.`,
      });
    }),
    exactCommands(
      "managed-prototype",
      ["managed prototype"],
      async ({ flags }) => {
        if (!flags.proposalPath || !flags.managedConfirmation)
          throw new Error(
            "managed prototype requires a reviewed --proposal and --confirm-managed digest from managed plan.",
          );
        const signal = getOperationCancellationSignal();
        const data = await executeManagedPrototype({
          input: await readManagedPrototypeRequest(flags.proposalPath),
          authorizedTenant: tenant,
          consentSha256: flags.managedConfirmation,
          ...(signal ? { signal } : {}),
        });
        return renderedCommand({
          data,
          status: data.status === "completed" ? "success" : "error",
          exitCode: data.status === "completed" ? 0 : 1,
          render: (value) =>
            `Synthetic prototype: ${value.status}; cleanup ${value.cleanup}. No data uploaded; hosted isolation and costs remain unverified.`,
        });
      },
    ),
  ];
