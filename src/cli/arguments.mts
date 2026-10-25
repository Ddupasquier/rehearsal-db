/** Parse and classify the stable Rehearsal command-line contract. */

import { RehearsalError } from "../shared/diagnostics.mjs";

export type RehearsalVerbosity = "normal" | "verbose" | "debug";

export interface RehearsalCliFlags {
  json: boolean;
  help: boolean;
  version: boolean;
  verbosity: RehearsalVerbosity;
  dryRun: boolean;
  write: boolean;
  plain: boolean;
  configPath: string | undefined;
  confirmation: string | undefined;
  recordsPath: string | undefined;
  ledgerPath: string | undefined;
  assetsPath: string | undefined;
  target: string | undefined;
  includeRuntime: boolean;
  includeImages: boolean;
  imageIds: string[] | undefined;
  imagesOnly: boolean;
  cleanupConfirmation: string | undefined;
  stopConfirmation: string | undefined;
  engineStopConfirmation: string | undefined;
  workloadConfirmation: string | undefined;
  managedConfirmation: string | undefined;
  proposalPath: string | undefined;
  sourceAccessConfirmation: string | undefined;
  sourceRetirementConfirmation: string | undefined;
  refreshConfirmation: string | undefined;
  identityConfirmation: string | undefined;
  identityName: string | undefined;
  exitGuidedSession: boolean;
  guided: boolean;
}

export interface ParsedArguments {
  flags: RehearsalCliFlags;
  positionals: string[];
}

export const parseArguments = (
  arguments_: readonly string[],
): ParsedArguments => {
  const flags: RehearsalCliFlags = {
    json: false,
    help: false,
    version: false,
    verbosity: "normal",
    dryRun: false,
    write: false,
    plain: false,
    configPath: undefined,
    confirmation: undefined,
    recordsPath: undefined,
    ledgerPath: undefined,
    assetsPath: undefined,
    target: undefined,
    includeRuntime: false,
    includeImages: false,
    imageIds: undefined,
    imagesOnly: false,
    cleanupConfirmation: undefined,
    stopConfirmation: undefined,
    engineStopConfirmation: undefined,
    workloadConfirmation: undefined,
    managedConfirmation: undefined,
    proposalPath: undefined,
    sourceAccessConfirmation: undefined,
    sourceRetirementConfirmation: undefined,
    refreshConfirmation: undefined,
    identityConfirmation: undefined,
    identityName: undefined,
    exitGuidedSession: false,
    guided: false,
  };
  const positionals: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--json") flags.json = true;
    else if (argument === "--help" || argument === "-h") flags.help = true;
    else if (argument === "--version" || argument === "-V")
      flags.version = true;
    else if (argument === "--verbose") flags.verbosity = "verbose";
    else if (argument === "--debug") flags.verbosity = "debug";
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (argument === "--write") flags.write = true;
    else if (argument === "--plain") flags.plain = true;
    else if (argument.startsWith("--config="))
      flags.configPath = argument.slice("--config=".length);
    else if (argument.startsWith("--confirm-candidates="))
      flags.confirmation = argument.slice("--confirm-candidates=".length);
    else if (argument.startsWith("--confirm-cleanup="))
      flags.cleanupConfirmation = argument.slice("--confirm-cleanup=".length);
    else if (argument.startsWith("--confirm-stop="))
      flags.stopConfirmation = argument.slice("--confirm-stop=".length);
    else if (argument.startsWith("--confirm-engine-stop="))
      flags.engineStopConfirmation = argument.slice(
        "--confirm-engine-stop=".length,
      );
    else if (argument.startsWith("--confirm-workloads="))
      flags.workloadConfirmation = argument.slice(
        "--confirm-workloads=".length,
      );
    else if (argument.startsWith("--confirm-managed="))
      flags.managedConfirmation = argument.slice("--confirm-managed=".length);
    else if (argument.startsWith("--proposal="))
      flags.proposalPath = argument.slice("--proposal=".length);
    else if (argument.startsWith("--confirm-source-access="))
      flags.sourceAccessConfirmation = argument.slice(
        "--confirm-source-access=".length,
      );
    else if (argument.startsWith("--confirm-source-retirement="))
      flags.sourceRetirementConfirmation = argument.slice(
        "--confirm-source-retirement=".length,
      );
    else if (argument.startsWith("--confirm-refresh="))
      flags.refreshConfirmation = argument.slice("--confirm-refresh=".length);
    else if (argument.startsWith("--confirm-identity="))
      flags.identityConfirmation = argument.slice("--confirm-identity=".length);
    else if (argument.startsWith("--identity="))
      flags.identityName = argument.slice("--identity=".length);
    else if (argument.startsWith("--records="))
      flags.recordsPath = argument.slice("--records=".length);
    else if (argument.startsWith("--ledger="))
      flags.ledgerPath = argument.slice("--ledger=".length);
    else if (argument.startsWith("--assets="))
      flags.assetsPath = argument.slice("--assets=".length);
    else if (argument.startsWith("--target="))
      flags.target = argument.slice("--target=".length);
    else if (argument === "--include-runtime") flags.includeRuntime = true;
    else if (argument === "--include-images") flags.includeImages = true;
    else if (argument === "--images-only") {
      flags.imagesOnly = true;
      flags.includeImages = true;
    } else if (argument.startsWith("--image-id="))
      (flags.imageIds ??= []).push(argument.slice("--image-id=".length));
    else if (argument.startsWith("--"))
      throw new RehearsalError({
        category: "configuration_invalid",
        code: "CONFIGURATION_INVALID",
        message: `Unknown Rehearsal option: ${argument}.`,
        refused: "No Rehearsal command was executed.",
        suggestions: ["Run rehearsal --help to list supported options."],
      });
    else positionals.push(argument);
  }
  return { flags, positionals };
};

