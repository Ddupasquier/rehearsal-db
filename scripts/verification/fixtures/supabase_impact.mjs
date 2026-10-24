/** Real installed-CLI aggregates on the Supabase scenario's already-owned target. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnScenarioCommand } from "../scenarios/process.mjs";
import {
  IMPACT_FIXTURE_CANARIES,
  IMPACT_FIXTURE_FILENAME,
  IMPACT_FIXTURE_SCHEMA,
  IMPACT_FIXTURE_SQL,
  assertImpactFixtureCounts,
  assertImpactPublicOutput,
  protectedFingerprint,
} from "./postgresql_impact.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error(
    "Supabase impact verification failed; private inputs and output withheld.",
  );
};

export async function proveSupabaseMigrationImpact({
  cwd,
  artifact,
  runSql,
  runtimeIdentity,
}) {
  if (
    !/^[a-f0-9]{64}$/u.test(artifact?.sha256) ||
    digest(await readFile(artifact.path)) !== artifact.sha256
  )
    fail();
  const relative = join("supabase/migrations", IMPACT_FIXTURE_FILENAME);
  const file = join(cwd, relative);
  if (
    await lstat(file).then(
      () => true,
      (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    )
  )
    fail();
  const schema = IMPACT_FIXTURE_SCHEMA;
  const sql = (text) => runSql(text).trim();
  if (
    sql(`select pg_catalog.to_regnamespace('${schema}') is null;`) !== "t" ||
    Number(sql("show server_version_num;")) < 170000
  )
    fail();
  const identity = runtimeIdentity();
  if (
    sql(
      "select not rolsuper and not pg_catalog.has_parameter_privilege(current_user, 'temp_file_limit', 'SET') from pg_catalog.pg_roles where rolname = current_user;",
    ) !== "t"
  )
    fail();
  const before = await protectedFingerprint(cwd, relative);
  const original = digest(
    sql(
      "select pg_catalog.jsonb_build_object('widgets', (select pg_catalog.jsonb_agg(to_jsonb(w) order by id) from public.widgets w), 'ledger', (select pg_catalog.jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m));",
    ),
  );
  const canaries = [...IMPACT_FIXTURE_CANARIES];
  const cli = (args, success = true) => {
    const result = spawnScenarioCommand(
      join(cwd, "node_modules/.bin/rehearsal"),
      [...args, "--json"],
      { cwd, timeout: 35000, maxBuffer: 131072 },
    );
    assertImpactPublicOutput(result, canaries);
    if (result.error || result.signal || (success && result.status !== 0))
      fail();
    return { result, envelope: JSON.parse(result.stdout) };
  };
  const marker = randomUUID();
  let schemaCreated = false,
    fileCreated = false,
    failure;
  let summary;
  try {
    sql(
      `begin; create schema ${schema}; comment on schema ${schema} is '${marker}'; commit;`,
    );
    schemaCreated = true;
    sql(`create table ${schema}.parent (id integer primary key, payload text, duplicate_key text);
      create table ${schema}.child (id integer primary key, parent_id integer);
      insert into ${schema}.parent values (1,null,'a'),(2,null,'a'),(3,'','b'),(4,'value','c'),(5,'value',null),(6,'value',null);
      insert into ${schema}.child values (1,1),(2,2),(3,9),(4,9),(5,null);`);
    await writeFile(file, IMPACT_FIXTURE_SQL, { flag: "wx", mode: 0o600 });
    fileCreated = true;
    const preview = cli(["inspect", "impact", "--target=primary"]).envelope
      .data;
    if (
      preview?.target?.provider !== "supabase" ||
      preview.mode !== "preview" ||
      preview.safety?.contactsDatabase !== false ||
      !/^[a-f0-9]{64}$/u.test(preview.candidateSha256)
    )
      fail();
    const confirmation = `--confirm-candidates=${preview.candidateSha256}`;
    const rows = () =>
      digest(
        sql(
          `select pg_catalog.jsonb_build_object('parent', (select pg_catalog.jsonb_agg(to_jsonb(p) order by id) from ${schema}.parent p), 'child', (select pg_catalog.jsonb_agg(to_jsonb(c) order by id) from ${schema}.child c));`,
        ),
      );
    const measure = (counts, reasons) => {
      const { result, envelope } = cli(
        ["measure", "impact", "--target=primary", confirmation],
        false,
      );
      const report = assertImpactFixtureCounts(envelope, {
        candidateSha256: preview.candidateSha256,
        counts,
        ...(reasons ? { reasons } : {}),
        version: artifact.version,
        provider: "supabase",
      });
      if (
        result.status !==
        (["partial", "unknown"].includes(report.measurementStatus) ? 1 : 0)
      )
        fail();
      return report;
    };
    const initialRows = rows();
    const first = measure(["2", "4", "2", "2", "5", "6", "6"]);
    if (rows() !== initialRows) fail();
    sql(
      `update ${schema}.parent set payload = 'PRIVATE_IMPACT_ROW_CANARY' where id = 1;`,
    );
    const editedRows = rows();
    const current = measure(["1", "5", "2", "2", "5", "6", "6"]);
    if (
      rows() !== editedRows ||
      first.runtimeIdentitySha256 !== current.runtimeIdentitySha256
    )
      fail();
    sql(`alter table ${schema}.parent enable row level security;`);
    const guarded = [null, null, null, null, "5", null, null];
    measure(
      guarded,
      guarded.map((count) =>
        count === null ? "unsupported_runtime_metadata" : null,
      ),
    );
    sql(`alter table ${schema}.parent disable row level security;`);
    await writeFile(file, `${IMPACT_FIXTURE_SQL}-- changed reviewed bytes\n`);
    const stale = cli(
      ["measure", "impact", "--target=primary", confirmation],
      false,
    );
    if (
      stale.result.status !== 2 ||
      stale.envelope.error?.category !== "configuration_invalid" ||
      stale.envelope.error?.code !== "CONFIGURATION_INVALID" ||
      cli(["inspect", "impact", "--target=primary"]).envelope.data
        .candidateSha256 === preview.candidateSha256
    )
      fail();
    await writeFile(file, IMPACT_FIXTURE_SQL);
    if (
      rows() !== editedRows ||
      runtimeIdentity() !== identity ||
      (await protectedFingerprint(cwd, relative)) !== before
    )
      fail();
    if (
      digest(
        sql(
          "select pg_catalog.jsonb_build_object('widgets', (select pg_catalog.jsonb_agg(to_jsonb(w) order by id) from public.widgets w), 'ledger', (select pg_catalog.jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m));",
        ),
      ) !== original
    )
      fail();
    const publicActivity = cli(["activity"]).envelope;
    if (publicActivity.data.state !== "idle") fail();
    summary = {
      status: "passed",
      provider: "supabase",
      counts: ["2", "4", "2", "2", "5", "6", "6"],
      editedCounts: ["1", "5", "2", "2", "5", "6", "6"],
      rlsUnknown: true,
      restrictedPostgresCannotSetDiskLimit: true,
      staleConsentRefused: true,
      inputsRowsLedgerAndRuntimePreserved: true,
      publicActivity,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (fileCreated) {
      const current = await readFile(file, "utf8");
      if (
        ![
          IMPACT_FIXTURE_SQL,
          `${IMPACT_FIXTURE_SQL}-- changed reviewed bytes\n`,
        ].includes(current)
      )
        fail();
      await unlink(file);
    }
    if (schemaCreated) {
      if (
        sql(
          `select pg_catalog.obj_description(oid, 'pg_namespace') from pg_catalog.pg_namespace where nspname = '${schema}';`,
        ) !== marker
      )
        fail();
      sql(`drop schema ${schema} cascade;`);
    }
    if (
      (await protectedFingerprint(cwd, relative)) !== before ||
      runtimeIdentity() !== identity
    )
      fail();
  }
  if (failure) throw failure;
  return summary;
}
