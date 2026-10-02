import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, "scripts/operations/rehearsal/rehearsal_cli.mjs");
const documentedCommands = [
  "guide",
  "setup",
  "init",
  "baseline prepare",
  "baseline create",
  "doctor",
  "support",
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
      "setup",
      "doctor",
      "baseline prepare",
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

  it("does not contain broken local Markdown links", async () => {
    const rootFiles = (await readdir(root))
      .filter((file) => file.endsWith(".md"))
      .map((file) => join(root, file));
    const guideFiles = (await readdir(join(root, "docs")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => join(root, "docs", file));

    for (const file of [...rootFiles, ...guideFiles]) {
      const markdown = await readFile(file, "utf8");
      const links = [...markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)].map(
        ([, link]) => link,
      );

      for (const link of links) {
        if (/^(?:https?:|mailto:|#)/u.test(link)) continue;
        const localPath = link.split("#", 1)[0].replace(/^<|>$/gu, "");
        await expect(access(resolve(dirname(file), localPath))).resolves.toBe(
          undefined,
        );
      }
    }
  });

  it("installs the current prerelease through the beta distribution tag", async () => {
    const [readme, gettingStarted] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "docs/getting-started.md"), "utf8"),
    ]);
    const installCommand = "npm install --save-dev @rehearsal-db/core@beta";

    expect(readme).toContain(installCommand);
    expect(gettingStarted).toContain(installCommand);
  });

  it("keeps the beginner journey aligned with the guide labels", async () => {
    const [gettingStarted, cliSource] = await Promise.all([
      readFile(join(root, "docs/getting-started.md"), "utf8"),
      readFile(cli, "utf8"),
    ]);

    for (const action of [
      "Set the stage",
      "Prepare the script",
      "Review the script",
      "Create the baseline",
      "Run a rehearsal",
    ]) {
      expect(gettingStarted).toContain(action);
      expect(cliSource).toContain(action);
    }
  });

  it("keeps beginner examples parseable and tied to the proved fixture", async () => {
    const [baselineGuide, tutorial] = await Promise.all([
      readFile(join(root, "docs/baselines.md"), "utf8"),
      readFile(join(root, "docs/tutorial.md"), "utf8"),
    ]);
    const documentedJson = [
      ...baselineGuide.matchAll(/```json\n([\s\S]*?)\n```/gu),
    ].map(([, source]) => JSON.parse(source));

    expect(documentedJson).toHaveLength(2);
    expect(documentedJson[0]).toMatchObject({
      table: "widgets",
      row: { id: 1 },
    });
    expect(documentedJson[1][0]).toMatchObject({
      version: "20260101000000",
      name: "create_widgets",
    });
    expect(tutorial).toContain("tests/fixtures/postgresql-project");
    expect(tutorial).toContain("20260101000100_add_widget_description.sql");
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
    expect(workflow).toContain("--access public --tag beta --provenance");
    expect(workflow).toContain('REGISTRY_SHA1="$(npm view');
    expect(workflow).toContain("for attempt in {1..36}");
    expect(workflow).toContain("after six minutes");
    expect(prepareJob).not.toContain("npm publish");
    expect(manifest.publishConfig).toEqual({
      access: "public",
      tag: "beta",
      provenance: true,
    });
    expect(manifest.private).toBe(false);
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(releaseGuide).toContain("Trusted publication boundary");
    expect(releaseGuide).toContain("explicit publication authorization");
    expect(normalizedReleaseGuide).toContain(
      "short-lived GitHub OIDC identity",
    );
    expect(normalizedReleaseGuide).toContain("does not read an npm token");
  });

  it("states the initial support and product boundaries without overclaiming", async () => {
    const [readme, configuration, manifest] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "docs/configuration.md"), "utf8"),
      readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    ]);

    expect(readme.replace(/\s+/gu, " ")).toContain("not a backup system");
    expect(readme).toContain("Hosted database URLs");
    expect(readme).toContain("Intentionally rejected");
    expect(readme).toContain("MySQL, MongoDB");
    expect(configuration).toContain(
      "advanced entry points are ESM JavaScript APIs in the first beta",
    );
    expect(manifest.description).toContain(
      "PostgreSQL and Supabase migrations",
    );
  });
});
