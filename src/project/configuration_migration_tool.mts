/** Explicit, version-qualified native migration tool selection; never executes project config. */
import {
  assertKnownKeys,
  assertPlainObject,
  assertRelativePath,
} from "./configuration_validation.mjs";

export interface PrismaMigrationTool {
  readonly kind: "prisma";
  readonly version: "7.10.1";
  readonly packageDirectory: string;
}

export const normalizeMigrationTool = (
  value: unknown,
): PrismaMigrationTool | null => {
  if (value === undefined) return null;
  const tool = assertPlainObject(value, "config.postgresql.migrationTool");
  assertKnownKeys(
    tool,
    ["kind", "version", "packageDirectory"],
    "config.postgresql.migrationTool",
  );
  if (tool.kind !== "prisma" || tool.version !== "7.10.1")
    throw new Error(
      "Native migration support requires explicitly selected Prisma Migrate 7.10.1 / PostgreSQL.",
    );
  const packageDirectory = assertRelativePath(
    tool.packageDirectory,
    "config.postgresql.migrationTool.packageDirectory",
  );
  if (
    packageDirectory.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(packageDirectory)
  )
    throw new Error(
      "Native migration package directory must be a bounded path without control characters.",
    );
  return Object.freeze({
    kind: "prisma",
    version: "7.10.1",
    packageDirectory,
  });
};
