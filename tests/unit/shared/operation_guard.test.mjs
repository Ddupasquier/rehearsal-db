import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireProjectOperation,
  assertInstalledPackageFingerprint,
  createInstalledPackageFingerprint,
  inspectProjectOperationLocks,
  inspectProjectOperationState,
} from "../../../dist/src/shared/operation_guard.mjs";

const lockRoot = join(tmpdir(), "rehearsal-db-operation-locks");

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project operation guard", () => {
  it("allows one project mutation at a time and releases it exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-operation-test-"));
    roots.push(root);
    const first = await acquireProjectOperation({
      projectRoot: root,
      command: "run",
    });
    await expect(
      acquireProjectOperation({ projectRoot: root, command: "discard" }),
    ).rejects.toThrow("already running");
    first.releaseSync();
    const second = await acquireProjectOperation({
      projectRoot: root,
      command: "discard",
    });
    await second.release();
  });

  it("reports independent idle and busy project state without private owner data", async () => {
    const firstRoot = await mkdtemp(
      join(tmpdir(), "rehearsal-operation-first-"),
    );
    const secondRoot = await mkdtemp(
      join(tmpdir(), "rehearsal-operation-second-"),
    );
    roots.push(firstRoot, secondRoot);
    const operation = await acquireProjectOperation({
      projectRoot: firstRoot,
      command: "open",
    });
    try {
      const busy = await inspectProjectOperationState({
        projectRoot: firstRoot,
      });
      expect(busy).toMatchObject({
        schemaVersion: 1,
        state: "busy",
        operation: { kind: "open" },
      });
      expect(busy.operation).not.toHaveProperty("pid");
      expect(busy.operation).not.toHaveProperty("token");
      await expect(
        inspectProjectOperationState({ projectRoot: secondRoot }),
      ).resolves.toEqual({
        schemaVersion: 1,
        state: "idle",
        operation: null,
      });
    } finally {
      await operation.release();
    }
  });

  it.each([
    ["stale", async (owner) => ({ ...owner, pid: Number.MAX_SAFE_INTEGER })],
    ["invalid", async () => ({ nope: true })],
  ])("reports %s internal state without changing it", async (state, edit) => {
    const root = await mkdtemp(join(tmpdir(), `rehearsal-operation-${state}-`));
    roots.push(root);
    const before = new Set(await inspectProjectOperationLocks());
    await acquireProjectOperation({ projectRoot: root, command: "reset" });
    const lockName = (await inspectProjectOperationLocks()).find(
      (name) => !before.has(name),
    );
    expect(lockName).toBeTruthy();
    const lockDirectory = join(lockRoot, lockName);
    const ownerPath = join(lockDirectory, "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, `${JSON.stringify(await edit(owner))}\n`);
    try {
      await expect(
        inspectProjectOperationState({ projectRoot: root }),
      ).resolves.toMatchObject({
        schemaVersion: 1,
        state,
      });
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  });

  it("detects an installed package replacement during an operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-package-test-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "dist/src/runtime"), { recursive: true }),
      mkdir(join(root, "dist/scripts/runtime"), { recursive: true }),
    ]);
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}\n');
    await writeFile(
      join(root, "dist/src/runtime/runtime.mjs"),
      "export const version = 1;\n",
    );
    const expected = createInstalledPackageFingerprint({ packageRoot: root });
    expect(
      assertInstalledPackageFingerprint({ packageRoot: root, expected }),
    ).toEqual(expected);
    await writeFile(
      join(root, "dist/src/runtime/runtime.mjs"),
      "export const version = 2;\n",
    );
    expect(() =>
      assertInstalledPackageFingerprint({ packageRoot: root, expected }),
    ).toThrow("changed during this operation");
  });
});
