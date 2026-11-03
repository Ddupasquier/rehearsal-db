/** Process-level input failures belong to runtime verification, outside docs:check. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, "dist/src/cli/rehearsal.mjs");

describe("CLI input contract", () => {
  it.each([
    { args: ["not-a-rehearsal-command"], unknownCommand: true },
    { args: ["checksum"], unknownCommand: true },
    { args: ["candidate"], unknownCommand: true },
    { args: ["baseline"], unknownCommand: true },
    { args: ["doctor", "--checksum"], unknownCommand: false },
    { args: ["doctor", "--candidate"], unknownCommand: false },
    { args: ["doctor", "--baseline"], unknownCommand: false },
  ])(
    "reports invalid CLI input $args with exit 2",
    async ({ args, unknownCommand }) => {
      let failure;
      try {
        await execute(process.execPath, [cli, ...args, "--json", "--plain"], {
          cwd: root,
          // Cold CLI imports on external storage can exceed the former five-second
          // fixture allowance. This bound does not change any product deadline.
          timeout: 20_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure?.code).toBe(2);
      expect(failure?.stderr).toBe("");
      const result = JSON.parse(failure.stdout);
      expect(result).toMatchObject({
        schemaVersion: 1,
        status: "error",
        error: {
          category: "configuration_invalid",
          code: "CONFIGURATION_INVALID",
          refused: "No Rehearsal command was executed.",
        },
      });
      expect(result.error.message).toContain(
        `Unknown Rehearsal ${unknownCommand ? "command" : "option"}:`,
      );
      expect(result.error.suggestions).toEqual([
        `Run rehearsal --help to list supported ${unknownCommand ? "commands" : "options"}.`,
      ]);
      if (unknownCommand) {
        expect(result.error.message).toContain(
          "Usage: rehearsal <command> [options]",
        );
      }
    },
    25_000,
  );
});
