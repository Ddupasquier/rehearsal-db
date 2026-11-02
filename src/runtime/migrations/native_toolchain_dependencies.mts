/** Resolve installed runtime package metadata only; never imports or evaluates package code. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { holdPathAncestry } from "../../shared/held_path_ancestry.mjs";
export const NATIVE_TOOLCHAIN_LIMITS = Object.freeze({
  maximumPackages: 256,
  maximumWorkers: 4,
  maximumInflightBytes: 64 * 1024 * 1024,
  maximumEntries: 20480,
  maximumFiles: 16384,
  maximumFileBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 384 * 1024 * 1024,
  maximumManifestBytes: 1024 * 1024,
});
/** Bound actual read buffers, including their growth sentinels, across fixed workers. */
export function createNativeReadBudget() {
  let inflight = 0;
  const waiters: Array<() => void> = [];
  return async (size: number): Promise<() => void> => {
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > NATIVE_TOOLCHAIN_LIMITS.maximumInflightBytes
    )
      throw invalidNativeToolchain();
    while (inflight + size > NATIVE_TOOLCHAIN_LIMITS.maximumInflightBytes)
      await new Promise<void>((done) => waiters.push(done));
    inflight += size;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inflight -= size;
      for (const wake of waiters.splice(0)) wake();
    };
  };
}
export const invalidNativeToolchain = () =>
  new Error(
    "Native migration execution requires an unchanged, bounded, regular project-local resolved runtime dependency closure; no installation or fallback was attempted.",
  );
const inside = (root: string, path: string) => {
  const local = relative(root, path);
  return (
    !!local &&
    local !== ".." &&
    !local.startsWith(`..${sep}`) &&
    !isAbsolute(local)
  );
};
const packageName = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u;
async function manifestAt(root: string, directory: string) {
  if (!inside(root, directory) || (await realpath(directory)) !== directory)
    throw invalidNativeToolchain();
  const held = await holdPathAncestry(directory);
  try {
    const path = join(directory, "package.json"),
      before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > NATIVE_TOOLCHAIN_LIMITS.maximumManifestBytes
    )
      throw invalidNativeToolchain();
    const fd = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await fd.stat();
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.ctimeMs !== before.ctimeMs
      )
        throw invalidNativeToolchain();
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await fd.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const after = await fd.stat(),
        leaf = await lstat(path);
      if (
        offset !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        leaf.isSymbolicLink() ||
        leaf.dev !== before.dev ||
        leaf.ino !== before.ino ||
        leaf.ctimeMs !== before.ctimeMs
      )
        throw invalidNativeToolchain();
      await held.assertUnchanged();
      const content = bytes.subarray(0, offset);
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(content),
        );
      } catch {
        throw invalidNativeToolchain();
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalidNativeToolchain();
      const manifest = value as Record<string, unknown>;
      if (
        typeof manifest.name !== "string" ||
        !packageName.test(manifest.name) ||
        typeof manifest.version !== "string" ||
        !manifest.version ||
        manifest.version.length > 128
      )
        throw invalidNativeToolchain();
      return {
        manifest,
        manifestSha256: createHash("sha256").update(content).digest("hex"),
      };
    } finally {
      await fd.close();
    }
  } finally {
    await held.close();
  }
}
function map(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidNativeToolchain();
  return value as Record<string, unknown>;
}
export async function resolveNativeRuntimePackages(
  root: string,
  roots: readonly string[],
) {
  const queue = [...roots],
    found = new Map<
      string,
      { directory: string; name: string; manifestSha256: string }
    >();
  // A package can be reached by many declaring parents. Read its exact metadata
  // once per observation; the caller re-observes the complete resolution after hashing.
  const metadata = new Map<string, Awaited<ReturnType<typeof manifestAt>>>();
  const readManifest = async (directory: string) => {
    const prior = metadata.get(directory);
    if (prior) return prior;
    const value = await manifestAt(root, directory);
    metadata.set(directory, value);
    return value;
  };
  while (queue.length) {
    const directory = queue.shift()!;
    if (found.has(directory)) continue;
    if (found.size >= NATIVE_TOOLCHAIN_LIMITS.maximumPackages)
      throw invalidNativeToolchain();
    const { manifest, manifestSha256 } = await readManifest(directory);
    found.set(directory, {
      directory,
      name: manifest.name as string,
      manifestSha256,
    });
    const required = map(manifest.dependencies),
      optional = map(manifest.optionalDependencies),
      peers = map(manifest.peerDependencies),
      peerMeta = map(manifest.peerDependenciesMeta);
    const names = [
      ...new Set([
        ...Object.keys(required),
        ...Object.keys(optional),
        ...Object.keys(peers),
      ]),
    ].sort();
    if (names.length > NATIVE_TOOLCHAIN_LIMITS.maximumPackages)
      throw invalidNativeToolchain();
    const resolver = createRequire(join(directory, "package.json"));
    for (const name of names) {
      if (!packageName.test(name) || name === "." || name === "..")
        throw invalidNativeToolchain();
      const spec = optional[name] ?? required[name] ?? peers[name];
      if (typeof spec !== "string" || !spec || spec.length > 1024)
        throw invalidNativeToolchain();
      const absentAllowed =
        Object.hasOwn(optional, name) ||
        (!Object.hasOwn(required, name) &&
          map(peerMeta[name]).optional === true);
      const search = resolver.resolve.paths(name);
      if (!search || search.length > 128) throw invalidNativeToolchain();
      let selected: string | undefined;
      for (const parent of search) {
        const candidate = join(parent, name);
        try {
          const stat = await lstat(candidate);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            !inside(root, candidate)
          )
            throw invalidNativeToolchain();
          selected = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!selected) {
        if (absentAllowed) continue;
        throw invalidNativeToolchain();
      }
      const child = await readManifest(selected);
      // npm aliases are explicit in the declaring manifest, never inferred.
      const expected = spec.startsWith("npm:")
        ? spec.slice(4).replace(/@[^@]*$/u, "")
        : name;
      if (child.manifest.name !== expected) throw invalidNativeToolchain();
      queue.push(selected);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0,
  );
}
