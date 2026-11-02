import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAndActivateBaseline } from "../../../../dist/src/baseline/artifact.mjs";
import {
  createMigrationInsightsInput,
  MIGRATION_INSIGHTS_LIMITS,
} from "../../../../dist/src/runtime/migrations/migration_insights_input.mjs";
import {
  inspectMigrationInsights,
  renderMigrationInsights,
} from "../../../../dist/src/runtime/migrations/migration_insights.mjs";
import { inspectMigrationReviewPlan } from "../../../../dist/src/runtime/migrations/migration_plan.mjs";

const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cli = join(process.cwd(), "dist/src/cli/rehearsal.mjs");
const configuration = pathToFileURL(
  join(process.cwd(), "dist/src/project/configuration.mjs"),
).href;
const makeWritable = async (path) => {
  await chmod(path, 0o700).catch(() => {});
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
};
const fixture = async (sql = "DROP TABLE public.widgets;") => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-insights-"));
  roots.push(root);
  await mkdir(join(root, "database/migrations"), { recursive: true });
  const historical = {
    filename: "20260101000000_create_widgets.sql",
    content: "create table public.widgets(id integer);\n",
  };
  const policy = JSON.stringify({
    policyVersion: 1,
    migrationCutoff: "20260101000000",
    tables: [
      {
        name: "widgets",
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
  });
  await writeFile(join(root, "policy.json"), policy);
  await writeFile(
    join(root, "database/migrations", historical.filename),
    historical.content,
  );
  await writeFile(
    join(root, "database/migrations/20260101000100_change.sql"),
    sql,
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "synthetic-insights" }),
  );
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `import {defineRehearsalConfig} from ${JSON.stringify(configuration)};
export default defineRehearsalConfig({schemaVersion:1,project:{name:"synthetic-insights"},postgresql:{migrationDirectory:"database/migrations",runtimeWorkdir:".rehearsal/runtime",image:"postgres:17-alpine",database:"postgres",user:"postgres"},baseline:{artifactDirectory:".rehearsal",sanitizationPolicy:"policy.json"},application:{startCommand:"node no-start.mjs",proofCommand:"node no-proof.mjs"},runtime:{target:"postgresql",applicationUrl:"http://127.0.0.1:5275",projectId:"synthetic-insights",databasePort:59422}});`,
  );
  await createAndActivateBaseline({
    artifactRoot: join(root, ".rehearsal"),
    generationId: "20260101T000000Z-aaaaaaaaaaaa",
    records: [{ table: "widgets", row: { id: 1 } }],
    metadata: {
      migrationCutoff: "20260101000000",
      migrationHistorySha256: "a".repeat(64),
      sanitizationPolicySha256: digest(policy),
    },
    expectedTables: ["widgets"],
    migrationFiles: [historical],
  });
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("exact bounded Migration Insights inspection", () => {
  it("binds findings to the complete plan and exact source without changing plan v1", async () => {
    const root = await fixture(
      "-- PRIVATE_SQL_CANARY\nDROP TABLE public.PRIVATE_IDENTIFIER;",
    );
    const before = await inspectMigrationReviewPlan({ projectRoot: root });
    const report = await inspectMigrationInsights({ projectRoot: root });
    expect(report.candidateSha256).toBe(before.candidateSha256);
    expect(report).toMatchObject({
      schemaVersion: 1,
      candidateCount: 1,
      verdict: "static_warnings",
      summary: { findingCount: 1, unknownCount: 0 },
      safety: {
        readsSqlBodies: true,
        executesSql: false,
        startsEngine: false,
        contactsDatabase: false,
        includesSqlOrRowValues: false,
      },
    });
    expect(report.targets[0].entries[0]).toMatchObject({
      version: "20260101000100",
      filename: "20260101000100_change.sql",
      workspaceRelativePath: "database/migrations/20260101000100_change.sql",
      findings: [{ rule: "drop_table", line: 2, column: 1 }],
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
    expect(renderMigrationInsights(report)).toContain(
      "not a safety or syntax-validity verdict",
    );
    expect(await inspectMigrationReviewPlan({ projectRoot: root })).toEqual(
      before,
    );
    expect(before.safety.readsSqlBodiesForSafety).toBe(false);
  });
  it("keeps unsupported SQL unknown even when it also contains a recognized warning", async () => {
    const root = await fixture(
      "SELECT 'DROP TABLE hidden;'; DROP TABLE widgets;",
    );
    const report = await inspectMigrationInsights({ projectRoot: root });
    expect(report.verdict).toBe("unknown");
    expect(report.targets[0].entries[0]).toMatchObject({
      coverage: "incomplete",
      unknownReasons: ["unsupported_sql"],
      findings: [{ rule: "drop_table" }],
    });
  });
  it("does not confuse no detected warning with database verification", async () => {
    const root = await fixture("UPDATE widgets SET id=2 WHERE id=1;");
    const report = await inspectMigrationInsights({ projectRoot: root });
    expect(report.verdict).toBe("no_detected_warning");
    expect(report.summary.findingCount).toBe(0);
    expect(report.limitation).toContain("not measured");
  });
  it("changes source hashes and exact approval digest when a pending file changes", async () => {
    const root = await fixture();
    const first = await inspectMigrationInsights({ projectRoot: root });
    await writeFile(
      join(root, "database/migrations/20260101000100_change.sql"),
      "TRUNCATE widgets;",
    );
    const second = await inspectMigrationInsights({ projectRoot: root });
    expect(second.candidateSha256).not.toBe(first.candidateSha256);
    expect(second.targets[0].entries[0].sha256).not.toBe(
      first.targets[0].entries[0].sha256,
    );
    expect(second.targets[0].entries[0].findings[0].rule).toBe("truncate");
  });
  it("binds raw BOM bytes while reporting decoded UTF-16 positions across mixed line endings", async () => {
    const sql =
      "\uFEFFDROP TABLE widgets;\r\nUPDATE widgets SET id=2;\rDELETE FROM widgets;\n";
    const root = await fixture(sql);
    const report = await inspectMigrationInsights({ projectRoot: root });
    const entry = report.targets[0].entries[0];
    expect(entry.sha256).toBe(digest(sql));
    expect(
      entry.findings.map(({ rule, line, column }) => ({ rule, line, column })),
    ).toEqual([
      { rule: "drop_table", line: 1, column: 1 },
      { rule: "broad_update", line: 2, column: 1 },
      { rule: "broad_delete", line: 3, column: 1 },
    ]);
    expect(
      await readFile(join(root, entry.workspaceRelativePath), "utf8"),
    ).toBe(sql);
  });
  it("binds every dependent target to the existing complete ordered topology digest", async () => {
    const root = await fixture("DROP TABLE widgets;");
    const dependent = await fixture("DELETE FROM widgets;");
    const dependentConfig = (
      await readFile(join(dependent, "rehearsal.config.mjs"), "utf8")
    )
      .replaceAll('"database/migrations"', '"publication/database/migrations"')
      .replaceAll('".rehearsal/runtime"', '"publication/.rehearsal/runtime"')
      .replaceAll('".rehearsal"', '"publication/.rehearsal"')
      .replaceAll('"policy.json"', '"publication/policy.json"')
      .replaceAll('"synthetic-insights"', '"synthetic-publication"')
      .replace(
        "application:{",
        'application:{environmentFile:"publication/.rehearsal/runtime.env",',
      )
      .replace("databasePort:59422", "databasePort:59423");
    await rename(dependent, join(root, "publication"));
    await writeFile(join(root, "publication.config.mjs"), dependentConfig);
    const primary = await readFile(join(root, "rehearsal.config.mjs"), "utf8");
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      primary.replace(
        "postgresql:",
        'dependentTargets:[{name:"publication",configPath:"publication.config.mjs"}],postgresql:',
      ),
    );
    const plan = await inspectMigrationReviewPlan({ projectRoot: root });
    const report = await inspectMigrationInsights({ projectRoot: root });
    expect(report.candidateSha256).toBe(plan.candidateSha256);
    expect(report.candidateCount).toBe(2);
    expect(report.targets.map((target) => target.name)).toEqual([
      "primary",
      "publication",
    ]);
    expect(report.targets[0].entries[0].findings[0].rule).toBe("drop_table");
    expect(report.targets[1].entries[0]).toMatchObject({
      workspaceRelativePath:
        "publication/database/migrations/20260101000100_change.sql",
      findings: [{ rule: "broad_delete" }],
    });
    expect(report.targets[0].candidateSha256).not.toBe(
      report.targets[1].candidateSha256,
    );
    expect(await inspectMigrationReviewPlan({ projectRoot: root })).toEqual(
      plan,
    );
  });
  it("exposes one public JSON envelope without starting application or infrastructure tools", async () => {
    const root = await fixture();
    const before = await readFile(join(root, "rehearsal.config.mjs"));
    const result = spawnSync(
      process.execPath,
      [cli, "inspect", "insights", "--json"],
      {
        cwd: root,
        env: { ...process.env, PATH: "" },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      command: "inspect insights",
      status: "success",
      data: { candidateCount: 1, verdict: "static_warnings" },
    });
    expect(await readFile(join(root, "rehearsal.config.mjs"))).toEqual(before);
  });
  it("refuses symlinked and oversized inputs without exposing their contents", async () => {
    const root = await fixture();
    const path = join(root, "database/migrations/20260101000100_change.sql");
    const sentinel = join(root, "PRIVATE_SENTINEL");
    await writeFile(sentinel, "PRIVATE_ROW");
    await rm(path);
    await symlink(sentinel, path);
    await expect(
      inspectMigrationInsights({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(await readFile(sentinel, "utf8")).toBe("PRIVATE_ROW");
    await rm(path);
    await writeFile(
      path,
      " ".repeat(MIGRATION_INSIGHTS_LIMITS.maximumFileBytes + 1),
    );
    await expect(
      inspectMigrationInsights({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  });
  it("refuses a symlinked directory and unsafe URL-like filenames", async () => {
    const root = await fixture();
    const outside = await mkdtemp(
      join(tmpdir(), "rehearsal-insights-outside-"),
    );
    roots.push(outside);
    await writeFile(join(outside, "20260101000100_change.sql"), "PRIVATE_ROW");
    const linked = join(root, "linked");
    await symlink(outside, linked);
    await expect(
      createMigrationInsightsInput(root).readInventory(
        pathToFileURL(`${linked}/`),
      ),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    const directory = join(root, "database/migrations");
    await writeFile(
      join(directory, "20260101000200_bad%23name.sql"),
      "PRIVATE_ROW",
    );
    await expect(
      inspectMigrationInsights({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  });
  it("refuses invalid UTF-8 and non-regular SQL without changing private inputs", async () => {
    const root = await fixture();
    const file = join(root, "database/migrations/20260101000100_change.sql");
    const invalid = Buffer.from([0xc3, 0x28]);
    await writeFile(file, invalid, { mode: 0o600 });
    const before = await stat(file);
    await expect(
      inspectMigrationInsights({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(await readFile(file)).toEqual(invalid);
    const after = await stat(file);
    expect([after.ino, after.mode, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.mode,
      before.size,
      before.mtimeMs,
    ]);
    await rm(file);
    await mkdir(file);
    await expect(
      inspectMigrationInsights({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  });
  it("refuses a changed shared-directory input instead of pairing old hashes with later SQL", async () => {
    const root = await fixture("DROP TABLE widgets;");
    const directory = join(root, "database/migrations");
    const file = join(directory, "20260101000100_change.sql");
    const input = createMigrationInsightsInput(root);
    const first = await input.readInventory(pathToFileURL(`${directory}/`));
    const original = first.find(
      (entry) => entry.filename === "20260101000100_change.sql",
    );
    expect(input.sourceFor(file, original.fileSha256)).toBe(
      "DROP TABLE widgets;",
    );
    await writeFile(file, "TRUNCATE widgets;");
    await expect(
      input.readInventory(pathToFileURL(`${directory}/`)),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(input.sourceFor(file, digest("TRUNCATE widgets;"))).toBeUndefined();
    expect(input.sourceFor(file, original.fileSha256)).toBe(
      "DROP TABLE widgets;",
    );
    expect(await readFile(file, "utf8")).toBe("TRUNCATE widgets;");
  });
  it("bounds total SQL bytes across inventory reads, not separately per file or target", async () => {
    const root = await fixture();
    const input = createMigrationInsightsInput(root);
    const size = MIGRATION_INSIGHTS_LIMITS.maximumFileBytes;
    // Eight exact-size files exhaust the shared 16 MiB budget. A second inventory
    // cannot start a new budget merely because it belongs to another target.
    const first = join(root, "bounded-first");
    const second = join(root, "bounded-second");
    await mkdir(first);
    await mkdir(second);
    const bytes = Buffer.alloc(size, 32);
    for (let index = 0; index < 8; index++)
      await writeFile(join(first, `2026010100000${index}_bounded.sql`), bytes);
    await writeFile(join(second, "20260101000009_beyond.sql"), " ");
    const inventory = await input.readInventory(pathToFileURL(`${first}/`));
    expect(inventory).toHaveLength(8);
    expect(inventory.every((entry) => entry.fileSha256 === digest(bytes))).toBe(
      true,
    );
    await expect(
      input.readInventory(pathToFileURL(`${second}/`)),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  });
  it("caps aggregate findings and reports remaining coverage as unknown, never safe", async () => {
    const root = await fixture("DROP TABLE widgets;\n".repeat(1000));
    for (let index = 2; index <= 6; index++)
      await writeFile(
        join(
          root,
          `database/migrations/20260101000${String(index).padStart(3, "0")}_change.sql`,
        ),
        "DROP TABLE widgets;\n".repeat(1000),
      );
    const report = await inspectMigrationInsights({ projectRoot: root });
    expect(report.candidateCount).toBe(6);
    expect(report.summary.findingCount).toBe(
      MIGRATION_INSIGHTS_LIMITS.maximumFindings,
    );
    expect(report.verdict).toBe("unknown");
    expect(report.summary.unknownCount).toBeGreaterThan(0);
    expect(report.targets[0].entries.at(-1)).toMatchObject({
      verdict: "unknown",
      coverage: "incomplete",
      unknownReasons: ["input_limit"],
      findings: [],
    });
    expect(JSON.stringify(report)).not.toContain('"safe"');
  });
});
