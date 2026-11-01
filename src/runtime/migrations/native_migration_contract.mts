/** Versioned exact native-tool binding, independent of filesystem/runtime execution. */
import type { PrismaNativeBinding } from "./prisma_history.mjs";
import { parseKnexCodeFiles, type KnexCodeFile } from "./knex_history.mjs";
import { createHash } from "node:crypto";

export interface PrismaMigrationBinding extends PrismaNativeBinding {
  readonly toolchainSha256: string;
}

export interface DrizzleMigrationBinding {
  readonly schemaVersion: 1;
  readonly kind: "drizzle";
  readonly kitVersion: "0.31.11";
  readonly ormVersion: "0.45.4";
  readonly driver: "pg";
  readonly driverVersion: "8.23.1";
  readonly journalVersion: "7";
  readonly dialect: "postgresql";
  readonly journalSha256: string;
  readonly toolchainSha256: string;
  readonly ledger: Readonly<{
    schema: "drizzle";
    table: "__drizzle_migrations";
  }>;
}
export interface KnexMigrationBinding {
  readonly schemaVersion: 1;
  readonly kind: "knex";
  readonly version: "3.3.0";
  readonly driver: "pg";
  readonly driverVersion: "8.23.1";
  readonly provider: "postgresql";
  readonly bundleSha256: string;
  readonly toolchainSha256: string;
  readonly isolationPolicySha256: string;
  readonly historicalFileChecksums: "unavailable";
  readonly codeFiles: readonly KnexCodeFile[];
  readonly ledger: Readonly<{ schema: "public"; table: "knex_migrations" }>;
}
export type NativeMigrationBinding =
  PrismaMigrationBinding | DrizzleMigrationBinding | KnexMigrationBinding;

