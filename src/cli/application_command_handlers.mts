/** Persistent application-session command handler. */

import * as prompts from "@clack/prompts";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import type { createRuntimeCommands } from "./runtime_commands.mjs";
import { useStyledPrompts } from "./terminal.mjs";

type RuntimeCommands = ReturnType<typeof createRuntimeCommands>;

export const createApplicationCommandHandlers = ({
  openRuntimeApplication,
}: {
  openRuntimeApplication: RuntimeCommands["openRuntimeApplication"];
}): readonly CommandDefinition[] => [
  exactCommands(
    "open",
    ["open"],
    async ({ flags, planOptions, guided, state }) => {
      if (flags.dryRun) {
        throw new Error("--dry-run is supported only by rehearsal run.");
      }
      const data = await openRuntimeApplication({
        flags,
        planOptions,
        session: state,
        onReady: (ready) => {
          const lines = [
            `Application: ${ready.url}`,
            "The verified database runtime stays running and keeps your local changes.",
            guided
              ? "Press Ctrl+C to close the app and return here, or Ctrl+Z to exit Rehearsal."
              : "Press Ctrl+C or Ctrl+Z to close the app. Rehearsal will leave the database runtime running.",
          ];
          if (useStyledPrompts(flags)) {
            prompts.note(lines.join("\n"), "SANDBOX READY");
          } else if (!flags.json) {
            console.log(["", "SANDBOX READY", ...lines, ""].join("\n"));
          }
        },
      });
      if (guided && data.application.stoppedBy === "SIGTSTP") {
        flags.exitGuidedSession = true;
      }
      if (guided) {
        state.lastGuidedDetails = [
          data.started.output,
          data.verified.output,
          ...data.preparations.map((preparation) => preparation.output),
        ]
          .filter(Boolean)
          .join("\n");
      }
      return renderedCommand({
        data,
        render: (result) =>
          [
            "SANDBOX APP CLOSED",
            `Application stopped after ${result.application.stoppedBy}.`,
            "The database runtime and its local database and Storage changes were preserved.",
            "Run rehearsal open to return, rehearsal verify to check it, or rehearsal stop to stop the databases.",
          ].join("\n"),
      });
    },
  ),
];
