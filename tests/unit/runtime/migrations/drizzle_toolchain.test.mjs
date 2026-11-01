import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  drizzleFixture,
  removeDrizzleFixture,
} from "../../../helpers/drizzle_fixture.mjs";
import { inspectDrizzleToolchain } from "../../../../dist/src/runtime/migrations/drizzle_toolchain.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeDrizzleFixture(root);
});
const fixture = async () => {
  const f = await drizzleFixture();
  roots.push(f.root);
  return f;
};
it("fingerprints exact dynamically resolved Kit, ORM and pg without executing code", async () => {
  const f = await fixture();
  const a = await inspectDrizzleToolchain({
    projectRoot: f.root,
    tool: f.tool,
  });
  expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(a.cliPath).toBe(join(f.kit, "bin.cjs"));
  expect(
    await inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
  ).toEqual(a);
  await writeFile(join(f.pg, "index.js"), "changed pg");
  expect(
    (await inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }))
      .sha256,
  ).not.toBe(a.sha256);
});
it.each(["postgres", "@vercel/postgres", "@neondatabase/serverless"])(
  "refuses reachable alternate fallback %s before execution",
  async (name) => {
    const f = await fixture();
    await mkdir(join(f.root, "node_modules", name), { recursive: true });
    await expect(
      inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
    ).rejects.toThrow(/no install, download or fallback/);
  },
);
it("binds transitive ORM dependencies and refuses missing required packages", async () => {
  const f = await fixture();
  const manifest = JSON.parse(
    await readFile(join(f.orm, "package.json"), "utf8"),
  );
  manifest.dependencies = { nested: "1.0.0" };
  await writeFile(join(f.orm, "package.json"), JSON.stringify(manifest));
  await expect(
    inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
  ).rejects.toThrow();
  const dep = join(f.root, "node_modules/nested");
  await mkdir(dep);
  await writeFile(
    join(dep, "package.json"),
    JSON.stringify({ name: "nested", version: "1.0.0", main: "index.js" }),
  );
  await writeFile(join(dep, "index.js"), "one");
  const a = await inspectDrizzleToolchain({
    projectRoot: f.root,
    tool: f.tool,
  });
  await writeFile(join(dep, "index.js"), "two");
  expect(
    (await inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }))
      .sha256,
  ).not.toBe(a.sha256);
});
it("refuses a different Kit-local driver than the reviewed root", async () => {
  const f = await fixture();
  const nested = join(f.kit, "node_modules/pg");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "package.json"), "{}");
  await expect(
    inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
  ).rejects.toThrow();
});
it("refuses symlinked package entries", async () => {
  const f = await fixture();
  await symlink(join(f.pg, "index.js"), join(f.pg, "alias.js"));
  await expect(
    inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
  ).rejects.toThrow();
});

it.each(["0.18.20", "0.24.2", "0.25.3", "0.25.4-beta.1", "0.26.0"])(
  "refuses unqualified Kit-resolved esbuild %s",
  async (version) => {
    const f = await fixture();
    await writeFile(
      join(f.root, "node_modules/esbuild/package.json"),
      JSON.stringify({ name: "esbuild", version, main: "lib/main.js" }),
    );
    await expect(
      inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
    ).rejects.toThrow();
  },
);
it("includes the actually resolved patched esbuild bytes in consent", async () => {
  const f = await fixture();
  const a = await inspectDrizzleToolchain({
    projectRoot: f.root,
    tool: f.tool,
  });
  await writeFile(
    join(f.root, "node_modules/esbuild/lib/main.js"),
    "changed transform implementation",
  );
  expect(
    (await inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }))
      .sha256,
  ).not.toBe(a.sha256);
});

it.each([
  ["kit", "0.31.10"],
  ["orm", "0.45.3"],
  ["pg", "8.23.0"],
])("refuses installed %s version drift", async (key, version) => {
  const f = await fixture();
  const path = join(f[key], "package.json"),
    manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...manifest, version }));
  await expect(
    inspectDrizzleToolchain({ projectRoot: f.root, tool: f.tool }),
  ).rejects.toThrow(/requires exact local/);
});
