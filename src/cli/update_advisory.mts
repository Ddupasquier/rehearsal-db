/** Explicit, bounded release checks; never invoked by passive or machine commands. */
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const UPDATE_DAY = 86_400_000;
const LIMIT = 65_536;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
type Channel = "stable" | "preview";
export interface UpdatePreference {
  schemaVersion: 1;
  permission: "ask" | "enabled" | "disabled";
  lastCheckAt: number | null;
  lastPromptAt: number | null;
  skippedVersion: string | null;
}
export const emptyUpdatePreference = (): UpdatePreference => ({
  schemaVersion: 1,
  permission: "ask",
  lastCheckAt: null,
  lastPromptAt: null,
  skippedVersion: null,
});
const parsed = (value: unknown) => {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = VERSION.exec(value);
  if (!match || match[0] !== value) return null;
  const numbers = match.slice(1, 4).map(Number);
  const pre = match[4]?.split(".") ?? [];
  if (
    numbers.some((part) => !Number.isSafeInteger(part)) ||
    pre.some(
      (part) =>
        /^\d+$/u.test(part) &&
        (!Number.isSafeInteger(Number(part)) ||
          (part.length > 1 && part[0] === "0")),
    )
  )
    return null;
  return { numbers, pre };
};
export function compareUpdateVersions(
  left: string,
  right: string,
): number | null {
  const a = parsed(left),
    b = parsed(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i])
      return a.numbers[i]! < b.numbers[i]! ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length)
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/u.test(x),
      yn = /^\d+$/u.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export type CoreUpdate =
  | {
      state: "available" | "current" | "ahead";
      version: string;
      channel: Channel;
    }
  | { state: "unavailable"; channel: Channel };
