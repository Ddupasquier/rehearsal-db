import { assertNativeBaselineManifestUnchanged } from "../../../dist/src/runtime/baseline_identity.mjs";
import { createHash } from "node:crypto";
import { writeFile, readFile, chmod, access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { knexFixture, removeKnexFixture } from "../../helpers/knex_fixture.mjs";
import { createKnexBaseline } from "../../../dist/src/baseline/knex_builder.mjs";
import { verifyActiveBaseline } from "../../../dist/src/baseline/artifact.mjs";
import { readConfiguredMigrationSource } from "../../../dist/src/runtime/native_migration_source.mjs";
import { createCandidateMigrationReceipt } from "../../../dist/src/runtime/restore.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeKnexFixture(root);
});
const fixture = async () => {
  const f = await knexFixture();
  roots.push(f.root);
  const loaded = {
    projectRoot: f.root,
    config: { postgresql: { migrationTool: f.tool } },
    paths: {
      migrationDirectory: f.directory,
      artifactDirectory: join(f.root, ".rehearsal"),
    },
  };
  const ledger = [
    {
      id: 1,
      name: "001_initial.cjs",
      batch: 1,
      migration_time: "2026-10-26T12:00:00Z",
    },
    {
      id: 3,
      name: "002_index.cjs",
      batch: 2,
      migration_time: "2026-10-26T12:00:01Z",
    },
  ];
  return { ...f, loaded, ledger };
};
const build = (f, extra = {}) =>
  createKnexBaseline({
    loaded: f.loaded,
    records: (async function* () {
      yield { table: "widgets", row: { id: 1 } };
    })(),
    ledger: f.ledger,
    policyBytes: Buffer.from("{}"),
    cutoff: { kind: "knex", name: "002_index.cjs" },
    expectedTables: ["widgets"],
    assets: [],
    ...extra,
  });
it("creates format5 with byte-exact code/support, native ledger ID gaps and explicit unavailable historical checksums", async () => {
  const f = await fixture();
  await build(f);
  const b = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  expect(b.formatVersion).toBe(5);
  await assertNativeBaselineManifestUnchanged({
    artifactRoot: f.loaded.paths.artifactDirectory,
    expected: b,
  });
  expect(b.knexHistory.sourceLedger.map((r) => r.id)).toEqual([1, 3]);
  expect(b.knexHistory.historicalFileChecksums).toBe("unavailable");
  expect(b.nativeMigrations.historicalFileChecksums).toBe("unavailable");
  expect(Object.keys(b.migrations)).toEqual([
    "001_initial.cjs",
    "002_index.cjs",
  ]);
  expect(b.knexHistory.files).toHaveLength(3);
  const source = await readFile(join(f.directory, "support/helper.cjs"));
  expect(
    await readFile(
      join(
        f.loaded.paths.artifactDirectory,
        "generations",
        b.generationId,
        "migrations/support/helper.cjs",
      ),
    ),
  ).toEqual(source);
});
it("refuses pending source history before reading records or creating artifacts", async () => {
  const f = await fixture();
  let read = false;
  await expect(
    build(f, {
      ledger: f.ledger.slice(0, 1),
      records: (async function* () {
        read = true;
        yield { table: "widgets", row: { id: 1 } };
      })(),
    }),
  ).rejects.toThrow(/complete source history/);
  expect(read).toBe(false);
  await expect(access(f.loaded.paths.artifactDirectory)).rejects.toThrow();
});
it("accepts append with exact native prefix but refuses modified historical support bytes", async () => {
  const f = await fixture();
  await build(f);
  const b = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  await writeFile(
    join(f.directory, "003_pending.cjs"),
    "exports.up=async()=>{};exports.down=async()=>{};",
  );
  const current = await readConfiguredMigrationSource(f.loaded);
  expect(
    createCandidateMigrationReceipt({
      baselineManifest: b,
      currentFiles: current.entries,
      nativeMigrations: current.binding,
    }).candidates.map((e) => e.nativeIdentity),
  ).toEqual([{ kind: "knex", name: "003_pending.cjs" }]);
  await writeFile(join(f.directory, "support/helper.cjs"), "modified");
  const changed = await readConfiguredMigrationSource(f.loaded);
  expect(() =>
    createCandidateMigrationReceipt({
      baselineManifest: b,
      currentFiles: changed.entries,
      nativeMigrations: changed.binding,
    }),
  ).toThrow(/support code changed/);
});
it("refuses changed immutable support bytes during active artifact verification", async () => {
  const f = await fixture();
  await build(f);
  const b = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  const file = join(
    f.loaded.paths.artifactDirectory,
    "generations",
    b.generationId,
    "migrations/support/helper.cjs",
  );
  await chmod(file, 0o600);
  await writeFile(file, "changed");
  await expect(
    verifyActiveBaseline({ artifactRoot: f.loaded.paths.artifactDirectory }),
  ).rejects.toThrow(/code bundle changed/);
});
