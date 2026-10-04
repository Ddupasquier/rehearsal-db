/** Parse and classify the stable Rehearsal command-line contract. */

export const parseArguments = (arguments_) => {
  const flags = {
    json: false,
    help: false,
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
    cleanupConfirmation: undefined,
    sourceAccessConfirmation: undefined,
    sourceRetirementConfirmation: undefined,
    refreshConfirmation: undefined,
    identityConfirmation: undefined,
    identityName: undefined,
    runtimeTopology: undefined,
    targetConfirmations: undefined,
    exitGuidedSession: false,
  };
  const positionals = [];
  for (const argument of arguments_) {
    if (argument === "--json") flags.json = true;
    else if (argument === "--help" || argument === "-h") flags.help = true;
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
    else if (argument.startsWith("--"))
      throw new Error(`Unknown Rehearsal option: ${argument}.`);
    else positionals.push(argument);
  }
  return { flags, positionals };
};

export const resetGuidedFlags = (flags) => {
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
    cleanupConfirmation: undefined,
    sourceAccessConfirmation: undefined,
    sourceRetirementConfirmation: undefined,
    refreshConfirmation: undefined,
    identityConfirmation: undefined,
    identityName: undefined,
    runtimeTopology: undefined,
    targetConfirmations: undefined,
    exitGuidedSession: false,
    setupPlan: undefined,
    preparationPlan: undefined,
    cleanupPlan: undefined,
  });
};

export const commandMutatesProject = ({ command, flags, guided }) => {
  if (guided) return true;
  if (["setup", "init", "baseline prepare", "privacy key"].includes(command))
    return flags.write;
  if (command === "cleanup") return flags.write;
  if (command === "source apply")
    return Boolean(flags.sourceAccessConfirmation);
  if (command === "source retire")
    return Boolean(flags.sourceRetirementConfirmation);
  if (command === "refresh") return Boolean(flags.refreshConfirmation);
  if (command === "identity claim") return Boolean(flags.identityConfirmation);
  if (command === "run") return !flags.dryRun;
  return [
    "baseline create",
    "baseline refresh",
    "open",
    "start",
    "migrate",
    "reset",
    "stop",
    "discard",
  ].includes(command);
};
