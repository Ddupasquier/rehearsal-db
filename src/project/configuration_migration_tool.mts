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

export interface DrizzleMigrationTool {
  readonly kind: "drizzle";
  readonly kitVersion: "0.31.11";
  readonly ormVersion: "0.45.4";
  readonly driver: "pg";
  readonly driverVersion: "8.23.1";
  readonly packageDirectory: string;
  readonly ormPackageDirectory: string;
  readonly driverPackageDirectory: string;
}
export type NativeMigrationTool = PrismaMigrationTool | DrizzleMigrationTool;
const packagePath = (value: unknown, label: string) => {
  const path = assertRelativePath(value, label);
  if (path.length > 512 || /[\u0000-\u001f\u007f]/u.test(path))
    throw new Error("Native migration package path is unsafe.");
  return path;
};
export const normalizeMigrationTool = (
  value: unknown,
): NativeMigrationTool | null => {
  if (value === undefined) return null;
  const tool = assertPlainObject(value, "config.postgresql.migrationTool");
  if (tool.kind === "drizzle") {
    assertKnownKeys(
      tool,
      [
        "kind",
        "kitVersion",
        "ormVersion",
        "driver",
        "driverVersion",
        "packageDirectory",
        "ormPackageDirectory",
        "driverPackageDirectory",
      ],
      "config.postgresql.migrationTool",
    );
    if (
      tool.kitVersion !== "0.31.11" ||
      tool.ormVersion !== "0.45.4" ||
      tool.driver !== "pg" ||
      tool.driverVersion !== "8.23.1"
    )
      throw new Error(
        "Drizzle requires explicitly pinned Kit 0.31.11, ORM 0.45.4 and pg 8.23.1 / PostgreSQL.",
      );
    return Object.freeze({
      kind: "drizzle",
      kitVersion: "0.31.11",
      ormVersion: "0.45.4",
      driver: "pg",
      driverVersion: "8.23.1",
      packageDirectory: packagePath(
        tool.packageDirectory,
        "migrationTool.packageDirectory",
      ),
      ormPackageDirectory: packagePath(
        tool.ormPackageDirectory,
        "migrationTool.ormPackageDirectory",
      ),
      driverPackageDirectory: packagePath(
        tool.driverPackageDirectory,
        "migrationTool.driverPackageDirectory",
      ),
    });
  }
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
