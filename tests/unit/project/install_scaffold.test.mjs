import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInstalledRehearsalScaffold,
  renderInstalledRehearsalScaffold,
  resolveRehearsalConsumerRoot,
} from "../../../dist/src/project/install_scaffold.mjs";

const roots = [];
const sourceRoot = process.cwd();

const makeRoot = async (name = "rehearsal-install-test-") => {
  const root = await mkdtemp(join(tmpdir(), name));
  roots.push(root);
  return root;
};

const writeManifest = async (root, manifest) => {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
};

const installPackageLink = async (root) => {
  const parent = join(root, "node_modules/@rehearsal-db");
  const packageRoot = join(parent, "core");
  await mkdir(parent, { recursive: true });
  await symlink(sourceRoot, packageRoot, "dir");
  return packageRoot;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("install-time project scaffolding", () => {
  it("creates a valid root config and preserves project-owned ignore content", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      name: "consumer-app",
      devDependencies: { "@rehearsal-db/core": "0.1.0-beta.10" },
      scripts: { dev: "vite", test: "vitest run" },
    });
    await mkdir(join(root, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase/config.toml"),
      'project_id = "consumer"\n[db]\nmajor_version = 17\n',
    );
    await writeFile(join(root, ".gitignore"), "node_modules/\ncustom-cache/\n");
    const packageRoot = await installPackageLink(root);

    const result = await createInstalledRehearsalScaffold({
      packageRoot,
      environment: {
        INIT_CWD: root,
        npm_config_local_prefix: root,
      },
      isPortAvailable: async () => true,
    });

    expect(result).toMatchObject({
      status: "ready",
      target: "supabase",
      configurationPath: "rehearsal.config.mjs",
      configurationAction: "create",
      rootConfigGenerationSkipped: false,
    });
    expect(renderInstalledRehearsalScaffold(result)).toContain(
      "Configuration: rehearsal.config.mjs (created)",
    );
    const [config, localConfig, gitignore] = await Promise.all([
      readFile(join(root, "rehearsal.config.mjs"), "utf8"),
      readFile(
        join(root, "infrastructure/rehearsal/supabase/config.toml"),
        "utf8",
      ),
      readFile(join(root, ".gitignore"), "utf8"),
    ]);
    expect(config).toContain('project: { name: "consumer-app" }');
    expect(config).toContain('target: "supabase"');
    expect(localConfig).toContain('project_id = "consumer-app-rehearsal"');
    expect(gitignore).toContain("node_modules/\ncustom-cache/\n");
    expect(gitignore).toContain(".rehearsal/");
    expect(gitignore).toContain(".env.rehearsal-service.local");
  });

  it("is idempotent and never rewrites an existing config", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      name: "postgres-app",
      devDependencies: { "@rehearsal-db/core": "0.1.0-beta.10" },
      scripts: { test: "node --test" },
    });
    await mkdir(join(root, "database/migrations"), { recursive: true });
    const packageRoot = await installPackageLink(root);
    const options = {
      packageRoot,
      environment: {
        INIT_CWD: root,
        npm_config_local_prefix: root,
      },
      isPortAvailable: async () => true,
    };
    await createInstalledRehearsalScaffold(options);
    const configPath = join(root, "rehearsal.config.mjs");
    const original = await readFile(configPath, "utf8");
    await writeFile(configPath, `${original}\n// user-owned marker\n`);

    const repeated = await createInstalledRehearsalScaffold({
      ...options,
      isPortAvailable: async () => false,
    });

    expect(repeated.files.every((file) => file.action === "unchanged")).toBe(
      true,
    );
    expect(repeated).toMatchObject({
      configurationPath: "rehearsal.config.mjs",
      configurationAction: "unchanged",
      rootConfigGenerationSkipped: false,
    });
    expect(renderInstalledRehearsalScaffold(repeated)).toContain(
      "Next: review rehearsal.config.mjs, then run npx rehearsal.",
    );
    expect(await readFile(configPath, "utf8")).toBe(
      `${original}\n// user-owned marker\n`,
    );
  });

  it("preserves a supported custom config path instead of creating a second one", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      name: "custom-config-app",
      devDependencies: { "@rehearsal-db/core": "0.1.0-beta.10" },
    });
    await mkdir(join(root, "database/migrations"), { recursive: true });
    await mkdir(join(root, "infrastructure/rehearsal"), { recursive: true });
    const customPath = join(
      root,
      "infrastructure/rehearsal/rehearsal.config.mjs",
    );
    await writeFile(
      customPath,
      `export default {
  schemaVersion: 1,
  project: { name: "custom-config-app" },
  postgresql: {
    migrationDirectory: "database/migrations",
    runtimeWorkdir: ".rehearsal/runtime",
    image: "postgres:17-alpine",
    database: "postgres",
    user: "postgres",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },
  application: { startCommand: "npm run dev", proofCommand: "npm test" },
  runtime: {
    target: "postgresql",
    applicationUrl: "http://localhost:5175",
    projectId: "custom-config-app-rehearsal",
    databasePort: 58322,
  },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
};
`,
    );
    const packageRoot = await installPackageLink(root);

    const result = await createInstalledRehearsalScaffold({
      packageRoot,
      environment: {
        INIT_CWD: root,
        npm_config_local_prefix: root,
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      configurationPath: "infrastructure/rehearsal/rehearsal.config.mjs",
      configurationAction: "unchanged",
      rootConfigGenerationSkipped: true,
    });
    const message = renderInstalledRehearsalScaffold(result);
    expect(message).toContain(
      "Configuration: infrastructure/rehearsal/rehearsal.config.mjs (existing)",
    );
    expect(message).toContain("rehearsal.config.mjs was not created");
    await expect(
      readFile(join(root, "rehearsal.config.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(customPath, "utf8")).toContain("custom-config-app");
  });

  it("selects one declaring workspace and refuses an ambiguous workspace", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      name: "workspace-root",
      private: true,
      workspaces: ["apps/*"],
    });
    const appOne = join(root, "apps/one");
    const appTwo = join(root, "apps/two");
    await writeManifest(appOne, {
      name: "app-one",
      devDependencies: { "@rehearsal-db/core": "0.1.0-beta.10" },
    });
    await writeManifest(appTwo, { name: "app-two" });
    const packageRoot = await installPackageLink(root);

    await expect(
      resolveRehearsalConsumerRoot({
        packageRoot,
        initCwd: root,
        localPrefix: root,
      }),
    ).resolves.toEqual({ status: "resolved", projectRoot: appOne });

    await writeManifest(appTwo, {
      name: "app-two",
      devDependencies: { "@rehearsal-db/core": "0.1.0-beta.10" },
    });
    await expect(
      resolveRehearsalConsumerRoot({
        packageRoot,
        initCwd: root,
        localPrefix: root,
        workspace: "apps/one",
      }),
    ).resolves.toEqual({ status: "resolved", projectRoot: appOne });
    await expect(
      resolveRehearsalConsumerRoot({
        packageRoot,
        initCwd: root,
        localPrefix: root,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
  });

  it("never treats global, cache, or source-package execution as a consumer", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      name: "consumer",
      devDependencies: { "@rehearsal-db/core": "0.1.0-beta.10" },
    });
    const packageRoot = await installPackageLink(root);

    await expect(
      resolveRehearsalConsumerRoot({
        packageRoot,
        initCwd: root,
        localPrefix: root,
        globalInstall: "true",
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    await expect(
      resolveRehearsalConsumerRoot({
        packageRoot: sourceRoot,
        initCwd: root,
        localPrefix: root,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    await expect(
      resolveRehearsalConsumerRoot({
        packageRoot: join(root, "_npx/hash/node_modules/@rehearsal-db/core"),
        initCwd: root,
        localPrefix: root,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
  });
});
