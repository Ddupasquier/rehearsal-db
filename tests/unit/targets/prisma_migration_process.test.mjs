import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { deployPrismaMigrations } from "../../../dist/src/targets/prisma_migration_process.mjs";
import { readPrismaMigrationInventory } from "../../../dist/src/runtime/migrations/prisma_history.mjs";
import { inspectPrismaToolchain } from "../../../dist/src/runtime/migrations/prisma_toolchain.mjs";
import { assertNativeBaselineManifestUnchanged } from "../../../dist/src/runtime/lifecycle/baseline_identity.mjs";
import { runWithOperationCancellation } from "../../../dist/src/shared/cancellation.mjs";
const preparation = vi.hoisted(() => ({
  afterConfig: null,
  duringHash: null,
  afterPreparedRead: null,
  hashes: 0,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    open: async (...args) => {
      const handle = await actual.open(...args);
      const file = String(args[0]);
      if (
        file.includes("/.prisma-deploy-") &&
        file.endsWith("/prisma.config.ts")
      ) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          await preparation.afterPreparedRead?.(file, actual);
          return result;
        };
      }
      return handle;
    },
    writeFile: async (...args) => {
      const result = await actual.writeFile(...args);
      if (
        String(args[0]).includes("/.prisma-deploy-") &&
        String(args[0]).endsWith("/prisma.config.ts")
      )
        await preparation.afterConfig?.(String(args[0]), actual);
      return result;
    },
  };
});
vi.mock(
  "../../../dist/src/runtime/migrations/prisma_toolchain.mjs",
  async (original) => {
    const actual = await original();
    return {
      ...actual,
      inspectPrismaToolchain: async (...args) => {
        preparation.hashes++;
        const result = await actual.inspectPrismaToolchain(...args);
        await preparation.duringHash?.();
        return result;
      },
    };
  },
);
const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  preparation.afterConfig = null;
  preparation.duringHash = null;
  preparation.afterPreparedRead = null;
  preparation.hashes = 0;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const ownedId = "a".repeat(64);
