import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectDetectedProject,
  loadRehearsalConfig,
  renderDetectedConfig,
} from "../../../dist/src/project/configuration.mjs";

const temporaryRoots = [];
const execute = promisify(execFile);
const cliPath = join(process.cwd(), "dist/src/cli/rehearsal.mjs");
const configurationModuleUrl = pathToFileURL(
  join(process.cwd(), "dist/src/project/configuration.mjs"),
).href;

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-config-test-"));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, "supabase/migrations"), { recursive: true }),
    mkdir(join(root, "database/migrations"), { recursive: true }),
    mkdir(join(root, "infrastructure/rehearsal/supabase"), {
      recursive: true,
    }),
  ]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-project",
      scripts: { dev: "vite", test: "vitest run" },
    }),
  );
  return root;
};

const configSource = (overrides = "") => `
import { defineRehearsalConfig } from ${JSON.stringify(configurationModuleUrl)};
export default defineRehearsalConfig({
	schemaVersion: 1,
	project: { name: "fixture-project" },
	supabase: {
		workdir: ".",
		migrationDirectory: "supabase/migrations",
		rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
		runtimeWorkdir: ".rehearsal/runtime",
	},
	baseline: {
		artifactDirectory: ".rehearsal",
		sanitizationPolicy: "infrastructure/rehearsal/policy.json",
	},
	application: { startCommand: "npm run dev", proofCommand: "npm test" },
	runtime: {
		applicationUrl: "http://localhost:5175",
		projectId: "fixture-rehearsal",
		apiPort: 58321,
		databasePort: 58322,
		studioPort: 58323,
	},
	safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
	verification: { commands: ["npm test"] },
	${overrides}
});
`;

