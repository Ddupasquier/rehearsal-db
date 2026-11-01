import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresqlMigrationRuntime } from "../../../dist/src/targets/postgresql_migrations.mjs";
import { readPrismaMigrationInventory } from "../../../dist/src/runtime/migrations/prisma_history.mjs";
import { assertCandidateConfirmation } from "../../../dist/src/runtime/lifecycle/lifecycle_engine.mjs";
import { createCandidateMigrationReceipt } from "../../../dist/src/runtime/recovery/restore.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(native = true) {
  const root = await mkdtemp(join(tmpdir(), "native-history-validation-"));
  roots.push(root);
  const directory = join(root, "migrations"),
    filename = "20260101000000_init/migration.sql",
    sql = "select 1;\n";
  await mkdir(join(directory, "20260101000000_init"), { recursive: true });
  await writeFile(join(directory, filename), sql);
  await writeFile(
    join(directory, "migration_lock.toml"),
    'provider = "postgresql"\n',
  );
  const inventory = await readPrismaMigrationInventory(
    pathToFileURL(directory + "/"),
  );
  const baseline = {
    formatVersion: 3,
    nativeMigrations: { ...inventory.binding, toolchainSha256: "a".repeat(64) },
    migrations: {
      [filename]: { sha256: createHash("sha256").update(sql).digest("hex") },
    },
  };
  const runSql = vi.fn(() => {
    throw Error("History validation must not contact a database");
  });
  const runtime = createPostgresqlMigrationRuntime({
    loaded: {
      projectRoot: root,
      config: {
        postgresql: native
          ? {
              migrationTool: {
                kind: "prisma",
                version: "7.10.1",
                packageDirectory: "node_modules/prisma",
              },
            }
          : {},
      },
      paths: { migrationDirectory: directory, runtimeWorkdir: root },
    },
    runSql,
    assertOwnedTarget: () => "b".repeat(64),
    assertExpectedBaseline: async () => {},
    containerName: "unused",
    database: "unused",
    databaseUser: "unused",
  });
  return { root, directory, filename, baseline, runtime, runSql };
}
it("validates fresh portable native history without installed executable dependencies or a candidate digest", async () => {
  const f = await fixture();
  expect(await f.runtime.validateHistory(f.baseline)).toBeUndefined();
  expect(f.runSql).not.toHaveBeenCalled();
  // Execution receipts remain strict: producer metadata cannot stand in for current bytes.
  const { toolchainSha256, ...history } = f.baseline.nativeMigrations;
  expect(() =>
    createCandidateMigrationReceipt({
      baselineManifest: f.baseline,
      currentFiles: [
        {
          version: "20260101000000",
          name: "init",
          filename: f.filename,
          fileSha256: f.baseline.migrations[f.filename].sha256,
        },
      ],
      nativeMigrations: history,
    }),
  ).toThrow();
});
it.each([
  "missing",
  "bytes",
  "lock",
  "provider",
  "baseline-format",
  "baseline-prefix",
  "baseline-tool",
])("refuses %s history before resume", async (mode) => {
  const f = await fixture();
  if (mode === "missing") await unlink(join(f.directory, f.filename));
  if (mode === "bytes")
    await writeFile(join(f.directory, f.filename), "select 2;\n");
  if (mode === "lock")
    await writeFile(
      join(f.directory, "migration_lock.toml"),
      '# changed\nprovider = "postgresql"\n',
    );
  if (mode === "provider")
    await writeFile(
      join(f.directory, "migration_lock.toml"),
      'provider = "mysql"\n',
    );
  if (mode === "baseline-format") f.baseline.formatVersion = 2;
  if (mode === "baseline-prefix")
    f.baseline.migrations[f.filename].sha256 = "c".repeat(64);
  if (mode === "baseline-tool") f.baseline.nativeMigrations.kind = "other";
  await expect(f.runtime.validateHistory(f.baseline)).rejects.toThrow();
  expect(f.runSql).not.toHaveBeenCalled();
});
it("leaves SQL mode history validation unchanged and never loads native tooling", async () => {
  const f = await fixture(false);
  await expect(
    f.runtime.validateHistory({ formatVersion: 2, migrations: {} }),
  ).resolves.toBeUndefined();
  expect(f.runSql).not.toHaveBeenCalled();
});

async function installToolchain(f) {
  const prisma = join(f.root, "node_modules/prisma"),
    engines = join(f.root, "node_modules/@prisma/engines");
  await mkdir(join(prisma, "build"), { recursive: true });
  await mkdir(engines, { recursive: true });
  await writeFile(
    join(prisma, "package.json"),
    JSON.stringify({
      name: "prisma",
      version: "7.10.1",
      bin: { prisma: "build/index.js" },
    }),
  );
  await writeFile(
    join(engines, "package.json"),
    JSON.stringify({ name: "@prisma/engines", version: "7.10.1" }),
  );
  await writeFile(
    join(engines, "schema-engine-test-native"),
    "syntheticengine-not-executed",
  );
  await writeFile(
    join(prisma, "build/index.js"),
    "throw Error('must not execute');\n",
  );
  return prisma;
}
it.each([
  "missing-toolchain",
  "unsupported-toolchain",
  "changed-toolchain-review",
  "stale-confirmation",
])("refuses %s during current native candidate preparation", async (mode) => {
  const f = await fixture();
  let confirmation = "b".repeat(64);
  if (mode !== "missing-toolchain") {
    const prisma = await installToolchain(f);
    const reviewed = await f.runtime.prepareMutation(f.baseline);
    confirmation = reviewed.candidateSha256;
    if (mode === "unsupported-toolchain")
      await writeFile(
        join(prisma, "package.json"),
        JSON.stringify({
          name: "prisma",
          version: "7.10.2",
          bin: { prisma: "build/index.js" },
        }),
      );
    if (mode === "changed-toolchain-review")
      await writeFile(
        join(prisma, "build/index.js"),
        "throw Error('changed bytes neverexecute');\n",
      );
    if (mode === "stale-confirmation") confirmation = "c".repeat(64);
  }
  await expect(
    f.runtime.prepareMutation(f.baseline, (receipt) =>
      assertCandidateConfirmation({ plan: receipt, confirmation }),
    ),
  ).rejects.toThrow();
  expect(f.runSql).not.toHaveBeenCalled();
});

it("retains an exclusive private native failure receipt without replacing prior recovery evidence", async () => {
  const f = await fixture();
  const baseline = { ...f.baseline, generationId: "owned-generation" };
  const receipt = {
    candidateSha256: "c".repeat(64),
    nativeMigrations: f.baseline.nativeMigrations,
  };
  const file = join(f.root, "native-migration-failure.json");
  await f.runtime.retainFailure(baseline, receipt);
  const bytes = await readFile(file, "utf8");
  expect(bytes).toBe(
    `${JSON.stringify({
      schemaVersion: 1,
      state: "failed_or_interrupted",
      baselineGenerationId: baseline.generationId,
      candidateSha256: receipt.candidateSha256,
      migrationTool: receipt.nativeMigrations,
      recovery: "retained-volume-review-required",
    })}\n`,
  );
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await expect(
    f.runtime.retainFailure(baseline, {
      ...receipt,
      candidateSha256: "d".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(f.runSql).not.toHaveBeenCalled();
});
