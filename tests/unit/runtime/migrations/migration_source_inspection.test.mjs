import { inspectMigrationImpact } from "../../../../dist/src/runtime/migrations/migration_impact.mjs";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  drizzleFixture,
  configureDrizzleFixture,
  removeDrizzleFixture,
} from "../../../helpers/drizzle_fixture.mjs";
import { inspectMigrationInsights } from "../../../../dist/src/runtime/migrations/migration_insights.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeDrizzleFixture(root);
});
const cli = join(process.cwd(), "dist/src/cli/rehearsal.mjs");
async function fixture() {
  const f = await drizzleFixture();
  roots.push(f.root);
  const sdkTrace = join(f.root, "sdk-executed");
  await writeFile(
    join(f.kit, "bin.cjs"),
    `require('node:fs').appendFileSync(${JSON.stringify(sdkTrace)},'kit');process.exit(81);`,
  );
  const configured = await configureDrizzleFixture(f);
  const bin = join(f.root, "deny-bin"),
    engineTrace = join(f.root, "engine-executed");
  await mkdir(bin);
  for (const name of [
    "docker",
    "colima",
    "supabase",
    "psql",
    "prisma",
    "drizzle-kit",
    "pg_ctl",
    "createdb",
    "open",
  ]) {
    const path = join(bin, name);
    await writeFile(
      path,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(engineTrace)},${JSON.stringify(name)});process.exit(81);\n`,
    );
    await chmod(path, 0o700);
  }
  return { ...configured, sdkTrace, engineTrace, bin };
}
function invoke(f, entry = f.plan.targets[0].entries[2], overrides = {}) {
  const flags = {
    target: "primary",
    "native-identity": JSON.stringify(entry.nativeIdentity),
    "source-sha256": entry.sha256,
    "candidate-sha256": f.plan.candidateSha256,
    ...overrides,
  };
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "inspect",
      "source",
      "--json",
      ...Object.entries(flags).map(([key, value]) => `--${key}=${value}`),
    ],
    {
      cwd: f.root,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: f.bin, REHEARSAL_UPDATE_CHECK: "off" },
    },
  );
  expect(result.error).toBeUndefined();
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error("Public source output was not bounded JSON.");
  }
  return { ...result, output };
}
async function noExecution(f) {
  await expect(access(f.sdkTrace)).rejects.toThrow();
  await expect(access(f.engineTrace)).rejects.toThrow();
}
it("public CLI returns exact closed native references for history and candidates without SDK/engine/SQL actions", async () => {
  const f = await fixture();
  const before = await readFile(join(f.root, "rehearsal.config.mjs"));
  const baselineData = await readFile(
    join(f.root, ".rehearsal/current/sanitized-data.ndjson"),
  );
  for (const entry of f.plan.targets[0].entries) {
    const result = invoke(f, entry);
    expect(result.status).toBe(0);
    expect(result.output.data).toEqual({
      schemaVersion: 2,
      evidence: "reviewed_source_input",
      target: "primary",
      candidateSha256: f.plan.candidateSha256,
      nativeIdentity: entry.nativeIdentity,
      filename: entry.filename,
      sha256: entry.sha256,
      workspaceRelativePath: `drizzle/${entry.filename}`,
      line: null,
      column: null,
    });
    expect(result.stdout).not.toContain("PRIVATE_SQL_CANARY");
  }
  expect(await readFile(join(f.root, "rehearsal.config.mjs"))).toEqual(before);
  expect(
    await readFile(join(f.root, ".rehearsal/current/sanitized-data.ndjson")),
  ).toEqual(baselineData);
  await noExecution(f);
});
it.each([
  {
    "native-identity": JSON.stringify({
      kind: "drizzle",
      idx: 2,
      when: 1720000002001,
      tag: "m_pending",
    }),
  },
  { "source-path": "../outside.sql" },
  {
    "native-identity":
      '{"kind":"drizzle","idx":0,"when":1720000000000,"tag":"../escape"}',
  },
  {
    "native-identity":
      '{"kind":"drizzle","idx":0,"when":1720000000000,"tag":"z_initial","path":"/foreign"}',
  },
  { "source-sha256": "a".repeat(64) },
  { "candidate-sha256": "b".repeat(64) },
  { target: "foreign" },
])(
  "public CLI refuses malformed or stale native request %# without side effects",
  async (overrides) => {
    const f = await fixture();
    const result = invoke(f, undefined, overrides);
    expect(result.status).not.toBe(0);
    expect(result.output.status).not.toBe("success");
    expect(result.stdout).not.toContain("PRIVATE_SQL_CANARY");
    await noExecution(f);
  },
);
it("public CLI refuses changed files and symlinked source rather than following a reviewed filename", async () => {
  const f = await fixture();
  const path = join(f.directory, "m_pending.sql"),
    old = await readFile(path);
  await writeFile(path, Buffer.concat([old, Buffer.from("-- drift")]));
  expect(invoke(f).status).not.toBe(0);
  await writeFile(path, old);
  const held = join(f.root, "held-pending.sql");
  await rename(path, held);
  await symlink(held, path);
  expect(invoke(f).status).not.toBe(0);
  await noExecution(f);
});
it("bounded static Drizzle Insights retains native identity and exact digest without exposing SQL or importing SDK", async () => {
  const f = await fixture();
  const result = await inspectMigrationInsights({ projectRoot: f.root });
  expect(result.candidateSha256).toBe(f.plan.candidateSha256);
  const entry = result.targets[0].entries[0];
  expect(entry.nativeIdentity).toEqual(
    f.plan.targets[0].entries[2].nativeIdentity,
  );
  expect(entry).not.toHaveProperty("version");
  expect(entry.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: "drop_table", line: 2, column: 1 }),
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SQL_CANARY");
  expect(result.safety).toMatchObject({
    executesSql: false,
    startsEngine: false,
    contactsDatabase: false,
    includesSqlOrRowValues: false,
  });
  await noExecution(f);
});

it("keeps live impact explicitly unsupported after adding the shared Drizzle static capture hook", async () => {
  const f = await fixture();
  await expect(
    inspectMigrationImpact({ projectRoot: f.root }, "primary"),
  ).rejects.toThrow(/not qualified for native Drizzle/);
  await noExecution(f);
});
