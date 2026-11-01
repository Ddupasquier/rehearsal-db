import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const rawReadBoundary = vi.hoisted(() => ({ denyNativeSql: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    readFile: (...args) => {
      if (
        rawReadBoundary.denyNativeSql &&
        String(args[0]).endsWith("/migration.sql")
      )
        throw new Error("Unbounded native SQL read refused by test boundary.");
      return actual.readFile(...args);
    },
  };
});
import {
  createAndActivateBaseline,
  verifyActiveBaseline,
  inspectBaselineGenerations,
} from "../../../dist/src/baseline/artifact.mjs";
import { createCandidateMigrationReceipt } from "../../../dist/src/runtime/recovery/restore.mjs";

const roots = [];
async function writable(path) {
  await chmod(path, 0o700).catch(() => {});
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await writable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
}
afterEach(async () => {
  rawReadBoundary.denyNativeSql = false;
  for (const path of roots.splice(0)) {
    await writable(path);
    await rm(path, { recursive: true, force: true });
  }
});
it("verifies native SQL using the bounded inventory without reopening it through readFile", async () => {
  const f = await fixture();
  rawReadBoundary.denyNativeSql = true;
  try {
    expect(await verifyActiveBaseline(f)).toEqual(f.manifest);
  } finally {
    rawReadBoundary.denyNativeSql = false;
  }
});
const hash = (x) => createHash("sha256").update(x).digest("hex");
const lock = Buffer.from('# Native history\r\nprovider = "postgresql"\r\n');
const sql = "create table widgets(id integer primary key);\r\n";
const entry = {
  version: "20261026000000",
  name: "init",
  filename: "20261026000000_init/migration.sql",
  fileSha256: hash(sql),
};
const binding = {
  schemaVersion: 1,
  kind: "prisma",
  version: "7.10.1",
  provider: "postgresql",
  lockSha256: hash(lock),
  toolchainSha256: "c".repeat(64),
};
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "prisma-baseline-"));
  roots.push(root);
  const artifactRoot = join(root, ".rehearsal");
  const manifest = await createAndActivateBaseline({
    artifactRoot,
    expectedTables: ["widgets"],
    records: [{ table: "widgets", row: { id: 1 } }],
    metadata: {
      migrationCutoff: entry.version,
      migrationHistorySha256: "a".repeat(64),
      sanitizationPolicySha256: "b".repeat(64),
      nativeMigrations: binding,
    },
    migrationFiles: [{ ...entry, content: sql }],
    migrationLock: lock,
    ...overrides,
  });
  return {
    artifactRoot,
    manifest,
    migrations: join(
      artifactRoot,
      "generations",
      manifest.generationId,
      "migrations",
    ),
  };
}
it("stores and verifies native paths, lock and exact raw bytes as a format3 immutable baseline", async () => {
  const f = await fixture();
  expect(f.manifest.formatVersion).toBe(3);
  expect(Object.keys(f.manifest.migrations)).toEqual([entry.filename]);
  expect(await readFile(join(f.migrations, entry.filename))).toEqual(
    Buffer.from(sql),
  );
  expect(await readFile(join(f.migrations, "migration_lock.toml"))).toEqual(
    lock,
  );
  expect(await verifyActiveBaseline(f)).toEqual(f.manifest);
  expect((await inspectBaselineGenerations(f))[0].formatVersion).toBe(3);
  expect((await inspectBaselineGenerations(f))[0].nativeMigrations).toEqual(
    binding,
  );
});
it.each(["missing-binding", "null-binding", "legacy-format"])(
  "refuses inconsistent native generation summaries: %s",
  async (kind) => {
    const f = await fixture();
    const manifestPath = join(f.migrations, "..", "baseline-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (kind === "missing-binding") delete manifest.nativeMigrations;
    else if (kind === "null-binding") manifest.nativeMigrations = null;
    else manifest.formatVersion = 2;
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(inspectBaselineGenerations(f)).rejects.toThrow();
    await expect(verifyActiveBaseline(f)).rejects.toThrow();
  },
);
it.each(["migration", "lock"])(
  "refuses changed native %s bytes",
  async (kind) => {
    const f = await fixture();
    const path = join(
      f.migrations,
      kind === "lock" ? "migration_lock.toml" : entry.filename,
    );
    await chmod(path, 0o600);
    await writeFile(path, "changed\n");
    await expect(verifyActiveBaseline(f)).rejects.toThrow();
  },
);
it("refuses missing or wrong-provider native lock before activating a baseline", async () => {
  await expect(fixture({ migrationLock: undefined })).rejects.toThrow(/lock/u);
  const wrong = Buffer.from('provider = "mysql"\n');
  await expect(
    fixture({
      migrationLock: wrong,
      metadata: {
        migrationCutoff: entry.version,
        migrationHistorySha256: "a".repeat(64),
        sanitizationPolicySha256: "b".repeat(64),
        nativeMigrations: { ...binding, lockSha256: hash(wrong) },
      },
    }),
  ).rejects.toThrow();
});
it("binds candidate confirmation to native toolchain, lock and the exact ordered suffix", async () => {
  const { manifest } = await fixture();
  const candidate = {
    version: "20261027000000",
    name: "add_name",
    filename: "20261027000000_add_name/migration.sql",
    fileSha256: "d".repeat(64),
  };
  const plan = (nativeMigrations, currentFiles = [entry, candidate]) =>
    createCandidateMigrationReceipt({
      baselineManifest: manifest,
      currentFiles,
      nativeMigrations,
    });
  const original = plan(binding);
  expect(original.candidates).toEqual([candidate]);
  expect(
    plan(binding, [entry, { ...candidate, fileSha256: "e".repeat(64) }])
      .candidateSha256,
  ).not.toBe(original.candidateSha256);
  expect(
    plan({ ...binding, toolchainSha256: "d".repeat(64) }).candidateSha256,
  ).not.toBe(original.candidateSha256);
  for (const change of [
    { lockSha256: "d".repeat(64) },
    { version: "7.10.2" },
    { provider: "mysql" },
  ])
    expect(() => plan({ ...binding, ...change })).toThrow();
  expect(() => plan(null)).toThrow();
  expect(() =>
    plan(binding, [{ ...entry, fileSha256: "d".repeat(64) }, candidate]),
  ).toThrow(/diverges/u);
});
