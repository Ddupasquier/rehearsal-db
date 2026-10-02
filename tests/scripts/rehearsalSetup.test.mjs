import { execFile } from "node:child_process";
import { createServer } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRehearsalSetup,
  assertSupportedRehearsalNodeRuntime,
  findAvailableRehearsalPorts,
  inspectRehearsalNodeRuntime,
  isRehearsalPortAvailable,
  planRehearsalSetup,
  renderSafeLocalSupabaseConfig,
} from "../../scripts/lib/rehearsal/setup.mjs";

const roots = [];
const execute = promisify(execFile);
const cliPath = join(
  process.cwd(),
  "scripts/operations/rehearsal/rehearsal_cli.mjs",
);

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-setup-test-"));
  roots.push(root);
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "Setup Fixture",
      scripts: { dev: "vite", test: "vitest run" },
    })}\n`,
  );
  await writeFile(
    join(root, "supabase/config.toml"),
    'project_id = "source-project"\n[db]\nmajor_version = 15\n',
  );
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("guided Rehearsal setup", () => {
  it("recognizes the maintained Node.js major and explains unsupported shells", () => {
    expect(inspectRehearsalNodeRuntime("24.3.0")).toMatchObject({
      major: 24,
      supported: true,
    });
    expect(() => assertSupportedRehearsalNodeRuntime("20.19.1")).toThrow(
      "nvm install 24 && nvm use 24",
    );
  });

  it("rejects a port that already answers on loopback", async () => {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      expect(await isRehearsalPortAvailable(server.address().port)).toBe(false);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("selects the first entirely available port block", async () => {
    const ports = await findAvailableRehearsalPorts({
      isAvailable: async (port) => port >= 58_340,
    });

    expect(ports).toEqual({
      shadow: 58_340,
      api: 58_341,
      database: 58_342,
      studio: 58_343,
      smtp: 58_344,
      pooler: 58_349,
    });
  });

  it("renders a conservative local-only Supabase configuration", () => {
    const source = renderSafeLocalSupabaseConfig({
      projectId: "fixture-rehearsal",
      applicationUrl: "http://localhost:5175",
      databaseMajorVersion: 17,
      ports: {
        shadow: 58_320,
        api: 58_321,
        database: 58_322,
        studio: 58_323,
        smtp: 58_324,
        pooler: 58_329,
      },
    });

    expect(source).toContain('project_id = "fixture-rehearsal"');
    expect(source).toContain("port = 58321");
    expect(source).toContain("shadow_port = 58320");
    expect(source).toContain("[auth]\nenabled = true");
    expect(source).toContain("[realtime]\nenabled = false");
    expect(source).toContain("[analytics]\nenabled = false");
    expect(source).not.toMatch(/project-ref|access_token|password/iu);
  });

  it("previews and applies setup without changing source config or overwriting", async () => {
    const root = await makeProject();
    const sourceConfigPath = join(root, "supabase/config.toml");
    const sourceConfig = await readFile(sourceConfigPath, "utf8");
    const plan = await planRehearsalSetup({
      projectRoot: root,
      isPortAvailable: async () => true,
    });

    expect(plan.files.map(({ path, action }) => ({ path, action }))).toEqual([
      { path: "rehearsal.config.mjs", action: "create" },
      {
        path: "infrastructure/rehearsal/supabase/config.toml",
        action: "create",
      },
      { path: ".gitignore", action: "update" },
    ]);
    await expect(
      stat(join(root, "rehearsal.config.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await applyRehearsalSetup(plan);

    const [config, localSupabase, gitignore, configStat] = await Promise.all([
      readFile(join(root, "rehearsal.config.mjs"), "utf8"),
      readFile(
        join(root, "infrastructure/rehearsal/supabase/config.toml"),
        "utf8",
      ),
      readFile(join(root, ".gitignore"), "utf8"),
      stat(join(root, "rehearsal.config.mjs")),
    ]);
    expect(config).toContain('project: { name: "setup-fixture" }');
    expect(config).toContain('target: "supabase"');
    expect(config).toContain("apiPort: 58321");
    expect(config).toContain("CHECK: commands detected from package.json");
    expect(config).toContain("Keep passwords, tokens, and production URLs out");
    expect(localSupabase).toContain('project_id = "setup-fixture-rehearsal"');
    expect(localSupabase).toContain("major_version = 15");
    expect(gitignore).toContain("# Rehearsal local artifacts");
    expect(gitignore).toContain(".rehearsal/");
    expect(configStat.mode & 0o077).toBe(0);
    expect(await readFile(sourceConfigPath, "utf8")).toBe(sourceConfig);
    await expect(applyRehearsalSetup(plan)).rejects.toThrow(
      "will not overwrite",
    );
  });

  it("creates minimal plain PostgreSQL scaffolding without Supabase files", async () => {
    const root = await makeProject();
    const plan = await planRehearsalSetup({
      projectRoot: root,
      target: "postgresql",
      isPortAvailable: async () => true,
    });

    expect(plan).toMatchObject({
      target: "postgresql",
      ports: { database: 58322 },
    });
    expect(plan.files.map(({ path }) => path)).toEqual([
      "rehearsal.config.mjs",
      ".gitignore",
    ]);
    await applyRehearsalSetup(plan);

    const config = await readFile(join(root, "rehearsal.config.mjs"), "utf8");
    expect(config).toContain('target: "postgresql"');
    expect(config).toContain('image: "postgres:17-alpine"');
    expect(config).toContain("databasePort: 58322");
    expect(config).toContain("CHECK: commands detected from package.json");
    expect(config).toContain("docs/configuration.md");
    await expect(
      stat(join(root, "infrastructure/rehearsal/supabase/config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes preview and explicit write through the public CLI", async () => {
    const root = await makeProject();
    await mkdir(join(root, "node_modules/@rehearsal-db"), {
      recursive: true,
    });
    await symlink(
      process.cwd(),
      join(root, "node_modules/@rehearsal-db/core"),
      "dir",
    );
    const preview = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "setup", "--json"], {
          cwd: root,
        })
      ).stdout,
    );
    expect(preview.data).toMatchObject({
      mode: "preview",
      project: "setup-fixture",
    });
    await expect(
      stat(join(root, "rehearsal.config.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const written = JSON.parse(
      (
        await execute(
          process.execPath,
          [cliPath, "setup", "--write", "--json"],
          { cwd: root },
        )
      ).stdout,
    );
    expect(written.data.mode).toBe("written");
    expect(written.data.readiness.state).toBe("NOT READY");
    await expect(
      stat(join(root, "rehearsal.config.mjs")),
    ).resolves.toBeDefined();
    await expect(
      execute(process.execPath, [cliPath, "setup", "--write", "--json"], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("summarizes expected first-run gaps without repeated file errors", async () => {
    const root = await makeProject();
    await mkdir(join(root, "node_modules/@rehearsal-db"), {
      recursive: true,
    });
    await symlink(
      process.cwd(),
      join(root, "node_modules/@rehearsal-db/core"),
      "dir",
    );
    const { stdout } = await execute(
      process.execPath,
      [cliPath, "setup", "--write", "--plain"],
      { cwd: root },
    );

    expect(stdout).toContain("environment and safety checks passed");
    expect(stdout).toContain("Baseline policy: not created yet");
    expect(stdout).toContain("Verified baseline: not created yet");
    expect(stdout).toContain(
      "Next: run rehearsal again and choose Prepare a reviewable baseline policy draft.",
    );
    expect(stdout).not.toContain("ENOENT");
  }, 15_000);

  it("refuses a stale preview when .gitignore changes", async () => {
    const root = await makeProject();
    const plan = await planRehearsalSetup({
      projectRoot: root,
      isPortAvailable: async () => true,
    });
    await writeFile(join(root, ".gitignore"), "node_modules/\nnew-entry/\n");

    await expect(applyRehearsalSetup(plan)).rejects.toThrow(
      ".gitignore changed after the setup preview",
    );
    await expect(
      stat(join(root, "rehearsal.config.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write when a previewed port becomes occupied", async () => {
    const root = await makeProject();
    let occupied = false;
    const plan = await planRehearsalSetup({
      projectRoot: root,
      isPortAvailable: async () => !occupied,
    });
    occupied = true;

    await expect(applyRehearsalSetup(plan)).rejects.toThrow(
      "ports became occupied after the preview",
    );
    await expect(
      stat(join(root, "rehearsal.config.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
