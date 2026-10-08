/** Project-wide mutation lock and installed-package integrity guard. */

import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const LOCK_ROOT = join(tmpdir(), "rehearsal-db-operation-locks");

export interface InstalledPackageFingerprint {
  readonly files: number;
  readonly sha256: string;
}

export interface ProjectOperation {
  readonly command: string;
  release(): Promise<void>;
  releaseSync(): void;
}

interface LockOwner {
  formatVersion: number;
  pid: number;
  command: string;
  projectHash: string;
  token: string;
  startedAt: string;
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const parseLockOwner = (source: string): LockOwner => {
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    !("token" in value) ||
    typeof value.token !== "string"
  ) {
    throw new Error("The Rehearsal operation-lock owner is invalid.");
  }
  return value as LockOwner;
};

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const packageFiles = (root: string, directory = root): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return packageFiles(root, path);
    if (!entry.isFile()) return [];
    return [relative(root, path)];
  });

export const createInstalledPackageFingerprint = ({
  packageRoot,
}: {
  packageRoot: string;
}): InstalledPackageFingerprint => {
  const files = [
    "package.json",
    ...["dist/src", "dist/scripts/runtime"].flatMap((directory) =>
      packageFiles(packageRoot, join(packageRoot, directory)),
    ),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(packageRoot, file)));
    hash.update("\0");
  }
  return Object.freeze({ files: files.length, sha256: hash.digest("hex") });
};

export const assertInstalledPackageFingerprint = ({
  packageRoot,
  expected,
}: {
  packageRoot: string;
  expected: InstalledPackageFingerprint;
}): InstalledPackageFingerprint => {
  const actual = createInstalledPackageFingerprint({ packageRoot });
  if (actual.files !== expected?.files || actual.sha256 !== expected?.sha256) {
    throw new Error(
      "The installed Rehearsal package changed during this operation. Reinstall the intended version, then start a new command.",
    );
  }
  return actual;
};

const processIsAlive = (pid: unknown): pid is number => {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
};

const assertPrivateLockRoot = async (): Promise<void> => {
  await mkdir(LOCK_ROOT, { recursive: true, mode: 0o700 });
  const details = await stat(LOCK_ROOT);
  if (
    !details.isDirectory() ||
    (details.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && details.uid !== process.getuid())
  ) {
    throw new Error("The Rehearsal operation-lock directory is not private.");
  }
};

export const acquireProjectOperation = async ({
  projectRoot,
  command,
}: {
  projectRoot: string;
  command: string;
}): Promise<ProjectOperation> => {
  await assertPrivateLockRoot();
  const canonicalRoot = await realpath(projectRoot);
  const projectHash = digest(canonicalRoot);
  const lockDirectory = join(LOCK_ROOT, projectHash);
  const ownerPath = join(lockDirectory, "owner.json");
  const token = randomBytes(16).toString("hex");
  const owner = {
    formatVersion: 1,
    pid: process.pid,
    command,
    projectHash,
    token,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const assertOwnership = (current: LockOwner): void => {
        if (current.token !== token || current.pid !== process.pid) {
          throw new Error(
            "The Rehearsal operation lock changed ownership unexpectedly.",
          );
        }
      };
      return Object.freeze({
        command,
        async release() {
          const current = parseLockOwner(await readFile(ownerPath, "utf8"));
          assertOwnership(current);
          await rm(lockDirectory, { recursive: true });
        },
        releaseSync() {
          const current = parseLockOwner(readFileSync(ownerPath, "utf8"));
          assertOwnership(current);
          rmSync(lockDirectory, { recursive: true });
        },
      });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST") || attempt > 0) throw error;
      const details = await lstat(lockDirectory);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error("The Rehearsal operation lock is unsafe.");
      }
      let current: LockOwner;
      try {
        current = parseLockOwner(await readFile(ownerPath, "utf8"));
      } catch {
        throw new Error(
          "Another Rehearsal operation owns this project, or its lock is incomplete.",
        );
      }
      if (processIsAlive(current.pid)) {
        throw new Error(
          `Another Rehearsal operation is already running for this project (PID ${current.pid}).`,
        );
      }
      const staleDirectory = `${lockDirectory}.stale-${token}`;
      try {
        await rename(lockDirectory, staleDirectory);
      } catch (renameError) {
        if (hasErrorCode(renameError, "ENOENT")) continue;
        throw renameError;
      }
      await rm(staleDirectory, { recursive: true });
    }
  }
  throw new Error("Rehearsal could not acquire its project operation lock.");
};

export const inspectProjectOperationLocks = async (): Promise<string[]> =>
  readdir(LOCK_ROOT).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  });
