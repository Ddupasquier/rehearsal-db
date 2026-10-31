/** Native names and current bytes; Knex's ledger does not attest historical bytes. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";

export const KNEX_HISTORY_LIMITS = Object.freeze({
  maximumMigrations: 10000,
  maximumEntries: 16000,
  maximumFileBytes: 8 * 1024 * 1024,
  maximumTotalBytes: 64 * 1024 * 1024,
  maximumDepth: 16,
});
export interface KnexMigrationIdentity {
  readonly kind: "knex";
  readonly name: string;
}
export interface KnexMigrationEntry {
  readonly nativeIdentity: KnexMigrationIdentity;
  readonly filename: string;
  readonly name: string;
  readonly fileSha256: string;
}
export interface KnexCodeFile {
  readonly filename: string;
  readonly fileSha256: string;
  readonly bytes: number;
}
export const parseKnexCodeFiles = (value: unknown): KnexCodeFile[] => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > KNEX_HISTORY_LIMITS.maximumEntries
  )
    throw fail();
  let previous = "",
    total = 0;
  return Array.from(value, (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
    const f = raw as Record<string, unknown>;
    if (
      Object.keys(f).length !== 3 ||
      typeof f.filename !== "string" ||
      f.filename.length > 3072 ||
      f.filename.split("/").length > KNEX_HISTORY_LIMITS.maximumDepth + 1 ||
      (!f.filename.includes("/") && !namePattern.test(f.filename)) ||
      f.filename <= previous ||
      f.filename
        .split("/")
        .some(
          (p) =>
            !segment.test(p) ||
            ["node_modules", "notes", "package.json"].includes(p),
        ) ||
      typeof f.fileSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(f.fileSha256) ||
      typeof f.bytes !== "number" ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes < 0 ||
      f.bytes > KNEX_HISTORY_LIMITS.maximumFileBytes ||
      (total += f.bytes) > KNEX_HISTORY_LIMITS.maximumTotalBytes
    )
      throw fail();
    previous = f.filename;
    return Object.freeze({
      filename: f.filename,
      fileSha256: f.fileSha256,
      bytes: f.bytes,
    });
  });
};
export interface KnexLedgerEntry {
  readonly id: number;
  readonly name: string;
  readonly batch: number;
  readonly migration_time: string;
}
const fail = () =>
  new Error(
    "Knex native history or reviewed code is unavailable, unsafe or divergent; historical file checksums are unavailable and no code was executed.",
  );
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,185}\.cjs$/u;
const segment = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,190}$/u;
export const parseKnexMigrationIdentity = (
  value: unknown,
): KnexMigrationIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const x = value as Record<string, unknown>;
  if (
    Object.keys(x).length !== 2 ||
    x.kind !== "knex" ||
    typeof x.name !== "string" ||
    !namePattern.test(x.name)
  )
    throw fail();
  return Object.freeze({ kind: "knex", name: x.name });
};
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.isFile() === b.isFile() &&
  a.isDirectory() === b.isDirectory() &&
  !b.isSymbolicLink();
export const readKnexMigrationInventory = async (
  directory: URL,
  options: { onBytes?: (name: string, bytes: Buffer) => void } = {},
) => {
  try {
    if (directory.protocol !== "file:" || directory.hash || directory.search)
      throw fail();
    const held = await holdPathAncestry(fileURLToPath(directory));
    try {
      let count = 0,
        total = 0;
      const files: KnexCodeFile[] = [],
        witnesses: Array<{ path: string; stat: BigIntStats }> = [];
      const walk = async (
        path: string,
        prefix: string,
        depth: number,
      ): Promise<void> => {
        if (depth > KNEX_HISTORY_LIMITS.maximumDepth) throw fail();
        const parent = await lstat(path, { bigint: true });
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail();
        await held.assertUnchanged();
        for await (const entry of await opendir(path)) {
          if (
            ++count > KNEX_HISTORY_LIMITS.maximumEntries ||
            !segment.test(entry.name) ||
            ["node_modules", "notes", "package.json"].includes(entry.name) ||
            entry.name.startsWith(".")
          )
            throw fail();
          const filename = prefix + entry.name,
            child = join(path, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            if (!prefix && entry.name.endsWith(".cjs")) throw fail();
            await walk(child, filename + "/", depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            (!prefix && !namePattern.test(entry.name))
          )
            throw fail();
          const leaf = await lstat(child, { bigint: true }),
            fd = await open(
              child,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
          try {
            const before = await fd.stat({ bigint: true });
            if (
              !before.isFile() ||
              !same(leaf, before) ||
              before.size > BigInt(KNEX_HISTORY_LIMITS.maximumFileBytes) ||
              BigInt(total) + before.size >
                BigInt(KNEX_HISTORY_LIMITS.maximumTotalBytes)
            )
              throw fail();
            const bytes = Buffer.alloc(Number(before.size) + 1);
            let offset = 0;
            while (offset < bytes.length) {
              const r = await fd.read(
                bytes,
                offset,
                bytes.length - offset,
                offset,
              );
              if (!r.bytesRead) break;
              offset += r.bytesRead;
            }
            if (
              offset !== Number(before.size) ||
              !same(before, await fd.stat({ bigint: true })) ||
              !same(before, await lstat(child, { bigint: true }))
            )
              throw fail();
            const content = bytes.subarray(0, offset);
            total += offset;
            // Migration modules must be valid native UTF-8; support assets remain raw bytes.
            if (!prefix)
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                content,
              );
            files.push(
              Object.freeze({
                filename,
                fileSha256: createHash("sha256").update(content).digest("hex"),
                bytes: offset,
              }),
            );
            witnesses.push({ path: child, stat: before });
            options.onBytes?.(filename, content);
          } finally {
            await fd.close();
          }
        }
        if (!same(parent, await lstat(path, { bigint: true }))) throw fail();
        witnesses.push({ path, stat: parent });
        await held.assertUnchanged();
      };
      await walk(held.path, "", 0);
      files.sort((a, b) =>
        a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
      );
      const entries: KnexMigrationEntry[] = files
        .filter((x) => !x.filename.includes("/"))
        .map((x) =>
          Object.freeze({
            nativeIdentity: parseKnexMigrationIdentity({
              kind: "knex",
              name: x.filename,
            }),
            filename: x.filename,
            name: x.filename,
            fileSha256: x.fileSha256,
          }),
        );
      if (
        !entries.length ||
        entries.length > KNEX_HISTORY_LIMITS.maximumMigrations
      )
        throw fail();
      for (const witness of witnesses)
        if (!same(witness.stat, await lstat(witness.path, { bigint: true })))
          throw fail();
      await held.assertUnchanged();
      return Object.freeze({
        entries,
        files,
        bundleSha256: createHash("sha256")
          .update(JSON.stringify(files))
          .digest("hex"),
        historicalFileChecksums: "unavailable" as const,
      });
    } finally {
      await held.close();
    }
  } catch {
    throw fail();
  }
};
export const normalizeKnexMigrationLedger = (
  rows: unknown,
): KnexLedgerEntry[] => {
  if (
    !Array.isArray(rows) ||
    rows.length > KNEX_HISTORY_LIMITS.maximumMigrations
  )
    throw fail();
  let id = 0,
    batch = 0;
  const names = new Set<string>();
  return Array.from(rows, (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
    const r = raw as Record<string, unknown>;
    if (
      Object.keys(r).length !== 4 ||
      !["id", "name", "batch", "migration_time"].every((k) =>
        Object.hasOwn(r, k),
      ) ||
      typeof r.id !== "number" ||
      !Number.isSafeInteger(r.id) ||
      r.id <= id ||
      r.id > 2147483647 ||
      typeof r.batch !== "number" ||
      !Number.isSafeInteger(r.batch) ||
      r.batch <= 0 ||
      r.batch > 2147483647 ||
      r.batch < batch ||
      typeof r.name !== "string" ||
      !namePattern.test(r.name) ||
      names.has(r.name) ||
      typeof r.migration_time !== "string" ||
      r.migration_time.length > 64 ||
      !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/u.test(
        r.migration_time,
      ) ||
      !Number.isFinite(Date.parse(r.migration_time))
    )
      throw fail();
    id = r.id;
    batch = r.batch;
    names.add(r.name);
    return Object.freeze({
      id,
      name: r.name,
      batch,
      migration_time: r.migration_time,
    });
  });
};
export const verifyKnexMigrationLedger = ({
  rows,
  entries,
}: {
  rows: unknown;
  entries: readonly KnexMigrationEntry[];
}) => {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > KNEX_HISTORY_LIMITS.maximumMigrations
  )
    throw fail();
  const ledger = normalizeKnexMigrationLedger(rows);
  if (ledger.length > entries.length) throw fail();
  for (let i = 0; i < entries.length; i++) {
    const x = entries[i]!;
    parseKnexMigrationIdentity(x.nativeIdentity);
    if (
      x.filename !== x.name ||
      x.nativeIdentity.name !== x.filename ||
      !/^[a-f0-9]{64}$/u.test(x.fileSha256) ||
      (i > 0 && entries[i - 1]!.filename >= x.filename) ||
      (i < ledger.length && ledger[i]!.name !== x.filename)
    )
      throw fail();
  }
  return ledger;
};
