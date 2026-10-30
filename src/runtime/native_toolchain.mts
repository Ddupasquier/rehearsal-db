/** Fingerprint a reviewed project-local native migration installation without executing it. */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  resolveNativeRuntimePackages,
  NATIVE_TOOLCHAIN_LIMITS,
  invalidNativeToolchain,
  createNativeReadBudget,
} from "./native_toolchain_dependencies.mjs";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";
const invalid = invalidNativeToolchain;
const same = (a: Stats, b: Stats) =>
  !b.isSymbolicLink() &&
  a.isFile() === b.isFile() &&
  a.isDirectory() === b.isDirectory() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
export interface NativePackageProfile {
  readonly label: string;
  readonly directory: string;
  readonly name: string;
  readonly version: string | ((value: unknown) => boolean);
  readonly bin?: Readonly<{ key: string; value: string }>;
  readonly nativePattern?: RegExp;
}
export const inspectNativeToolchain = async ({
  projectRoot,
  profiles,
  onBytes,
}: {
  projectRoot: string;
  profiles: readonly NativePackageProfile[];
  onBytes?: (path: string, bytes: Buffer) => Promise<void> | void;
}) => {
  const root = await realpath(projectRoot);
  const roots = profiles.map((profile) => {
    const directory = resolve(root, profile.directory),
      local = relative(root, directory);
    if (
      !local ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local)
    )
      throw invalid();
    return { ...profile, directory };
  });
  if (
    roots.length < 1 ||
    roots.length > 8 ||
    new Set(roots.map((x) => x.directory)).size !== roots.length ||
    new Set(roots.map((x) => x.label)).size !== roots.length
  )
    throw invalid();
  const packages = await resolveNativeRuntimePackages(
    root,
    roots.map((x) => x.directory),
  );
  const entrypoints = new Map<
    string,
    { directory: string; cliPath?: string; nativePath?: string }
  >();
  for (const profile of roots)
    entrypoints.set(profile.label, {
      directory: profile.directory,
      ...(profile.bin
        ? { cliPath: join(profile.directory, profile.bin.value) }
        : {}),
    });
  const hashes: Array<{ path: string; sha256: string }> = [],
    witnesses: Array<{ path: string; stat: Stats }> = [];
  let bytes = 0,
    visited = 0,
    fileCount = 0;
  // Fixed four workers share a 64MiB buffer budget, including the growth sentinel.
  // Reservation and release are synchronous; no worker can over-admit the budget.
  const acquire = createNativeReadBudget();
  for (const selected of packages) {
    const directory = selected.directory;
    const profile = roots.find((x) => x.directory === directory);
    const prefix =
      profile?.label ?? relative(root, directory).split(sep).join("/");
    const held = await holdPathAncestry(directory);
    try {
      const files: Array<{ path: string; name: string; before: Stats }> = [];
      // Directory-boundary ancestry observations plus every final immutable
      // witness detect timestamp/identity drift. This is not atomic openat
      // resolution or a filesystem sandbox against a malicious local owner.
      const enumerate = async (
        path: string,
        observed?: Stats,
      ): Promise<void> => {
        if (!observed && ++visited > NATIVE_TOOLCHAIN_LIMITS.maximumEntries)
          throw invalid();
        const before = observed ?? (await lstat(path));
        if (before.isSymbolicLink()) throw invalid();
        if (before.isDirectory()) {
          await held.assertUnchanged();
          const pending: string[] = [];
          const flush = async () => {
            if (!pending.length) return;
            const batch = pending.splice(0);
            if (visited + batch.length > NATIVE_TOOLCHAIN_LIMITS.maximumEntries)
              throw invalid();
            visited += batch.length;
            const observations = await Promise.allSettled(
              batch.map((child) => lstat(child)),
            );
            const failure = observations.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") throw failure.reason;
            // Finish this entire batch before descending. Recursion therefore
            // cannot multiply the global four-request metadata bound.
            for (let i = 0; i < batch.length; i++) {
              const observation = observations[i]!;
              if (observation.status !== "fulfilled") throw invalid();
              await enumerate(batch[i]!, observation.value);
            }
          };
          for await (const entry of await opendir(path)) {
            if (entry.name === "node_modules") {
              if (
                ++visited > NATIVE_TOOLCHAIN_LIMITS.maximumEntries ||
                !entry.isDirectory() ||
                entry.isSymbolicLink()
              )
                throw invalid();
              continue;
            }
            pending.push(join(path, entry.name));
            if (pending.length === NATIVE_TOOLCHAIN_LIMITS.maximumWorkers)
              await flush();
          }
          await flush();
          if (!same(before, await lstat(path))) throw invalid();
          witnesses.push({ path, stat: before });
          await held.assertUnchanged();
          return;
        }
        if (
          !before.isFile() ||
          ++fileCount > NATIVE_TOOLCHAIN_LIMITS.maximumFiles ||
          before.size > NATIVE_TOOLCHAIN_LIMITS.maximumFileBytes ||
          bytes + before.size > NATIVE_TOOLCHAIN_LIMITS.maximumTotalBytes ||
          before.size + 1 > NATIVE_TOOLCHAIN_LIMITS.maximumInflightBytes
        )
          throw invalid();
        bytes += before.size;
        files.push({
          path,
          name: relative(directory, path).split(sep).join("/"),
          before,
        });
      };
      await enumerate(directory);
      let next = 0,
        failed = false;
      const worker = async () => {
        while (!failed && next < files.length) {
          const { path, name, before } = files[next++]!;
          let release: (() => void) | undefined;
          try {
            release = await acquire(before.size + 1);
            const handle = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              if (!same(before, await handle.stat())) throw invalid();
              const content = Buffer.alloc(before.size + 1);
              let offset = 0;
              while (offset < content.length) {
                const part = await handle.read(
                  content,
                  offset,
                  content.length - offset,
                  offset,
                );
                if (!part.bytesRead) break;
                offset += part.bytesRead;
              }
              if (
                offset !== before.size ||
                !same(before, await handle.stat()) ||
                !same(before, await lstat(path))
              )
                throw invalid();
              const data = content.subarray(0, offset),
                sha256 = createHash("sha256").update(data).digest("hex");
              if (name === "package.json") {
                let manifest;
                try {
                  manifest = JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(data),
                  );
                } catch {
                  throw invalid();
                }
                if (
                  !manifest ||
                  typeof manifest !== "object" ||
                  Array.isArray(manifest) ||
                  sha256 !== selected.manifestSha256 ||
                  manifest.name !== selected.name ||
                  (profile &&
                    (manifest.name !== profile.name ||
                      (typeof profile.version === "function"
                        ? !profile.version(manifest.version)
                        : manifest.version !== profile.version)))
                )
                  throw invalid();
                if (
                  profile?.bin &&
                  manifest.bin?.[profile.bin.key] !== profile.bin.value
                )
                  throw invalid();
              }
              if (profile?.nativePattern?.test(name)) {
                const entry = entrypoints.get(profile.label)!;
                if (entry.nativePath) throw invalid();
                entry.nativePath = path;
              }
              hashes.push({ path: `${prefix}/${name}`, sha256 });
              await onBytes?.(path, data);
              witnesses.push({ path, stat: before });
            } finally {
              await handle.close();
            }
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            release?.();
          }
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: NATIVE_TOOLCHAIN_LIMITS.maximumWorkers }, () =>
          worker(),
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      await held.assertUnchanged();
    } finally {
      await held.close();
    }
  }
  if (
    JSON.stringify(
      await resolveNativeRuntimePackages(
        root,
        roots.map((x) => x.directory),
      ),
    ) !== JSON.stringify(packages)
  )
    throw invalid();
  // Fixed bounded batches avoid serial external-drive stat latency. All checks
  // must complete before returning; no partially verified digest is exposed.
  for (
    let i = 0;
    i < witnesses.length;
    i += NATIVE_TOOLCHAIN_LIMITS.maximumWorkers
  ) {
    await Promise.all(
      witnesses
        .slice(i, i + NATIVE_TOOLCHAIN_LIMITS.maximumWorkers)
        .map(async (entry) => {
          if (!same(entry.stat, await lstat(entry.path))) throw invalid();
        }),
    );
  }
  for (const profile of roots) {
    const bin = profile.bin;
    if (
      !hashes.some((file) => file.path === `${profile.label}/package.json`) ||
      (bin &&
        !hashes.some(
          (file) =>
            file.path === `${profile.label}/${bin.value.replace(/^\.\//u, "")}`,
        )) ||
      (profile.nativePattern && !entrypoints.get(profile.label)!.nativePath)
    )
      throw invalid();
  }
  return Object.freeze({
    sha256: createHash("sha256")
      .update(
        JSON.stringify(
          hashes.sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          ),
        ),
      )
      .digest("hex"),
    entrypoints,
  });
};
