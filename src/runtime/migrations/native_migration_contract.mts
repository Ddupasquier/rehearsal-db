/** Versioned exact native-tool binding, independent of filesystem/runtime execution. */
import type { PrismaNativeBinding } from "./prisma_history.mjs";

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
export type NativeMigrationBinding =
  PrismaMigrationBinding | DrizzleMigrationBinding;

export const parseNativeMigrationBinding = (
  value: unknown,
): NativeMigrationBinding => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native migration binding is missing or invalid.");
  const x = value as Record<string, unknown>;
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
  a: PrismaNativeBinding | DrizzleMigrationBinding,
  b: PrismaNativeBinding | DrizzleMigrationBinding,
) => {
  if (a.kind !== b.kind) return false;
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
