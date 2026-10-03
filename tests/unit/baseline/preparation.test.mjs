import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBaselinePreparation,
  inspectBaselineInputFiles,
  planBaselinePreparation,
} from "../../../src/baseline/preparation.mjs";
import { createSyntheticBaselineFromFiles } from "../../../src/baseline/builder.mjs";
import { validateRuntimeSanitizationPolicy } from "../../../src/baseline/sanitization_policy.mjs";

const roots = [];
const execute = promisify(execFile);
const cliPath = join(process.cwd(), "src/cli/rehearsal.mjs");
const configurationUrl = pathToFileURL(
  join(process.cwd(), "src/project/configuration.mjs"),
).href;

const makeTreeWritable = async (path) => {
  await chmod(path, 0o700).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
};

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-prepare-test-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "supabase/migrations"), { recursive: true }),
    mkdir(join(root, "rehearsal"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "prepare-fixture", scripts: { dev: "vite", test: "vitest" } })}\n`,
  );
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `import { defineRehearsalConfig } from ${JSON.stringify(configurationUrl)};
export default defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "prepare-fixture" },
  supabase: { workdir: ".", migrationDirectory: "supabase/migrations", rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml", runtimeWorkdir: ".rehearsal/runtime" },
  baseline: { artifactDirectory: ".rehearsal", sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json" },
  application: { startCommand: "npm run dev", proofCommand: "npm test" },
  runtime: { applicationUrl: "http://localhost:5175", projectId: "prepare-fixture-rehearsal", apiPort: 58321, databasePort: 58322, studioPort: 58323 },
});
`,
  );
  await writeFile(
    join(root, "rehearsal/synthetic-data.ndjson"),
    [
      JSON.stringify({
        table: "widgets",
        row: { id: 1, name: "value-that-must-not-be-printed" },
      }),
      JSON.stringify({
        table: "widgets",
        row: { id: 2, name: "second-value", description: null },
      }),
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "rehearsal/migration-ledger.json"),
    `${JSON.stringify([
      {
        version: "20261001000000",
        name: "create_widgets",
        statements: ["create table public.widgets(id bigint)"],
      },
    ])}\n`,
  );
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("baseline preparation", () => {
  it("preflights records, migrations, and optional storage without exposing values", async () => {
    const root = await makeProject();
    await writeFile(join(root, "rehearsal/exact-byte.txt"), "asset-value");
    await writeFile(
      join(root, "rehearsal/assets.json"),
      `${JSON.stringify([
        {
          bucket: "fixture-assets",
          objectPath: "proof/exact-byte.txt",
          contentType: "text/plain",
          file: "rehearsal/exact-byte.txt",
        },
      ])}\n`,
    );

    const inspection = await inspectBaselineInputFiles({
      projectRoot: root,
      recordsPath: "rehearsal/synthetic-data.ndjson",
      ledgerPath: "rehearsal/migration-ledger.json",
      assetsPath: "rehearsal/assets.json",
    });

    expect(inspection).toMatchObject({
      recordsPath: "rehearsal/synthetic-data.ndjson",
      ledgerPath: "rehearsal/migration-ledger.json",
      assetsPath: "rehearsal/assets.json",
      rowCount: 2,
      migrationCount: 1,
      assetCount: 1,
    });
    expect(JSON.stringify(inspection)).not.toContain(
      "value-that-must-not-be-printed",
    );
  });

  it("rejects invalid storage manifests before baseline creation", async () => {
    const root = await makeProject();
    await writeFile(
      join(root, "rehearsal/assets.json"),
      `${JSON.stringify([
        {
          bucket: "fixture-assets",
          objectPath: "../escape.txt",
          file: "rehearsal/missing.txt",
        },
      ])}\n`,
    );

    await expect(
      inspectBaselineInputFiles({
        projectRoot: root,
        recordsPath: "rehearsal/synthetic-data.ndjson",
        ledgerPath: "rehearsal/migration-ledger.json",
        assetsPath: "rehearsal/assets.json",
      }),
    ).rejects.toThrow("entry 1 has an invalid shape");
  });

  it("creates a schema-only fail-closed policy draft", async () => {
    const root = await makeProject();
    const plan = await planBaselinePreparation({
      projectRoot: root,
      recordsPath: "rehearsal/synthetic-data.ndjson",
      ledgerPath: "rehearsal/migration-ledger.json",
    });

    expect(plan).toMatchObject({
      migrationCutoff: "20261001000000",
      migrationCount: 1,
      rowCount: 2,
      tables: [
        {
          name: "widgets",
          rowCount: 2,
          columns: ["description", "id", "name"],
        },
      ],
    });
    expect(plan.content).not.toContain("value-that-must-not-be-printed");
    await applyBaselinePreparation(plan);

    const policy = JSON.parse(await readFile(plan.destination, "utf8"));
    expect(policy.draft).toBe(true);
    expect(policy.tables[0].columns).toHaveLength(3);
    expect(policy.tables[0].columns[0]).toMatchObject({
      action: "REVIEW REQUIRED",
      generated: "REVIEW REQUIRED",
      identity: "REVIEW REQUIRED",
      foreignKey: "REVIEW REQUIRED",
    });
    expect(() => validateRuntimeSanitizationPolicy(policy)).toThrow(
      "still a REVIEW REQUIRED draft",
    );
    await expect(
      createSyntheticBaselineFromFiles({
        projectRoot: root,
        recordsPath: "rehearsal/synthetic-data.ndjson",
        ledgerPath: "rehearsal/migration-ledger.json",
      }),
    ).rejects.toThrow("still a REVIEW REQUIRED draft");
    await expect(applyBaselinePreparation(plan)).rejects.toThrow(
      "will not overwrite",
    );
  });

  it("supports non-mutating preview and explicit CLI write", async () => {
    const root = await makeProject();
    const args = [
      "baseline",
      "prepare",
      "--records=rehearsal/synthetic-data.ndjson",
      "--ledger=rehearsal/migration-ledger.json",
      "--json",
    ];
    const preview = JSON.parse(
      (await execute(process.execPath, [cliPath, ...args], { cwd: root }))
        .stdout,
    );
    expect(preview.data.mode).toBe("preview");
    expect(JSON.stringify(preview.data)).not.toContain(
      "value-that-must-not-be-printed",
    );
    const humanPreview = (
      await execute(process.execPath, [cliPath, ...args.slice(0, -1)], {
        cwd: root,
      })
    ).stdout;
    expect(humanPreview).toContain("Records: 2 rows");
    expect(humanPreview).toContain("Migrations: 1 migration");
    expect(humanPreview).not.toContain("1 migrations");
    await expect(
      stat(join(root, "infrastructure/rehearsal/sanitization-policy.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const written = JSON.parse(
      (
        await execute(process.execPath, [cliPath, ...args, "--write"], {
          cwd: root,
        })
      ).stdout,
    );
    expect(written.data.mode).toBe("written");
    await expect(
      stat(join(root, "infrastructure/rehearsal/sanitization-policy.json")),
    ).resolves.toBeDefined();
  });
});
