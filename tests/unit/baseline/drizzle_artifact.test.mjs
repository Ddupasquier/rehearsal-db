import { verifyDrizzleBaselineHistory } from "../../../dist/src/runtime/migrations/drizzle_baseline_contract.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  drizzleFixture,
  removeDrizzleFixture,
} from "../../helpers/drizzle_fixture.mjs";
import { readDrizzleMigrationInventory } from "../../../dist/src/runtime/migrations/drizzle_history.mjs";
import { drizzleMigrationFiles } from "../../../dist/src/runtime/migrations/migration_identity.mjs";
import { createDrizzleBaseline } from "../../../dist/src/baseline/drizzle_builder.mjs";
import {
  verifyActiveBaseline,
  inspectBaselineGenerations,
} from "../../../dist/src/baseline/artifact.mjs";
import { createCandidateMigrationReceipt } from "../../../dist/src/runtime/recovery/restore.mjs";
const rawRead = vi.hoisted(() => ({ directory: null, attempts: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    readFile: async (...args) => {
      if (rawRead.directory && String(args[0]).startsWith(rawRead.directory)) {
        rawRead.attempts++;
        throw new Error("Unbounded native migration re-read denied.");
      }
      return actual.readFile(...args);
    },
  };
});
const roots = [];
afterEach(async () => {
  rawRead.directory = null;
  rawRead.attempts = 0;
  for (const root of roots.splice(0)) await removeDrizzleFixture(root);
});
const hash = (x) => createHash("sha256").update(x).digest("hex");
async function fixture(pending = false) {
  const f = await drizzleFixture();
  roots.push(f.root);
  const inventory = await readDrizzleMigrationInventory(
    pathToFileURL(`${f.directory}/`),
  );
  const ledger = inventory.entries.slice(0, pending ? 1 : 2).map((e, i) => ({
    id: i ? 3 : 1,
    hash: e.hash,
    created_at: String(e.when),
  }));
  const last = inventory.entries.at(-1);
  const cutoff = {
    kind: "drizzle",
    idx: last.idx,
    when: last.when,
    tag: last.tag,
  };
  const loaded = {
    projectRoot: f.root,
    config: { postgresql: { migrationTool: f.tool } },
    paths: {
      migrationDirectory: f.directory,
      artifactDirectory: join(f.root, ".rehearsal"),
    },
  };
  return { ...f, inventory, ledger, cutoff, loaded };
}
async function build(f, extra = {}) {
  return createDrizzleBaseline({
    loaded: f.loaded,
    records: (async function* () {
      yield { table: "widgets", row: { id: 1 } };
    })(),
    ledger: f.ledger,
    policyBytes: Buffer.from("{}"),
    cutoff: f.cutoff,
    expectedTables: ["widgets"],
    assets: [],
    ...extra,
  });
}
it("preserves byte-exact journal and journal order, native cutoff and provenance IDs", async () => {
  const f = await fixture();
  await build(f);
  const manifest = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  expect(manifest.formatVersion).toBe(4);
  expect(manifest.migrationCutoff).toEqual(f.cutoff);
  expect(manifest.drizzleHistory.entries.map((e) => e.filename)).toEqual([
    "z_initial.sql",
    "a_index.sql",
  ]);
  expect(manifest.drizzleHistory.sourceLedger.map((e) => e.id)).toEqual([1, 3]);
  const journal = await readFile(
    join(
      f.loaded.paths.artifactDirectory,
      "generations",
      manifest.generationId,
      "migrations/meta/_journal.json",
    ),
  );
  expect(journal.equals(f.journal)).toBe(true);
  expect(manifest.drizzleHistory.journal).toEqual({
    path: "meta/_journal.json",
    sha256: hash(f.journal),
    bytes: f.journal.length,
  });
  expect(
    (
      await inspectBaselineGenerations({
        artifactRoot: f.loaded.paths.artifactDirectory,
      })
    )[0].formatVersion,
  ).toBe(4);
});
it("refuses a pending journal before consuming a record or writing a generation", async () => {
  const f = await fixture(true);
  let consumed = false;
  await expect(
    build(f, {
      records: (async function* () {
        consumed = true;
        yield {};
      })(),
    }),
  ).rejects.toThrow(/complete native journal/);
  expect(consumed).toBe(false);
  await expect(
    readFile(join(f.loaded.paths.artifactDirectory, "active")),
  ).rejects.toThrow();
});
it("allows semantic append/formatting while full current journal binds fresh consent", async () => {
  const f = await fixture();
  await build(f);
  const manifest = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  const initial = { ...manifest.nativeMigrations };
  const appended = {
    idx: 2,
    version: "7",
    when: 1720000002000,
    tag: "m_last",
    breakpoints: false,
    filename: "m_last.sql",
    hash: hash("select 2;"),
  };
  const entries = drizzleMigrationFiles([...f.inventory.entries, appended]);
  const a = createCandidateMigrationReceipt({
    baselineManifest: manifest,
    currentFiles: entries,
    nativeMigrations: { ...initial, journalSha256: "a".repeat(64) },
  });
  expect(a.candidates).toHaveLength(1);
  const b = createCandidateMigrationReceipt({
    baselineManifest: manifest,
    currentFiles: entries,
    nativeMigrations: { ...initial, journalSha256: "b".repeat(64) },
  });
  expect(b.candidateSha256).not.toBe(a.candidateSha256);
  for (const field of ["idx", "when", "tag"]) {
    const changed = structuredClone(entries);
    changed[0].nativeIdentity[field] = field === "tag" ? "different" : 99;
    expect(() =>
      createCandidateMigrationReceipt({
        baselineManifest: manifest,
        currentFiles: changed,
        nativeMigrations: initial,
      }),
    ).toThrow(/prefix/);
  }
  const changed = structuredClone(entries);
  changed[0].breakpoints = false;
  expect(() =>
    createCandidateMigrationReceipt({
      baselineManifest: manifest,
      currentFiles: changed,
      nativeMigrations: initial,
    }),
  ).toThrow(/prefix/);
});

