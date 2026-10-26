/** PostgreSQL migration ownership: existing SQL ledger or explicitly selected native Prisma. */
import { pathToFileURL } from "node:url";
import type { loadRehearsalConfig } from "../project/configuration.mjs";
import type { BaselineManifest } from "../baseline/artifact.mjs";
import {
  readMigrationFileInventory,
  type MigrationFileEntry,
} from "../runtime/migration_history.mjs";
import { readConfiguredMigrationSource } from "../runtime/native_migration_source.mjs";
import { parseNativeMigrationBinding } from "../runtime/native_migration_contract.mjs";
import {
  normalizePrismaMigrationLedger,
  readPrismaMigrationInventory,
} from "../runtime/prisma_history.mjs";
import { createCandidateMigrationReceipt } from "../runtime/restore.mjs";
import { runOwnedPostgresqlMigration } from "./postgresql_process.mjs";
import { deployPrismaMigrations } from "./prisma_migration_process.mjs";
import { inspectPrismaToolchain } from "../runtime/prisma_toolchain.mjs";

type Loaded = Awaited<ReturnType<typeof loadRehearsalConfig>>;
const quote = (x: string) => `'${x.replaceAll("'", "''")}'`;

export const createPostgresqlMigrationRuntime = ({
  loaded,
  runSql,
  assertOwnedTarget,
  containerName,
  database,
  databaseUser,
}: {
  loaded: Loaded;
  runSql: (sql: string) => string;
  assertOwnedTarget: () => string;
  containerName: string;
  database: string;
  databaseUser: string;
}) => {
  const tool = loaded.config.postgresql?.migrationTool;
  const readLedger = () => {
    if (tool) {
      assertOwnedTarget();
      const rows = JSON.parse(
        runSql(`select coalesce(json_agg(history), '[]'::json)::text from (
select migration_name, checksum, finished_at::text, rolled_back_at::text
from public._prisma_migrations order by migration_name limit 10001
) history;`),
      );
      return normalizePrismaMigrationLedger(rows).map((row) => ({
        version: row.migration_name.slice(0, 14),
        name: row.migration_name.slice(15),
        fileSha256: row.checksum,
      }));
    }
    return runSql(`select version || E'\\t' || name || E'\\t' || file_sha256
from rehearsal_internal.schema_migrations order by version;`)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [version, name, fileSha256] = line.split("\t");
        return { version, name, fileSha256 };
      });
  };
  const verifyLedger = ({
    currentFiles,
    baseline,
  }: {
    currentFiles: readonly MigrationFileEntry[];
    baseline: BaselineManifest;
  }) => {
    const ledger = readLedger();
    const baselineCount = Object.keys(baseline.migrations).length;
    if (ledger.length < baselineCount || ledger.length > currentFiles.length)
      throw new Error(
        "The PostgreSQL runtime migration ledger has an unexpected length.",
      );
    for (let i = 0; i < ledger.length; i++) {
      const applied = ledger[i]!,
        source = currentFiles[i]!;
      if (
        applied.version !== source.version ||
        applied.name !== source.name ||
        applied.fileSha256 !== source.fileSha256
      )
        throw new Error(
          "The PostgreSQL runtime migration ledger differs from the reviewed native/SQL history.",
        );
    }
    return { ledger, appliedCandidateCount: ledger.length - baselineCount };
  };
  const plan = async (baseline: BaselineManifest) => {
    const source = await readConfiguredMigrationSource(loaded);
    return {
      currentFiles: source.entries,
      nativeMigrations: source.binding,
      ...createCandidateMigrationReceipt({
        baselineManifest: baseline,
        currentFiles: source.entries,
        nativeMigrations: source.binding,
      }),
    };
  };
  const applySql = async (
    migration: MigrationFileEntry,
    directory: string,
    kind: "baseline" | "candidate",
  ) => {
    await runOwnedPostgresqlMigration({
      containerName,
      database,
      databaseUser,
      repositoryRoot: loaded.projectRoot,
      migration,
      directory,
      migrationKind: kind,
    });
    runSql(`insert into rehearsal_internal.schema_migrations (version, name, file_sha256)
values (${quote(migration.version)}, ${quote(migration.name)}, ${quote(migration.fileSha256)});`);
  };
  return {
    plan,
    readLedger,
    verifyLedger,
    initialize: () => {
      if (!tool)
        runSql(`create schema if not exists rehearsal_internal;
create table if not exists rehearsal_internal.schema_migrations (
version text primary key, name text not null,
file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
applied_at timestamptz not null default now());`);
    },
    restore: async (
      baseline: BaselineManifest,
      directory: string,
      databaseUrl: string,
    ) => {
      if (tool) {
        const producer = parseNativeMigrationBinding(baseline.nativeMigrations);
        const toolchain = await inspectPrismaToolchain({
          projectRoot: loaded.projectRoot,
          packageDirectory: tool.packageDirectory,
        });
        const binding = { ...producer, toolchainSha256: toolchain.sha256 };
        const inventory = await readPrismaMigrationInventory(
          pathToFileURL(`${directory}/`),
        );
        await deployPrismaMigrations({
          projectRoot: loaded.projectRoot,
          packageDirectory: tool.packageDirectory,
          directory,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          entries: inventory.entries,
          binding,
          databaseUrl,
          assertOwnedTarget,
        });
        verifyLedger({ currentFiles: inventory.entries, baseline });
      } else {
        for (const migration of await readMigrationFileInventory(
          pathToFileURL(`${directory}/`),
        ))
          await applySql(migration, directory, "baseline");
      }
    },
    apply: async (
      baseline: BaselineManifest,
      receipt: Awaited<ReturnType<typeof plan>>,
      databaseUrl: string,
    ) => {
      const before = verifyLedger({
        currentFiles: receipt.currentFiles,
        baseline,
      });
      if (tool) {
        await deployPrismaMigrations({
          projectRoot: loaded.projectRoot,
          packageDirectory: tool.packageDirectory,
          directory: loaded.paths.migrationDirectory,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          entries: receipt.currentFiles,
          binding: parseNativeMigrationBinding(receipt.nativeMigrations),
          databaseUrl,
          assertOwnedTarget,
        });
      } else {
        for (const migration of receipt.candidates.slice(
          before.appliedCandidateCount,
        ))
          await applySql(
            migration,
            loaded.paths.migrationDirectory,
            "candidate",
          );
      }
    },
  };
};
