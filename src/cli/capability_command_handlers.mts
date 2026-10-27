/** Additive metadata contract. Success means inspection completed, never a rehearsal passed. */
import { inspectCommandCapabilities } from "../project/command_capabilities.mjs";
import {
  exactCommands,
  renderedCommand,
  type CommandDefinition,
} from "./command_contract.mjs";
export const createCapabilityCommandHandlers =
  (): readonly CommandDefinition[] => [
    exactCommands(
      "command-capabilities",
      ["inspect capabilities"],
      async ({ planOptions, flags }) => {
        const data = await inspectCommandCapabilities({
          projectRoot: planOptions.projectRoot ?? process.cwd(),
          ...(flags.receiptPath === undefined
            ? {}
            : { receiptPath: flags.receiptPath }),
        });
        return renderedCommand({
          data,
          render: () =>
            [
              "COMMAND CAPABILITIES — INSPECTION ONLY",
              "Runtime availability was not observed. No project configuration or engine was executed.",
              ...data.operations.flatMap((row) => [
                `${row.commands.join(", ")}: ${row.backend}; ${row.supportState}; availability ${row.availability}`,
                `  Requires: ${row.requirements.map((value) => value.replaceAll("-", " ")).join(", ")}`,
              ]),
              `Receipt: ${data.receipt.state}; current inputs, timestamp and live state remain unknown.`,
            ].join("\n"),
        });
      },
    ),
  ];