it("refuses native manifest provenance drift while leaving baseline data bytes intact", async () => {
  const f = await fixture();
  await build(f);
  const manifest = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  const generation = join(
      f.loaded.paths.artifactDirectory,
      "generations",
      manifest.generationId,
    ),
    file = join(generation, "baseline-manifest.json"),
    data = await readFile(join(generation, "sanitized-data.ndjson"));
  for (const mutate of [
    (value) => {
      value.drizzleHistory.sourceLedger[1].id = 4;
    },
    (value) => {
      value.drizzleHistory.entries[0].breakpoints = false;
    },
    (value) => {
      value.drizzleHistory.journal.bytes++;
    },
    (value) => {
      value.migrationCutoff.when++;
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify(changed));
    await expect(
      verifyActiveBaseline({ artifactRoot: f.loaded.paths.artifactDirectory }),
    ).rejects.toThrow();
    expect(await readFile(join(generation, "sanitized-data.ndjson"))).toEqual(
      data,
    );
  }
});

it("rejects a BOM or malformed raw journal even when its receipt is self-consistent", async () => {
  const f = await fixture();
  await build(f);
  const manifest = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  for (const journal of [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), f.journal]),
    Buffer.from("PRIVATE_JOURNAL_CANARY"),
  ]) {
    const binding = {
        ...manifest.nativeMigrations,
        journalSha256: hash(journal),
      },
      history = {
        ...manifest.drizzleHistory,
        journal: {
          path: "meta/_journal.json",
          sha256: hash(journal),
          bytes: journal.length,
        },
      },
      historySha256 = hash(
        JSON.stringify({
          binding,
          history: manifest.drizzleHistory.sourceLedger,
        }),
      );
    let error;
    try {
      verifyDrizzleBaselineHistory({
        binding,
        history,
        historySha256,
        cutoff: f.cutoff,
        migrations: manifest.migrations,
        journal,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("PRIVATE_JOURNAL_CANARY");
  }
});

it("verifies native bytes through bounded inventory without raw journal or SQL re-reads", async () => {
  const f = await fixture();
  await build(f);
  const manifest = await verifyActiveBaseline({
    artifactRoot: f.loaded.paths.artifactDirectory,
  });
  rawRead.directory =
    join(
      f.loaded.paths.artifactDirectory,
      "generations",
      manifest.generationId,
      "migrations",
    ) + "/";
  await expect(
    verifyActiveBaseline({ artifactRoot: f.loaded.paths.artifactDirectory }),
  ).resolves.toMatchObject({
    generationId: manifest.generationId,
    formatVersion: 4,
  });
  expect(rawRead.attempts).toBe(0);
});
