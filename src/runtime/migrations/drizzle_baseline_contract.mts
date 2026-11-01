/** Strict native format4 history receipts; source ledger IDs remain provenance. */
import { createHash } from "node:crypto";
import {
  parseDrizzleJournal,
  verifyDrizzleMigrationLedger,
  type DrizzleMigrationEntry,
} from "./drizzle_history.mjs";
import {
  parseDrizzleMigrationIdentity,
  sameMigrationCutoff,
  type MigrationCutoff,
} from "./migration_identity.mjs";
import { parseNativeMigrationBinding } from "./native_migration_contract.mjs";
const invalid = () =>
  new Error(
    "Drizzle baseline native history or journal receipt is inconsistent.",
  );
export const verifyDrizzleBaselineHistory = ({
  binding,
  history,
  cutoff,
  migrations,
  journal,
  historySha256,
}: {
  binding: unknown;
  history: unknown;
  cutoff: MigrationCutoff;
  migrations: Readonly<Record<string, { sha256: string }>>;
  journal: Uint8Array;
  historySha256: string;
}): DrizzleMigrationEntry[] => {
  if (
    !(journal instanceof Uint8Array) ||
    journal.byteLength < 1 ||
    journal.byteLength > 8 * 1024 * 1024 ||
    typeof historySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(historySha256)
  )
    throw invalid();
  const native = parseNativeMigrationBinding(binding);
  if (
    native.kind !== "drizzle" ||
    !history ||
    typeof history !== "object" ||
    Array.isArray(history)
  )
    throw invalid();
  const h = history as Record<string, unknown>;
  if (
    Object.keys(h).length !== 4 ||
    Object.keys(h).some(
      (key) =>
        !["schemaVersion", "entries", "sourceLedger", "journal"].includes(key),
    ) ||
    h.schemaVersion !== 1 ||
    !Array.isArray(h.entries) ||
    h.entries.length < 1 ||
    h.entries.length > 10000
  )
    throw invalid();
  const receipt = h.journal as Record<string, unknown>;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).length !== 3 ||
    receipt.path !== "meta/_journal.json" ||
    receipt.sha256 !== native.journalSha256 ||
    receipt.bytes !== journal.byteLength ||
    createHash("sha256").update(journal).digest("hex") !== native.journalSha256
  )
    throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        journal,
      ),
    );
  } catch {
    throw invalid();
  }
  const raw = parseDrizzleJournal(parsed);
  if (
    raw.length !== h.entries.length ||
    Object.keys(migrations).length !== raw.length
  )
    throw invalid();
  const storedEntries = h.entries;
  const entries = raw.map((entry, index) => {
    const stored = storedEntries[index] as Record<string, unknown>;
    const filename = `${entry.tag}.sql`,
      hash = migrations[filename]?.sha256;
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).length !== 7 ||
      Object.keys(stored).some(
        (key) =>
          ![
            "idx",
            "version",
            "when",
            "tag",
            "breakpoints",
            "filename",
            "hash",
          ].includes(key),
      ) ||
      stored.idx !== entry.idx ||
      stored.version !== entry.version ||
      stored.when !== entry.when ||
      stored.tag !== entry.tag ||
      stored.breakpoints !== entry.breakpoints ||
      stored.filename !== filename ||
      stored.hash !== hash ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(hash)
    )
      throw invalid();
    return { ...entry, filename, hash };
  });
  const ledger = verifyDrizzleMigrationLedger({
    rows: h.sourceLedger,
    entries,
  });
  if (
    ledger.length !== entries.length ||
    createHash("sha256")
      .update(JSON.stringify({ binding: native, history: ledger }))
      .digest("hex") !== historySha256
  )
    throw invalid();
  const last = entries.at(-1)!;
  if (
    !sameMigrationCutoff(parseDrizzleMigrationIdentity(cutoff), {
      kind: "drizzle",
      idx: last.idx,
      when: last.when,
      tag: last.tag,
    })
  )
    throw invalid();
  return entries;
};
