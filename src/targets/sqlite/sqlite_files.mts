/** Private embedded-file ownership. Cooperative guards, not an OS sandbox. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RehearsalError } from "../../shared/diagnostics.mjs";
import type { NormalizedRehearsalConfig } from "../../project/configuration.mjs";

export const sqliteSha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const sqliteError = (code: string, message: string): RehearsalError =>
  new RehearsalError({
    category:
      code === "SQLITE_RUNTIME_DIRTY"
        ? "migration_verification_failure"
        : "unsafe_environment",
    code,
    message,
    refused: "The source database and unproven files were preserved.",
    suggestions: [
      "Review this project's SQLite configuration and retained recovery evidence before retrying.",
    ],
  });
export interface SqliteFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
}
export const sqliteIdentity = (s: BigIntStats): SqliteFileIdentity => {
  if (s.birthtimeNs <= 0n)
    throw sqliteError(
      "SQLITE_OWNERSHIP_UNPROVEN",
      "SQLite file creation identity is unavailable.",
    );
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    birthtimeNs: String(s.birthtimeNs),
  };
};
export const sameSqliteIdentity = (
  a: SqliteFileIdentity,
  b: SqliteFileIdentity,
): boolean =>
  Boolean(
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    [a.dev, a.ino, a.birthtimeNs, b.dev, b.ino, b.birthtimeNs].every(
      (x) => typeof x === "string" && /^[0-9]+$/u.test(x),
    ) &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeNs === b.birthtimeNs,
  );
export const sqlitePathExists = (path: string): boolean => {
  try {
    fs.lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};

/** Canonicalize the caller's project alias once; reject aliases below it. */
export const sqliteProjectPath = (
  projectRoot: string,
  path: string,
  allowMissing = false,
): string => {
  const suffix = relative(resolve(projectRoot), resolve(path));
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix))
    throw sqliteError(
      "SQLITE_OWNERSHIP_UNPROVEN",
      "A SQLite path is outside its project or names the project root.",
    );
  const root = fs.realpathSync(projectRoot);
  let current = root;
  const parts = suffix.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const s = fs.lstatSync(current, { bigint: true });
      if (
        s.isSymbolicLink() ||
        (!s.isDirectory() && i !== parts.length - 1) ||
        (s.isFile() && s.nlink !== 1n)
      )
        throw sqliteError(
          "SQLITE_OWNERSHIP_UNPROVEN",
          "SQLite paths cannot contain symlinks, hard links or non-directory ancestors.",
        );
    } catch (e) {
      if (allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT")
        return join(root, suffix);
      throw e;
    }
  }
  return current;
};

export const sqliteFileIdentity = (path: string): SqliteFileIdentity => {
  const s = fs.lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n)
    throw sqliteError(
      "SQLITE_OWNERSHIP_UNPROVEN",
      "The SQLite file identity is unsafe.",
    );
  return sqliteIdentity(s);
};
export const assertSqliteFile = (
  path: string,
  expected: SqliteFileIdentity,
): void => {
  if (!sameSqliteIdentity(sqliteFileIdentity(path), expected))
    throw sqliteError(
      "SQLITE_OWNERSHIP_UNPROVEN",
      "An owned SQLite file was replaced; it was preserved.",
    );
};
export const readSqliteBytes = (path: string, maximum: number): Buffer => {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    maximum > 64 * 1024 * 1024
  )
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "The SQLite input bound is invalid.",
    );
  const identity = sqliteFileIdentity(path);
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd, { bigint: true });
    if (
      !s.isFile() ||
      s.nlink !== 1n ||
      !sameSqliteIdentity(identity, sqliteIdentity(s)) ||
      s.size > BigInt(maximum)
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite metadata is oversized or changed.",
      );
    const bytes = Buffer.allocUnsafe(Number(s.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (next === 0) break;
      count += next;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    assertSqliteFile(path, identity);
    if (
      count !== Number(s.size) ||
      after.size !== s.size ||
      after.ctimeNs !== s.ctimeNs ||
      after.mtimeNs !== s.mtimeNs ||
      count > maximum
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite input exceeds its bound or changed while being read.",
      );
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
};
export const parseSqliteJson = <T,>(bytes: Uint8Array): T => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as T;
  } catch {
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "SQLite private metadata is not valid JSON.",
    );
  }
};
export const readSqliteJson = <T,>(path: string, maximum = 512 * 1024): T =>
  parseSqliteJson<T>(readSqliteBytes(path, maximum));
