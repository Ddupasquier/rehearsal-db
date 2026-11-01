import { spawnSync } from "node:child_process";
import {
  mkdir,
  writeFile,
  chmod,
  access,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  knexFixture,
  configureKnexFixture,
  removeKnexFixture,
} from "../../../helpers/knex_fixture.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeKnexFixture(root);
});
const fixture = async () => {
  const f = await knexFixture();
  roots.push(f.root);
  const configured = await configureKnexFixture(f),
    bin = join(f.root, "deny-bin"),
    trace = join(f.root, "engine-executed");
  await mkdir(bin);
  for (const name of ["docker", "colima", "psql", "knex", "supabase", "open"]) {
    const path = join(bin, name);
    await writeFile(
      path,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)},'DENIED');process.exit(81);`,
    );
    await chmod(path, 0o700);
  }
  return { ...configured, bin, trace };
};
const invoke = (f, entry = f.plan.targets[0].entries[2], extra = {}) => {
  const flags = {
    target: "primary",
    "native-identity": JSON.stringify(entry.nativeIdentity),
    "source-sha256": entry.sha256,
    "candidate-sha256": f.plan.candidateSha256,
    ...extra,
  };
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist/src/cli/rehearsal.mjs"),
      "inspect",
      "source",
      "--json",
      ...Object.entries(flags).map(([k, v]) => `--${k}=${v}`),
    ],
    {
      cwd: f.root,
      env: { ...process.env, PATH: f.bin, REHEARSAL_UPDATE_CHECK: "off" },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  return { ...result, output: JSON.parse(result.stdout) };
};
it("public CLI returns only exact reviewed native code references for represented and pending names without executing SDK/engines", async () => {
  const f = await fixture();
  for (const row of [
    f.plan.targets[0].entries[0],
    f.plan.targets[0].entries[2],
  ]) {
    const result = invoke(f, row);
    expect(result.status).toBe(0);
    const ref = result.output.data;
    expect(ref.schemaVersion).toBe(2);
    expect(ref.nativeIdentity).toEqual(row.nativeIdentity);
    expect(ref.filename).toBe(row.filename);
    expect(ref.sha256).toBe(row.sha256);
    expect(ref.line).toBe(null);
    expect(ref.column).toBe(null);
    expect(JSON.stringify(result.output)).not.toContain(
      "PRIVATE_SOURCE_CANARY",
    );
  }
  await expect(access(f.trace)).rejects.toThrow();
});
it("public CLI refuses stale identity, file digest, whole-plan consent and caller paths with no engine contact", async () => {
  const f = await fixture();
  for (const extra of [
    {
      "native-identity": JSON.stringify({
        kind: "knex",
        name: "../private.cjs",
      }),
    },
    { "source-sha256": "0".repeat(64) },
    { "candidate-sha256": "0".repeat(64) },
    { path: "outside.cjs" },
  ])
    expect(invoke(f, undefined, extra).status).not.toBe(0);
  await expect(access(f.trace)).rejects.toThrow();
});
it("refuses a symlink substituted for reviewed code", async () => {
  const f = await fixture(),
    file = join(f.directory, "003_pending.cjs"),
    backup = join(f.root, "owned-backup.cjs");
  await rename(file, backup);
  await symlink(backup, file);
  try {
    expect(invoke(f).status).not.toBe(0);
  } finally {
    await rm(file);
    await rename(backup, file);
  }
  await expect(access(f.trace)).rejects.toThrow();
});
