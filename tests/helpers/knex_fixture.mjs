/** Synthetic metadata only: never native SDK conformance or host migration execution. */
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const knexFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "knex-fixture-")),
    directory = join(root, "migrations"),
    knex = join(root, "node_modules/knex"),
    pg = join(root, "node_modules/pg");
  for (const path of [directory, knex, pg])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(knex, "package.json"),
    JSON.stringify({
      name: "knex",
      version: "3.3.0",
      main: "knex.js",
      dependencies: { pg: "8.23.1" },
    }),
  );
  await writeFile(join(knex, "knex.js"), "throw Error('MUST_NOT_EXECUTE_SDK')");
  await writeFile(
    join(pg, "package.json"),
    JSON.stringify({ name: "pg", version: "8.23.1", main: "index.js" }),
  );
  await writeFile(join(pg, "index.js"), "throw Error('MUST_NOT_EXECUTE_PG')");
  for (const name of ["001_initial.cjs", "002_index.cjs"])
    await writeFile(
      join(directory, name),
      "exports.up=async()=>{};exports.down=async()=>{};\r\n",
    );
  await mkdir(join(directory, "support"));
  await writeFile(
    join(directory, "support/helper.cjs"),
    "throw Error('MUST_NOT_EXECUTE_SOURCE')",
  );
  const tool = {
    kind: "knex",
    version: "3.3.0",
    driver: "pg",
    driverVersion: "8.23.1",
    packageDirectory: "node_modules/knex",
    driverPackageDirectory: "node_modules/pg",
  };
  return { root, directory, knex, pg, tool };
};
export const removeKnexFixture = async (root) => {
  async function writable(path) {
    await chmod(path, 0o700).catch(() => {});
    for (const entry of await readdir(path, { withFileTypes: true }).catch(
      () => [],
    )) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(child);
      else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
    }
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
};

export const configureKnexFixture = async (f) => {
  const { pathToFileURL } = await import("node:url");
  const { loadRehearsalConfig } =
    await import("../../dist/src/project/configuration.mjs");
  const { createKnexBaseline } =
    await import("../../dist/src/baseline/knex_builder.mjs");
  const { inspectMigrationReviewPlan } =
    await import("../../dist/src/runtime/migrations/migration_plan.mjs");
  const cutoff = { kind: "knex", name: "002_index.cjs" };
  const policyBytes = Buffer.from(
    JSON.stringify({
      policyVersion: 1,
      migrationCutoff: cutoff,
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
    }),
  );
  await writeFile(join(f.root, "policy.json"), policyBytes);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ name: "knex-fixture", type: "module", version: "1.0.0" }),
  );
  const configuration = pathToFileURL(
    join(process.cwd(), "dist/src/index.mjs"),
  ).href;
  await writeFile(
    join(f.root, "rehearsal.config.mjs"),
    `import {defineRehearsalConfig} from ${JSON.stringify(configuration)};export default defineRehearsalConfig({schemaVersion:1,project:{name:'knex-fixture'},postgresql:{migrationDirectory:'migrations',runtimeWorkdir:'.rehearsal/runtime',image:'postgres:17-alpine',database:'postgres',user:'postgres',migrationTool:${JSON.stringify(f.tool)}},baseline:{artifactDirectory:'.rehearsal',sanitizationPolicy:'policy.json'},application:{startCommand:'node never-start.mjs',proofCommand:'node never-proof.mjs'},runtime:{target:'postgresql',applicationUrl:'http://127.0.0.1:5275',projectId:'knex-fixture',databasePort:59422}});`,
  );
  const loaded = await loadRehearsalConfig({ projectRoot: f.root });
  await createKnexBaseline({
    loaded,
    records: (async function* () {
      yield { table: "widgets", row: { id: 1 } };
    })(),
    ledger: [
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
    ],
    policyBytes,
    cutoff,
    expectedTables: ["widgets"],
    assets: [],
  });
  await writeFile(
    join(f.directory, "003_pending.cjs"),
    "exports.up=async()=>{throw Error('PRIVATE_SOURCE_CANARY')};exports.down=async()=>{};",
  );
  const plan = await inspectMigrationReviewPlan({ projectRoot: f.root });
  return { ...f, loaded, plan };
};
