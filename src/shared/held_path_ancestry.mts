/**
 * Timestamp-based concurrent-change guard for a canonical directory ancestry.
 * This is not atomic openat resolution or a sandbox: it cannot prevent every
 * transient access or privileged timestamp manipulation. Callers retain their
 * own project-containment, regular-file and exact-input identity checks, use
 * only `path` for reads, assert before/after those reads, and close in finally.
 */
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const HELD_PATH_ANCESTRY_MAXIMUM_DIRECTORIES = 128;

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

export interface HeldPathAncestry {
  readonly path: string;
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

const unavailable = (): Error =>
  new Error("Path ancestry is unavailable, unsafe or changed.");

const identity = (details: BigIntStats): DirectoryIdentity => {
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    typeof details.dev !== "bigint" ||
    typeof details.ino !== "bigint" ||
    typeof details.ctimeNs !== "bigint" ||
    typeof details.mtimeNs !== "bigint"
  )
    throw unavailable();
  return {
    dev: details.dev,
    ino: details.ino,
    ctimeNs: details.ctimeNs,
    mtimeNs: details.mtimeNs,
  };
};

const same = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.ctimeNs === right.ctimeNs &&
  left.mtimeNs === right.mtimeNs;

export const holdPathAncestry = async (
  directory: string,
): Promise<HeldPathAncestry> => {
  const handles: FileHandle[] = [];
  const entries: Array<{
    readonly path: string;
    readonly handle: FileHandle;
    readonly identity: DirectoryIdentity;
  }> = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      let failed = false;
      for (const handle of handles.splice(0).reverse()) {
        try {
          await handle.close();
        } catch {
          failed = true;
        }
      }
      if (failed) throw unavailable();
    })();
    return closing;
  };
  try {
    if (!isAbsolute(directory)) throw unavailable();
    const path = resolve(directory);
    const root = parse(path).root;
    const segments = relative(root, path).split(sep).filter(Boolean);
    if (segments.length + 1 > HELD_PATH_ANCESTRY_MAXIMUM_DIRECTORIES)
      throw unavailable();
    // Reject aliases and all symlink ancestors, including ancestors above the
    // caller's project root. Root aliases must be canonicalized by the caller.
    if ((await realpath(path)) !== path) throw unavailable();
    const paths = [root];
    for (const segment of segments) paths.push(join(paths.at(-1)!, segment));
    for (const current of paths) {
      const before = identity(await lstat(current, { bigint: true }));
      const handle = await open(
        current,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      // Retain immediately: a later stat failure must still close this handle.
      handles.push(handle);
      const opened = identity(await handle.stat({ bigint: true }));
      const after = identity(await lstat(current, { bigint: true }));
      if (!same(before, opened) || !same(before, after)) throw unavailable();
      entries.push({ path: current, handle, identity: before });
    }
    const assertUnchanged = async (): Promise<void> => {
      try {
        if (closed || (await realpath(path)) !== path) throw unavailable();
        for (const entry of entries) {
          const held = identity(await entry.handle.stat({ bigint: true }));
          const lexical = identity(await lstat(entry.path, { bigint: true }));
          if (!same(entry.identity, held) || !same(entry.identity, lexical))
            throw unavailable();
        }
        if ((await realpath(path)) !== path) throw unavailable();
      } catch {
        await close().catch(() => {});
        throw unavailable();
      }
    };
    await assertUnchanged();
    return Object.freeze({ path, assertUnchanged, close });
  } catch {
    await close().catch(() => {});
    throw unavailable();
  }
};
