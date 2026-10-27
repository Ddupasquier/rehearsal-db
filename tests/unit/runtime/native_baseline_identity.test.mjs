import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  unlink,
  rm,
  readFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertNativeBaselineManifestUnchanged,
  assertActiveBaselineUnchanged,
} from "../../../dist/src/runtime/baseline_identity.mjs";
const mutation = vi.hoisted(() => ({ afterRead: null }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    open: async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith("/baseline-manifest.json")) {
        const read = handle.read.bind(handle);
        handle.read = async (...values) => {
          const result = await read(...values);
          await mutation.afterRead?.(String(args[0]), actual);
          return result;
        };
      }
      return handle;
    },
  };
});
const roots = [];
afterEach(async () => {
  mutation.afterRead = null;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "native-baseline-identity-"));
  roots.push(parent);
  const root = join(parent, ".rehearsal");
  const generationId = "20261027T000000Z-aaaaaaaaaaaa",
    directory = join(root, "generations", generationId),
    manifestPath = join(directory, "baseline-manifest.json");
  await mkdir(directory, { recursive: true });
  const expected = {
    formatVersion: 3,
    generationId,
    nativeMigrations: {
      schemaVersion: 1,
      kind: "prisma",
      version: "7.10.1",
      provider: "postgresql",
      lockSha256: "a".repeat(64),
      toolchainSha256: "b".repeat(64),
    },
    files: { "sanitized-data.ndjson": { sha256: "c".repeat(64) } },
  };
  await writeFile(manifestPath, JSON.stringify(expected));
  await symlink("generations/" + generationId, join(root, "current"));
  return {
    root,
    manifestPath,
    expected,
    check: () =>
      assertNativeBaselineManifestUnchanged({ artifactRoot: root, expected }),
  };
}
it("asserts metadata identity without reading or claiming to verify a row payload", async () => {
  const f = await fixture();
  await expect(f.check()).resolves.toBeUndefined();
  await expect(
    readFile(
      join(
        f.root,
        "generations",
        f.expected.generationId,
        "sanitized-data.ndjson",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses a different active generation even when its manifest copies the reviewed data digest", async () => {
  const f = await fixture();
  const next = "20261027T000001Z-bbbbbbbbbbbb";
  await mkdir(join(f.root, "generations", next));
  await writeFile(
    join(f.root, "generations", next, "baseline-manifest.json"),
    JSON.stringify({ ...f.expected, generationId: next }),
  );
  await unlink(join(f.root, "current"));
  await symlink("generations/" + next, join(f.root, "current"));
  await expect(f.check()).rejects.toThrow("active baseline changed");
});
it("refuses changed manifest metadata and symlinked manifest leaves", async () => {
  const f = await fixture();
  await writeFile(
    f.manifestPath,
    JSON.stringify({
      ...f.expected,
      files: { "sanitized-data.ndjson": { sha256: "d".repeat(64) } },
    }),
  );
  await expect(f.check()).rejects.toThrow("active baseline changed");
  const backup = f.manifestPath + ".saved";
  await rename(f.manifestPath, backup);
  await symlink(backup, f.manifestPath);
  await expect(f.check()).rejects.toThrow();
});
it.each(["inode", "pointer"])(
  "refuses %s replacement during the actual metadata FD read",
  async (mode) => {
    const f = await fixture();
    mutation.afterRead = async (file, actual) => {
      mutation.afterRead = null;
      if (mode === "inode") {
        const bytes = await actual.readFile(file);
        await actual.rename(file, file + ".saved");
        await actual.writeFile(file, bytes);
      } else {
        await actual.unlink(join(f.root, "current"));
        await actual.symlink(
          "generations/" + f.expected.generationId,
          join(f.root, "current"),
        );
      }
    };
    await expect(f.check()).rejects.toThrow();
  },
);
it("bounds native metadata at 8 MiB and refuses applying that new bound to SQL formats", async () => {
  const f = await fixture();
  await writeFile(f.manifestPath, " ".repeat(8 * 1024 * 1024 + 1));
  await expect(f.check()).rejects.toThrow("8 MiB");
  await expect(
    assertNativeBaselineManifestUnchanged({
      artifactRoot: f.root,
      expected: { ...f.expected, formatVersion: 2 },
    }),
  ).rejects.toThrow("requires format 3");
});

it("compares fresh active baseline identity including generation, data and history without substituting a toolchain digest", () => {
  const baseline = {
    generationId: "baseline-reviewed",
    files: { "sanitized-data.ndjson": { sha256: "a".repeat(64) } },
    sanitizationPolicySha256: "b".repeat(64),
    migrations: { "20260101000000_init.sql": { sha256: "c".repeat(64) } },
  };
  expect(() =>
    assertActiveBaselineUnchanged(baseline, structuredClone(baseline)),
  ).not.toThrow();
  for (const current of [
    { ...baseline, generationId: "changed" },
    {
      ...baseline,
      files: { "sanitized-data.ndjson": { sha256: "d".repeat(64) } },
    },
    { ...baseline, sanitizationPolicySha256: "e".repeat(64) },
    {
      ...baseline,
      migrations: { "20260101000000_init.sql": { sha256: "f".repeat(64) } },
    },
  ])
    expect(() => assertActiveBaselineUnchanged(baseline, current)).toThrow(
      "active baseline changed",
    );
});
