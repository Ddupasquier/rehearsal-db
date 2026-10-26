/** Versioned exact native-tool binding, independent of filesystem/runtime execution. */
import type { PrismaNativeBinding } from "./prisma_history.mjs";

export interface NativeMigrationBinding extends PrismaNativeBinding {
  readonly toolchainSha256: string;
}

export const parseNativeMigrationBinding = (
  value: unknown,
): NativeMigrationBinding => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native migration binding is missing or invalid.");
  const x = value as Record<string, unknown>;
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
  a.kind === b.kind &&
  a.version === b.version &&
  a.provider === b.provider &&
  a.lockSha256 === b.lockSha256 &&
  a.toolchainSha256 === b.toolchainSha256;

/** Baseline history is portable; each execution review separately binds installed platform bytes. */
export const sameNativeMigrationHistory = (
  a: NativeMigrationBinding,
  b: NativeMigrationBinding,
) =>
  a.kind === b.kind &&
  a.version === b.version &&
  a.provider === b.provider &&
  a.lockSha256 === b.lockSha256;
