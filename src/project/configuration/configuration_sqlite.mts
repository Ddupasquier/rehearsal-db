/** Own SQLite-only configuration defaults and standalone file-budget validation. */
import {
  assertPositiveInteger,
  assertRelativePath,
} from "./configuration_validation.mjs";
import type { PlainObject } from "./configuration_validation.mjs";
export const normalizeSqliteConfiguration = (
  sqlite: PlainObject | null,
  resources: PlainObject,
  dependentTargetCount: number,
) => {
  const sqliteMaximumBytes = sqlite
    ? assertPositiveInteger(
        sqlite.maximumBytes ?? 64 * 1024 * 1024,
        "config.sqlite.maximumBytes",
      )
    : null;
  const sqliteTimeoutSeconds = sqlite
    ? assertPositiveInteger(
        sqlite.timeoutSeconds ?? 10,
        "config.sqlite.timeoutSeconds",
      )
    : null;
  if (
    sqlite &&
    (dependentTargetCount > 0 ||
      (resources.maximumBytes !== undefined && resources.maximumBytes !== null))
  )
    throw new Error(
      "The initial SQLite target is standalone and uses config.sqlite.maximumBytes for its file budget.",
    );
  if (
    sqlite &&
    (!Number.isSafeInteger(sqliteMaximumBytes) ||
      sqliteMaximumBytes! > 64 * 1024 * 1024 ||
      sqliteTimeoutSeconds! > 60)
  )
    throw new Error("SQLite limits must not exceed 64 MiB and 60 seconds.");
  if (
    sqlite &&
    ((resources.capacityAdmission as Record<string, unknown> | undefined)
      ?.enabled ||
      (resources.restoreCache as Record<string, unknown> | undefined)?.enabled)
  )
    throw new Error(
      "SQLite uses file budgets; container capacity admission and COPY caches do not apply.",
    );
  if (!sqlite) return null;
  return Object.freeze({
    sourceDatabase: assertRelativePath(
      sqlite.sourceDatabase,
      "config.sqlite.sourceDatabase",
    ),
    migrationDirectory: assertRelativePath(
      sqlite.migrationDirectory,
      "config.sqlite.migrationDirectory",
    ),
    runtimeWorkdir: assertRelativePath(
      sqlite.runtimeWorkdir ?? ".rehearsal/runtime",
      "config.sqlite.runtimeWorkdir",
    ),
    expectedVersion: expectedSqliteVersion(sqlite.expectedVersion),
    maximumBytes: sqliteMaximumBytes!,
    timeoutSeconds: sqliteTimeoutSeconds!,
  });
};
const expectedSqliteVersion = (value: unknown): "3.53.4" => {
  if (value !== undefined && value !== null && value !== "3.53.4")
    throw new Error("config.sqlite.expectedVersion must be one of: 3.53.4.");
  return "3.53.4";
};
