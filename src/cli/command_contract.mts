/** Typed contracts shared by CLI command handlers and the process entry point. */

import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import type { RehearsalStatus } from "../shared/diagnostics.mjs";
import type { RehearsalCliFlags, RehearsalVerbosity } from "./arguments.mjs";

export interface CliSessionState {
  lastGuidedDetails: string | undefined;
  runtimeTopology: unknown | undefined;
  targetConfirmations: unknown | undefined;
  setupPlan: unknown | undefined;
  preparationPlan: unknown | undefined;
  cleanupPlan: unknown | undefined;
}

export const createCliSessionState = (): CliSessionState => ({
  lastGuidedDetails: undefined,
  runtimeTopology: undefined,
  targetConfirmations: undefined,
  setupPlan: undefined,
  preparationPlan: undefined,
  cleanupPlan: undefined,
});

export const resetCommandSessionState = (state: CliSessionState): void => {
  Object.assign(state, {
    runtimeTopology: undefined,
    targetConfirmations: undefined,
    setupPlan: undefined,
    preparationPlan: undefined,
    cleanupPlan: undefined,
  });
};

export interface CommandContext {
  readonly command: string;
  readonly flags: RehearsalCliFlags;
  readonly planOptions: RehearsalConfigPathOptions;
  readonly guided: boolean;
  readonly state: CliSessionState;
}

export interface RenderedCommandResult {
  readonly kind: "rendered";
  readonly data: unknown;
  readonly status: RehearsalStatus;
  readonly render: (verbosity: RehearsalVerbosity) => string;
  readonly exitCode?: number;
}

export interface TextCommandResult {
  readonly kind: "text";
  readonly output: string;
  readonly exitCode?: number;
}

export interface SilentCommandResult {
  readonly kind: "silent";
  readonly exitCode?: number;
}

export type CommandResult =
  RenderedCommandResult | TextCommandResult | SilentCommandResult;

export type CommandHandler = (
  context: CommandContext,
) => Promise<CommandResult>;

export interface CommandDefinition {
  readonly id: string;
  readonly matches: (context: CommandContext) => boolean;
  readonly handle: CommandHandler;
}

export const renderedCommand = <Data,>({
  data,
  render,
  status = "success",
  exitCode,
}: {
  data: Data;
  render: (data: Data, verbosity: RehearsalVerbosity) => string;
  status?: RehearsalStatus;
  exitCode?: number;
}): RenderedCommandResult => ({
  kind: "rendered",
  data,
  status,
  render: (verbosity) => render(data, verbosity),
  ...(exitCode === undefined ? {} : { exitCode }),
});

export const textCommand = (
  output: string,
  options: { exitCode?: number } = {},
): TextCommandResult => ({
  kind: "text",
  output,
  ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
});

export const silentCommand = (
  options: { exitCode?: number } = {},
): SilentCommandResult => ({
  kind: "silent",
  ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
});

export const exactCommands = (
  id: string,
  commands: readonly string[],
  handle: CommandHandler,
): CommandDefinition => ({
  id,
  matches: ({ command }) => commands.includes(command),
  handle,
});
