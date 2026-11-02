import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  DRIZZLE_HISTORY_LIMITS,
  parseDrizzleJournal,
  readDrizzleMigrationInventory,
  normalizeDrizzleMigrationLedger,
  verifyDrizzleMigrationLedger,
} from "../../../../dist/src/runtime/migrations/drizzle_history.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (idx) => ({
  idx,
  version: "7",
  when: 1700000000000 + idx,
  tag: idx === 0 ? "z_first" : "a_second",
  breakpoints: idx === 0,
});
const original = () => ({
  version: "7",
  dialect: "postgresql",
  entries: [record(0), record(1)],
});
async function fixture(journal = original()) {
  const root = await mkdtemp(join(tmpdir(), "drizzle-history-"));
  roots.push(root);
  await mkdir(join(root, "meta"));
  const journalBytes = Buffer.from(JSON.stringify(journal));
  await writeFile(join(root, "meta/_journal.json"), journalBytes);
  for (const entry of journal.entries)
    await writeFile(
      join(root, entry.tag + ".sql"),
      Buffer.from(
        "\ufeff-- exact CRLF\r\nselect 1;\r\n--> statement-breakpoint\r\nselect 2;\r\n",
      ),
    );
  return { root, url: pathToFileURL(root + "/"), journalBytes };
}
const rows = (entries) =>
  entries.map((entry, index) => ({
    id: index * 2 + 1,
    hash: entry.hash,
    created_at: String(entry.when),
  }));