const postgresqlConfigSource = () => `
import { defineRehearsalConfig } from ${JSON.stringify(configurationModuleUrl)};
export default defineRehearsalConfig({
	schemaVersion: 1,
	project: { name: "fixture-project" },
	postgresql: {
		migrationDirectory: "database/migrations",
		runtimeWorkdir: ".rehearsal/runtime",
		image: "postgres:17-alpine",
		database: "fixture",
		user: "rehearsal",
	},
	baseline: {
		artifactDirectory: ".rehearsal",
		sanitizationPolicy: "infrastructure/rehearsal/policy.json",
	},
	application: { startCommand: "npm run dev", proofCommand: "npm test" },
	runtime: {
		target: "postgresql",
		applicationUrl: "http://localhost:5175",
		projectId: "fixture-rehearsal",
		databasePort: 58322,
	},
	safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
});
`;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Rehearsal configuration", () => {
  it("loads a versioned project contract and resolves only project-owned paths", async () => {
    const root = await makeProject();
    await writeFile(join(root, "rehearsal.config.mjs"), configSource());
    const loaded = await loadRehearsalConfig({ projectRoot: root });

    expect(loaded.config.schemaVersion).toBe(1);
    expect(loaded.config.project.name).toBe("fixture-project");
    expect(loaded.config.runtime.target).toBe("supabase");
    expect(loaded.paths.migrationDirectory).toBe(
      join(root, "supabase/migrations"),
    );
    expect(loaded.config.safety.allowedHosts).toEqual([
      "127.0.0.1",
      "::1",
      "localhost",
    ]);
    expect(loaded.config.supabase.serviceEnvironmentFile).toBeNull();
    expect(loaded.config.supabase.serviceEnvironmentVariables).toEqual([]);
    expect(loaded.config.supabase.authentication).toBeNull();
    expect(loaded.config.containerRuntime).toEqual({ autoStartColima: false });
    expect(loaded.config.lifecycle).toEqual({
      run: "keep-until-stop",
      open: "keep-until-stop",
    });
    expect(loaded.config.cleanup).toEqual({ retainBaselineGenerations: 2 });
    expect(loaded.config.preparation).toBeNull();
    expect(loaded.config.dependentTargets).toEqual([]);
  });

  it("loads explicit bounded runtime lifecycle modes", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      configSource(
        'lifecycle: { run: "stop-after-run", open: "stop-on-application-exit" },',
      ),
    );

    const loaded = await loadRehearsalConfig({ projectRoot: root });
    expect(loaded.config.lifecycle).toEqual({
      run: "stop-after-run",
      open: "stop-on-application-exit",
    });
  });

  it("rejects unsupported runtime lifecycle modes", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      configSource('lifecycle: { run: "discard-after-run" },'),
    );

    await expect(loadRehearsalConfig({ projectRoot: root })).rejects.toThrow(
      "config.lifecycle.run must be one of: keep-until-stop, stop-after-run",
    );
  });

  it("loads declarative local OAuth providers and derives their credential allowlist", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      configSource().replace(
        'runtimeWorkdir: ".rehearsal/runtime",',
        `runtimeWorkdir: ".rehearsal/runtime",
        authentication: {
          enableLocalSignup: true,
          environmentFile: ".env.rehearsal-service.local",
          providers: [
            {
              name: "google",
              clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
              clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
              skipNonceCheck: true,
              emailOptional: false,
            },
            {
              name: "github",
              clientIdEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_ID",
              clientSecretEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_SECRET",
            },
          ],
        },`,
      ),
    );

    const loaded = await loadRehearsalConfig({ projectRoot: root });

    expect(loaded.config.supabase.authentication.providers).toHaveLength(2);
    expect(loaded.config.supabase.authentication.providers[0]).toMatchObject({
      skipNonceCheck: true,
      emailOptional: false,
    });
    expect(loaded.config.supabase.authentication.providers[1]).toMatchObject({
      skipNonceCheck: false,
      emailOptional: false,
    });
    expect(loaded.config.supabase.serviceEnvironmentVariables).toEqual([
      "REHEARSAL_GOOGLE_CLIENT_ID",
      "REHEARSAL_GOOGLE_CLIENT_SECRET",
      "REHEARSAL_GITHUB_CLIENT_ID",
      "REHEARSAL_GITHUB_CLIENT_SECRET",
    ]);
    expect(loaded.config.safety.authenticationProviders).toEqual([
      "google",
      "github",
    ]);
    expect(loaded.paths.serviceEnvironment).toBe(
      join(root, ".env.rehearsal-service.local"),
    );
  });

  it("refuses unsupported, duplicate, ambiguous, or unsafe OAuth declarations", async () => {
    const authentication = `authentication: {
      enableLocalSignup: true,
      environmentFile: ".env.rehearsal-service.local",
      providers: [{
        name: "google",
        clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
        clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
      }],
    },`;
    for (const [name, current, replacement, expected] of [
      [
        "unsupported",
        'name: "google"',
        'name: "gitlab"',
        "must be one of: github, google",
      ],
      [
        "unsafe-variable",
        'clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID"',
        'clientIdEnvironmentVariable: "bad-key"',
        "safe environment variable name",
      ],
      [
        "duplicate-variable",
        'clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET"',
        'clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID"',
        "environment variables must be unique",
      ],
      [
        "invalid-provider-option",
        'name: "google"',
        'name: "google", skipNonceCheck: "yes"',
        "skipNonceCheck must be a boolean",
      ],
    ]) {
      const root = await makeProject();
      const path = join(root, `${name}.config.mjs`);
      await writeFile(
        path,
        configSource().replace(
          'runtimeWorkdir: ".rehearsal/runtime",',
          `runtimeWorkdir: ".rehearsal/runtime", ${authentication.replace(current, replacement)}`,
        ),
      );
      await expect(
        loadRehearsalConfig({ projectRoot: root, configPath: path }),
      ).rejects.toThrow(expected);
    }

    const root = await makeProject();
    const path = join(root, "ambiguous.config.mjs");
    await writeFile(
      path,
      configSource().replace(
        'runtimeWorkdir: ".rehearsal/runtime",',
        `runtimeWorkdir: ".rehearsal/runtime", ${authentication} serviceEnvironmentFile: ".env.legacy", serviceEnvironmentVariables: ["LEGACY_KEY"],`,
      ),
    );
    await expect(
      loadRehearsalConfig({ projectRoot: root, configPath: path }),
    ).rejects.toThrow("cannot be combined with the legacy");

    const missingSignupRoot = await makeProject();
    const missingSignupPath = join(
      missingSignupRoot,
      "missing-signup.config.mjs",
    );
    await writeFile(
      missingSignupPath,
      configSource().replace(
        'runtimeWorkdir: ".rehearsal/runtime",',
        `runtimeWorkdir: ".rehearsal/runtime", ${authentication.replace("enableLocalSignup: true,", "")}`,
      ),
    );
    await expect(
      loadRehearsalConfig({
        projectRoot: missingSignupRoot,
        configPath: missingSignupPath,
      }),
    ).rejects.toThrow("enableLocalSignup must be true");
  });

  it("validates project-declared dependent runtime references", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      configSource(
        'dependentTargets: [{ name: "publication-api", configPath: "rehearsal.publication.config.mjs", prepareCommand: "npm run prepare:publication" }],',
      ),
    );
    const loaded = await loadRehearsalConfig({ projectRoot: root });

    expect(loaded.config.dependentTargets).toEqual([
      {
        name: "publication-api",
        configPath: "rehearsal.publication.config.mjs",
        prepareCommand: "npm run prepare:publication",
      },
    ]);
  });

  it("validates direct application environment, readiness, and HTTP proofs", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      configSource(
        `application: {
          startCommand: "npm run dev",
          proofCommand: "npm test",
          environmentVariables: { APP_DATABASE_URL: "primary:DATABASE_URL" },
          readiness: { url: "http://127.0.0.1:5175/health", expectedStatus: 204, timeoutSeconds: 10 },
          httpProofs: [
            { name: "known", kind: "positive", url: "http://127.0.0.1:5175/known", expectedStatus: 200, json: { path: ["items"], minimumItems: 1 } },
            { name: "missing", kind: "negative", url: "http://127.0.0.1:5175/missing", expectedStatus: 404, json: { path: ["error"], equals: "not found" } },
          ],
        },`,
      ).replace(
        'application: { startCommand: "npm run dev", proofCommand: "npm test" },',
        "",
      ),
    );
    const loaded = await loadRehearsalConfig({ projectRoot: root });
    expect(loaded.config.application.environmentVariables).toEqual({
      APP_DATABASE_URL: "primary:DATABASE_URL",
    });
    expect(
      loaded.config.application.httpProofs.map((proof) => proof.kind),
    ).toEqual(["positive", "negative"]);
  });

  it("rejects unknown properties, versions, hosted URLs, and escaping paths", async () => {
    for (const [name, source, expected] of [
      [
        "unknown",
        configSource("mystery: true,"),
        "Unknown Rehearsal configuration property",
      ],
      [
        "version",
        configSource().replace("schemaVersion: 1", "schemaVersion: 2"),
        "Unsupported Rehearsal configuration version",
      ],
      [
        "runtime-target",
        configSource().replace(
          'applicationUrl: "http://localhost:5175"',
          'target: "mysql", applicationUrl: "http://localhost:5175"',
        ),
        "Unsupported Rehearsal runtime target",
      ],
      [
        "hosted",
        configSource().replace(
          "http://localhost:5175",
          "https://project.supabase.co",
        ),
        "loopback",
      ],
      [
        "escape",
        configSource().replace('"supabase/migrations"', '"../migrations"'),
        "inside the project root",
      ],
      [
        "runtime-location",
        configSource().replace(
          'runtimeWorkdir: ".rehearsal/runtime"',
          'runtimeWorkdir: "tmp/rehearsal-runtime"',
        ),
        "runtime directory inside",
      ],
      [
        "artifact-location",
        configSource().replace(
          'artifactDirectory: ".rehearsal"',
          'artifactDirectory: ".database-sandbox"',
        ),
        'directory named ".rehearsal"',
      ],
      [
        "environment-location",
        configSource().replace(
          'application: { startCommand: "npm run dev", proofCommand: "npm test" }',
          'application: { startCommand: "npm run dev", proofCommand: "npm test", environmentFile: ".env" }',
        ),
        "file inside",
      ],
      [
        "project-id",
        configSource().replace(
          'projectId: "fixture-rehearsal"',
          'projectId: "Fixture Rehearsal"',
        ),
        "lowercase letters",
      ],
      [
        "service-environment-pair",
        configSource().replace(
          'runtimeWorkdir: ".rehearsal/runtime",',
          'runtimeWorkdir: ".rehearsal/runtime", serviceEnvironmentFile: ".env.rehearsal.local",',
        ),
        "must be configured together",
      ],
      [
        "container-runtime",
        configSource("containerRuntime: { autoStartColima: 40 },"),
        "must be true or false",
      ],
      [
        "cleanup-retention",
        configSource("cleanup: { retainBaselineGenerations: 0 },"),
        "must be a positive integer",
      ],
      [
        "privacy-key-location",
        configSource(
          'preparation: { sourcePolicy: "infrastructure/rehearsal/source-access-policy.json", privacyKey: "private.key" },',
        ),
        "secret file inside",
      ],
      [
        "dependent-target-path",
        configSource(
          'dependentTargets: [{ name: "publication-api", configPath: "../outside.mjs" }],',
        ),
        "inside the project root",
      ],
      [
        "dependent-target-name",
        configSource(
          'dependentTargets: [{ name: "Publication API", configPath: "publication.mjs" }],',
        ),
        "lowercase letters",
      ],
    ]) {
      const root = await makeProject();
      const path = join(root, `${name}.config.mjs`);
      await writeFile(path, source);
      await expect(
        loadRehearsalConfig({ projectRoot: root, configPath: path }),
      ).rejects.toThrow(expected);
    }
  });

  it("loads a plain PostgreSQL target without Supabase configuration", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      postgresqlConfigSource(),
    );

    const loaded = await loadRehearsalConfig({ projectRoot: root });

    expect(loaded.config.runtime).toMatchObject({
      target: "postgresql",
      ports: { database: 58322 },
    });
    expect(loaded.config.supabase).toBeNull();
    expect(loaded.config.postgresql).toMatchObject({
      image: "postgres:17-alpine",
      database: "fixture",
      user: "rehearsal",
    });
    expect(loaded.paths).toMatchObject({
      migrationDirectory: join(root, "database/migrations"),
      runtimeWorkdir: join(root, ".rehearsal/runtime"),
      rehearsalConfig: null,
      serviceEnvironment: null,
      supabaseWorkdir: null,
    });
  });

  it("detects safe onboarding facts and renders a fail-closed preview", async () => {
    const root = await makeProject();
    await writeFile(join(root, "package-lock.json"), "{}\n");
    await writeFile(
      join(root, "supabase/config.toml"),
      "project_id = 'fixture'\n",
    );
    const detected = await inspectDetectedProject({ projectRoot: root });
    const source = renderDetectedConfig(detected);

    expect(detected.packageManager).toBe("npm");
    expect(detected.hasSupabaseConfig).toBe(true);
    expect(detected.hasMigrations).toBe(true);
    expect(source).toContain('hostedAccess: "disabled"');
    expect(source).toContain('outboundNetwork: "deny"');
    expect(source).toContain("containerRuntime:");
    expect(source).toContain("autoStartColima: false");
    expect(source).toContain('run: "keep-until-stop"');
    expect(source).toContain('open: "keep-until-stop"');
    expect(source).toContain('"stop-after-run"');
    expect(source).toContain('"stop-on-application-exit"');
    expect(source).toContain("cleanup:");
    expect(source).toContain("retainBaselineGenerations: 2");
    expect(source).toContain("dependentTargets:");
    expect(source).toContain('configPath: "rehearsal.publication.config.mjs"');
    expect(source).toContain("Generated from this project by `npx rehearsal`");
    expect(source).toContain("CHECK: commands detected from package.json");
    expect(source).toContain("authentication:");
    expect(source).toContain("enableLocalSignup: true");
    expect(source).toContain(
      'clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET"',
    );
    expect(source).toContain("docs/configuration.md");
    expect(source).not.toContain("project-ref");
  });

  it("keeps init non-mutating until --write and never overwrites config", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "supabase/config.toml"),
      'project_id = "fixture-project"\n[db]\nmajor_version = 17\n',
    );
    const destination = join(root, "rehearsal.config.mjs");
    const preview = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "init", "--json"], {
          cwd: root,
        })
      ).stdout,
    );
    expect(preview.data.mode).toBe("preview");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const written = JSON.parse(
      (
        await execute(
          process.execPath,
          [cliPath, "init", "--write", "--json"],
          { cwd: root },
        )
      ).stdout,
    );
    expect(written.data.mode).toBe("written");
    const writtenSource = await readFile(destination, "utf8");
    expect(writtenSource).toContain('from "@rehearsal-db/core"');
    await writeFile(
      destination,
      writtenSource.replace(
        '"@rehearsal-db/core"',
        JSON.stringify(configurationModuleUrl),
      ),
    );
    await expect(
      loadRehearsalConfig({ projectRoot: root }),
    ).resolves.toMatchObject({
      config: { project: { name: "fixture-project" } },
    });
    const currentTemplate = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "init", "--json"], {
          cwd: root,
        })
      ).stdout,
    );
    expect(currentTemplate.data.mode).toBe("current-template");
    expect(currentTemplate.data.source).toContain("containerRuntime:");
    expect(currentTemplate.data.source).toContain("authentication:");
    expect(currentTemplate.data.availableOptions).toEqual([
      {
        path: "supabase.authentication",
        summary:
          "Configure local Google or GitHub sign-in with credentials kept outside tracked files.",
      },
    ]);
    const currentTemplateText = await execute(
      process.execPath,
      [cliPath, "init", "--plain"],
      { cwd: root },
    );
    expect(currentTemplateText.stdout).toContain("AVAILABLE BUT NOT ENABLED");
    expect(currentTemplateText.stdout).toContain("supabase.authentication");
    expect(await readFile(destination, "utf8")).toBe(
      writtenSource.replace(
        '"@rehearsal-db/core"',
        JSON.stringify(configurationModuleUrl),
      ),
    );
    await expect(
      execute(process.execPath, [cliPath, "init", "--write", "--json"], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("makes the declarative authentication replacement discoverable from a legacy config", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "supabase/config.toml"),
      'project_id = "fixture-project"\n[db]\nmajor_version = 17\n',
    );
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      configSource()
        .replace(
          'runtimeWorkdir: ".rehearsal/runtime",',
          'runtimeWorkdir: ".rehearsal/runtime", serviceEnvironmentFile: ".env.rehearsal-service.local", serviceEnvironmentVariables: ["LEGACY_GOOGLE_CLIENT_ID", "LEGACY_GOOGLE_SECRET"],',
        )
        .replace(
          'safety: { hostedAccess: "disabled", outboundNetwork: "deny" },',
          'safety: { hostedAccess: "disabled", outboundNetwork: "deny", authenticationProviders: ["google"] },',
        ),
    );

    const result = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "init", "--json"], {
          cwd: root,
        })
      ).stdout,
    );

    expect(result.data.mode).toBe("current-template");
    expect(result.data.availableOptions).toEqual([
      {
        path: "supabase.authentication",
        summary:
          "A declarative Google/GitHub replacement is available; replace the legacy provider fields together after review.",
      },
    ]);
  });

  it("provides discoverable help without requiring a project configuration", async () => {
    const root = await makeProject();
    const { stdout } = await execute(process.execPath, [cliPath, "--help"], {
      cwd: root,
    });
    expect(stdout).toContain("Usage: rehearsal <command>");
    expect(stdout).toContain("candidates");
  });

  it("prints the installed version without requiring project configuration", async () => {
    const root = await makeProject();
    const packageManifest = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    );
    const [{ stdout }, { stdout: jsonOutput }] = await Promise.all([
      execute(process.execPath, [cliPath, "--version"], { cwd: root }),
      execute(process.execPath, [cliPath, "version", "--json"], { cwd: root }),
    ]);

    expect(stdout.trim()).toBe(packageManifest.version);
    expect(JSON.parse(jsonOutput)).toEqual({
      name: packageManifest.name,
      version: packageManifest.version,
    });
  });

  it("guides an unconfigured project through doctor without crashing", async () => {
    const root = await makeProject();
    let result;
    try {
      await execute(process.execPath, [cliPath, "doctor"], { cwd: root });
    } catch (error) {
      result = error;
    }

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("NOT READY");
    expect(result.stdout).toContain("Next: fix the items above");
    expect(result.stderr).toBe("");
  });
});
