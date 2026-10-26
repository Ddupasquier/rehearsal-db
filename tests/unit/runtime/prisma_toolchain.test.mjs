import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectPrismaToolchain } from "../../../dist/src/runtime/prisma_toolchain.mjs";

const metadata = vi.hoisted(() => ({
  paths: new Set(),
  seen: new Set(),
  active: 0,
  maximum: 0,
  fail: null,
  release: null,
  gate: null,
  entered: null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    lstat: async (...args) => {
      const path = String(args[0]);
      if (!metadata.paths.has(path) || metadata.seen.has(path))
        return actual.lstat(...args);
      metadata.seen.add(path);
      if (metadata.seen.size === 4) metadata.entered?.();
      metadata.active++;
      metadata.maximum = Math.max(metadata.maximum, metadata.active);
      try {
        if (path === metadata.fail)
          throw new Error("fixed synthetic metadata refusal");
        if (metadata.gate) await metadata.gate;
        else await new Promise((done) => setImmediate(done));
        return await actual.lstat(...args);
      } finally {
        metadata.active--;
      }
    },
  };
});

const roots = [];
afterEach(async () => {
  metadata.release?.();
  metadata.paths.clear();
  metadata.seen.clear();
  metadata.active = 0;
  metadata.maximum = 0;
  metadata.fail = null;
  metadata.gate = null;
  metadata.release = null;
  metadata.entered = null;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prisma-toolchain-"));
  roots.push(root);
  const packageDirectory = "node_modules/prisma";
  const prisma = join(root, packageDirectory),
    engines = join(root, "node_modules/@prisma/engines");
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
  const canary = join(root, "must-not-execute");
  await writeFile(
    join(prisma, "build/index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(canary)},"executed"); throw Error("must not execute");\n`,
  );
  const engine = join(engines, "schema-engine-darwin-arm64");
  await writeFile(engine, `#!/bin/sh\nexit 89\n`);
  return {
    root,
    prisma,
    engines,
    engine,
    canary,
    packageDirectory,
    inspect: () =>
      inspectPrismaToolchain({ projectRoot: root, packageDirectory }),
  };
}
it("fingerprints exact reviewed local package/engine bytes deterministically without executing the CLI", async () => {
  const f = await fixture();
  const first = await f.inspect();
  expect(first).toEqual({
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    cliPath: join(f.prisma, "build/index.js"),
    enginePath: f.engine,
  });
  expect(await f.inspect()).toEqual(first);
  await expect(access(f.canary)).rejects.toMatchObject({ code: "ENOENT" });
  expect(Object.isFrozen(first)).toBe(true);
});
it.each(["cli", "engine", "additional-package-file"])(
  "changes the reviewed fingerprint when %s bytes change",
  async (kind) => {
    const f = await fixture();
    const before = await f.inspect();
    const path =
      kind === "cli"
        ? join(f.prisma, "build/index.js")
        : kind === "engine"
          ? f.engine
          : join(f.prisma, "NOTICE");
    await writeFile(path, "changed reviewed input\n");
    const after = await f.inspect();
    expect(after.sha256).not.toBe(before.sha256);
    await expect(access(f.canary)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it.each([
  "prisma-version",
  "engine-version",
  "prisma-name",
  "engine-name",
  "bin",
  "missing-cli",
  "missing-engine",
  "missing-prisma-manifest",
  "missing-engine-manifest",
  "duplicate-engine",
  "malformed-manifest",
])("refuses %s instead of falling back or installing", async (kind) => {
  const f = await fixture();
  if (kind === "missing-cli") await rm(join(f.prisma, "build/index.js"));
  else if (kind === "missing-engine") await rm(f.engine);
  else if (kind === "missing-prisma-manifest")
    await rm(join(f.prisma, "package.json"));
  else if (kind === "missing-engine-manifest")
    await rm(join(f.engines, "package.json"));
  else if (kind === "duplicate-engine")
    await writeFile(join(f.engines, "schema-engine-other-platform"), "foreign");
  else if (kind === "malformed-manifest")
    await writeFile(join(f.prisma, "package.json"), "{invalid");
  else {
    const path = join(
      kind.startsWith("engine") ? f.engines : f.prisma,
      "package.json",
    );
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (kind.endsWith("version")) manifest.version = "7.10.2";
    if (kind.endsWith("name")) manifest.name = "foreign-package";
    if (kind === "bin") manifest.bin.prisma = "../foreign/index.js";
    await writeFile(path, JSON.stringify(manifest));
  }
  await expect(f.inspect()).rejects.toThrow();
  await expect(access(f.canary)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["package", "engine-directory", "cli", "engine"])(
  "refuses a symlink at %s",
  async (kind) => {
    const f = await fixture();
    const path =
      kind === "package"
        ? f.prisma
        : kind === "engine-directory"
          ? f.engines
          : kind === "cli"
            ? join(f.prisma, "build/index.js")
            : f.engine;
    const original = path + "-original";
    await rename(path, original);
    await symlink(original, path);
    await expect(f.inspect()).rejects.toThrow();
    await expect(access(f.canary)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("refuses an absent installation and project-escaping paths without creating an installation", async () => {
  const f = await fixture();
  await expect(
    inspectPrismaToolchain({
      projectRoot: f.root,
      packageDirectory: "node_modules/missing",
    }),
  ).rejects.toThrow();
  await expect(
    access(join(f.root, "node_modules/missing")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  for (const packageDirectory of [
    "..",
    "../foreign-prisma",
    ".",
    "/foreign/prisma",
  ])
    await expect(
      inspectPrismaToolchain({ projectRoot: f.root, packageDirectory }),
    ).rejects.toThrow();
});

async function addPackage(f, name, manifest = {}, scope = f.root) {
  const directory = join(scope, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...manifest }),
  );
  await writeFile(
    join(directory, "index.js"),
    "throw Error('dependency code must never execute during inspection');\n",
  );
  return directory;
}
async function dependenciesAt(directory, extra) {
  const path = join(directory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...manifest, ...extra }));
}
it("binds transitive runtime config-loader bytes without evaluating them", async () => {
  const f = await fixture();
  await dependenciesAt(f.prisma, {
    dependencies: { "@prisma/config": "7.10.1" },
  });
  const config = await addPackage(f, "@prisma/config", {
    version: "7.10.1",
    dependencies: { "synthetic-jiti": "1.0.0" },
  });
  const jiti = await addPackage(f, "synthetic-jiti");
  const first = await f.inspect();
  await writeFile(
    join(jiti, "index.js"),
    "throw Error('changed loader code');\n",
  );
  expect((await f.inspect()).sha256).not.toBe(first.sha256);
  const second = await f.inspect();
  await writeFile(
    join(config, "index.js"),
    "throw Error('changed config code');\n",
  );
  expect((await f.inspect()).sha256).not.toBe(second.sha256);
});
it("uses Node lookup scope so a nested dependency shadows a hoisted package", async () => {
  const f = await fixture();
  await dependenciesAt(f.prisma, {
    dependencies: { "synthetic-loader": "1.0.0" },
  });
  const nested = await addPackage(f, "synthetic-loader", {}, f.prisma);
  const hoisted = await addPackage(f, "synthetic-loader");
  const first = await f.inspect();
  await writeFile(join(hoisted, "index.js"), "unselected hoisted bytes\n");
  expect((await f.inspect()).sha256).toBe(first.sha256);
  await writeFile(join(nested, "index.js"), "selected nested bytes\n");
  expect((await f.inspect()).sha256).not.toBe(first.sha256);
});
it("includes selected optional dependencies and peers but permits absent explicitly optional packages", async () => {
  const f = await fixture();
  await dependenciesAt(f.prisma, {
    optionalDependencies: {
      "synthetic-optional": "1.0.0",
      "absent-optional": "1.0.0",
    },
    peerDependencies: { "synthetic-peer": "1.0.0", "absent-peer": "1.0.0" },
    peerDependenciesMeta: { "absent-peer": { optional: true } },
  });
  const optional = await addPackage(f, "synthetic-optional"),
    peer = await addPackage(f, "synthetic-peer");
  const first = await f.inspect();
  await writeFile(join(optional, "index.js"), "changed optional\n");
  const second = await f.inspect();
  expect(second.sha256).not.toBe(first.sha256);
  await writeFile(join(peer, "index.js"), "changed peer\n");
  expect((await f.inspect()).sha256).not.toBe(second.sha256);
});
it.each(["required", "peer", "mismatched-name", "symlink"])(
  "refuses unsafe or unavailable dependency %s",
  async (kind) => {
    const f = await fixture();
    await dependenciesAt(
      f.prisma,
      kind === "peer"
        ? { peerDependencies: { "synthetic-required": "1.0.0" } }
        : { dependencies: { "synthetic-required": "1.0.0" } },
    );
    if (kind === "mismatched-name")
      await addPackage(f, "synthetic-required", { name: "foreign-name" });
    if (kind === "symlink") {
      const target = await addPackage(f, "synthetic-elsewhere");
      await symlink(target, join(f.root, "node_modules/synthetic-required"));
    }
    await expect(f.inspect()).rejects.toThrow();
  },
);
it("refuses a dependency that Node would select outside the declared project", async () => {
  const f = await fixture();
  await dependenciesAt(f.prisma, {
    dependencies: { "synthetic-outside": "1.0.0" },
  });
  const project = join(f.root, "consumer");
  await mkdir(project);
  await rename(join(f.root, "node_modules"), join(project, "node_modules"));
  await addPackage(f, "synthetic-outside");
  await expect(
    inspectPrismaToolchain({
      projectRoot: project,
      packageDirectory: "node_modules/prisma",
    }),
  ).rejects.toThrow();
});
it("withholds malformed transitive package metadata instead of exposing parser input", async () => {
  const f = await fixture();
  await dependenciesAt(f.prisma, {
    dependencies: { "synthetic-private": "1.0.0" },
  });
  const dependency = await addPackage(f, "synthetic-private");
  await writeFile(
    join(dependency, "package.json"),
    '{"PRIVATE_MANIFEST_CANARY": malformed}',
  );
  const error = await f.inspect().catch((error) => error);
  expect(error.message).toContain("Prisma requires an unchanged");
  expect(error.message).not.toContain("PRIVATE_MANIFEST_CANARY");
});

// Exercise admission without allocating hundreds of MiB or relying on GC timing.
it("bounds simultaneous read buffers including sentinels and releases waiting workers", async () => {
  const { createPrismaReadBudget, PRISMA_TOOLCHAIN_LIMITS } =
    await import("../../../dist/src/runtime/prisma_toolchain_dependencies.mjs");
  const acquire = createPrismaReadBudget(),
    limit = PRISMA_TOOLCHAIN_LIMITS.maximumInflightBytes;
  const release = await acquire(limit);
  let admitted = false;
  const waiting = acquire(1).then((done) => {
    admitted = true;
    return done;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  release();
  release();
  const releaseSecond = await waiting;
  expect(admitted).toBe(true);
  releaseSecond();
  const releaseAll = await acquire(limit);
  releaseAll();
  await expect(acquire(limit + 1)).rejects.toThrow();
  await expect(acquire(0)).rejects.toThrow();
});

it("batches initial metadata four at a time without multiplying concurrency across nested directories", async () => {
  const f = await fixture();
  for (const parent of ["build", "nested/child"]) {
    await mkdir(join(f.prisma, parent), { recursive: true });
    for (let i = 0; i < 12; i++) {
      const path = join(f.prisma, parent, `input-${i}.js`);
      await writeFile(path, "module.exports=1;\n");
      metadata.paths.add(path);
    }
  }
  const result = await f.inspect();
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(metadata.seen.size).toBe(24);
  expect(metadata.maximum).toBe(4);
  expect(metadata.active).toBe(0);
});
it("settles all admitted metadata requests on refusal before returning", async () => {
  const f = await fixture();
  const directory = join(f.prisma, "batch");
  await mkdir(directory);
  for (let i = 0; i < 4; i++) {
    const path = join(directory, `input-${i}.js`);
    await writeFile(path, "module.exports=1;\n");
    metadata.paths.add(path);
  }
  metadata.fail = join(directory, "input-0.js");
  metadata.gate = new Promise((done) => {
    metadata.release = done;
  });
  const outcome = f.inspect().then(
    () => ({ success: true }),
    (error) => ({ error }),
  );
  try {
    const entered = new Promise((done) => {
      metadata.entered = () => done(true);
    });
    if (metadata.seen.size === 4) metadata.entered();
    expect(await Promise.race([entered, outcome.then(() => false)])).toBe(true);
    expect(metadata.seen.size).toBe(4);
    expect(metadata.active).toBe(3);
    metadata.release();
    const result = await outcome;
    expect(result.error).toBeInstanceOf(Error);
    expect(metadata.active).toBe(0);
  } finally {
    metadata.release();
    await outcome;
  }
});