const sql = "-- exact CRLF source\r\nselect 1;\r\n";
async function fixture(mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "prisma-process-"));
  roots.push(root);
  const directory = join(root, "prisma/migrations"),
    runtimeWorkdir = join(root, ".rehearsal/runtime"),
    prisma = join(root, "node_modules/prisma"),
    engines = join(root, "node_modules/@prisma/engines");
  const folder = "20261026000000_init";
  await Promise.all([
    mkdir(join(directory, folder), { recursive: true }),
    mkdir(runtimeWorkdir, { recursive: true }),
    mkdir(join(prisma, "build"), { recursive: true }),
    mkdir(engines, { recursive: true }),
  ]);
  await writeFile(
    join(directory, "migration_lock.toml"),
    'provider = "postgresql"\n',
  );
  await writeFile(join(directory, folder, "migration.sql"), sql);
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
  const enginePath = join(engines, "schema-engine-test-native");
  await writeFile(enginePath, "synthetic engine; never executes\n");
  const observation = join(root, "observation.json"),
    hostileCanary = join(root, "project-config-executed");
  await writeFile(
    join(root, "prisma.config.ts"),
    `require('node:fs').writeFileSync(${JSON.stringify(hostileCanary)},'unsafe'); throw Error('hostile project config');`,
  );
  await writeFile(join(root, ".env"), "HOSTED_SECRET_CANARY=must-not-load\n");
  const cliPath = join(prisma, "build/index.js");
  await writeFile(
    cliPath,
    `const fs=require('node:fs'); const path=require('node:path'); const crypto=require('node:crypto');
const args=process.argv.slice(2), config=args[3], cwd=process.cwd();
const conf=fs.readFileSync(config,'utf8'), url=new URL(process.env.REHEARSAL_NATIVE_DATABASE_URL);
const copied=fs.readFileSync(path.join(cwd,'migrations',${JSON.stringify(folder)},'migration.sql'));
const mode=${JSON.stringify(mode)};
fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({
 args:args.slice(0,3), privateConfig:path.dirname(config)===cwd, privateCwd:cwd.startsWith(${JSON.stringify(runtimeWorkdir)}+path.sep),
 sourceHash:crypto.createHash('sha256').update(copied).digest('hex'),
 secretOnlyInEnvironment:!conf.includes('private-password')&&conf.includes('REHEARSAL_NATIVE_DATABASE_URL'),
 host:url.hostname, database:url.pathname, schema:url.searchParams.get('schema'),
 hasServerLimits:url.searchParams.get('options').includes('statement_timeout=120000'),
 engineMatches:process.env.PRISMA_SCHEMA_ENGINE_BINARY===${JSON.stringify(enginePath)},
 ambientAbsent:['HOSTED_SECRET_CANARY','NODE_OPTIONS','DATABASE_URL','PRISMA_ENGINES_MIRROR','PRISMA_SCHEMA_ENGINE_BINARY_BAD'].every(key=>!(key in process.env)),
 cachesPrivate:['XDG_CACHE_HOME','JITI_CACHE_DIR','TMPDIR','TMP','TEMP'].every(key=>process.env[key]===cwd||process.env[key].startsWith(cwd+path.sep)),
 networkAdvisoriesDisabled:process.env.CHECKPOINT_DISABLE==='1'&&process.env.PRISMA_HIDE_UPDATE_MESSAGE==='1'
}));
if(mode==='failure'){process.stdout.write('PRIVATE_SQL select secret; private-password');process.stderr.write('PRIVATE_PROVIDER_ERROR private-password');process.exitCode=13;}
if(mode==='configuration-drift')fs.writeFileSync(config,'throw Error("changed after execution");');
if(mode==='baseline-drift'){const manifest=${JSON.stringify(join(root, ".rehearsal/generations/20261027T000000Z-aaaaaaaaaaaa/baseline-manifest.json"))};const value=JSON.parse(fs.readFileSync(manifest,'utf8'));value.generationId='changed-after-child';fs.writeFileSync(manifest,JSON.stringify(value));}


`,
  );
  const inventory = await readPrismaMigrationInventory(
    pathToFileURL(directory + "/"),
  );
  const toolchain = await inspectPrismaToolchain({
    projectRoot: root,
    packageDirectory: "node_modules/prisma",
  });
  const artifactRoot = join(root, ".rehearsal"),
    generationId = "20261027T000000Z-aaaaaaaaaaaa",
    generationDirectory = join(artifactRoot, "generations", generationId),
    manifestPath = join(generationDirectory, "baseline-manifest.json");
  await mkdir(generationDirectory, { recursive: true });
  const expectedBaseline = {
    formatVersion: 3,
    generationId,
    nativeMigrations: {
      ...inventory.binding,
      toolchainSha256: toolchain.sha256,
    },
    files: { "sanitized-data.ndjson": { sha256: "b".repeat(64) } },
  };
  await writeFile(manifestPath, JSON.stringify(expectedBaseline));
  await symlink("generations/" + generationId, join(artifactRoot, "current"));
  const options = {
    projectRoot: root,
    packageDirectory: "node_modules/prisma",
    directory,
    runtimeWorkdir,
    entries: inventory.entries,
    binding: { ...inventory.binding, toolchainSha256: toolchain.sha256 },
    databaseUrl:
      "postgresql://postgres:private-password@127.0.0.1:58322/postgres?sslmode=disable",
    assertOwnedTarget: () => ownedId,
    assertExpectedBaseline: () =>
      assertNativeBaselineManifestUnchanged({
        artifactRoot,
        expected: expectedBaseline,
      }),
  };
  return {
    root,
    options,
    observation,
    hostileCanary,
    cliPath,
    runtimeWorkdir,
    manifestPath,
    expectedBaseline,
  };
}
async function noWorkspace(f) {
  expect(await readdir(f.runtimeWorkdir)).toEqual([]);
}
async function notDispatched(f) {
  await expect(access(f.observation)).rejects.toMatchObject({ code: "ENOENT" });
  await noWorkspace(f);
}
it("runs only the reviewed child with private generated config/copied bytes and a clean bounded environment", async () => {
  const f = await fixture();
  for (const [key, value] of Object.entries({
    HOSTED_SECRET_CANARY: "must-not-leak",
    NODE_OPTIONS: "--require=/missing-hostile-preload",
    DATABASE_URL: "postgresql://hosted.example/production",
    PRISMA_ENGINES_MIRROR: "https://foreign.example",
    PRISMA_SCHEMA_ENGINE_BINARY_BAD: "foreign",
  }))
    vi.stubEnv(key, value);
  await deployPrismaMigrations(f.options);
  expect(JSON.parse(await readFile(f.observation, "utf8"))).toEqual({
    args: ["migrate", "deploy", "--config"],
    privateConfig: true,
    privateCwd: true,
    sourceHash: createHash("sha256").update(sql).digest("hex"),
    secretOnlyInEnvironment: true,
    host: "127.0.0.1",
    database: "/postgres",
    schema: "public",
    hasServerLimits: true,
    engineMatches: true,
    ambientAbsent: true,
    cachesPrivate: true,
    networkAdvisoriesDisabled: true,
  });
  await expect(access(f.hostileCanary)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await noWorkspace(f);
  expect(
    await readFile(
      join(f.options.directory, "20261026000000_init/migration.sql"),
      "utf8",
    ),
  ).toBe(sql);
});
it("redacts a real owned-child failure and removes only its private execution workspace", async () => {
  const f = await fixture("failure");
  const error = await deployPrismaMigrations(f.options).catch((error) => error);
  expect(error.message).toContain("Prisma Migrate failed (exit 13)");
  for (const secret of [
    "private-password",
    "PRIVATE_SQL",
    "PRIVATE_PROVIDER_ERROR",
    "select secret",
  ])
    expect(error.message).not.toContain(secret);
  await access(f.observation);
  await noWorkspace(f);
  expect(await readFile(join(f.root, ".env"), "utf8")).toBe(
    "HOSTED_SECRET_CANARY=must-not-load\n",
  );
});
it("refuses cancellation observed during preparation before starting the owned child", async () => {
  const f = await fixture(),
    signals = new EventEmitter();
  let observations = 0;
  await expect(
    runWithOperationCancellation({
      signalTarget: signals,
      input: null,
      task: () =>
        deployPrismaMigrations({
          ...f.options,
          assertOwnedTarget: () => {
            if (++observations === 1) signals.emit("SIGINT");
            return ownedId;
          },
        }),
    }),
  ).rejects.toMatchObject({ category: "operation_cancelled" });
  await notDispatched(f);
});
it("refuses executable drift during staging before starting the changed child", async () => {
  const f = await fixture();
  let observations = 0;
  await expect(
    deployPrismaMigrations({
      ...f.options,
      assertOwnedTarget: () => {
        if (++observations === 1)
          appendFileSync(
            f.cliPath,
            "\n// changed while execution files were being prepared\n",
          );
        return ownedId;
      },
    }),
  ).rejects.toThrow("toolchain changed before dispatch");
  await notDispatched(f);
});
it("refuses target identity drift before dispatch and cleans the prepared workspace", async () => {
  const f = await fixture();
  let observations = 0;
  await expect(
    deployPrismaMigrations({
      ...f.options,
      assertOwnedTarget: () =>
        ++observations === 1 ? ownedId : "b".repeat(64),
    }),
  ).rejects.toThrow("target changed before dispatch");
  await notDispatched(f);
});
it("refuses changed reviewed migration bytes before staging or dispatch", async () => {
  const f = await fixture();
  await writeFile(
    join(f.options.directory, "20261026000000_init/migration.sql"),
    "select 2;\n",
  );
  await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
    "changed after review",
  );
  await notDispatched(f);
});
it("does not claim success when target identity drifts after the child exits", async () => {
  const f = await fixture();
  let observations = 0;
  await expect(
    deployPrismaMigrations({
      ...f.options,
      assertOwnedTarget: () => (++observations <= 2 ? ownedId : "b".repeat(64)),
    }),
  ).rejects.toThrow("identity changed");
  await access(f.observation);
  await noWorkspace(f);
});

