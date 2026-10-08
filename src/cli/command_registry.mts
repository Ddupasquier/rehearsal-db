/** Resolve one CLI request to exactly one typed command handler. */

import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
} from "./command_contract.mjs";

export interface CommandRegistry {
  readonly ids: readonly string[];
  execute(context: CommandContext): Promise<CommandResult | null>;
}

export const createCommandRegistry = (
  definitions: readonly CommandDefinition[],
): CommandRegistry => {
  const ids = definitions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("CLI command registry IDs must be unique.");
  }
  return Object.freeze({
    ids: Object.freeze(ids),
    async execute(context: CommandContext) {
      const definition = definitions.find((candidate) =>
        candidate.matches(context),
      );
      return definition ? definition.handle(context) : null;
    },
  });
};
