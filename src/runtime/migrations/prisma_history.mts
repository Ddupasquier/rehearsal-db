/** Bounded native Prisma Migrate history; never evaluates project code or contacts a database. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { holdPathAncestry } from "../../shared/held_path_ancestry.mjs";
import type { MigrationFileEntry } from "./migration_history.mjs";

export const PRISMA_HISTORY_LIMITS = Object.freeze({
  maximumFiles: 10000,
  maximumFileBytes: 8 * 1024 * 1024,
  maximumTotalBytes: 64 * 1024 * 1024,
});
export interface PrismaNativeBinding {
  schemaVersion: 1;
  kind: "prisma";
  version: "7.10.1";
  provider: "postgresql";
  lockSha256: string;
}
export interface PrismaLedgerEntry {
  migration_name: string;
  checksum: string;
  finished_at: string;
  rolled_back_at: null;
}
const folderPattern = /^(\d{14})_([A-Za-z0-9][A-Za-z0-9_-]{0,190})$/u;
const digest = (bytes: NodeJS.ArrayBufferView | string) =>
  createHash("sha256").update(bytes).digest("hex");
const refused = () =>
  new Error(
    "Prisma migration history is unavailable, malformed, unsafe or divergent; no project code or SQL was executed.",
  );
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  b.isFile() &&
  !b.isSymbolicLink() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

export async function readPrismaMigrationInventory(
  directory: URL,
  options: {
    readBytes?: (path: URL, filename: string) => Promise<Buffer>;
    onBytes?: (filename: string, bytes: Buffer) => void;
  } = {},
): Promise<{ entries: MigrationFileEntry[]; binding: PrismaNativeBinding }> {
  const root = fileURLToPath(directory);
  const ancestry = await holdPathAncestry(root);
  let total = 0;
  const witnesses: Array<{ path: string; stat: BigIntStats }> = [];
  const directories: Array<{ path: string; stat: BigIntStats }> = [];
  const read = async (filename: string): Promise<Buffer> => {
    const path = join(ancestry.path, filename);
    const parent = await holdPathAncestry(dirname(path));
    try {
      await ancestry.assertUnchanged();
      const leaf = await lstat(path, { bigint: true });
      if (!leaf.isFile() || leaf.isSymbolicLink()) throw refused();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !sameFile(leaf, before) ||
          before.size > BigInt(PRISMA_HISTORY_LIMITS.maximumFileBytes) ||
          BigInt(total) + before.size >
            BigInt(PRISMA_HISTORY_LIMITS.maximumTotalBytes)
        )
          throw refused();
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (
          offset !== Number(before.size) ||
          !sameFile(before, await handle.stat({ bigint: true })) ||
          !sameFile(before, await lstat(path, { bigint: true }))
        )
          throw refused();
        await parent.assertUnchanged();
        await ancestry.assertUnchanged();
        const result = bytes.subarray(0, offset);
        if (options.readBytes) {
          const supplied = await options.readBytes(
            pathToFileURL(path),
            filename,
          );
          if (
            !Buffer.isBuffer(supplied) ||
            !supplied.equals(result) ||
            !sameFile(before, await handle.stat({ bigint: true })) ||
            !sameFile(before, await lstat(path, { bigint: true }))
          )
            throw refused();
          await parent.assertUnchanged();
          await ancestry.assertUnchanged();
        }
        witnesses.push({ path, stat: before });
        total += offset;
        options.onBytes?.(filename, Buffer.from(result));
        return result;
      } finally {
        await handle.close();
      }
    } finally {
      await parent.close();
    }
  };
  try {
    const folders: string[] = [];
    let lock = false,
      visited = 0;
    for await (const entry of await opendir(ancestry.path)) {
      if (
        ++visited > PRISMA_HISTORY_LIMITS.maximumFiles + 1 ||
        entry.isSymbolicLink()
      )
        throw refused();
      if (entry.name === "migration_lock.toml" && entry.isFile() && !lock)
        lock = true;
      else if (entry.isDirectory() && folderPattern.test(entry.name))
        folders.push(entry.name);
      else throw refused();
    }
    if (
      !lock ||
      !folders.length ||
      folders.length > PRISMA_HISTORY_LIMITS.maximumFiles
    )
      throw refused();
    const lockBytes = await read("migration_lock.toml");
    // The generated lock's only semantic setting is provider. Comments/blank
    // lines are permitted; duplicate keys, tables and additional settings refuse.
    const lockText = new TextDecoder("utf-8", { fatal: true }).decode(
      lockBytes,
    );
    const lines = lockText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (
      lines.length !== 1 ||
      !/^provider\s*=\s*(?:"postgresql"|'postgresql')\s*(?:#.*)?$/u.test(
        lines[0]!,
      )
    )
      throw refused();
    const entries: MigrationFileEntry[] = [];
    const versions = new Set<string>();
    for (const folder of folders.sort()) {
      const match = folderPattern.exec(folder)!;
      if (versions.has(match[1]!)) throw refused();
      versions.add(match[1]!);
      const childAncestry = await holdPathAncestry(join(ancestry.path, folder));
      try {
        const directoryStat = await lstat(childAncestry.path, { bigint: true });
        directories.push({ path: childAncestry.path, stat: directoryStat });
        let children = 0;
        for await (const child of await opendir(childAncestry.path)) {
          if (
            ++children > 1 ||
            child.name !== "migration.sql" ||
            !child.isFile() ||
            child.isSymbolicLink()
          )
            throw refused();
        }
        if (children !== 1) throw refused();
        await childAncestry.assertUnchanged();
      } finally {
        await childAncestry.close();
      }
      const filename = `${folder}/migration.sql`;
      entries.push({
        version: match[1]!,
        name: match[2]!,
        filename,
        fileSha256: digest(await read(filename)),
      });
    }
    await ancestry.assertUnchanged();
    for (const entry of directories) {
      const after = await lstat(entry.path, { bigint: true });
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        entry.stat.dev !== after.dev ||
        entry.stat.ino !== after.ino ||
        entry.stat.mtimeNs !== after.mtimeNs ||
        entry.stat.ctimeNs !== after.ctimeNs
      )
        throw refused();
    }
    for (const entry of witnesses)
      if (!sameFile(entry.stat, await lstat(entry.path, { bigint: true })))
        throw refused();
    await ancestry.assertUnchanged();
    return {
      entries,
      binding: {
        schemaVersion: 1,
        kind: "prisma",
        version: "7.10.1",
        provider: "postgresql",
        lockSha256: digest(lockBytes),
      },
    };
  } catch {
    throw refused();
  } finally {
    await ancestry.close();
  }
}

export function normalizePrismaMigrationLedger(
  rows: unknown,
): PrismaLedgerEntry[] {
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    rows.length > PRISMA_HISTORY_LIMITS.maximumFiles
  )
    throw refused();
  const seen = new Set<string>();
  let previousVersion = "";
  return rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw refused();
    const value = row as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 ||
      Object.keys(value).some(
        (key) =>
          ![
            "migration_name",
            "checksum",
            "finished_at",
            "rolled_back_at",
          ].includes(key),
      ) ||
      typeof value.migration_name !== "string" ||
      !folderPattern.test(value.migration_name) ||
      seen.has(value.migration_name) ||
      value.migration_name.slice(0, 14) <= previousVersion ||
      typeof value.checksum !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.checksum) ||
      typeof value.finished_at !== "string" ||
      value.finished_at.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(
        value.finished_at,
      ) ||
      !Number.isFinite(Date.parse(value.finished_at)) ||
      value.rolled_back_at !== null
    )
      throw refused();
    seen.add(value.migration_name);
    previousVersion = value.migration_name.slice(0, 14);
    return {
      migration_name: value.migration_name,
      checksum: value.checksum,
      finished_at: value.finished_at,
      rolled_back_at: null,
    };
  });
}
export function verifyPrismaMigrationLedger({
  rows,
  entries,
}: {
  rows: unknown;
  entries: readonly MigrationFileEntry[];
}): PrismaLedgerEntry[] {
  const ledger = normalizePrismaMigrationLedger(rows);
  if (
    !entries.length ||
    entries.length > PRISMA_HISTORY_LIMITS.maximumFiles ||
    ledger.length > entries.length
  )
    throw refused();
  let previous = "";
  for (const entry of entries) {
    if (
      !/^\d{14}$/u.test(entry.version) ||
      entry.version <= previous ||
      !folderPattern.test(`${entry.version}_${entry.name}`) ||
      entry.filename !== `${entry.version}_${entry.name}/migration.sql` ||
      !/^[a-f0-9]{64}$/u.test(entry.fileSha256)
    )
      throw refused();
    previous = entry.version;
  }
  for (let index = 0; index < ledger.length; index++) {
    const applied = ledger[index]!,
      file = entries[index]!;
    if (
      applied.migration_name !== `${file.version}_${file.name}` ||
      applied.checksum !== file.fileSha256
    )
      throw refused();
  }
  return ledger;
}
