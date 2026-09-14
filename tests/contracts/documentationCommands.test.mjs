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

  it("keeps the copyable baseline inputs aligned with the proved fixture", async () => {
    const [gettingStarted, policy, ledger, records] = await Promise.all([
      readFile(join(root, "docs/getting-started.md"), "utf8"),
      readFile(
        join(
          root,
          "tests/fixtures/rehearsal-project/rehearsal/sanitization-policy.json",
        ),
        "utf8",
      ),
      readFile(
        join(
          root,
          "tests/fixtures/rehearsal-project/rehearsal/migration-ledger.json",
        ),
        "utf8",
      ),
      readFile(
        join(
          root,
          "tests/fixtures/rehearsal-project/rehearsal/sanitized-data.ndjson",
        ),
        "utf8",
      ),
    ]);
    const documentedJson = [
      ...gettingStarted.matchAll(/```json\n([\s\S]*?)\n```/gu),
    ].map(([, source]) => JSON.parse(source));

    expect(documentedJson).toContainEqual(JSON.parse(policy));
    expect(documentedJson).toContainEqual(JSON.parse(ledger));
    expect(documentedJson).toContainEqual(JSON.parse(records));
  });

  it("keeps npm publication behind an exact-artifact human gate", async () => {
    const [workflow, releaseGuide, manifest] = await Promise.all([
      readFile(join(root, ".github/workflows/publish.yml"), "utf8"),
      readFile(join(root, "docs/releasing.md"), "utf8"),
      readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    ]);
    const normalizedReleaseGuide = releaseGuide.replace(/\s+/gu, " ");
    const prepareJob = workflow.slice(
      workflow.indexOf("\n  prepare:"),
      workflow.indexOf("\n  publish:"),
    );

    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("actions/download-artifact@v8");
    expect(workflow).toContain("sha256sum --check --strict");
    expect(workflow).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(workflow).toContain('test "$RELEASE_TAG" = "v$PACKAGE_VERSION"');
    expect(workflow).toContain('test "$RELEASE_PRERELEASE" = "true"');
    expect(workflow).toContain('test "$PACKAGE_PRIVATE" = "false"');
    expect(workflow).toContain('test "$PACKAGE_VERSION" = "0.1.0-beta.0"');
    expect(workflow).toContain("--access public --tag beta --provenance");
    expect(workflow).toContain('REGISTRY_SHA1="$(npm view');
    expect(prepareJob).not.toContain("npm publish");
    expect(manifest.publishConfig).toEqual({
      access: "public",
      tag: "beta",
      provenance: true,
    });
    expect(releaseGuide).toContain("One-time first-package bootstrap");
    expect(releaseGuide).toContain("explicit publication authorization");
    expect(releaseGuide).toContain("**Bypass 2FA** enabled");
    expect(normalizedReleaseGuide).toContain(
      "deletes the GitHub environment secret and revokes the temporary npm token",
    );
  });

  it("states the initial support and product boundaries without overclaiming", async () => {
    const [readme, configuration, manifest] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "docs/configuration.md"), "utf8"),
      readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    ]);

    for (const comparison of [
      "Backups and point-in-time recovery",
      "Staging",
      "Synthetic seed data",
      "Database branches or preview databases",
      "Migration linters and migration-only test tools",
    ]) {
      expect(readme).toContain(comparison);
    }
    expect(readme).toContain("Local cost and storage");
    expect(readme.replace(/\s+/gu, " ")).toContain(
      "does not support an arbitrary unmanaged PostgreSQL",
    );
    expect(configuration).toContain(
      "advanced entry points are ESM JavaScript APIs in the first beta",
    );
    expect(manifest.description).toContain("Supabase migrations");
    expect(manifest.description).not.toMatch(/PostgreSQL and Supabase/iu);
  });
});
