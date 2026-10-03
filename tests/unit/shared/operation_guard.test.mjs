import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireProjectOperation,
  assertInstalledPackageFingerprint,
  createInstalledPackageFingerprint,
} from "../../../src/shared/operation_guard.mjs";

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

  it("detects an installed package replacement during an operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-package-test-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "src/runtime"), { recursive: true }),
      mkdir(join(root, "scripts/runtime"), { recursive: true }),
    ]);
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}\n');
    await writeFile(
      join(root, "src/runtime/runtime.mjs"),
      "export const version = 1;\n",
    );
    const expected = createInstalledPackageFingerprint({ packageRoot: root });
    expect(
      assertInstalledPackageFingerprint({ packageRoot: root, expected }),
    ).toEqual(expected);
    await writeFile(
      join(root, "src/runtime/runtime.mjs"),
      "export const version = 2;\n",
    );
    expect(() =>
      assertInstalledPackageFingerprint({ packageRoot: root, expected }),
    ).toThrow("changed during this operation");
  });
});
