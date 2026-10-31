import { writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { knexFixture, removeKnexFixture } from "../../helpers/knex_fixture.mjs";
import { inspectKnexToolchain } from "../../../dist/src/runtime/knex_toolchain.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeKnexFixture(root);
});
const fixture = async () => {
  const f = await knexFixture();
  roots.push(f.root);
  return f;
};
it("binds native Knex's actually resolved pg and copied complete bytes without executing either", async () => {
  const f = await fixture(),
    copied = new Map();
  const a = await inspectKnexToolchain({
    projectRoot: f.root,
    tool: f.tool,
    onBytes: (path, bytes) => {
      copied.set(path, Buffer.from(bytes));
    },
  });
  expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(copied.has(join(f.pg, "index.js"))).toBe(true);
  expect(
    await inspectKnexToolchain({ projectRoot: f.root, tool: f.tool }),
  ).toEqual(a);
  await writeFile(join(f.pg, "index.js"), "changed");
  expect(
    (await inspectKnexToolchain({ projectRoot: f.root, tool: f.tool })).sha256,
  ).not.toBe(a.sha256);
});
it("refuses dynamically selected alternate pg, even if explicitly configured driver is exact", async () => {
  const f = await fixture(),
    nested = join(f.knex, "node_modules/pg");
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(nested, "package.json"),
    JSON.stringify({ name: "pg", version: "8.23.1", main: "index.js" }),
  );
  await writeFile(join(nested, "index.js"), "alternate");
  await expect(
    inspectKnexToolchain({ projectRoot: f.root, tool: f.tool }),
  ).rejects.toThrow(/no code/);
});
it("refuses unsafe versions, symlinked roots and malformed manifests without disclosing contents", async () => {
  const f = await fixture();
  await writeFile(join(f.pg, "package.json"), '{"PRIVATE_CANARY');
  let e;
  try {
    await inspectKnexToolchain({ projectRoot: f.root, tool: f.tool });
  } catch (error) {
    e = error;
  }
  expect(String(e)).not.toContain("PRIVATE_CANARY");
  await rm(f.pg, { recursive: true });
  await symlink(f.knex, f.pg);
  await expect(
    inspectKnexToolchain({ projectRoot: f.root, tool: f.tool }),
  ).rejects.toThrow();
});
