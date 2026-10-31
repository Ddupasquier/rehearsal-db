/** Pinned Drizzle journal/ledger metadata only: no configuration, imports or SQL execution. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";

export const DRIZZLE_HISTORY_LIMITS = Object.freeze({
  maximumMigrations: 10000,
  maximumDirectoryEntries: 20002,
  maximumFileBytes: 8 * 1024 * 1024,
  maximumTotalBytes: 64 * 1024 * 1024,
});
export interface DrizzleJournalEntry {
  readonly idx: number;
  readonly version: "7";
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}
export interface DrizzleMigrationEntry extends DrizzleJournalEntry {
  readonly filename: string;
  readonly hash: string;
}
export interface DrizzleLedgerEntry {
  readonly id: number;
  readonly hash: string;
  readonly created_at: number;
}
export interface DrizzleHistoryBinding {
  readonly schemaVersion: 1;
  readonly kind: "drizzle";
  readonly kitVersion: "0.31.11";
  readonly ormVersion: "0.45.4";
  readonly journalVersion: "7";
  readonly dialect: "postgresql";
  readonly journalSha256: string;
  readonly ledger: Readonly<{
    schema: "drizzle";
    table: "__drizzle_migrations";
  }>;
}
const invalid = () =>
  new Error(
    "Drizzle PostgreSQL migration history is unavailable, unsafe, incomplete or divergent; no code or SQL was executed.",
  );
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u;
const checksumPattern = /^[a-f0-9]{64}$/u;
const hash = (bytes: NodeJS.ArrayBufferView) =>
  createHash("sha256").update(bytes).digest("hex");
const plain = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  )
    throw invalid();
};
const positive = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw invalid();
  return value;
};
const text = (bytes: Buffer): string => {
  try {
    // Preserve BOM/CRLF exactly: the pinned ORM hashes Buffer.toString() UTF-8,
    // whose bytes match the original only for well-formed UTF-8.
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (!Buffer.from(decoded).equals(bytes)) throw invalid();
    return decoded;
  } catch {
    throw invalid();
  }
};
export const parseDrizzleJournal = (value: unknown): DrizzleJournalEntry[] => {
  const journal = plain(value);
  keys(journal, ["version", "dialect", "entries"]);
  if (
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    !journal.entries.length ||
    journal.entries.length > DRIZZLE_HISTORY_LIMITS.maximumMigrations
  )
    throw invalid();
  let previous = 0;
  const tags = new Set<string>();
  return Array.from(journal.entries, (item: unknown, index: number) => {
    const entry = plain(item);
    keys(entry, ["idx", "version", "when", "tag", "breakpoints"]);
    const when = positive(entry.when);
    if (
      entry.idx !== index ||
      entry.version !== "7" ||
      when <= previous ||
      typeof entry.tag !== "string" ||
      !tagPattern.test(entry.tag) ||
      tags.has(entry.tag) ||
      typeof entry.breakpoints !== "boolean"
    )
      throw invalid();
    previous = when;
    tags.add(entry.tag);
    return Object.freeze({
      idx: index,
      version: "7",
      when,
      tag: entry.tag,
      breakpoints: entry.breakpoints,
    });
  });
};
const same = (before: BigIntStats, after: BigIntStats) =>
  after.isFile() &&
  !after.isSymbolicLink() &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

export const readDrizzleMigrationInventory = async (
  directory: URL,
  options: {
    readonly onBytes?: (filename: string, bytes: Buffer) => void;
  } = {},
): Promise<{
  entries: DrizzleMigrationEntry[];
  binding: DrizzleHistoryBinding;
}> => {
  try {
    if (directory.protocol !== "file:" || directory.search || directory.hash)
      throw invalid();
    const root = await holdPathAncestry(fileURLToPath(directory));
    try {
      let visited = 0,
        totalBytes = 0;
      const files: Array<{ path: string; stat: BigIntStats }> = [];
      const visit = () => {
        if (++visited > DRIZZLE_HISTORY_LIMITS.maximumDirectoryEntries)
          throw invalid();
      };
      const sqlNames = new Set<string>();
      let hasMeta = false;
      for await (const entry of await opendir(root.path)) {
        visit();
        if (
          entry.name === "meta" &&
          entry.isDirectory() &&
          !entry.isSymbolicLink()
        )
          hasMeta = true;
        else if (
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.endsWith(".sql") &&
          tagPattern.test(entry.name.slice(0, -4))
        )
          sqlNames.add(entry.name);
        else throw invalid();
        if (sqlNames.size > DRIZZLE_HISTORY_LIMITS.maximumMigrations)
          throw invalid();
      }
      if (!hasMeta) throw invalid();
      const meta = await holdPathAncestry(join(root.path, "meta"));
      try {
        const read = async (
          filename: string,
          consume = true,
        ): Promise<Buffer> => {
          await root.assertUnchanged();
          await meta.assertUnchanged();
          const path = join(root.path, filename),
            leaf = await lstat(path, { bigint: true });
          if (!leaf.isFile() || leaf.isSymbolicLink()) throw invalid();
          const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const before = await handle.stat({ bigint: true });
            if (
              !same(leaf, before) ||
              before.size > BigInt(DRIZZLE_HISTORY_LIMITS.maximumFileBytes) ||
              BigInt(totalBytes) + before.size >
                BigInt(DRIZZLE_HISTORY_LIMITS.maximumTotalBytes)
            )
              throw invalid();
            let bytes = Buffer.alloc(0);
            if (consume) {
              const buffer = Buffer.alloc(Number(before.size) + 1);
              let offset = 0;
              while (offset < buffer.length) {
                const part = await handle.read(
                  buffer,
                  offset,
                  buffer.length - offset,
                  offset,
                );
                if (!part.bytesRead) break;
                offset += part.bytesRead;
              }
              if (offset !== Number(before.size)) throw invalid();
              bytes = buffer.subarray(0, offset);
              text(bytes);
              options.onBytes?.(filename, Buffer.from(bytes));
            }
            if (
              !same(before, await handle.stat({ bigint: true })) ||
              !same(before, await lstat(path, { bigint: true }))
            )
              throw invalid();
            await root.assertUnchanged();
            await meta.assertUnchanged();
            files.push({ path, stat: before });
            totalBytes += Number(before.size);
            return bytes;
          } finally {
            await handle.close();
          }
        };
        const journalBytes = await read("meta/_journal.json");
        let journal: unknown;
        try {
          journal = JSON.parse(text(journalBytes));
        } catch {
          throw invalid();
        }
        const rows = parseDrizzleJournal(journal);
        if (
          sqlNames.size !== rows.length ||
          rows.some((entry) => !sqlNames.has(`${entry.tag}.sql`))
        )
          throw invalid();
        let hasJournal = false;
        // Kit's optional snapshots are generator inputs, not read by either
        // pinned PostgreSQL ORM migrator. Only their bounded regular-file
        // identities are observed; their contents are not parsed or hashed.
        for await (const entry of await opendir(meta.path)) {
          visit();
          if (!entry.isFile() || entry.isSymbolicLink()) throw invalid();
          if (entry.name === "_journal.json") hasJournal = true;
          else {
            const match = /^(\d{4})_snapshot\.json$/u.exec(entry.name);
            if (!match || Number(match[1]) >= rows.length) throw invalid();
            await read(`meta/${entry.name}`, false);
          }
        }
        if (!hasJournal) throw invalid();
        const entries: DrizzleMigrationEntry[] = [];
        for (const entry of rows) {
          const filename = `${entry.tag}.sql`;
          entries.push(
            Object.freeze({
              ...entry,
              filename,
              hash: hash(await read(filename)),
            }),
          );
        }
        for (const file of files)
          if (!same(file.stat, await lstat(file.path, { bigint: true })))
            throw invalid();
        await meta.assertUnchanged();
        await root.assertUnchanged();
        return {
          entries,
          binding: Object.freeze({
            schemaVersion: 1,
            kind: "drizzle",
            kitVersion: "0.31.11",
            ormVersion: "0.45.4",
            journalVersion: "7",
            dialect: "postgresql",
            journalSha256: hash(journalBytes),
            ledger: Object.freeze({
              schema: "drizzle",
              table: "__drizzle_migrations",
            }),
          }),
        };
      } finally {
        await meta.close();
      }
    } finally {
      await root.close();
    }
  } catch {
    throw invalid();
  }
};
const databaseInteger = (value: unknown): number => {
  if (typeof value === "string") {
    if (!/^[1-9]\d{0,15}$/u.test(value)) throw invalid();
    const parsed = Number(value);
    if (String(parsed) !== value) throw invalid();
    return positive(parsed);
  }
  return positive(value);
};
export const normalizeDrizzleMigrationLedger = (
  rows: unknown,
): DrizzleLedgerEntry[] => {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > DRIZZLE_HISTORY_LIMITS.maximumMigrations
  )
    throw invalid();
  let previousId = 0,
    previousTime = 0;
  return Array.from(rows, (row: unknown) => {
    const value = plain(row);
    keys(value, ["id", "hash", "created_at"]);
    const id = databaseInteger(value.id),
      created_at = databaseInteger(value.created_at);
    if (
      id > 2147483647 ||
      id <= previousId ||
      created_at <= previousTime ||
      typeof value.hash !== "string" ||
      !checksumPattern.test(value.hash)
    )
      throw invalid();
    previousId = id;
    previousTime = created_at;
    return Object.freeze({ id, hash: value.hash, created_at });
  });
};
export const verifyDrizzleMigrationLedger = ({
  rows,
  entries,
}: {
  rows: unknown;
  entries: readonly DrizzleMigrationEntry[];
}): DrizzleLedgerEntry[] => {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > DRIZZLE_HISTORY_LIMITS.maximumMigrations
  )
    throw invalid();
  const journal = parseDrizzleJournal({
    version: "7",
    dialect: "postgresql",
    entries: Array.from(entries, (value) => {
      const entry = plain(value);
      keys(entry, [
        "idx",
        "version",
        "when",
        "tag",
        "breakpoints",
        "filename",
        "hash",
      ]);
      return {
        idx: entry.idx,
        version: entry.version,
        when: entry.when,
        tag: entry.tag,
        breakpoints: entry.breakpoints,
      };
    }),
  });
  for (let i = 0; i < entries.length; i++) {
    const entry = plain(entries[i]);
    keys(entry, [
      "idx",
      "version",
      "when",
      "tag",
      "breakpoints",
      "filename",
      "hash",
    ]);
    if (
      entry.filename !== `${journal[i]!.tag}.sql` ||
      typeof entry.hash !== "string" ||
      !checksumPattern.test(entry.hash)
    )
      throw invalid();
  }
  const ledger = normalizeDrizzleMigrationLedger(rows);
  if (ledger.length > entries.length) throw invalid();
  for (let i = 0; i < ledger.length; i++)
    if (
      ledger[i]!.created_at !== entries[i]!.when ||
      ledger[i]!.hash !== entries[i]!.hash
    )
      throw invalid();
  return ledger;
};
