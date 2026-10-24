import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  handles: [],
  beforeOpen: null,
  transformStat: null,
  closeFailurePath: null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: async (path, flags, ...options) => {
      if (io.beforeOpen) await io.beforeOpen(path);
      const handle = await actual.open(path, flags, ...options);
      const entry = { path, flags, closeCalls: 0, closed: false };
      io.handles.push(entry);
      return {
        stat: async (statOptions) => {
          const details = await handle.stat(statOptions);
          return io.transformStat ? io.transformStat(path, details) : details;
        },
        close: async () => {
          entry.closeCalls++;
          await handle.close();
          entry.closed = true;
          if (path === io.closeFailurePath)
            throw new Error("PRIVATE_CLOSE_FAILURE");
        },
      };
    },
  };
});

import {
  HELD_PATH_ANCESTRY_MAXIMUM_DIRECTORIES,
  holdPathAncestry,
} from "../../../dist/src/shared/held_path_ancestry.mjs";

const roots = [];
const held = [];
const message = "Path ancestry is unavailable, unsafe or changed.";
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rehearsal-held-ancestry-")),
  );
  roots.push(root);
  const upper = join(root, "upper");
  const project = join(upper, "project");
  const directory = join(project, "migrations");
  const outside = join(root, "outside");
  await mkdir(directory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(directory, "input.sql"), "INSIDE_INPUT");
  await writeFile(join(outside, "input.sql"), "PRIVATE_OUTSIDE_INPUT");
  return { root, upper, project, directory, outside };
};
const acquire = async (directory) => {
  const result = await holdPathAncestry(directory);
  held.push(result);
  return result;
};
const expectAllClosed = () => {
  expect(io.handles.length).toBeGreaterThan(0);
  expect(io.handles.every((entry) => entry.closed)).toBe(true);
  expect(io.handles.every((entry) => entry.closeCalls === 1)).toBe(true);
};

