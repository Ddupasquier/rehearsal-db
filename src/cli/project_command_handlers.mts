/** Project setup, baseline creation, privacy-key, and cleanup command handlers. */

import { relative } from "node:path";
import { createSyntheticBaselineFromFiles } from "../baseline/builder.mjs";
import { inspectBaselineInputFiles } from "../baseline/preparation.mjs";
import { createPrivacyKey } from "../baseline/privacy_engine.mjs";
import { formatCount } from "../shared/human_output.mjs";
import { runRehearsalInit } from "./init_command.mjs";
import { loadPreparationContext } from "./source_commands.mjs";
import {
  renderBaselinePreparation,
  renderCleanup,
  renderInit,
  renderSetup,
} from "./renderers.mjs";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import type { createProjectCommands } from "./project_commands.mjs";

type ProjectCommands = ReturnType<typeof createProjectCommands>;

export const createProjectCommandHandlers = ({
  projectRoot,
  runSetup,
  runBaselinePreparation,
  runCleanup,
}: {
  projectRoot: string;
  runSetup: ProjectCommands["runSetup"];
  runBaselinePreparation: ProjectCommands["runBaselinePreparation"];
  runCleanup: ProjectCommands["runCleanup"];
}): readonly CommandDefinition[] => [
  exactCommands("setup", ["setup"], async ({ flags, planOptions, state }) => {
    const data = await runSetup({ flags, planOptions, session: state });
    return renderedCommand({
      data,
      render: () => renderSetup(data as Parameters<typeof renderSetup>[0]),
    });
  }),
  exactCommands("init", ["init"], async ({ flags }) => {
    const data = await runRehearsalInit({ projectRoot, flags });
    return renderedCommand({
      data,
      render: (result) =>
        renderInit(result as Parameters<typeof renderInit>[0]),
    });
  }),
  exactCommands(
    "baseline-prepare",
    ["baseline prepare"],
    async ({ flags, planOptions, state }) => {
      const data = await runBaselinePreparation({
        flags,
        planOptions,
        session: state,
      });
      return renderedCommand({
        data,
        render: (result) => renderBaselinePreparation(result, flags),
      });
    },
  ),
  exactCommands(
    "baseline-create",
    ["baseline create"],
    async ({ flags, planOptions }) => {
      if (!flags.recordsPath || !flags.ledgerPath) {
        throw new Error(
          "baseline create requires --records and --ledger input paths.",
        );
      }
      const baselineInput = {
        ...planOptions,
        recordsPath: flags.recordsPath,
        ledgerPath: flags.ledgerPath,
        ...(flags.assetsPath === undefined
          ? {}
          : { assetsPath: flags.assetsPath }),
      };
      await inspectBaselineInputFiles(baselineInput);
      const data = await createSyntheticBaselineFromFiles(baselineInput);
      return renderedCommand({
        data,
        render: (baseline) =>
          [
            `Activated synthetic baseline ${baseline.generationId}: ${formatCount(baseline.rowCount, "row")} across ${formatCount(baseline.tableCount, "table")}; ${formatCount(baseline.migrationCount, "migration")} through ${baseline.migrationCutoff}.`,
            "",
            flags.guided
              ? "Next: choose Run a rehearsal when you are ready."
              : "Next: run rehearsal doctor to check readiness.",
          ].join("\n"),
      });
    },
  ),
  exactCommands(
    "privacy-key",
    ["privacy key"],
    async ({ flags, planOptions }) => {
      const { loaded } = await loadPreparationContext(planOptions);
      if (!loaded.paths.privacyKey) {
        throw new Error("No config.preparation.privacyKey is configured.");
      }
      const privacyKeyPath = loaded.paths.privacyKey;
      const data = flags.write
        ? {
            mode: "written" as const,
            path: relative(loaded.projectRoot, privacyKeyPath),
            ...(await createPrivacyKey(privacyKeyPath)),
          }
        : {
            mode: "preview" as const,
            path: relative(loaded.projectRoot, privacyKeyPath),
          };
      return renderedCommand({
        data,
        render: (result) =>
          result.mode === "preview"
            ? `PRIVACY KEY — PREVIEW\n\nWould create ${result.path} with owner-only permissions.\nNothing was written. Rerun with --write after reviewing the path.`
            : `Created owner-only privacy key at ${result.path}.\nFingerprint: ${result.fingerprint}\nThe key is excluded from source control and must not be shared.`,
      });
    },
  ),
  exactCommands(
    "cleanup",
    ["cleanup"],
    async ({ flags, planOptions, state }) => {
      const data = await runCleanup({ flags, planOptions, session: state });
      return renderedCommand({
        data,
        render: () =>
          renderCleanup(data as Parameters<typeof renderCleanup>[0]),
      });
    },
  ),
];
