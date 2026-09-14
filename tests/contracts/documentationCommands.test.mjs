import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, "scripts/operations/rehearsal/rehearsal_cli.mjs");
const documentedCommands = [
  "init",
  "baseline create",
  "doctor",
  "explain",
  "run --dry-run",
  "run --confirm-candidates=",
  "candidates",
  "inspect baseline",
  "inspect migrations",
  "start",
  "migrate --confirm-candidates=",
  "reset",
  "status",
  "stop",
  "discard",
  "verify",
];

describe("documented CLI contract", () => {
  it("keeps the command reference aligned with executable help", async () => {
    const [{ stdout }, commandReference, fixtureProof] = await Promise.all([
      execute(process.execPath, [cli, "--help"], { cwd: root }),
      readFile(join(root, "docs/commands.md"), "utf8"),
      readFile(
        join(
          root,
          "scripts/operations/rehearsal/prove_independent_fixture.mjs",
        ),
        "utf8",
      ),
    ]);

    for (const command of documentedCommands) {
      expect(stdout).toContain(command);
      expect(commandReference).toContain(command);
    }

    for (const command of [
      "doctor",
      "baseline create",
      "explain",
      "run --dry-run",
      "run",
      "candidates",
      "inspect baseline",
      "inspect migrations",
      "start",
      "migrate",
      "reset",
      "status",
      "stop",
      "discard",
      "verify",
    ]) {
      expect(fixtureProof).toContain(`\"${command}\"`);
    }
  });

  it("links every primary guide from the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const guide of [
      "getting-started",
      "tutorial",
      "configuration",
      "commands",
      "sanitization",
      "production-source",
      "baselines",
      "adapters",
      "security-model",
      "troubleshooting",
      "releasing",
      "glossary",
    ]) {
      expect(readme).toContain(`docs/${guide}.md`);
    }
  });
});
