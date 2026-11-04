/** Persistent application-session command handler. */

import * as prompts from "@clack/prompts";
import { exactCommands, renderedCommand } from "../command_contract.mjs";
import type { CommandDefinition } from "../command_contract.mjs";
import type { createRuntimeCommands } from "../runtime/runtime_commands.mjs";
import type { RuntimeStackResult } from "../runtime/runtime_stack_runner.mjs";
import { useStyledPrompts } from "../presentation/terminal.mjs";

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
            `Application: ${ready.applicationUrl}`,
            "Closing applies the configured stop or discard policy.",
            guided
              ? "Press Ctrl+C to close the app and return here, or Ctrl+Z to exit Rehearsal."
              : "Press Ctrl+C or Ctrl+Z to close the app. Rehearsal will then apply the configured lifecycle policy.",
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
          data.lifecycle.stop?.output,
        ]
          .filter(Boolean)
          .join("\n");
      }
      const sqlite =
        (state.runtimeTopology as RuntimeStackResult["topology"] | undefined)
          ?.primary.config.runtime.target === "sqlite";
      return renderedCommand({
        data,
        render: (result) =>
          [
            "SANDBOX APP CLOSED",
            `Application stopped after ${result.application.stoppedBy}.`,
            result.lifecycle.runtimeState === "removed"
              ? sqlite
                ? `Lifecycle ${result.lifecycle.mode} removed the SQLite sandbox file and its data; the immutable baseline remains.`
                : `Lifecycle ${result.lifecycle.mode} removed the disposable database runtime and its data; the immutable baseline remains.`
              : result.lifecycle.runtimeState === "stopped"
                ? sqlite
                  ? `Lifecycle ${result.lifecycle.mode} paused the SQLite sandbox file; its local data was preserved.`
                  : `Lifecycle ${result.lifecycle.mode} stopped the database runtime; its local database and Storage changes were preserved.`
                : sqlite
                  ? `Lifecycle ${result.lifecycle.mode} left the SQLite sandbox file enabled; its local data was preserved.`
                  : `Lifecycle ${result.lifecycle.mode} left the database runtime running; its local database and Storage changes were preserved.`,
            result.lifecycle.runtimeState === "removed"
              ? "Run rehearsal run to create a fresh disposable runtime."
              : result.lifecycle.runtimeState === "stopped"
                ? "Run rehearsal start or rehearsal open to resume."
                : sqlite
                  ? "Run rehearsal open to return, rehearsal verify to check it, or rehearsal stop to pause the SQLite sandbox file."
                  : "Run rehearsal open to return, rehearsal verify to check it, or rehearsal stop to stop the databases.",
          ].join("\n"),
      });
    },
  ),
];
