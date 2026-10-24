import { describe, expect, it } from "vitest";
import {
  commandMutatesProject,
  parseArguments,
  resetGuidedFlags,
} from "../../../dist/src/cli/arguments.mjs";
import {
  RehearsalError,
  normalizeRehearsalError,
} from "../../../dist/src/shared/diagnostics.mjs";

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

  it.each(["--surprise", "--checksum", "--candidate", "--baseline"])(
    "classifies unknown option %s as invalid input regardless of its text",
    (option) => {
      let failure;
      try {
        parseArguments(["doctor", option]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(RehearsalError);
      expect(normalizeRehearsalError(failure)).toMatchObject({
        category: "configuration_invalid",
        code: "CONFIGURATION_INVALID",
        exitCode: 2,
        message: `Unknown Rehearsal option: ${option}.`,
        suggestions: ["Run rehearsal --help to list supported options."],
      });
    },
  );

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

  it("keeps stale-stop previews read-only and locks only an exact confirmed stop", () => {
    const preview = parseArguments(["stop-stale", "--json"]);
    expect(
      commandMutatesProject({ command: "stop-stale", flags: preview.flags }),
    ).toBe(false);
    const apply = parseArguments([
      "stop-stale",
      `--confirm-stop=${"a".repeat(64)}`,
    ]);
    expect(apply.flags.stopConfirmation).toBe("a".repeat(64));
    expect(
      commandMutatesProject({ command: "stop-stale", flags: apply.flags }),
    ).toBe(true);
    expect(
      commandMutatesProject({
        command: "configuration review",
        flags: parseArguments(["--proposal=proposal.json"]).flags,
      }),
    ).toBe(false);
  });

  it("keeps impact preview offline and locks measurement even without confirmation or with dry-run", () => {
    const preview = parseArguments([
      "inspect",
      "impact",
      "--target=publication",
      "--json",
    ]);
    expect(preview.positionals).toEqual(["inspect", "impact"]);
    expect(preview.flags.target).toBe("publication");
    expect(
      commandMutatesProject({
        command: "inspect impact",
        flags: preview.flags,
      }),
    ).toBe(false);
    const measurement = parseArguments([
      "measure",
      "impact",
      "--target=primary",
      `--confirm-candidates=${"a".repeat(64)}`,
    ]);
    expect(measurement.flags.confirmation).toBe("a".repeat(64));
    expect(measurement.flags.target).toBe("primary");
    for (const flags of [
      measurement.flags,
      parseArguments([]).flags,
      parseArguments(["--dry-run"]).flags,
    ]) {
      expect(commandMutatesProject({ command: "measure impact", flags })).toBe(
        true,
      );
    }
  });
});
