import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  readKnexMigrationInventory,
  verifyKnexMigrationLedger,
  normalizeKnexMigrationLedger,
  parseKnexMigrationIdentity,
  parseKnexCodeFiles,
} from "../../../dist/src/runtime/knex_history.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "knex-history-"));
  roots.push(root);
  await writeFile(
    join(root, "002_second.cjs"),
    "exports.up=()=>{};exports.down=()=>{};\r\n",
  );
  await writeFile(
    join(root, "001_first.cjs"),
    "\ufeffexports.up=()=>{};exports.down=()=>{};\r\n",
  );
  await mkdir(join(root, "support"));
  await writeFile(
    join(root, "support", "helper.cjs"),
    "throw Error('MUST_NOT_EXECUTE')",
  );
  return { root, url: pathToFileURL(root + "/") };
};
const rows = (entries) =>
  entries.map((e, i) => ({
    id: i * 2 + 1,
    name: e.filename,
    batch: i + 1,
    migration_time: "2026-10-26T12:00:00.000Z",
  }));
it("preserves native filename order, raw code and support bytes without executing modules", async () => {
  const f = await fixture(),
    bytes = new Map();
  const a = await readKnexMigrationInventory(f.url, {
    onBytes: (n, b) => bytes.set(n, b),
  });
  expect(a.entries.map((x) => x.nativeIdentity)).toEqual([
    { kind: "knex", name: "001_first.cjs" },
    { kind: "knex", name: "002_second.cjs" },
  ]);
  expect(a.entries[0].fileSha256).toBe(
    createHash("sha256").update(bytes.get("001_first.cjs")).digest("hex"),
  );
  expect(a.historicalFileChecksums).toBe("unavailable");
  expect(
    verifyKnexMigrationLedger({
      rows: rows(a.entries),
      entries: a.entries,
    }).map((r) => r.id),
  ).toEqual([1, 3]);
  expect(
    verifyKnexMigrationLedger({
      rows: rows(a.entries).slice(0, 1),
      entries: a.entries,
    }),
  ).toHaveLength(1);
  expect(await readKnexMigrationInventory(f.url)).toEqual(a);
  await writeFile(join(f.root, "support/helper.cjs"), "changed");
  expect((await readKnexMigrationInventory(f.url)).bundleSha256).not.toBe(
    a.bundleSha256,
  );
});
it.each([".env", "notes", "knexfile.cjs.txt", "package.json", "node_modules"])(
  "refuses unreviewed root entry %s",
  async (name) => {
    const f = await fixture();
    await writeFile(join(f.root, name), "PRIVATE");
    await expect(readKnexMigrationInventory(f.url)).rejects.toThrow(
      /no code was executed/,
    );
  },
);
it("refuses symlink support inputs and invalid UTF8 migration bytes", async () => {
  const f = await fixture();
  await symlink(
    join(f.root, "001_first.cjs"),
    join(f.root, "support/alias.cjs"),
  );
  await expect(readKnexMigrationInventory(f.url)).rejects.toThrow();
  await rm(join(f.root, "support/alias.cjs"));
  await writeFile(join(f.root, "001_first.cjs"), Buffer.from([255]));
  await expect(readKnexMigrationInventory(f.url)).rejects.toThrow();
});
it("rejects native ledger duplicates, reordered names and invalid batches without historical hash inference", async () => {
  const f = await fixture(),
    a = await readKnexMigrationInventory(f.url),
    r = rows(a.entries);
  for (const bad of [
    [r[1], r[0]],
    [r[0], { ...r[1], id: 1 }],
    [r[0], { ...r[1], name: r[0].name }],
    [r[0], { ...r[1], batch: 0 }],
    [{ ...r[0], checksum: "fabricated" }],
  ])
    expect(() =>
      verifyKnexMigrationLedger({ rows: bad, entries: a.entries }),
    ).toThrow();
  expect(() =>
    normalizeKnexMigrationLedger([{ ...r[0], migration_time: "private bad" }]),
  ).toThrow();
});
it("rejects oversized unknown entry arrays before reading indices", () => {
  const entries = new Proxy(new Array(10001), {
    get(t, k, r) {
      if (k === "0") throw Error("UNBOUNDED_INDEX");
      return Reflect.get(t, k, r);
    },
  });
  expect(() => verifyKnexMigrationLedger({ rows: [], entries })).toThrow(
    /historical/,
  );
  expect(() => parseKnexCodeFiles(new Array(16001))).toThrow();
});
it.each([
  { kind: "knex", name: "../x.cjs" },
  { kind: "knex", name: "x.js" },
  { kind: "knex", name: "x.cjs", version: "invented" },
])("refuses fabricated/escaping identity %#", (x) =>
  expect(() => parseKnexMigrationIdentity(x)).toThrow(),
);

it("accepts fresh native batch/id/timestamp provenance only while exact ordered filenames remain unchanged", async () => {
  const f = await fixture(),
    inventory = await readKnexMigrationInventory(f.url),
    source = rows(inventory.entries);
  const fresh = source.map((row, i) => ({
    ...row,
    id: i + 1,
    batch: 1,
    migration_time: "2026-10-30T12:00:00.000Z",
  }));
  expect(source.map((row) => [row.id, row.batch])).toEqual([
    [1, 1],
    [3, 2],
  ]);
  expect(
    verifyKnexMigrationLedger({ rows: fresh, entries: inventory.entries }),
  ).toEqual(fresh);
  expect(() =>
    verifyKnexMigrationLedger({
      rows: [fresh[1], fresh[0]],
      entries: inventory.entries,
    }),
  ).toThrow();
  expect(() =>
    verifyKnexMigrationLedger({
      rows: [{ ...fresh[0], name: "001_changed.cjs" }],
      entries: inventory.entries,
    }),
  ).toThrow();
});
