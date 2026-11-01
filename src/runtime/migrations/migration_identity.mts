/** Native migration identities are explicit; Drizzle milliseconds are never timestamp-file versions. */
import type { MigrationFileEntry } from "./migration_history.mjs";
import type { DrizzleMigrationEntry } from "./drizzle_history.mjs";
import {
  parseKnexMigrationIdentity,
  type KnexMigrationIdentity,
  type KnexMigrationEntry,
} from "./knex_history.mjs";
export interface DrizzleMigrationIdentity {
  readonly kind: "drizzle";
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}
export type MigrationCutoff =
  string | DrizzleMigrationIdentity | KnexMigrationIdentity;
export interface DrizzleMigrationFileEntry {
  readonly nativeIdentity: DrizzleMigrationIdentity;
  readonly name: string;
  readonly filename: string;
  readonly fileSha256: string;
  readonly breakpoints: boolean;
}
export type AnyMigrationFileEntry =
  MigrationFileEntry | DrizzleMigrationFileEntry | KnexMigrationEntry;
export const parseDrizzleMigrationIdentity = (
  value: unknown,
): DrizzleMigrationIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native Drizzle cutoff.");
  const x = value as Record<string, unknown>;
  if (
    Object.keys(x).length !== 4 ||
    Object.keys(x).some(
      (key) => !["kind", "idx", "when", "tag"].includes(key),
    ) ||
    x.kind !== "drizzle" ||
    typeof x.idx !== "number" ||
    !Number.isSafeInteger(x.idx) ||
    x.idx < 0 ||
    x.idx >= 10000 ||
    typeof x.when !== "number" ||
    !Number.isSafeInteger(x.when) ||
    x.when <= 0 ||
    typeof x.tag !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u.test(x.tag)
  )
    throw new Error("Invalid native Drizzle cutoff.");
  return Object.freeze({
    kind: "drizzle",
    idx: x.idx,
    when: x.when,
    tag: x.tag,
  });
};
export const parseMigrationCutoff = (value: unknown): MigrationCutoff => {
  if (typeof value === "string" && /^\d{14}$/u.test(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "knex"
  )
    return parseKnexMigrationIdentity(value);
  return parseDrizzleMigrationIdentity(value);
};
export const sameMigrationCutoff = (a: MigrationCutoff, b: MigrationCutoff) =>
  typeof a === "string" || typeof b === "string"
    ? a === b
    : a.kind === "knex" || b.kind === "knex"
      ? a.kind === "knex" && b.kind === "knex" && a.name === b.name
      : a.kind === b.kind &&
        a.idx === b.idx &&
        a.when === b.when &&
        a.tag === b.tag;
export const describeMigrationCutoff = (value: MigrationCutoff) =>
  typeof value === "string"
    ? value
    : value.kind === "knex"
      ? `Knex ${value.name}`
      : `Drizzle #${value.idx} (${value.when}, ${value.tag})`;
export const isDrizzleMigrationFile = (
  entry: AnyMigrationFileEntry,
): entry is DrizzleMigrationFileEntry =>
  "nativeIdentity" in entry && entry.nativeIdentity.kind === "drizzle";
export const isKnexMigrationFile = (
  entry: AnyMigrationFileEntry,
): entry is KnexMigrationEntry =>
  "nativeIdentity" in entry && entry.nativeIdentity.kind === "knex";
export const isNativeMigrationFile = (
  entry: AnyMigrationFileEntry,
): entry is DrizzleMigrationFileEntry | KnexMigrationEntry =>
  "nativeIdentity" in entry;
export const drizzleMigrationFiles = (
  entries: readonly DrizzleMigrationEntry[],
): DrizzleMigrationFileEntry[] =>
  entries.map((entry) => ({
    nativeIdentity: {
      kind: "drizzle",
      idx: entry.idx,
      when: entry.when,
      tag: entry.tag,
    },
    name: entry.tag,
    filename: entry.filename,
    fileSha256: entry.hash,
    breakpoints: entry.breakpoints,
  }));
export const drizzleNativeEntries = (
  entries: readonly AnyMigrationFileEntry[],
): DrizzleMigrationEntry[] =>
  entries.map((entry) => {
    if (!isDrizzleMigrationFile(entry))
      throw new Error("Drizzle history requires explicit native identities.");
    const id = parseDrizzleMigrationIdentity(entry.nativeIdentity);
    return {
      idx: id.idx,
      version: "7",
      when: id.when,
      tag: id.tag,
      breakpoints: entry.breakpoints,
      filename: entry.filename,
      hash: entry.fileSha256,
    };
  });

/** Legacy consumers must refuse explicit native identities rather than fabricate versions. */
export const requireTimestampMigrationFiles = (
  entries: readonly AnyMigrationFileEntry[],
): MigrationFileEntry[] => {
  if (entries.length > 10000)
    throw new Error("Timestamped migration inventory exceeds its bound.");
  return entries.map((entry) => {
    if (isNativeMigrationFile(entry))
      throw new Error(
        "This consumer requires timestamped SQL or Prisma migration identities.",
      );
    return entry;
  });
};