export const writeSqliteJson = (
  path: string,
  value: unknown,
  exclusive = false,
): void => {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 512 * 1024)
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "SQLite metadata exceeds its limit.",
    );
  if (exclusive) {
    fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return;
  }
  const old = sqlitePathExists(path) ? sqliteFileIdentity(path) : null;
  const temporary = join(dirname(path), `.metadata-${randomUUID()}.json`);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  if (old) assertSqliteFile(path, old);
  else if (sqlitePathExists(path))
    throw sqliteError(
      "SQLITE_OWNERSHIP_UNPROVEN",
      "A foreign SQLite metadata file appeared.",
    );
  fs.renameSync(temporary, path);
};

interface DirectoryOwner {
  readonly version: 1;
  readonly family: "sqlite";
  readonly projectId: string;
  readonly projectSha256: string;
  readonly directory: SqliteFileIdentity;
  readonly nonce: string;
}
export interface SqliteOwnedDirectory {
  readonly path: string;
  assertOwned(): void;
  close(): void;
}
/** Never adopt a pre-existing empty directory or foreign owner metadata. */
export const sqliteOwnedDirectory = (
  projectRoot: string,
  path: string,
  config: NormalizedRehearsalConfig,
  create = false,
): SqliteOwnedDirectory => {
  const root = fs.realpathSync(projectRoot);
  const canonical = sqliteProjectPath(projectRoot, path, create);
  if (create && !sqlitePathExists(canonical)) {
    // The configured project owns these structural parents, but only the exact
    // directory carrying the receipt below is eligible for SQLite retirement.
    fs.mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 });
    if (dirname(canonical) !== root)
      sqliteProjectPath(root, dirname(canonical));
    fs.mkdirSync(canonical, { mode: 0o700 });
    writeSqliteJson(
      join(canonical, "owner.json"),
      {
        version: 1,
        family: "sqlite",
        projectId: config.runtime.projectId,
        projectSha256: sqliteSha256(fs.realpathSync(projectRoot)),
        directory: sqliteIdentity(fs.lstatSync(canonical, { bigint: true })),
        nonce: randomUUID(),
      } satisfies DirectoryOwner,
      true,
    );
  }
  const fd = fs.openSync(
    canonical,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const original = sqliteIdentity(fs.fstatSync(fd, { bigint: true }));
    const owner = readSqliteJson<DirectoryOwner>(join(canonical, "owner.json"));
    if (!owner || typeof owner !== "object")
      throw sqliteError(
        "SQLITE_OWNERSHIP_UNPROVEN",
        "SQLite directory owner metadata is malformed.",
      );
    const assertOwned = (): void => {
      sqliteProjectPath(root, canonical);
      if (
        !sameSqliteIdentity(
          original,
          sqliteIdentity(fs.fstatSync(fd, { bigint: true })),
        )
      )
        throw sqliteError(
          "SQLITE_OWNERSHIP_UNPROVEN",
          "The SQLite directory handle changed.",
        );
      const current = fs.lstatSync(canonical, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameSqliteIdentity(original, sqliteIdentity(current)) ||
        owner.version !== 1 ||
        owner.family !== "sqlite" ||
        owner.projectId !== config.runtime.projectId ||
        owner.projectSha256 !== sqliteSha256(fs.realpathSync(projectRoot)) ||
        !sameSqliteIdentity(owner.directory, original) ||
        typeof owner.nonce !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(owner.nonce)
      )
        throw sqliteError(
          "SQLITE_OWNERSHIP_UNPROVEN",
          "SQLite directory ownership is unavailable or changed.",
        );
      const latest = readSqliteJson<DirectoryOwner>(
        join(canonical, "owner.json"),
      );
      if (JSON.stringify(latest) !== JSON.stringify(owner))
        throw sqliteError(
          "SQLITE_OWNERSHIP_UNPROVEN",
          "SQLite directory ownership changed.",
        );
    };
    assertOwned();
    let closed = false;
    return {
      path: canonical,
      assertOwned,
      close: () => {
        if (!closed) {
          closed = true;
          fs.closeSync(fd);
        }
      },
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
};

export const unlinkSqliteFile = (
  path: string,
  identity: SqliteFileIdentity,
): void => {
  assertSqliteFile(path, identity);
  fs.unlinkSync(path);
};
