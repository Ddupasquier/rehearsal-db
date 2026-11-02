/** Bounded local JSON reader; final symlinks and escaped ancestors fail closed. */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export const readBoundedShapeJson = async (
  path: string,
  { root }: { readonly root: string },
): Promise<Readonly<{ bytes: Buffer; value: unknown }>> => {
  const maximumBytes = 1024 * 1024;
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Shape JSON boundary must not be a symbolic link.");
  const canonicalRoot = await realpath(root);
  const localPath = async (): Promise<string> => {
    if ((await realpath(root)) !== canonicalRoot)
      throw new Error("Shape JSON boundary changed during inspection.");
    const candidate = await realpath(path);
    const local = relative(canonicalRoot, candidate);
    if (
      !local ||
      local === ".." ||
      local.startsWith("../") ||
      local.startsWith("..\\") ||
      isAbsolute(local)
    )
      throw new Error(
        "Shape JSON must remain inside its declared local boundary.",
      );
    return candidate;
  };
  const candidate = await localPath();
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > maximumBytes
  ) {
    throw new Error(
      "Shape JSON must be a bounded regular file, not a symbolic link.",
    );
  }
  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const currentPath = await localPath();
    const current = await lstat(path);
    if (
      !opened.isFile() ||
      opened.ino !== details.ino ||
      opened.dev !== details.dev ||
      currentPath !== candidate ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    ) {
      throw new Error("Shape JSON changed while opening it.");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes)
      throw new Error("Shape JSON exceeds its read boundary.");
    const bytes = buffer.subarray(0, offset);
    const afterPath = await localPath();
    const after = await lstat(path);
    if (
      afterPath !== candidate ||
      after.isSymbolicLink() ||
      opened.ino !== after.ino ||
      opened.dev !== after.dev
    )
      throw new Error("Shape JSON changed while reading it.");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Shape JSON is invalid; no source value was printed.");
    }
    return Object.freeze({ bytes, value });
  } finally {
    await handle.close();
  }
};
