import { EventEmitter } from "node:events";
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  drizzleFixture,
  removeDrizzleFixture,
} from "../../helpers/drizzle_fixture.mjs";
import { readDrizzleMigrationInventory } from "../../../dist/src/runtime/drizzle_history.mjs";
import { drizzleMigrationFiles } from "../../../dist/src/runtime/migration_identity.mjs";
import { inspectDrizzleToolchain } from "../../../dist/src/runtime/drizzle_toolchain.mjs";
import { deployDrizzleMigrations } from "../../../dist/src/targets/drizzle_migration_process.mjs";
import { runWithOperationCancellation } from "../../../dist/src/shared/cancellation.mjs";
const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await removeDrizzleFixture(root);
});
async function fixture(mode = "success") {
  const f = await drizzleFixture("");
  roots.push(f.root);
  const witness = join(f.root, "child-witness.json");
  await writeFile(
    join(f.kit, "bin.cjs"),
    `const fs=require('node:fs'),path=require('node:path');const mode=${JSON.stringify(mode)};const config=process.argv[4];const root=process.cwd();const expected=path.join(root,'drizzle.config.cjs');if(process.argv[2]!=='migrate'||process.argv[3]!=='--config'||config!==expected)process.exit(40);const x=require(config);const env=process.env;const journal=fs.readFileSync('migrations/meta/_journal.json');fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify({closed:x.dialect==='postgresql'&&!('schema' in x)&&x.migrations.schema==='drizzle'&&x.migrations.table==='__drizzle_migrations',emptyDotenv:fs.readFileSync(env.DOTENV_CONFIG_PATH).length===0,closedTsconfig:JSON.stringify(JSON.parse(fs.readFileSync(env.TSX_TSCONFIG_PATH)))==='{"compilerOptions":{}}',cacheDisabled:env.TSX_DISABLE_CACHE==='1',isolated:!env.SECRET_CANARY&&!env.NODE_OPTIONS&&!env.PGHOST&&!env.TEST_CONFIG_PATH_PREFIX,temp:env.TMPDIR===root,raw:journal.toString('base64')}));if(mode==='failure'){console.error('PRIVATE_SQL_PASSWORD_CANARY');process.exit(7);}if(mode==='hang')setInterval(()=>{},1000);`,
  );
  const inventory = await readDrizzleMigrationInventory(
    pathToFileURL(f.directory + "/"),
  );
  const toolchain = await inspectDrizzleToolchain({
    projectRoot: f.root,
    tool: f.tool,
  });
  const options = {
    projectRoot: f.root,
    tool: f.tool,
    directory: f.directory,
    runtimeWorkdir: f.runtimeWorkdir,
    entries: drizzleMigrationFiles(inventory.entries),
    binding: {
      ...inventory.binding,
      driver: "pg",
      driverVersion: "8.23.1",
      toolchainSha256: toolchain.sha256,
    },
    databaseUrl:
      "postgresql://postgres:private-password@127.0.0.1:58322/postgres?sslmode=disable",
    assertOwnedTarget: () => "a".repeat(64),
    assertExpectedBaseline: async () => {},
  };
  return { ...f, options, witness };
}
it("uses only generated closed inputs, raw native copy and sanitized private environment", async () => {
  const f = await fixture();
  vi.stubEnv("SECRET_CANARY", "private");
  vi.stubEnv("TEST_CONFIG_PATH_PREFIX", f.root);
  vi.stubEnv("PGHOST", "remote.example");
  await writeFile(
    join(f.root, "drizzle.config.cjs"),
    'throw new Error("hostile project config");',
  );
  await deployDrizzleMigrations(f.options);
  const proof = JSON.parse(await readFile(f.witness, "utf8"));
  expect(proof).toEqual({
    closed: true,
    emptyDotenv: true,
    closedTsconfig: true,
    cacheDisabled: true,
    isolated: true,
    temp: true,
    raw: f.journal.toString("base64"),
  });
  expect(await readdir(f.runtimeWorkdir)).toEqual([]);
});
it("redacts failed tool output and removes only its private staging workspace", async () => {
  const f = await fixture("failure");
  let error;
  try {
    await deployDrizzleMigrations(f.options);
  } catch (e) {
    error = e;
  }
  expect(String(error)).toMatch(/Drizzle Kit migrate failed \(exit 7\)/);
  expect(String(error)).not.toContain("PRIVATE_SQL_PASSWORD_CANARY");
  expect(await readdir(f.runtimeWorkdir)).toEqual([]);
  expect(await readFile(join(f.directory, "meta/_journal.json"))).toEqual(
    f.journal,
  );
});
it("refuses stale journal consent, target drift and pre-spawn cancellation without executing child", async () => {
  const f = await fixture();
  await writeFile(
    join(f.directory, "meta/_journal.json"),
    f.journal.toString() + " ",
  );
  await expect(deployDrizzleMigrations(f.options)).rejects.toThrow(
    /changed after review/,
  );
  await expect(access(f.witness)).rejects.toThrow();
  await writeFile(join(f.directory, "meta/_journal.json"), f.journal);
  let calls = 0;
  await expect(
    deployDrizzleMigrations({
      ...f.options,
      assertOwnedTarget: () => (++calls === 1 ? "a" : "b").repeat(64),
    }),
  ).rejects.toThrow(/target changed/);
  await expect(access(f.witness)).rejects.toThrow();
  const signals = new EventEmitter();
  await expect(
    runWithOperationCancellation({
      signalTarget: signals,
      input: null,
      task: () => {
        signals.emit("SIGINT");
        return deployDrizzleMigrations(f.options);
      },
    }),
  ).rejects.toMatchObject({ category: "operation_cancelled" });
  await expect(access(f.witness)).rejects.toThrow();
  expect(await readdir(f.runtimeWorkdir)).toEqual([]);
});

async function waitForWitness(path) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  throw new Error("Owned synthetic child did not reach its fixed witness.");
}
it("cancels a running owned child and removes private inputs while source remains unchanged", async () => {
  const f = await fixture("hang");
  const signals = new EventEmitter();
  const outcome = runWithOperationCancellation({
    signalTarget: signals,
    input: null,
    task: () => deployDrizzleMigrations(f.options),
  }).then(
    () => null,
    (error) => error,
  );
  try {
    await waitForWitness(f.witness);
  } finally {
    signals.emit("SIGINT");
  }
  const error = await outcome;
  expect(error).toMatchObject({ category: "operation_cancelled" });
  expect(await readdir(f.runtimeWorkdir)).toEqual([]);
  expect(await readFile(join(f.directory, "meta/_journal.json"))).toEqual(
    f.journal,
  );
});
it("enforces the existing 120-second deadline and cleans only its owned child workspace", async () => {
  const f = await fixture("hang");
  const real = globalThis.setTimeout;
  let expire;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      if (delay === 120000) expire = callback;
      return real(callback, delay, ...args);
    });
  const outcome = deployDrizzleMigrations(f.options).then(
    () => null,
    (error) => error,
  );
  try {
    await waitForWitness(f.witness);
    expect(expire).toBeTypeOf("function");
    expire();
    const error = await outcome;
    expect(String(error)).toMatch(/120-second bound/);
    expect(await readdir(f.runtimeWorkdir)).toEqual([]);
    expect(await readFile(join(f.directory, "meta/_journal.json"))).toEqual(
      f.journal,
    );
  } finally {
    expire?.();
    await outcome;
    timer.mockRestore();
  }
});