export const parseNativeMigrationBinding = (
  value: unknown,
): NativeMigrationBinding => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native migration binding is missing or invalid.");
  const x = value as Record<string, unknown>;
  if (x.kind === "knex") {
    const keys = [
      "schemaVersion",
      "kind",
      "version",
      "driver",
      "driverVersion",
      "provider",
      "bundleSha256",
      "toolchainSha256",
      "isolationPolicySha256",
      "historicalFileChecksums",
      "ledger",
      "codeFiles",
    ];
    const ledger = x.ledger as Record<string, unknown> | undefined;
    if (
      Object.keys(x).length !== keys.length ||
      Object.keys(x).some((k) => !keys.includes(k)) ||
      x.schemaVersion !== 1 ||
      x.version !== "3.3.0" ||
      x.driver !== "pg" ||
      x.driverVersion !== "8.23.1" ||
      x.provider !== "postgresql" ||
      x.historicalFileChecksums !== "unavailable" ||
      ![x.bundleSha256, x.toolchainSha256, x.isolationPolicySha256].every(
        (s) => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s),
      ) ||
      !ledger ||
      Array.isArray(ledger) ||
      Object.keys(ledger).length !== 2 ||
      ledger.schema !== "public" ||
      ledger.table !== "knex_migrations"
    )
      throw new Error("Native Knex binding is invalid or unsupported.");
    const codeFiles = Object.freeze(parseKnexCodeFiles(x.codeFiles));
    if (
      createHash("sha256").update(JSON.stringify(codeFiles)).digest("hex") !==
      x.bundleSha256
    )
      throw new Error("Knex code bundle binding is inconsistent.");
    return Object.freeze({
      schemaVersion: 1,
      kind: "knex",
      version: "3.3.0",
      driver: "pg",
      driverVersion: "8.23.1",
      provider: "postgresql",
      bundleSha256: x.bundleSha256 as string,
      toolchainSha256: x.toolchainSha256 as string,
      isolationPolicySha256: x.isolationPolicySha256 as string,
      historicalFileChecksums: "unavailable",
      codeFiles,
      ledger: Object.freeze({ schema: "public", table: "knex_migrations" }),
    });
  }
  if (x.kind === "drizzle") {
    const keys = [
      "schemaVersion",
      "kind",
      "kitVersion",
      "ormVersion",
      "driver",
      "driverVersion",
      "journalVersion",
      "dialect",
      "journalSha256",
      "toolchainSha256",
      "ledger",
    ];
    const ledger = x.ledger as Record<string, unknown> | undefined;
    if (
      Object.keys(x).length !== keys.length ||
      Object.keys(x).some((key) => !keys.includes(key)) ||
      x.schemaVersion !== 1 ||
      x.kitVersion !== "0.31.11" ||
      x.ormVersion !== "0.45.4" ||
      x.driver !== "pg" ||
      x.driverVersion !== "8.23.1" ||
      x.journalVersion !== "7" ||
      x.dialect !== "postgresql" ||
      typeof x.journalSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(x.journalSha256) ||
      typeof x.toolchainSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(x.toolchainSha256) ||
      !ledger ||
      typeof ledger !== "object" ||
      Array.isArray(ledger) ||
      Object.keys(ledger).length !== 2 ||
      ledger.schema !== "drizzle" ||
      ledger.table !== "__drizzle_migrations"
    )
      throw new Error(
        "Native migration binding is missing, invalid or unsupported.",
      );
    return Object.freeze({
      schemaVersion: 1,
      kind: "drizzle",
      kitVersion: "0.31.11",
      ormVersion: "0.45.4",
      driver: "pg",
      driverVersion: "8.23.1",
      journalVersion: "7",
      dialect: "postgresql",
      journalSha256: x.journalSha256,
      toolchainSha256: x.toolchainSha256,
      ledger: Object.freeze({
        schema: "drizzle",
        table: "__drizzle_migrations",
      }),
    });
  }
  const keys = [
    "schemaVersion",
    "kind",
    "version",
    "provider",
    "lockSha256",
    "toolchainSha256",
  ];
  if (
    Object.keys(x).length !== keys.length ||
    Object.keys(x).some((key) => !keys.includes(key)) ||
    x.schemaVersion !== 1 ||
    x.kind !== "prisma" ||
    x.version !== "7.10.1" ||
    x.provider !== "postgresql" ||
    typeof x.lockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(x.lockSha256) ||
    typeof x.toolchainSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(x.toolchainSha256)
  )
    throw new Error(
      "Native migration binding is missing, invalid or unsupported.",
    );
  return Object.freeze({
    schemaVersion: 1,
    kind: "prisma",
    version: "7.10.1",
    provider: "postgresql",
    lockSha256: x.lockSha256,
    toolchainSha256: x.toolchainSha256,
  });
};

export const sameNativeMigrationBinding = (
  a: NativeMigrationBinding,
  b: NativeMigrationBinding,
) =>
  JSON.stringify(parseNativeMigrationBinding(a)) ===
  JSON.stringify(parseNativeMigrationBinding(b));

/** Exact native input/copy identity, independent of installed platform bytes.
 * Drizzle append compatibility instead uses the ordered semantic prefix in restore;
 * a historical producer journal SHA must not equal an appended current journal SHA.
 */
export const sameNativeMigrationHistory = (
  a: PrismaNativeBinding | DrizzleMigrationBinding | KnexMigrationBinding,
  b: PrismaNativeBinding | DrizzleMigrationBinding | KnexMigrationBinding,
) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "knex" && b.kind === "knex")
    return (
      a.version === b.version &&
      a.driverVersion === b.driverVersion &&
      a.bundleSha256 === b.bundleSha256 &&
      a.isolationPolicySha256 === b.isolationPolicySha256
    );
  if (a.kind === "drizzle" && b.kind === "drizzle")
    return (
      a.kitVersion === b.kitVersion &&
      a.ormVersion === b.ormVersion &&
      a.driver === b.driver &&
      a.driverVersion === b.driverVersion &&
      a.dialect === b.dialect &&
      a.journalVersion === b.journalVersion &&
      a.journalSha256 === b.journalSha256
    );
  return (
    a.kind === "prisma" &&
    b.kind === "prisma" &&
    a.version === b.version &&
    a.provider === b.provider &&
    a.lockSha256 === b.lockSha256
  );
};