beforeEach(() => {
  io.handles = [];
  io.beforeOpen = null;
  io.transformStat = null;
  io.closeFailurePath = null;
});
afterEach(async () => {
  for (const ancestry of held.splice(0)) await ancestry.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("held canonical path ancestry", () => {
  it("holds no-follow directories from filesystem root through the leaf and closes each once", async () => {
    const { directory } = await fixture();
    const ancestry = await acquire(directory);
    expect(ancestry.path).toBe(directory);
    expect(io.handles[0].path).toBe(parse(directory).root);
    expect(io.handles.at(-1).path).toBe(directory);
    expect(io.handles.length).toBeLessThanOrEqual(
      HELD_PATH_ANCESTRY_MAXIMUM_DIRECTORIES,
    );
    expect(
      io.handles.every(
        ({ flags }) =>
          (flags & constants.O_DIRECTORY) !== 0 &&
          (flags & constants.O_NOFOLLOW) !== 0,
      ),
    ).toBe(true);
    await ancestry.assertUnchanged();
    expect(await readFile(join(ancestry.path, "input.sql"), "utf8")).toBe(
      "INSIDE_INPUT",
    );
    await ancestry.assertUnchanged();
    await ancestry.close();
    await ancestry.close();
    expectAllClosed();
    await expect(ancestry.assertUnchanged()).rejects.toThrow(message);
    expectAllClosed();
  });

  it.each(["parent", "leaf"])(
    "refuses a preexisting symlinked %s, even when it stays inside the fixture",
    async (kind) => {
      const { root, project, directory } = await fixture();
      const alias = join(root, "alias");
      await symlink(kind === "parent" ? project : directory, alias);
      const requested = kind === "parent" ? join(alias, "migrations") : alias;
      await expect(holdPathAncestry(requested)).rejects.toThrow(message);
      expect(io.handles).toEqual([]);
    },
  );

  it("refuses a symlink escape and never opens its outside directory", async () => {
    const { root, outside } = await fixture();
    const alias = join(root, "escape");
    await symlink(outside, alias);
    await expect(holdPathAncestry(alias)).rejects.toThrow(message);
    expect(io.handles).toEqual([]);
    expect(await readFile(join(outside, "input.sql"), "utf8")).toBe(
      "PRIVATE_OUTSIDE_INPUT",
    );
  });

  it.each(["upper", "project", "directory"])(
    "detects an ordinary %s rename and restore during a held read",
    async (key) => {
      const paths = await fixture();
      const ancestry = await acquire(paths.directory);
      const original = paths[key];
      const moved = `${original}-moved`;
      await rename(original, moved);
      await rename(moved, original);
      await expect(ancestry.assertUnchanged()).rejects.toThrow(message);
      expectAllClosed();
    },
  );

  it("detects a transient ancestor symlink and restore despite the original final path and leaf inode", async () => {
    const { project, directory, outside } = await fixture();
    const ancestry = await acquire(directory);
    const moved = `${project}-moved`;
    // The helper is not atomic openat: an adversarial path can transiently lead
    // outside. Its post-read ancestry guard must refuse that result, not bless it.
    await mkdir(join(outside, "migrations"));
    await writeFile(
      join(outside, "migrations/input.sql"),
      "PRIVATE_TRANSIENT_INPUT",
    );
    await rename(project, moved);
    try {
      await symlink(outside, project);
      expect(await readFile(join(directory, "input.sql"), "utf8")).toBe(
        "PRIVATE_TRANSIENT_INPUT",
      );
    } finally {
      await rm(project, { force: true });
      await rename(moved, project);
    }
    await expect(ancestry.assertUnchanged()).rejects.toThrow(message);
    expectAllClosed();
  });

  it("detects replacement of the directory leaf with another ordinary directory", async () => {
    const { directory } = await fixture();
    const ancestry = await acquire(directory);
    await rename(directory, `${directory}-moved`);
    await mkdir(directory);
    await expect(ancestry.assertUnchanged()).rejects.toThrow(message);
    expectAllClosed();
  });

  it("does not claim to detect in-place file-content changes without the caller's leaf guard", async () => {
    const { directory } = await fixture();
    const ancestry = await acquire(directory);
    await writeFile(join(directory, "input.sql"), "CHANGED_INPUT");
    await expect(ancestry.assertUnchanged()).resolves.toBeUndefined();
    await ancestry.close();
    expectAllClosed();
  });

  it("refuses a directory replacement between lstat and open and closes already-held ancestors", async () => {
    const { directory } = await fixture();
    io.beforeOpen = async (path) => {
      if (path !== directory) return;
      io.beforeOpen = null;
      await rename(directory, `${directory}-moved`);
      await mkdir(directory);
    };
    await expect(holdPathAncestry(directory)).rejects.toThrow(message);
    expectAllClosed();
  });

  it.each(["ino", "ctimeNs", "mtimeNs"])(
    "refuses unavailable or divergent %s descriptor metadata",
    async (key) => {
      const { directory } = await fixture();
      io.transformStat = (path, details) =>
        path !== directory
          ? details
          : new Proxy(details, {
              get(target, property) {
                if (property === key)
                  return key === "ino" ? target.ino + 1n : undefined;
                return Reflect.get(target, property);
              },
            });
      await expect(holdPathAncestry(directory)).rejects.toThrow(message);
      expectAllClosed();
    },
  );

  it("closes every earlier descriptor after a later open fails and redacts the underlying error", async () => {
    const { directory } = await fixture();
    io.beforeOpen = async (path) => {
      if (path === directory) throw new Error("PRIVATE_OPEN_FAILURE");
    };
    await expect(holdPathAncestry(directory)).rejects.toThrow(message);
    expectAllClosed();
  });

  it("attempts every descriptor close even if one fails and keeps the error fixed", async () => {
    const { directory } = await fixture();
    const ancestry = await acquire(directory);
    io.closeFailurePath = directory;
    await expect(ancestry.close()).rejects.toThrow(message);
    expectAllClosed();
    await expect(ancestry.close()).rejects.toThrow(message);
    expectAllClosed();
  });

  it("still closes all descriptors when metadata refusal and one close failure coincide", async () => {
    const { directory } = await fixture();
    const ancestry = await acquire(directory);
    io.closeFailurePath = directory;
    await mkdir(join(directory, "new-entry"));
    await expect(ancestry.assertUnchanged()).rejects.toThrow(message);
    expectAllClosed();
  });

  it("bounds ancestry depth before opening and refuses relative paths or regular files", async () => {
    const { directory } = await fixture();
    const deep =
      parse(directory).root +
      Array(HELD_PATH_ANCESTRY_MAXIMUM_DIRECTORIES).fill("component").join(sep);
    await expect(holdPathAncestry(deep)).rejects.toThrow(message);
    await expect(holdPathAncestry("../outside")).rejects.toThrow(message);
    expect(io.handles).toEqual([]);
    await expect(
      holdPathAncestry(join(directory, "input.sql")),
    ).rejects.toThrow(message);
    expectAllClosed();
  });
});
