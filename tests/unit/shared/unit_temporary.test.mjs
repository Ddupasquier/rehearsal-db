import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import setup from "../../helpers/unit_temporary_global.mjs";
import { holdPathAncestry } from "../../../dist/src/shared/held_path_ancestry.mjs";

describe("parallel unit scratch ownership", () => {
  it("precreates distinct worker roots and keeps other-worker writes out of a held ancestry", async () => {
    const root = await mkdtemp(join(tmpdir(), "unit-temp-proof-"));
    let workers;
    const cleanup = await setup({
      config: { root, maxWorkers: 2 },
      provide: (key, value) => {
        expect(key).toBe("rehearsalUnitTemporaryRoots");
        workers = value;
      },
    });
    let held;
    try {
      expect(workers).toHaveLength(2);
      expect(new Set(workers).size).toBe(2);
      expect(
        workers.every((path) => !relative(root, path).startsWith("..")),
      ).toBe(true);
      const directory = join(workers[0], "project/migrations");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "input.sql"), "INSIDE");
      held = await holdPathAncestry(directory);
      await mkdir(join(workers[1], "independent-project"));
      await held.assertUnchanged();
      await held.close();
      held = undefined;
      // The strict guard is not relaxed: same-ancestor sibling churn still refuses.
      held = await holdPathAncestry(directory);
      await mkdir(join(workers[0], "same-worker-sibling"));
      await expect(held.assertUnchanged()).rejects.toThrow("Path ancestry");
    } finally {
      await held?.close();
      await cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("removes only its generated tree and never follows a fixture symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "unit-temp-cleanup-"));
    let workers;
    const cleanup = await setup({
      config: { root, maxWorkers: 1 },
      provide: (_key, value) => {
        workers = value;
      },
    });
    const sentinel = join(root, "outside.txt");
    try {
      await writeFile(sentinel, "PRESERVE");
      await symlink(sentinel, join(workers[0], "escape"));
      await cleanup();
      expect(await readFile(sentinel, "utf8")).toBe("PRESERVE");
      expect(await readdir(join(root, "test-results"))).toEqual([]);
      expect((await lstat(sentinel)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