it("hashes the full actual toolchain once before dispatch and once after execution", async () => {
  const f = await fixture();
  preparation.hashes = 0;
  await deployPrismaMigrations(f.options);
  expect(preparation.hashes).toBe(2);
  await access(f.observation);
  await noWorkspace(f);
});
it.each(["source", "private-copy", "configuration"])(
  "refuses %s drift while staging before launching any SQL child",
  async (mode) => {
    const f = await fixture();
    preparation.afterConfig = async (config, actual) => {
      const workspace = join(config, ".."),
        file =
          mode === "source"
            ? join(f.options.directory, "20261026000000_init/migration.sql")
            : mode === "private-copy"
              ? join(workspace, "migrations/20261026000000_init/migration.sql")
              : config;
      await actual.writeFile(
        file,
        mode === "configuration"
          ? "throw Error('changed config');\n"
          : "select 999;\n",
      );
    };
    await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
      /changed before dispatch/,
    );
    await notDispatched(f);
  },
);

it.each(["private-copy", "configuration"])(
  "rechecks %s after awaited full toolchain inspection, refusing dispatch",
  async (mode) => {
    const f = await fixture();
    let configPath;
    preparation.afterConfig = async (config) => {
      configPath = config;
    };
    preparation.duringHash = async () => {
      const file =
        mode === "configuration"
          ? configPath
          : join(configPath, "../migrations/20261026000000_init/migration.sql");
      await writeFile(file, "changed during full hash\n");
    };
    await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
      /changed before dispatch/,
    );
    await notDispatched(f);
  },
);

it("refuses identical config bytes installed at a replacement inode after the opened read", async () => {
  const f = await fixture();
  preparation.afterPreparedRead = async (file, actual) => {
    const bytes = await actual.readFile(file);
    await actual.rename(file, file + ".original");
    await actual.writeFile(file, bytes, { mode: 0o600 });
  };
  await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
    "configuration changed before dispatch",
  );
  await notDispatched(f);
});

it("refuses a real manifest drift during awaited toolchain hashing before launching the child", async () => {
  const f = await fixture();
  preparation.duringHash = async () => {
    await writeFile(
      f.manifestPath,
      JSON.stringify({ ...f.expectedBaseline, generationId: "changed" }),
    );
  };
  await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
    "active baseline changed",
  );
  await notDispatched(f);
});
it("does not establish success when the executed child changes its generated configuration", async () => {
  const f = await fixture("configuration-drift");
  await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
    "configuration changed after execution",
  );
  await access(f.observation);
  await noWorkspace(f);
});

it("does not establish success when active baseline metadata changes during the child", async () => {
  const f = await fixture("baseline-drift");
  await expect(deployPrismaMigrations(f.options)).rejects.toThrow(
    "active baseline changed",
  );
  await access(f.observation);
  await noWorkspace(f);
});
