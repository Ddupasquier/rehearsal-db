import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "../../src/project/configuration.mjs";

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, "src/cli/rehearsal.mjs");
const documentedCommands = [
  "version",
  "guide",
  "setup",
  "init",
  "baseline prepare",
  "baseline create",
  "privacy key",
  "source plan",
  "source apply --confirm-source-access=",
  "source retire",
  "baseline refresh",
  "refresh",
  "identity plan --identity=",
  "identity claim --identity=",
  "doctor",
  "support",
  "explain",
  "run --dry-run",
  "run --confirm-candidates=",
  "open",
  "candidates",
  "inspect baseline",
  "inspect migrations",
  "start",
  "migrate --confirm-candidates=",
  "reset",
  "status",
  "stop",
  "discard",
  "cleanup",
  "verify",
];

describe("documented CLI contract", () => {
  it("keeps generated configuration sections represented in the reference", async () => {
    const detected = {
      projectName: "contract-app",
      packageManager: "npm",
      postgresqlMigrationDirectory: "database/migrations",
      applicationCommand: "npm run dev",
      verificationCommand: "npm test",
    };
    const generated = [
      renderDetectedConfig(detected),
      renderDetectedPostgresqlConfig(detected),
    ];
    const reference = await readFile(
      join(root, "docs/configuration.md"),
      "utf8",
    );

    for (const section of [
      "schemaVersion:",
      "project:",
      "baseline:",
      "preparation:",
      "runtimePolicy:",
      "identityPolicy:",
      "containerRuntime:",
      "cleanup:",
      "dependentTargets:",
      "application:",
      "runtime:",
      "safety:",
    ]) {
      expect(generated.every((source) => source.includes(section))).toBe(true);
      expect(reference).toContain(section);
    }
    expect(generated[0]).toContain("supabase:");
    expect(generated[1]).toContain("postgresql:");
    expect(reference).toContain("supabase:");
    expect(reference).toContain("postgresql:");
  });

  it("keeps the command reference aligned with executable help", async () => {
    const [
      { stdout },
      commandReference,
      fixtureProof,
      standaloneFixtureProof,
      postgresqlFixtureProof,
    ] = await Promise.all([
      execute(process.execPath, [cli, "--help"], { cwd: root }),
      readFile(join(root, "docs/commands.md"), "utf8"),
      readFile(
        join(root, "scripts/verification/fixtures/supabase.mjs"),
        "utf8",
      ),
      readFile(
        join(root, "scripts/verification/fixtures/standalone.mjs"),
        "utf8",
      ),
      readFile(
        join(root, "scripts/verification/fixtures/postgresql.mjs"),
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
      "cleanup",
      "verify",
    ]) {
      expect(fixtureProof).toContain(`\"${command}\"`);
    }

    expect(standaloneFixtureProof).toContain('"refresh"');
    expect(postgresqlFixtureProof).toContain('["open", "--plain"]');
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
      "roadmap",
      "standalone-workflow",
      "runtime-policies",
      "architecture",
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
    const [gettingStarted, cliEntrySource, guidedSource] = await Promise.all([
      readFile(join(root, "docs/getting-started.md"), "utf8"),
      readFile(cli, "utf8"),
      readFile(join(root, "src/cli/guided.mjs"), "utf8"),
    ]);
    const cliSource = `${cliEntrySource}\n${guidedSource}`;

    for (const action of [
      "Set the stage",
      "Prepare the script",
      "Review the script",
      "Create the baseline",
      "Run a rehearsal",
      "Open the sandbox app",
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

    expect(documentedJson).toHaveLength(3);
    expect(documentedJson[0]).toMatchObject({
      table: "widgets",
      row: { id: 1 },
    });
    expect(documentedJson[1]).toMatchObject({
      schema: "app_api",
      table: "publication_products",
    });
    expect(documentedJson[2][0]).toMatchObject({
      version: "20260101000000",
      name: "create_widgets",
    });
    expect(tutorial).toContain("tests/fixtures/postgresql-project");
    expect(tutorial).toContain("20260101000100_add_widget_description.sql");
  });

  it("respects user-owned container runtime capacity", async () => {
    const [runtimeSource, cleanupSource, configuration] = await Promise.all([
      readFile(join(root, "src/targets/supabase_environment.mjs"), "utf8"),
      readFile(join(root, "src/runtime/cleanup.mjs"), "utf8"),
      readFile(join(root, "docs/configuration.md"), "utf8"),
    ]);

    expect(runtimeSource).toContain('runLocalCommand("colima", ["start"]');
    expect(runtimeSource).not.toContain('"--disk"');
    expect(runtimeSource).not.toContain('"--memory"');
    expect(cleanupSource).toContain('"ls", "--all", "--quiet"');
    expect(cleanupSource).not.toMatch(
      /(?:system|image|container|volume) prune/u,
    );
    expect(cleanupSource).not.toContain('"--force"');
    expect(cleanupSource).toContain("exact --confirm-cleanup digest");
    expect(configuration).toContain("autoStartColima");
    expect(configuration).toContain("retainBaselineGenerations");
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
    const syncTagsJob = workflow.slice(workflow.indexOf("\n  sync-tags:"));

    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("actions/download-artifact@v8");
    expect(workflow).toContain("sha256sum --check --strict");
    expect(workflow).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(workflow).toContain('test "$RELEASE_TAG" = "v$PACKAGE_VERSION"');
    expect(workflow).toContain('test "$RELEASE_PRERELEASE" = "true"');
    expect(workflow).toContain('test "$PACKAGE_PRIVATE" = "false"');
    expect(workflow).toContain("--access public --tag beta --provenance");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("npm install --global npm@11.21.0");
    expect(workflow).toContain(
      'npm dist-tag add "$PACKAGE_NAME@$PACKAGE_VERSION" beta',
    );
    expect(workflow).toContain(
      'npm dist-tag add "$PACKAGE_NAME@$PACKAGE_VERSION" latest',
    );
    expect(workflow).toContain(
      "tags.beta === version && tags.latest === version",
    );
    expect(syncTagsJob).toContain("github.ref == 'refs/heads/main'");
    expect(syncTagsJob).toContain(
      `PACKAGE_VERSION="$(node -p "require('./package.json').version")"`,
    );
    expect(syncTagsJob).not.toContain("npm publish");
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
    expect(normalizedReleaseGuide).toContain(
      "the npm package page and the ordinary `npm install @rehearsal-db/core` command current",
    );
    expect(normalizedReleaseGuide).toContain(
      "it cannot publish a package or select a different version",
    );
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
