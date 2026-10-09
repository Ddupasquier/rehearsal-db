/** Assemble the CLI command families into one ordered typed registry. */

import { createApplicationCommandHandlers } from "./application_command_handlers.mjs";
import { createBasicCommandHandlers } from "./basic_command_handlers.mjs";
import { createCommandRegistry } from "./command_registry.mjs";
import { createIdentityCommandHandlers } from "./identity_command_handlers.mjs";
import { createInspectionCommandHandlers } from "./inspection_command_handlers.mjs";
import { createProjectCommandHandlers } from "./project_command_handlers.mjs";
import { createRuntimeActionHandlers } from "./runtime_action_handlers.mjs";
import { createSourceCommandHandlers } from "./source_command_handlers.mjs";
import type { createProjectCommands } from "./project_commands.mjs";
import type { createRuntimeCommands } from "./runtime_commands.mjs";
import type { createRefreshWorkflow } from "./source_commands.mjs";

type ProjectCommands = ReturnType<typeof createProjectCommands>;
type RuntimeCommands = ReturnType<typeof createRuntimeCommands>;
type RefreshWorkflow = ReturnType<typeof createRefreshWorkflow>;

export const createCliCommandRegistry = ({
  projectRoot,
  projectCommands,
  runtimeCommands,
  runRefreshWorkflow,
}: {
  projectRoot: string;
  projectCommands: ProjectCommands;
  runtimeCommands: RuntimeCommands;
  runRefreshWorkflow: RefreshWorkflow;
}) =>
  createCommandRegistry([
    ...createBasicCommandHandlers(),
    ...createProjectCommandHandlers({
      projectRoot,
      runSetup: projectCommands.runSetup,
      runBaselinePreparation: projectCommands.runBaselinePreparation,
      runCleanup: projectCommands.runCleanup,
    }),
    ...createSourceCommandHandlers({ runRefreshWorkflow }),
    ...createIdentityCommandHandlers({
      loadIdentityClaimPlan: projectCommands.loadIdentityClaimPlan,
      loadIdentityPolicy: projectCommands.loadIdentityPolicy,
      startRuntimeApplication: runtimeCommands.startRuntimeApplication,
    }),
    ...createInspectionCommandHandlers(),
    ...createApplicationCommandHandlers({
      openRuntimeApplication: runtimeCommands.openRuntimeApplication,
    }),
    ...createRuntimeActionHandlers({
      prepareCandidateConfirmation:
        runtimeCommands.prepareCandidateConfirmation,
      prepareDependentTargets: runtimeCommands.prepareDependentTargets,
      proveRuntimeStack: runtimeCommands.proveRuntimeStack,
      runRuntimeStack: runtimeCommands.runRuntimeStack,
    }),
  ]);
