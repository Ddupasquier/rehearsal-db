/** Format5 preserves reviewed code, not a fabricated historical checksum ledger. */
import { createHash } from "node:crypto";
import { parseNativeMigrationBinding } from "./native_migration_contract.mjs";
import {
  parseKnexMigrationIdentity,
  verifyKnexMigrationLedger,
  type KnexMigrationEntry,
  type KnexCodeFile,
  type KnexLedgerEntry,
} from "./knex_history.mjs";
export interface KnexBaselineHistory {
  readonly schemaVersion: 1;
  readonly entries: readonly KnexMigrationEntry[];
  readonly files: readonly KnexCodeFile[];
  readonly sourceLedger: readonly KnexLedgerEntry[];
  readonly historicalFileChecksums: "unavailable";
}
const fail = () =>
  new Error(
    "Knex baseline reviewed code/history receipt is invalid; historical applied-file checksums are unavailable.",
  );
export const verifyKnexBaselineHistory = ({
  binding,
  history,
  cutoff,
  migrations,
  historySha256,
}: {
  binding: unknown;
  history: unknown;
  cutoff: unknown;
  migrations: Readonly<Record<string, { sha256: string }>>;
  historySha256: string;
}): KnexBaselineHistory => {
  const b = parseNativeMigrationBinding(binding);
  if (
    b.kind !== "knex" ||
    !history ||
    typeof history !== "object" ||
    Array.isArray(history)
  )
    throw fail();
  const h = history as Record<string, unknown>;
  if (
    Object.keys(h).length !== 5 ||
    ![
      "schemaVersion",
      "entries",
      "files",
      "sourceLedger",
      "historicalFileChecksums",
    ].every((k) => Object.hasOwn(h, k)) ||
    h.schemaVersion !== 1 ||
    h.historicalFileChecksums !== "unavailable" ||
    !Array.isArray(h.entries) ||
    !h.entries.length ||
    h.entries.length > 10000 ||
    !Array.isArray(h.files) ||
    h.files.length < h.entries.length ||
    h.files.length > 16000
  )
    throw fail();
  const entries = h.entries as KnexMigrationEntry[],
    ledger = verifyKnexMigrationLedger({ rows: h.sourceLedger, entries });
  if (
    ledger.length !== entries.length ||
    parseKnexMigrationIdentity(cutoff).name !== entries.at(-1)!.filename ||
    Object.keys(migrations).length !== entries.length
  )
    throw fail();
  let total = 0,
    previous = "";
  const files = h.files as KnexCodeFile[];
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      Object.keys(file).length !== 3 ||
      !["filename", "fileSha256", "bytes"].every((k) =>
        Object.hasOwn(file, k),
      ) ||
      typeof file.filename !== "string" ||
      file.filename.length > 3072 ||
      file.filename.split("/").length > 17 ||
      file.filename <= previous ||
      file.filename
        .split("/")
        .some(
          (p) =>
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,190}$/u.test(p) ||
            ["node_modules", "notes", "package.json"].includes(p),
        ) ||
      !/^[a-f0-9]{64}$/u.test(file.fileSha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 8 * 1024 * 1024 ||
      (total += file.bytes) > 64 * 1024 * 1024
    )
      throw fail();
    previous = file.filename;
  }
  for (const entry of entries)
    if (
      Object.keys(entry).length !== 4 ||
      entry.fileSha256 !== migrations[entry.filename]?.sha256 ||
      files.find((f) => f.filename === entry.filename)?.fileSha256 !==
        entry.fileSha256
    )
      throw fail();
  if (
    files.filter((f) => !f.filename.includes("/")).length !== entries.length ||
    createHash("sha256").update(JSON.stringify(files)).digest("hex") !==
      b.bundleSha256 ||
    createHash("sha256")
      .update(JSON.stringify({ binding: b, history: ledger }))
      .digest("hex") !== historySha256
  )
    throw fail();
  return {
    schemaVersion: 1,
    entries,
    files,
    sourceLedger: ledger,
    historicalFileChecksums: "unavailable",
  };
};
