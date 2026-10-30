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
import { discoverProjectProfile } from "../../../dist/src/project/project_discovery.mjs";

const roots = [];

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-discovery-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project discovery", () => {
  it("separates detected facts, suggestions, and human decisions", async () => {
    const root = await makeRoot();
    await Promise.all([
      mkdir(join(root, "supabase/migrations"), { recursive: true }),
      mkdir(join(root, "rehearsal"), { recursive: true }),
      mkdir(join(root, ".rehearsal/generations"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "smart-app",
          packageManager: "npm@11.0.0",
          engines: { node: ">=22 <27" },
          scripts: {
            dev: "vite --port 5175 --token should-never-be-returned",
            test: "vitest run",
          },
          devDependencies: { vite: "7.0.0" },
          dependencies: { "@supabase/supabase-js": "2.0.0" },
        }),
      ),
      writeFile(join(root, "package-lock.json"), "{}\n"),
      writeFile(join(root, "supabase/config.toml"), 'project_id = "smart"\n'),
      writeFile(join(root, "rehearsal/sanitization-policy.json"), "{}\n"),
      writeFile(join(root, ".env"), "SECRET=must-not-appear\n"),
      writeFile(
        join(root, "rehearsal.config.mjs"),
        'await import("node:fs/promises").then(({writeFile}) => writeFile("executed", "bad"));\nexport default { runtime: { applicationUrl: "http://localhost:5175", apiPort: 58321 }, productionUrl: "https://production.example.com" };\n',
      ),
      symlink("generations/example", join(root, ".rehearsal/current")),
    ]);
    let probes = 0;

    const result = await discoverProjectProfile({
      projectRoot: root,
      containerEngineProbe: async () => {
        probes += 1;
        return "running";
      },
    });

    expect(probes).toBe(1);
    expect(result).toMatchObject({
      schemaVersion: 1,
      project: { name: "smart-app", packageManifest: "present" },
      configuration: {
        state: "present_unvalidated",
        activePath: "rehearsal.config.mjs",
      },
      safety: {
        projectCodeExecuted: false,
        environmentFilesRead: false,
        databaseContacted: false,
        containerEngineStarted: false,
      },
    });
    expect(result.detected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "detected",
          id: "package.manager",
          value: "npm",
        }),
        expect.objectContaining({
          id: "database.migrationDirectories",
          value: ["supabase/migrations"],
        }),
        expect.objectContaining({ id: "container.engine", value: "running" }),
      ]),
    );
    expect(result.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "suggested",
          id: "application.framework",
          value: "Vite",
          confidence: "high",
        }),
        expect.objectContaining({
          id: "application.startCommand",
          value: "npm run dev",
        }),
        expect.objectContaining({
          id: "application.readiness.url",
          value: "http://localhost:5175",
        }),
        expect.objectContaining({
          id: "authentication.callbackUrl",
          value: "http://127.0.0.1:58321/auth/v1/callback",
        }),
      ]),
    );
    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "decision",
          id: "privacy.productionData",
        }),
        expect.objectContaining({ id: "privacy.sanitization" }),
        expect.objectContaining({ id: "privacy.identity" }),
        expect.objectContaining({ id: "cleanup.policy" }),
      ]),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("should-never-be-returned");
    expect(serialized).not.toContain("must-not-appear");
    expect(serialized).not.toContain("production.example.com");
    await expect(
      readFile(join(root, "executed"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("surfaces ambiguous package, migration, and config choices", async () => {
    const root = await makeRoot();
    await Promise.all([
      mkdir(join(root, "database/migrations"), { recursive: true }),
      mkdir(join(root, "migrations"), { recursive: true }),
      mkdir(join(root, "infrastructure/rehearsal"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "ambiguous-app",
          packageManager: "pnpm@10",
          scripts: {},
        }),
      ),
      writeFile(join(root, "package-lock.json"), "{}\n"),
      writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n"),
      writeFile(join(root, "rehearsal.config.mjs"), "export default {};\n"),
      writeFile(
        join(root, "infrastructure/rehearsal/rehearsal.config.mjs"),
        "export default {};\n",
      ),
    ]);

    const result = await discoverProjectProfile({
      projectRoot: root,
      containerEngineProbe: async () => "stopped",
    });

    expect(result.configuration.state).toBe("ambiguous");
    expect(result.decisions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "package.manager",
        "database.migrationDirectory",
        "rehearsal.configuration.active",
        "application.startCommand",
        "application.proofCommand",
      ]),
    );
    expect(
      result.configuration.fields.find(
        ({ path }) => path === "configuration.path",
      ),
    ).toMatchObject({ status: "decision_required" });
  });

  it("does not follow a symlinked package manifest outside the project", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "outside-secret", scripts: { dev: "secret" } }),
    );
    await symlink(join(outside, "package.json"), join(root, "package.json"));

    const result = await discoverProjectProfile({
      projectRoot: root,
      containerEngineProbe: async () => "unavailable",
    });

    expect(result.project).toEqual({
      name: expect.stringMatching(/^rehearsal-discovery-/u),
      packageManifest: "missing",
    });
    expect(JSON.stringify(result)).not.toContain("outside-secret");
  });
});

it("reports native Drizzle metadata as an explicit decision without evaluating configs or journal contents", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "drizzle/meta"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "drizzle-discovery" }),
  );
  await writeFile(
    join(root, "drizzle/meta/_journal.json"),
    "not evaluated during metadata discovery",
  );
  await writeFile(
    join(root, "drizzle.config.cjs"),
    'throw new Error("private config must not execute");',
  );
  await writeFile(join(root, ".env"), "PRIVATE_SECRET=must-not-read");
  const result = await discoverProjectProfile({
    projectRoot: root,
    containerEngineProbe: async () => "unavailable",
  });
  expect(result.detected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "database.drizzle",
        value: "drizzle/meta/_journal.json",
      }),
    ]),
  );
  expect(result.decisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "database.migrationTool" }),
    ]),
  );
  expect(
    result.suggested.some((item) => item.id === "database.migrationDirectory"),
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
  expect(result.safety).toMatchObject({
    projectCodeExecuted: false,
    environmentFilesRead: false,
    databaseContacted: false,
  });
});
