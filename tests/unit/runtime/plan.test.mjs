import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAndActivateBaseline } from "../../../dist/src/baseline/artifact.mjs";
import {
  buildRehearsalPlan,
  inspectRehearsalMigrations,
} from "../../../dist/src/runtime/plan.mjs";

const roots = [];
const configurationModuleUrl = pathToFileURL(
  join(process.cwd(), "dist/src/project/configuration.mjs"),
).href;

const makeTreeWritable = async (path) => {
  await chmod(path, 0o700).catch(() => undefined);
  for (const entry of await import("node:fs/promises").then(({ readdir }) =>
    readdir(path, { withFileTypes: true }).catch(() => []),
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
};

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-plan-test-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "supabase/migrations"), { recursive: true }),
    mkdir(join(root, "infrastructure/rehearsal/supabase"), {
      recursive: true,
    }),
  ]);
  const historical = {
    filename: "20260912000000_create_widget.sql",
    content: "create table public.widget(id bigint primary key);\n",
  };
  const policySource = `${JSON.stringify({
    policyVersion: 1,
    migrationCutoff: "20260912000000",
    tables: [
      {
        name: "widget",
        sourceRows: "STREAM AND SANITIZE",
        columns: [
          {
            name: "id",
            action: "KEEP",
            generated: "NEVER",
            identity: "NO",
            foreignKey: null,
          },
        ],
      },
    ],
  })}\n`;
  await writeFile(
    join(root, "supabase/migrations", historical.filename),
    historical.content,
  );
  await writeFile(
    join(root, "infrastructure/rehearsal/supabase/config.toml"),
    'project_id = "fixture-rehearsal"\n[api]\nport = 58321\n[db]\nport = 58322\n[studio]\nport = 58323\n',
  );
  await writeFile(
    join(root, "infrastructure/rehearsal/policy.json"),
    policySource,
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { dev: "vite", test: "vitest" },
    }),
  );
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `import { defineRehearsalConfig } from ${JSON.stringify(configurationModuleUrl)};
export default defineRehearsalConfig({
	schemaVersion: 1,
	project: { name: "fixture" },
	supabase: { workdir: ".", migrationDirectory: "supabase/migrations", rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml", runtimeWorkdir: ".rehearsal/runtime" },
	baseline: { artifactDirectory: ".rehearsal", sanitizationPolicy: "infrastructure/rehearsal/policy.json" },
	application: { startCommand: "npm run dev", proofCommand: "npm test" },
	runtime: { applicationUrl: "http://localhost:5175", projectId: "fixture-rehearsal", apiPort: 58321, databasePort: 58322, studioPort: 58323 },
});\n`,
  );
  await createAndActivateBaseline({
    artifactRoot: join(root, ".rehearsal"),
    generationId: "20260912T120000Z-aaaaaaaaaaaa",
    records: [{ table: "widget", row: { id: 1 } }],
    metadata: {
      migrationCutoff: "20260912000000",
      migrationHistorySha256: "a".repeat(64),
      sanitizationPolicySha256: createHash("sha256")
        .update(policySource)
        .digest("hex"),
    },
    expectedTables: ["widget"],
    migrationFiles: [historical],
  });
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("Rehearsal plan", () => {
  it("builds deterministic plan semantics without mutating the project", async () => {
    const root = await createFixture();
    const first = await buildRehearsalPlan({ projectRoot: root });
    const second = await buildRehearsalPlan({ projectRoot: root });

    expect(second).toEqual(first);
    expect(first.environment.target).toBe("supabase");
    expect(first.baseline.rowCount).toBe(1);
    expect(first.migrations.representedCount).toBe(1);
    expect(first.migrations.candidateCount).toBe(0);
    expect(first.guarantee).toBe("No production resources will be contacted.");
  });

  it("reports the exact generated local OAuth callback", async () => {
    const root = await createFixture();
    const configPath = join(root, "rehearsal.config.mjs");
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace(
        'runtimeWorkdir: ".rehearsal/runtime"',
        `runtimeWorkdir: ".rehearsal/runtime", authentication: {
          enableLocalSignup: true,
          environmentFile: ".env.rehearsal-service.local",
          providers: [{
            name: "github",
            clientIdEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_ID",
            clientSecretEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_SECRET",
          }],
        }`,
      ),
    );

    const plan = await buildRehearsalPlan({ projectRoot: root });

    expect(plan.environment.authenticationProviders).toEqual(["github"]);
    expect(plan.environment.authenticationCallback).toBe(
      "http://127.0.0.1:58321/auth/v1/callback",
    );
  });

  it("classifies only exact suffix files as candidates", async () => {
    const root = await createFixture();
    await writeFile(
      join(root, "supabase/migrations/20260912000100_add_widget_name.sql"),
      "alter table public.widget add column name text;\n",
    );
    const inspection = await inspectRehearsalMigrations({ projectRoot: root });
    expect(inspection.migrations.map(({ status }) => status)).toEqual([
      "represented_by_baseline",
      "candidate",
    ]);
    expect(inspection.candidateSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when represented migration bytes change", async () => {
    const root = await createFixture();
    await writeFile(
      join(root, "supabase/migrations/20260912000000_create_widget.sql"),
      "select 'tampered';\n",
    );
    await expect(buildRehearsalPlan({ projectRoot: root })).rejects.toThrow(
      "diverges from the active baseline",
    );
  });

  it("fails closed when the reviewed sanitization policy changes", async () => {
    const root = await createFixture();
    const policyPath = join(root, "infrastructure/rehearsal/policy.json");
    const policy = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(policyPath, "utf8"),
      ),
    );
    policy.tables[0].columns[0].action = "REPLACE";
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`);

    await expect(buildRehearsalPlan({ projectRoot: root })).rejects.toThrow(
      "does not match the reviewed baseline policy checksum",
    );
  });
});