it("preserves authoritative journal array order/native timestamps and raw UTF8 hashes including BOM/CRLF", async () => {
  const f = await fixture(),
    observed = [];
  const result = await readDrizzleMigrationInventory(f.url, {
    onBytes: (name, bytes) => observed.push([name, bytes]),
  });
  expect(result.entries.map((entry) => entry.tag)).toEqual([
    "z_first",
    "a_second",
  ]);
  for (let idx = 0; idx < result.entries.length; idx++) {
    const entry = result.entries[idx],
      bytes = await readFile(join(f.root, entry.filename));
    expect(entry).toEqual({
      ...record(idx),
      filename: record(idx).tag + ".sql",
      hash: sha(bytes),
    });
    expect(entry).not.toHaveProperty("version14");
  }
  expect(result.binding).toEqual({
    schemaVersion: 1,
    kind: "drizzle",
    kitVersion: "0.31.11",
    ormVersion: "0.45.4",
    journalVersion: "7",
    dialect: "postgresql",
    journalSha256: sha(f.journalBytes),
    ledger: { schema: "drizzle", table: "__drizzle_migrations" },
  });
  expect(observed.map(([name]) => name)).toEqual([
    "meta/_journal.json",
    "z_first.sql",
    "a_second.sql",
  ]);
});
it("metadata-checks optional generator snapshots without consuming or hashing their contents", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "meta/0000_snapshot.json"),
    Buffer.from([255, 0, 2]),
  );
  const first = await readDrizzleMigrationInventory(f.url),
    seen = [];
  await writeFile(
    join(f.root, "meta/0000_snapshot.json"),
    "different generator-only bytes",
  );
  expect(
    await readDrizzleMigrationInventory(f.url, {
      onBytes: (name) => seen.push(name),
    }),
  ).toEqual(first);
  expect(seen).not.toContain("meta/0000_snapshot.json");
});
it.each([
  "duplicate-index",
  "gap-index",
  "unordered-index",
  "duplicate-time",
  "unordered-time",
  "zero-time",
  "unsafe-time",
  "string-time",
  "duplicate-tag",
  "bad-version",
  "wrong-dialect",
  "unknown-key",
  "missing-breakpoints",
  "invalid-breakpoints",
  "empty",
  "sparse",
])("rejects malformed journal %s", (kind) => {
  const journal = original();
  if (kind === "duplicate-index") journal.entries[1].idx = 0;
  if (kind === "gap-index") journal.entries[1].idx = 2;
  if (kind === "unordered-index") journal.entries.reverse();
  if (kind === "duplicate-time")
    journal.entries[1].when = journal.entries[0].when;
  if (kind === "unordered-time") journal.entries[1].when = 1;
  if (kind === "zero-time") journal.entries[0].when = 0;
  if (kind === "unsafe-time")
    journal.entries[1].when = Number.MAX_SAFE_INTEGER + 1;
  if (kind === "string-time") journal.entries[1].when = "1700000000001";
  if (kind === "duplicate-tag") journal.entries[1].tag = journal.entries[0].tag;
  if (kind === "bad-version") journal.version = "8";
  if (kind === "wrong-dialect") journal.dialect = "sqlite";
  if (kind === "unknown-key") journal.sql = "private-cannot-run";
  if (kind === "missing-breakpoints") delete journal.entries[1].breakpoints;
  if (kind === "invalid-breakpoints") journal.entries[1].breakpoints = "true";
  if (kind === "empty") journal.entries = [];
  if (kind === "sparse") journal.entries = new Array(2);
  expect(() => parseDrizzleJournal(journal)).toThrow(
    /no code or SQL was executed/,
  );
});
it.each([
  "../escape",
  "/absolute",
  "nested/file",
  "back\\slash",
  "percent%2fescape",
  "dot.name",
  " space",
  "unicode-é",
  "control\n",
  "nul\0",
])("rejects a non-confining journal tag %j", (tag) => {
  const journal = original();
  journal.entries[0].tag = tag;
  expect(() => parseDrizzleJournal(journal)).toThrow();
});
it("bounds native journal and ledger entries before inspecting them", () => {
  expect(() =>
    parseDrizzleJournal({
      ...original(),
      entries: new Array(DRIZZLE_HISTORY_LIMITS.maximumMigrations + 1),
    }),
  ).toThrow();
  expect(() =>
    normalizeDrizzleMigrationLedger(
      new Array(DRIZZLE_HISTORY_LIMITS.maximumMigrations + 1),
    ),
  ).toThrow();
});
it.each([
  "missing-sql",
  "extra-sql",
  "extra-root",
  "extra-meta",
  "extra-snapshot",
  "symlink-sql",
  "symlink-journal",
  "symlink-meta",
  "symlink-snapshot",
  "symlink-root",
  "directory-sql",
  "malformed-sql-utf8",
  "malformed-journal-utf8",
  "malformed-json",
])("refuses unsafe inventory %s", async (kind) => {
  const f = await fixture();
  let url = f.url;
  if (kind === "missing-sql") await rm(join(f.root, "z_first.sql"));
  if (kind === "extra-sql")
    await writeFile(join(f.root, "extra.sql"), "select 9;");
  if (kind === "extra-root")
    await writeFile(
      join(f.root, "drizzle.config.ts"),
      "throw Error('must not execute');",
    );
  if (kind === "extra-meta")
    await writeFile(join(f.root, "meta/unknown.json"), "{}");
  if (kind === "extra-snapshot")
    await writeFile(join(f.root, "meta/9999_snapshot.json"), "{}");
  if (kind === "symlink-sql") {
    await rm(join(f.root, "z_first.sql"));
    await symlink(join(f.root, "a_second.sql"), join(f.root, "z_first.sql"));
  }
  if (kind === "symlink-journal") {
    await rename(
      join(f.root, "meta/_journal.json"),
      join(f.root, "meta/0000_snapshot.json"),
    );
    await symlink(
      join(f.root, "meta/0000_snapshot.json"),
      join(f.root, "meta/_journal.json"),
    );
  }
  if (kind === "symlink-meta") {
    const target = f.root + "-meta";
    roots.push(target);
    await rename(join(f.root, "meta"), target);
    await symlink(target, join(f.root, "meta"));
  }
  if (kind === "symlink-snapshot")
    await symlink(
      join(f.root, "z_first.sql"),
      join(f.root, "meta/0000_snapshot.json"),
    );
  if (kind === "symlink-root") {
    const alias = f.root + "-alias";
    roots.push(alias);
    await symlink(f.root, alias);
    url = pathToFileURL(alias + "/");
  }
  if (kind === "directory-sql") {
    await rm(join(f.root, "z_first.sql"));
    await mkdir(join(f.root, "z_first.sql"));
  }
  if (kind === "malformed-sql-utf8")
    await writeFile(join(f.root, "z_first.sql"), Buffer.from([255, 254]));
  if (kind === "malformed-journal-utf8")
    await writeFile(join(f.root, "meta/_journal.json"), Buffer.from([255]));
  if (kind === "malformed-json")
    await writeFile(
      join(f.root, "meta/_journal.json"),
      '{"PRIVATE_JOURNAL_CANARY": malformed}',
    );
  const error = await readDrizzleMigrationInventory(url).catch(
    (error) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("no code or SQL was executed");
  expect(error.message).not.toContain("PRIVATE_JOURNAL_CANARY");
});
it("refuses files above the per-file byte limit before allocating their sparse bytes", async () => {
  const f = await fixture();
  await truncate(
    join(f.root, "z_first.sql"),
    DRIZZLE_HISTORY_LIMITS.maximumFileBytes + 1,
  );
  await expect(readDrizzleMigrationInventory(f.url)).rejects.toThrow();
});
it("bounds aggregate sizes including ignored regular snapshots without reading their contents", async () => {
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: Array.from({ length: 9 }, (_, idx) => ({
      ...record(idx),
      tag: `entry_${idx}`,
    })),
  };
  const f = await fixture(journal);
  for (let idx = 0; idx < 9; idx++) {
    const path = join(
      f.root,
      "meta",
      String(idx).padStart(4, "0") + "_snapshot.json",
    );
    await writeFile(path, "");
    await truncate(path, DRIZZLE_HISTORY_LIMITS.maximumFileBytes);
  }
  await expect(readDrizzleMigrationInventory(f.url)).rejects.toThrow();
});
it("refuses mutation of an earlier SQL file before returning the final inventory", async () => {
  const f = await fixture();
  await expect(
    readDrizzleMigrationInventory(f.url, {
      onBytes: (name) => {
        if (name === "a_second.sql") {
          /* fixed synchronous mutation simulates a competing local writer */ requireMutation(
            join(f.root, "z_first.sql"),
          );
        }
      },
    }),
  ).rejects.toThrow();
});
it("accepts exact successful ledger prefixes with native timestamp identity and legitimate serial-ID gaps", async () => {
  const f = await fixture(),
    { entries } = await readDrizzleMigrationInventory(f.url),
    ledger = rows(entries);
  expect(verifyDrizzleMigrationLedger({ rows: ledger, entries })).toEqual(
    ledger.map((row) => ({ ...row, created_at: Number(row.created_at) })),
  );
  expect(
    verifyDrizzleMigrationLedger({ rows: ledger.slice(0, 1), entries }),
  ).toHaveLength(1);
  expect(entries.map((entry) => entry.when)).toEqual([
    1700000000000, 1700000000001,
  ]);
});
it.each([
  "missing",
  "duplicate-id",
  "unordered-id",
  "duplicate-time",
  "bad-time",
  "null-time",
  "unsafe-time",
  "bad-hash",
  "divergent-time",
  "missing-first",
  "reversed",
  "extra-row",
  "extra-field",
  "missing-field",
  "noncanonical-number",
  "id-out-of-range",
  "sparse",
])("refuses incomplete or divergent ledger %s", async (kind) => {
  const f = await fixture(),
    { entries } = await readDrizzleMigrationInventory(f.url);
  let ledger = rows(entries);
  if (kind === "missing") ledger = [];
  if (kind === "duplicate-id") ledger[1].id = ledger[0].id;
  if (kind === "unordered-id") ledger[1].id = 1;
  if (kind === "duplicate-time") ledger[1].created_at = ledger[0].created_at;
  if (kind === "bad-time") ledger[0].created_at = "not-a-time";
  if (kind === "null-time") ledger[0].created_at = null;
  if (kind === "unsafe-time") ledger[0].created_at = "9007199254740992";
  if (kind === "bad-hash") ledger[0].hash = "f".repeat(64);
  if (kind === "divergent-time") ledger[0].created_at = "1699999999999";
  if (kind === "missing-first") ledger = ledger.slice(1);
  if (kind === "reversed") ledger.reverse();
  if (kind === "extra-row")
    ledger.push({ id: 9, hash: "f".repeat(64), created_at: "1700000000002" });
  if (kind === "extra-field") ledger[0].sql = "private";
  if (kind === "missing-field") delete ledger[0].hash;
  if (kind === "noncanonical-number") ledger[0].created_at = "01700000000000";
  if (kind === "id-out-of-range") ledger[0].id = 2147483648;
  if (kind === "sparse") ledger = new Array(2);
  expect(() =>
    verifyDrizzleMigrationLedger({ rows: ledger, entries }),
  ).toThrow();
});

it("refuses oversized externally supplied inventories before observing their entries", () => {
  let touched = false;
  const entries = new Proxy([], {
    get(target, key, receiver) {
      if (key === "length") return DRIZZLE_HISTORY_LIMITS.maximumMigrations + 1;
      touched = true;
      throw new Error("PRIVATE_ENTRY_GETTER_POISON");
    },
  });
  const error = (() => {
    try {
      verifyDrizzleMigrationLedger({ rows: [], entries });
    } catch (error) {
      return error;
    }
  })();
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain("PRIVATE_ENTRY_GETTER_POISON");
  expect(touched).toBe(false);
});
