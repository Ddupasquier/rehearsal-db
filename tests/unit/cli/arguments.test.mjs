import { describe, expect, it } from "vitest";
import {
  commandMutatesProject,
  parseArguments,
  resetGuidedFlags,
} from "../../../dist/src/cli/arguments.mjs";

describe("CLI arguments", () => {
  it("separates commands from supported flags", () => {
    const { flags, positionals } = parseArguments([
      "identity",
      "claim",
      "--identity=owner",
      "--confirm-identity=digest",
      "--config=rehearsal.config.mjs",
      "--json",
      "--version",
    ]);

    expect(positionals).toEqual(["identity", "claim"]);
    expect(flags).toMatchObject({
      identityName: "owner",
      identityConfirmation: "digest",
      configPath: "rehearsal.config.mjs",
      json: true,
      version: true,
    });
  });

  it("accepts the conventional short version flag", () => {
    expect(parseArguments(["-V"]).flags.version).toBe(true);
  });

  it("rejects unknown long options", () => {
    expect(() => parseArguments(["doctor", "--surprise"])).toThrow(
      "Unknown Rehearsal option: --surprise.",
    );
  });

  it("clears one-action guided state without clearing display preferences", () => {
    const flags = parseArguments([
      "--plain",
      "--verbose",
      "--write",
      "--include-images",
      "--confirm-refresh=digest",
    ]).flags;

    resetGuidedFlags(flags);

    expect(flags).toMatchObject({
      plain: true,
      verbosity: "verbose",
      write: false,
      includeImages: false,
      refreshConfirmation: undefined,
    });
  });

  it("locks only commands that can change project state", () => {
    const flags = parseArguments([]).flags;

    expect(commandMutatesProject({ command: "doctor", flags })).toBe(false);
    expect(commandMutatesProject({ command: "run", flags })).toBe(true);
    expect(commandMutatesProject({ command: "open", flags })).toBe(true);
    expect(
      commandMutatesProject({
        command: "run",
        flags: { ...flags, dryRun: true },
      }),
    ).toBe(false);
    expect(
      commandMutatesProject({
        command: "cleanup",
        flags: { ...flags, write: true },
      }),
    ).toBe(true);
    expect(
      commandMutatesProject({ command: "doctor", flags, guided: true }),
    ).toBe(true);
  });
});
