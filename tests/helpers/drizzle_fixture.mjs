/** Synthetic pinned metadata/process fixtures; never genuine Drizzle conformance. */
import {
  mkdir,
  mkdtemp,
  writeFile,
  chmod,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const drizzleTool = {
  kind: "drizzle",
  kitVersion: "0.31.11",
  ormVersion: "0.45.4",
  driver: "pg",
  driverVersion: "8.23.1",
  packageDirectory: "node_modules/drizzle-kit",
  ormPackageDirectory: "node_modules/drizzle-orm",
  driverPackageDirectory: "node_modules/pg",
};
export async function drizzleFixture(
  cli = 'throw new Error("must not execute inventory");',
) {
  const root = await mkdtemp(join(tmpdir(), "drizzle-native-"));
  const kit = join(root, drizzleTool.packageDirectory),
    orm = join(root, drizzleTool.ormPackageDirectory),
    pg = join(root, drizzleTool.driverPackageDirectory),
    directory = join(root, "drizzle"),
    runtimeWorkdir = join(root, ".rehearsal/runtime");
  for (const path of [
    join(root, "node_modules/esbuild/lib"),
    kit,
    join(orm, "node-postgres"),
    pg,
    join(directory, "meta"),
    runtimeWorkdir,
  ])
    await mkdir(path, { recursive: true });
  for (const [path, value] of [
    [
      join(kit, "package.json"),
      {
        name: "drizzle-kit",
        version: "0.31.11",
        bin: { "drizzle-kit": "./bin.cjs" },
      },
    ],
    [
      join(orm, "package.json"),
      {
        name: "drizzle-orm",
        version: "0.45.4",
        exports: {
          ".": "./index.js",
          "./node-postgres/migrator": "./node-postgres/migrator.js",
        },
      },
    ],
    [
      join(pg, "package.json"),
      { name: "pg", version: "8.23.1", main: "index.js" },
    ],
  ])
    await writeFile(path, JSON.stringify(value));
  await writeFile(
    join(root, "node_modules/esbuild/package.json"),
    JSON.stringify({
      name: "esbuild",
      version: "0.25.12",
      main: "lib/main.js",
    }),
  );
  await writeFile(
    join(root, "node_modules/esbuild/lib/main.js"),
    "module.exports={};",
  );
  await writeFile(join(kit, "bin.cjs"), cli);
  await writeFile(join(orm, "index.js"), "module.exports = {};");
  await writeFile(
    join(orm, "node-postgres/migrator.js"),
    "module.exports = {};",
  );
  await writeFile(join(pg, "index.js"), "module.exports = {};");
  const entries = [
    {
      idx: 0,
      version: "7",
      when: 1720000000000,
      tag: "z_initial",
      breakpoints: true,
    },
    {
      idx: 1,
      version: "7",
      when: 1720000001000,
      tag: "a_index",
      breakpoints: true,
    },
  ];
  const journal = Buffer.from(
    JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2) +
      "\r\n",
  );
  await writeFile(join(directory, "meta/_journal.json"), journal);
  for (const e of entries)
    await writeFile(
      join(directory, `${e.tag}.sql`),
      "-- exact native SQL\r\nselect 1;\r\n",
    );
  return {
    root,
    kit,
    orm,
    pg,
    directory,
    runtimeWorkdir,
    journal,
    entries,
    tool: drizzleTool,
  };
}
export async function removeDrizzleFixture(root) {
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
  await writable(root);
  await rm(root, { recursive: true, force: true });
}

/** Build a real Core-readable synthetic project, not an installed SDK/database proof. */
export async function configureDrizzleFixture(f) {
  const { pathToFileURL } = await import("node:url");
  const configuration = pathToFileURL(
    join(process.cwd(), "dist/src/project/configuration.mjs"),
  ).href;
  const { loadRehearsalConfig } = await import(configuration);
  const { readDrizzleMigrationInventory } =
    await import("../../dist/src/runtime/drizzle_history.mjs");
  const { createDrizzleBaseline } =
    await import("../../dist/src/baseline/drizzle_builder.mjs");
  const { inspectMigrationReviewPlan } =
    await import("../../dist/src/runtime/migration_plan.mjs");
  const inventory = await readDrizzleMigrationInventory(
    pathToFileURL(f.directory + "/"),
  );
  const last = inventory.entries.at(-1),
    cutoff = { kind: "drizzle", idx: last.idx, when: last.when, tag: last.tag };
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
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ name: "drizzle-fixture", type: "module" }),
  );
  await writeFile(join(f.root, "policy.json"), policyBytes);
  await writeFile(
    join(f.root, "rehearsal.config.mjs"),
    `import {defineRehearsalConfig} from ${JSON.stringify(configuration)};export default defineRehearsalConfig({schemaVersion:1,project:{name:'drizzle-fixture'},postgresql:{migrationDirectory:'drizzle',runtimeWorkdir:'.rehearsal/runtime',image:'postgres:17-alpine',database:'postgres',user:'postgres',migrationTool:${JSON.stringify(f.tool)}},baseline:{artifactDirectory:'.rehearsal',sanitizationPolicy:'policy.json'},application:{startCommand:'node never-start.mjs',proofCommand:'node never-proof.mjs'},runtime:{target:'postgresql',applicationUrl:'http://127.0.0.1:5275',projectId:'drizzle-fixture',databasePort:59422}});`,
  );
  const loaded = await loadRehearsalConfig({ projectRoot: f.root });
  await createDrizzleBaseline({
    loaded,
    records: (async function* () {
      yield { table: "widgets", row: { id: 1 } };
    })(),
    ledger: inventory.entries.map((entry, i) => ({
      id: i ? 3 : 1,
      hash: entry.hash,
      created_at: String(entry.when),
    })),
    policyBytes,
    cutoff,
    expectedTables: ["widgets"],
    assets: [],
  });
  const pending = {
    idx: 2,
    version: "7",
    when: 1720000002000,
    tag: "m_pending",
    breakpoints: true,
  };
  await writeFile(
    join(f.directory, "m_pending.sql"),
    "-- PRIVATE_SQL_CANARY\r\nDROP TABLE public.widgets;\r\n",
  );
  await writeFile(
    join(f.directory, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [...f.entries, pending],
    }),
  );
  const plan = await inspectMigrationReviewPlan({ projectRoot: f.root });
  return { ...f, loaded, plan };
}
