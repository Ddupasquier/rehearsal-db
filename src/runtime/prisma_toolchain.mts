/** Fingerprint a reviewed project-local Prisma installation without executing it. */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  resolvePrismaRuntimePackages,
  PRISMA_TOOLCHAIN_LIMITS,
  invalidPrismaToolchain,
  createPrismaReadBudget,
} from "./prisma_toolchain_dependencies.mjs";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";
const invalid = invalidPrismaToolchain;
const same = (a: Stats, b: Stats) =>
  !b.isSymbolicLink() &&
  a.isFile() === b.isFile() &&
  a.isDirectory() === b.isDirectory() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
export const inspectPrismaToolchain = async ({
  projectRoot,
  packageDirectory,
}: {
  projectRoot: string;
  packageDirectory: string;
}) => {
  const root = await realpath(projectRoot),
    packagePath = resolve(root, packageDirectory),
    local = relative(root, packagePath);
  if (
    !local ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  )
    throw invalid();
  const enginePath = resolve(packagePath, "..", "@prisma", "engines");
  const packages = await resolvePrismaRuntimePackages(root, [
    packagePath,
    enginePath,
  ]);
  const hashes: Array<{ path: string; sha256: string }> = [],
    witnesses: Array<{ path: string; stat: Stats }> = [];
  let bytes = 0,
    visited = 0,
    fileCount = 0,
    engineBinary: string | undefined;
  // Fixed four workers share a 64MiB buffer budget, including the growth sentinel.
  // Reservation and release are synchronous; no worker can over-admit the budget.
  const acquire = createPrismaReadBudget();
  for (const selected of packages) {
    const directory = selected.directory;
    const prefix =
      directory === packagePath
        ? "prisma"
        : directory === enginePath
          ? "engines"
          : relative(root, directory).split(sep).join("/");
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
        if (!observed && ++visited > PRISMA_TOOLCHAIN_LIMITS.maximumEntries)
          throw invalid();
        const before = observed ?? (await lstat(path));
        if (before.isSymbolicLink()) throw invalid();
        if (before.isDirectory()) {
          await held.assertUnchanged();
          const pending: string[] = [];
          const flush = async () => {
            if (!pending.length) return;
            const batch = pending.splice(0);
            if (visited + batch.length > PRISMA_TOOLCHAIN_LIMITS.maximumEntries)
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
                ++visited > PRISMA_TOOLCHAIN_LIMITS.maximumEntries ||
                !entry.isDirectory() ||
                entry.isSymbolicLink()
              )
                throw invalid();
              continue;
            }
            pending.push(join(path, entry.name));
            if (pending.length === PRISMA_TOOLCHAIN_LIMITS.maximumWorkers)
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
          ++fileCount > PRISMA_TOOLCHAIN_LIMITS.maximumFiles ||
          before.size > PRISMA_TOOLCHAIN_LIMITS.maximumFileBytes ||
          bytes + before.size > PRISMA_TOOLCHAIN_LIMITS.maximumTotalBytes ||
          before.size + 1 > PRISMA_TOOLCHAIN_LIMITS.maximumInflightBytes
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
                  ((prefix === "prisma" || prefix === "engines") &&
                    (manifest.name !==
                      (prefix === "prisma" ? "prisma" : "@prisma/engines") ||
                      manifest.version !== "7.10.1"))
                )
                  throw invalid();
                if (
                  prefix === "prisma" &&
                  manifest.bin?.prisma !== "build/index.js"
                )
                  throw invalid();
              }
              if (
                prefix === "engines" &&
                /^schema-engine-[a-z0-9_.-]+(?:\.exe)?$/u.test(name)
              ) {
                if (engineBinary) throw invalid();
                engineBinary = path;
              }
              hashes.push({ path: `${prefix}/${name}`, sha256 });
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
        Array.from({ length: PRISMA_TOOLCHAIN_LIMITS.maximumWorkers }, () =>
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
      await resolvePrismaRuntimePackages(root, [packagePath, enginePath]),
    ) !== JSON.stringify(packages)
  )
    throw invalid();
  // Fixed bounded batches avoid serial external-drive stat latency. All checks
  // must complete before returning; no partially verified digest is exposed.
  for (
    let i = 0;
    i < witnesses.length;
    i += PRISMA_TOOLCHAIN_LIMITS.maximumWorkers
  ) {
    await Promise.all(
      witnesses
        .slice(i, i + PRISMA_TOOLCHAIN_LIMITS.maximumWorkers)
        .map(async (entry) => {
          if (!same(entry.stat, await lstat(entry.path))) throw invalid();
        }),
    );
  }
  if (
    !engineBinary ||
    !hashes.some((file) => file.path === "prisma/build/index.js") ||
    !hashes.some((file) => file.path === "prisma/package.json") ||
    !hashes.some((file) => file.path === "engines/package.json")
  )
    throw invalid();
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
    cliPath: join(packagePath, "build", "index.js"),
    enginePath: engineBinary,
  });
};