export async function checkCoreUpdate({
  installed,
  fetchImplementation = fetch,
  timeoutMs = 3_000,
}: {
  installed: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}): Promise<CoreUpdate> {
  const current = parsed(installed);
  const channel: Channel = current?.pre.length ? "preview" : "stable";
  const unavailable = { state: "unavailable", channel } as const;
  if (!current) return unavailable;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const candidates: { version: string; channel: Channel }[] = [];
  const readChannel = async (target: Channel): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const endpoint = `https://registry.npmjs.org/@rehearsal-db%2Fcore/${target === "preview" ? "beta" : "latest"}`;
      const response = await fetchImplementation(endpoint, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (
        response.status !== 200 ||
        response.redirected ||
        response.url !== endpoint ||
        !response.body ||
        !/^application\/json(?:\s*;|$)/iu.test(
          response.headers.get("content-type") ?? "",
        )
      )
        return;
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^\d+$/u.test(declared) || Number(declared) > LIMIT)
      )
        return;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (!controller.signal.aborted) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > LIMIT) return;
        chunks.push(item.value);
      }
      if (controller.signal.aborted) return;
      const metadata = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bytes),
        ),
      );
      const candidate = parsed(metadata.version);
      if (
        metadata.name !== "@rehearsal-db/core" ||
        !candidate ||
        (target === "stable"
          ? candidate.pre.length > 0
          : candidate.pre.length === 0)
      )
        return;
      const tarball = new URL(metadata.dist?.tarball);
      if (
        tarball.href !==
          `https://registry.npmjs.org/@rehearsal-db/core/-/core-${metadata.version}.tgz` ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(metadata.dist?.integrity ?? "")
      )
        return;
      candidates.push({ version: metadata.version, channel: target });
    } catch {
      // An unavailable channel never supplies release or compatibility claims.
    } finally {
      void reader?.cancel().catch(() => undefined);
    }
  };
  try {
    await Promise.race([
      Promise.all(
        (channel === "preview" ? ["preview", "stable"] : ["stable"]).map(
          (target) => readChannel(target as Channel),
        ),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve();
          },
          Math.min(3_000, Math.max(1, timeoutMs)),
        );
      }),
    ]);
    const release = candidates.sort(
      (left, right) => -compareUpdateVersions(left.version, right.version)!,
    )[0];
    if (!release) return unavailable;
    const comparison = compareUpdateVersions(installed, release.version)!;
    return {
      state:
        comparison < 0 ? "available" : comparison > 0 ? "ahead" : "current",
      ...release,
    };
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const privateRegular = async (path: string, limit: number) => {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > limit ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw new Error("Unsafe update preferences.");
  return metadata;
};
const canonicalAncestors = async (directory: string): Promise<void> => {
  let existing = resolve(directory);
  while (true) {
    try {
      if ((await realpath(existing)) !== existing)
        throw new Error("Symbolic update state ancestor.");
      return;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
};
const boundedJson = async (path: string, limit: number) => {
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Symbolic metadata path.");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error("Unsafe metadata file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size > limit
    )
      throw new Error("Changed metadata file.");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("Oversized metadata file.");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
};
export const defaultUpdateDirectory = () => join(homedir(), ".cache/rehearsal");
export async function readUpdatePreference(
  directory: string,
  now: number,
): Promise<UpdatePreference> {
  const path = join(directory, "updates-v1.json");
  try {
    await canonicalAncestors(directory);
    const parent = await lstat(directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      return emptyUpdatePreference();
    const before = await privateRegular(path, 8_192);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size > 8_192 ||
        metadata.ino !== before.ino ||
        metadata.dev !== before.dev ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid())
      )
        throw new Error("Unsafe preference size.");
      const buffer = Buffer.alloc(8_193);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8_192) throw new Error("Oversized preferences.");
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (
        value.schemaVersion !== 1 ||
        !["ask", "enabled", "disabled"].includes(value.permission) ||
        Object.keys(value).sort().join() !==
          Object.keys(emptyUpdatePreference()).sort().join() ||
        [value.lastCheckAt, value.lastPromptAt].some(
          (time) =>
            time !== null &&
            (!Number.isSafeInteger(time) || time < 0 || time > now),
        ) ||
        (value.skippedVersion !== null && !parsed(value.skippedVersion))
      )
        throw new Error("Invalid preferences.");
      return value;
    } finally {
      await handle.close();
    }
  } catch {
    return emptyUpdatePreference();
  }
}
export async function saveUpdatePreference(
  directory: string,
  value: UpdatePreference,
  expected: UpdatePreference = emptyUpdatePreference(),
): Promise<boolean> {
  let temporary: string | undefined;
  let lockPath: string | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await canonicalAncestors(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await canonicalAncestors(directory);
    const parent = await lstat(directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      return false;
    lockPath = join(directory, "updates-v1.lock");
    // Contention fails closed immediately. Never steal another guide's lock,
    // including one retained after an abnormal exit.
    lock = await open(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const lockMetadata = await lock.stat();
    if (
      !lockMetadata.isFile() ||
      (lockMetadata.mode & 0o077) !== 0 ||
      (process.getuid && lockMetadata.uid !== process.getuid())
    )
      return false;
    if (
      !isDeepStrictEqual(
        await readUpdatePreference(directory, Date.now()),
        expected,
      )
    )
      return false;
    const path = join(directory, "updates-v1.json");
    try {
      await privateRegular(path, 8_192);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        return false;
    }
    temporary = join(directory, `.updates-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    if (
      !isDeepStrictEqual(
        await readUpdatePreference(directory, Date.now()),
        expected,
      )
    )
      return false;
    await rename(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    if (lock && lockPath) {
      try {
        const owned = await lock.stat();
        await lock.close();
        const current = await lstat(lockPath);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.ino === owned.ino &&
          current.dev === owned.dev
        )
          await rm(lockPath);
      } catch {
        await lock.close().catch(() => undefined);
      }
    }
  }
}

export async function coreUpdateCommand(
  project: string,
  installed: string,
  available: string,
): Promise<string | null> {
  if (
    !parsed(installed) ||
    !parsed(available) ||
    compareUpdateVersions(installed, available)! >= 0
  )
    return null;
  try {
    const manifest = await boundedJson(join(project, "package.json"), LIMIT);
    if (manifest.name === "@rehearsal-db/core") return null;
    const dev = manifest.devDependencies?.["@rehearsal-db/core"],
      prod = manifest.dependencies?.["@rehearsal-db/core"],
      optional = manifest.optionalDependencies?.["@rehearsal-db/core"];
    if (optional !== undefined || (dev !== undefined && prod !== undefined))
      return null;
    const specification = dev ?? prod;
    if (typeof specification !== "string") return null;
    const pinned = specification.replace(/^[~^]/u, "");
    if (
      !["latest", "beta"].includes(specification) &&
      (!parsed(pinned) ||
        (!/^[~^]/u.test(specification) &&
          compareUpdateVersions(pinned, installed) !== 0))
    )
      return null;
    if (/^[~^]/u.test(specification)) {
      const base = parsed(pinned)!,
        actual = parsed(installed)!;
      if (
        compareUpdateVersions(installed, pinned)! < 0 ||
        base.numbers[0] !== actual.numbers[0] ||
        ((specification[0] === "~" || base.numbers[0] === 0) &&
          base.numbers[1] !== actual.numbers[1]) ||
        (base.numbers[0] === 0 &&
          base.numbers[1] === 0 &&
          base.numbers[2] !== actual.numbers[2]) ||
        (actual.pre.length > 0 && base.numbers.join() !== actual.numbers.join())
      )
        return null;
    }
    // Other package-manager provenance formats remain manual-only, not guessed.
    if (
      manifest.packageManager !== undefined &&
      (typeof manifest.packageManager !== "string" ||
        !/^npm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(
          manifest.packageManager,
        ))
    )
      return null;
    for (const name of [
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ]) {
      try {
        await lstat(join(project, name));
        return null;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    const current = parsed(installed)!,
      next = parsed(available)!;
    if (
      current.numbers[0] !== next.numbers[0] ||
      (current.numbers[0] === 0 && current.numbers[1] !== next.numbers[1])
    )
      return null;
    const [lock, installedLock, actual] = await Promise.all([
      boundedJson(join(project, "package-lock.json"), 1_048_576),
      boundedJson(join(project, "node_modules/.package-lock.json"), 1_048_576),
      boundedJson(
        join(project, "node_modules/@rehearsal-db/core/package.json"),
        LIMIT,
      ),
    ]);
    const entry = lock.packages?.["node_modules/@rehearsal-db/core"],
      recorded = installedLock.packages?.["node_modules/@rehearsal-db/core"];
    const origin = `https://registry.npmjs.org/@rehearsal-db/core/-/core-${installed}.tgz`;
    if (
      ![2, 3].includes(lock.lockfileVersion) ||
      ![2, 3].includes(installedLock.lockfileVersion) ||
      actual.name !== "@rehearsal-db/core" ||
      actual.version !== installed ||
      actual.bin?.rehearsal !== "dist/src/cli/rehearsal.mjs" ||
      !entry ||
      !recorded ||
      entry.version !== installed ||
      recorded.version !== installed ||
      entry.resolved !== origin ||
      recorded.resolved !== origin ||
      entry.link ||
      recorded.link ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? "") ||
      recorded.integrity !== entry.integrity
    )
      return null;
    const declaredRoot = lock.packages?.[""];
    if (
      declaredRoot?.[dev ? "devDependencies" : "dependencies"]?.[
        "@rehearsal-db/core"
      ] !== specification
    )
      return null;
    const packageVersion = `@rehearsal-db/core@${available}`;
    return `npm install ${dev ? "--save-dev" : "--save"} --save-exact ${packageVersion}`;
  } catch {
    return null;
  }
}