export const resetGuidedFlags = (flags: RehearsalCliFlags): void => {
  Object.assign(flags, {
    dryRun: false,
    write: false,
    confirmation: undefined,
    recordsPath: undefined,
    ledgerPath: undefined,
    assetsPath: undefined,
    target: undefined,
    includeRuntime: false,
    includeImages: false,
    imageIds: undefined,
    imagesOnly: false,
    cleanupConfirmation: undefined,
    stopConfirmation: undefined,
    engineStopConfirmation: undefined,
    workloadConfirmation: undefined,
    managedConfirmation: undefined,
    proposalPath: undefined,
    sourceAccessConfirmation: undefined,
    sourceRetirementConfirmation: undefined,
    refreshConfirmation: undefined,
    identityConfirmation: undefined,
    identityName: undefined,
    exitGuidedSession: false,
  });
};

export const commandMutatesProject = ({
  command,
  flags,
  guided,
}: {
  command: string;
  flags: RehearsalCliFlags;
  guided: boolean;
}): boolean => {
  if (guided) return true;
  // Engine shutdown owns the shared lifecycle lease, not a project/config lock.
  if (command === "engine status" || command === "engine stop") return false;
  if (["setup", "init", "baseline prepare", "privacy key"].includes(command))
    return flags.write;
  if (["cleanup", "cleanup containers"].includes(command)) return flags.write;
  if (command === "stop-stale") return Boolean(flags.stopConfirmation);
  if (command === "source apply")
    return Boolean(flags.sourceAccessConfirmation);
  if (command === "source retire")
    return Boolean(flags.sourceRetirementConfirmation);
  if (command === "refresh") return Boolean(flags.refreshConfirmation);
  if (command === "identity claim") return Boolean(flags.identityConfirmation);
  if (command === "identity connect") return true;
  if (command === "run") return !flags.dryRun;
  return [
    "baseline create",
    "baseline refresh",
    "open",
    "start",
    "migrate",
    "measure impact",
    "reset",
    "stop",
    "discard",
  ].includes(command);
};
