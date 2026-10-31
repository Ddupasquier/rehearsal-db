import {
  withKnexRestrictedRole,
  currentKnexSqlCredentials,
  currentKnexSqlSignal,
} from "./knex_restricted_role.mjs";
import { runKnexRestrictedSql } from "./knex_restricted_sql.mjs";
import type { KnexSqlPhase } from "./knex_role_receipt.mjs";
import { runKnexAdminSql } from "./knex_admin_sql.mjs";
import { inspectKnexWorkerEngine } from "./knex_worker_engine.mjs";
import {
  readKnexMigrationInventory,
  normalizeKnexMigrationLedger,
  verifyKnexMigrationLedger,
} from "../runtime/knex_history.mjs";
import { inspectKnexToolchain } from "../runtime/knex_toolchain.mjs";
import { deployKnexMigrations } from "./knex_migration_process.mjs";
import {
  drizzleMigrationFiles,
  drizzleNativeEntries,
  isDrizzleMigrationFile,
  isKnexMigrationFile,
  isNativeMigrationFile,
  type AnyMigrationFileEntry,
} from "../runtime/migration_identity.mjs";
import {
  readDrizzleMigrationInventory,
  verifyDrizzleMigrationLedger,
  normalizeDrizzleMigrationLedger,
} from "../runtime/drizzle_history.mjs";
import { inspectDrizzleToolchain } from "../runtime/drizzle_toolchain.mjs";
import { deployDrizzleMigrations } from "./drizzle_migration_process.mjs";
/** PostgreSQL migration ownership: existing SQL ledger or explicitly selected native producer. */
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
import {
  createCandidateMigrationReceipt,
  assertBaselineMigrationHistory,
} from "../runtime/restore.mjs";
import { runOwnedPostgresqlMigration } from "./postgresql_process.mjs";
import { deployPrismaMigrations } from "./prisma_migration_process.mjs";
import { inspectPrismaToolchain } from "../runtime/prisma_toolchain.mjs";

type Loaded = Awaited<ReturnType<typeof loadRehearsalConfig>>;
const quote = (x: string) => `'${x.replaceAll("'", "''")}'`;

export const createPostgresqlMigrationRuntime = ({
  loaded,
  runSql,
  assertOwnedTarget,
  assertExpectedBaseline,
  containerName,
  database,
  databaseUser,
}: {
  loaded: Loaded;
  runSql: (sql: string) => string;
  assertOwnedTarget: () => string;
  assertExpectedBaseline: (baseline: BaselineManifest) => Promise<void>;
  containerName: string;
  database: string;
  databaseUser: string;
}) => {
  const tool = loaded.config.postgresql?.migrationTool;
  const runKnexSql = (sql: string) =>
    runKnexAdminSql({
      cwd: loaded.projectRoot,
      containerId: assertOwnedTarget(),
      database,
      user: databaseUser,
      sql,
    });
  const withRestrictedPhase = async <T,>(
    phase: KnexSqlPhase,
    work: () => Promise<T> | T,
    generationId?: string,
  ): Promise<T> =>
    tool?.kind === "knex"
      ? withKnexRestrictedRole({
          projectId: loaded.config.runtime.projectId,
          database,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          runSql: runKnexSql,
          assertOwnedTarget,
          phase,
          ...(generationId ? { generationId } : {}),
          ...(phase === "application"
            ? {
                authenticateApplication: (
                  credentials: Parameters<
                    typeof runKnexRestrictedSql
                  >[0]["credentials"],
                ) => {
                  if (
                    runKnexRestrictedSql({
                      cwd: loaded.projectRoot,
                      credentials,
                      assertOwnedTarget,
                      sql: "select session_user;",
                    }).trim() !== credentials.user
                  )
                    throw new Error(
                      "Restricted Knex application authentication could not be verified.",
                    );
                },
              }
            : {}),
          work: async () => work(),
        })
      : work();
  const readKnexLedger = () => {
    assertOwnedTarget();
    let rows: unknown;
    try {
      rows = JSON.parse(
        runKnexRestrictedSql({
          cwd: loaded.projectRoot,
          credentials: currentKnexSqlCredentials(),
          assertOwnedTarget,
          sql: `select coalesce(json_agg(history), '[]'::json)::text from (select id,name,batch,migration_time::text from public.knex_migrations order by id limit 10001) history;`,
        }),
      );
    } catch {
      throw new Error(
        "Knex native runtime ledger is unavailable; provider output is withheld.",
      );
    }
    return normalizeKnexMigrationLedger(rows);
  };
  const readDrizzleLedger = () => {
    assertOwnedTarget();
    let rows: unknown;
    try {
      rows = JSON.parse(
        runSql(
          `select coalesce(json_agg(history), '[]'::json)::text from (select id, hash, created_at from drizzle.__drizzle_migrations order by created_at, id limit 10001) history;`,
        ),
      );
    } catch {
      throw new Error(
        "Native Drizzle runtime ledger output is invalid; provider output is withheld.",
      );
    }
    return normalizeDrizzleMigrationLedger(rows);
  };
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
    currentFiles: readonly AnyMigrationFileEntry[];
    baseline: BaselineManifest;
  }) => {
    if (tool?.kind === "knex") {
      const entries = currentFiles.map((entry) => {
        if (!isKnexMigrationFile(entry))
          throw new Error("Knex native names are required.");
        return entry;
      });
      const ledger = verifyKnexMigrationLedger({
        rows: readKnexLedger(),
        entries,
      });
      const baselineCount = Object.keys(baseline.migrations).length;
      if (ledger.length < baselineCount)
        throw new Error("Knex runtime ledger is missing its baseline prefix.");
      return { ledger, appliedCandidateCount: ledger.length - baselineCount };
    }
    if (tool?.kind === "drizzle") {
      const ledger = verifyDrizzleMigrationLedger({
        rows: readDrizzleLedger(),
        entries: drizzleNativeEntries(currentFiles),
      });
      const baselineCount = Object.keys(baseline.migrations).length;
      if (ledger.length < baselineCount)
        throw new Error(
          "Drizzle runtime ledger is missing the baseline prefix.",
        );
      return { ledger, appliedCandidateCount: ledger.length - baselineCount };
    }
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
        isNativeMigrationFile(source) ||
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
    withRestrictedPhase,
    assertOwnedTarget,
    plan,
    prepareMutation: async (
      baseline: BaselineManifest,
      confirm?: (receipt: Awaited<ReturnType<typeof plan>>) => void,
    ) => {
      const receipt = await plan(baseline);
      if (tool?.kind === "knex")
        inspectKnexWorkerEngine({
          cwd: loaded.projectRoot,
          projectId: loaded.config.runtime.projectId,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
        });
      confirm?.(receipt);
      return receipt;
    },
    validateHistory: async (baseline: BaselineManifest) => {
      if (!tool) return;
      if (tool.kind === "knex") {
        const inventory = await readKnexMigrationInventory(
          pathToFileURL(`${loaded.paths.migrationDirectory}/`),
        );
        const producer = parseNativeMigrationBinding(baseline.nativeMigrations);
        if (producer.kind !== "knex")
          throw new Error("Knex baseline is required.");
        assertBaselineMigrationHistory({
          baselineManifest: baseline,
          currentFiles: inventory.entries,
          nativeMigrations: {
            ...producer,
            bundleSha256: inventory.bundleSha256,
            codeFiles: inventory.files,
          },
        });
        return;
      }
      if (tool.kind === "drizzle") {
        const inventory = await readDrizzleMigrationInventory(
          pathToFileURL(`${loaded.paths.migrationDirectory}/`),
        );
        assertBaselineMigrationHistory({
          baselineManifest: baseline,
          currentFiles: drizzleMigrationFiles(inventory.entries),
          nativeMigrations: parseNativeMigrationBinding({
            ...inventory.binding,
            driver: "pg",
            driverVersion: "8.23.1",
            toolchainSha256: "0".repeat(64),
          }),
        });
        return;
      }
      const inventory = await readPrismaMigrationInventory(
        pathToFileURL(`${loaded.paths.migrationDirectory}/`),
      );
      assertBaselineMigrationHistory({
        baselineManifest: baseline,
        currentFiles: inventory.entries,
        nativeMigrations: inventory.binding,
      });
    },
    readLedger:
      tool?.kind === "knex"
        ? readKnexLedger
        : tool?.kind === "drizzle"
          ? readDrizzleLedger
          : readLedger,
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
      beforeReplay?: () => void,
    ) => {
      if (tool?.kind === "knex" && currentKnexSqlSignal())
        throw new Error(
          "Knex reset schema restore requires an independent phase boundary; no preparation or replay was attempted.",
        );
      if (tool?.kind !== "knex") beforeReplay?.();
      if (tool?.kind === "knex") {
        const producer = parseNativeMigrationBinding(baseline.nativeMigrations);
        if (producer.kind !== "knex")
          throw new Error("Knex baseline binding is required.");
        const toolchain = await inspectKnexToolchain({
          projectRoot: loaded.projectRoot,
          tool,
        });
        const inventory = await readKnexMigrationInventory(
          pathToFileURL(`${directory}/`),
        );
        await withRestrictedPhase("worker", async () => {
          beforeReplay?.();
          await deployKnexMigrations({
            projectRoot: loaded.projectRoot,
            tool,
            directory,
            runtimeWorkdir: loaded.paths.runtimeWorkdir,
            projectId: loaded.config.runtime.projectId,
            entries: inventory.entries,
            binding: { ...producer, toolchainSha256: toolchain.sha256 },
            databaseUrl,
            runSql: runKnexSql,
            assertOwnedTarget,
            assertExpectedBaseline: () => assertExpectedBaseline(baseline),
          });
        });
        await withRestrictedPhase("verify", () =>
          verifyLedger({ currentFiles: inventory.entries, baseline }),
        );
      } else if (tool?.kind === "drizzle") {
        const producer = parseNativeMigrationBinding(baseline.nativeMigrations);
        if (producer.kind !== "drizzle")
          throw new Error("Drizzle baseline binding is required.");
        const toolchain = await inspectDrizzleToolchain({
          projectRoot: loaded.projectRoot,
          tool,
        });
        const inventory = await readDrizzleMigrationInventory(
          pathToFileURL(`${directory}/`),
        );
        await deployDrizzleMigrations({
          projectRoot: loaded.projectRoot,
          tool,
          directory,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          entries: drizzleMigrationFiles(inventory.entries),
          binding: { ...producer, toolchainSha256: toolchain.sha256 },
          databaseUrl,
          assertOwnedTarget,
          assertExpectedBaseline: () => assertExpectedBaseline(baseline),
        });
        verifyLedger({
          currentFiles: drizzleMigrationFiles(inventory.entries),
          baseline,
        });
      } else if (tool) {
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
          assertExpectedBaseline: () => assertExpectedBaseline(baseline),
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
      const before = await withRestrictedPhase("verify", () =>
        verifyLedger({
          currentFiles: receipt.currentFiles,
          baseline,
        }),
      );
      if (tool?.kind === "knex") {
        const entries = receipt.currentFiles.map((entry) => {
          if (!isKnexMigrationFile(entry))
            throw new Error("Knex native names are required.");
          return entry;
        });
        await deployKnexMigrations({
          projectRoot: loaded.projectRoot,
          tool,
          directory: loaded.paths.migrationDirectory,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          projectId: loaded.config.runtime.projectId,
          entries,
          binding: parseNativeMigrationBinding(receipt.nativeMigrations),
          databaseUrl,
          runSql: runKnexSql,
          assertOwnedTarget,
          assertExpectedBaseline: () => assertExpectedBaseline(baseline),
        });
      } else if (tool?.kind === "drizzle") {
        const entries = receipt.currentFiles.map((entry) => {
          if (!isDrizzleMigrationFile(entry))
            throw new Error("Native Drizzle identity missing.");
          return entry;
        });
        await deployDrizzleMigrations({
          projectRoot: loaded.projectRoot,
          tool,
          directory: loaded.paths.migrationDirectory,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          entries,
          binding: parseNativeMigrationBinding(receipt.nativeMigrations),
          databaseUrl,
          assertOwnedTarget,
          assertExpectedBaseline: () => assertExpectedBaseline(baseline),
        });
      } else if (tool) {
        await deployPrismaMigrations({
          projectRoot: loaded.projectRoot,
          packageDirectory: tool.packageDirectory,
          directory: loaded.paths.migrationDirectory,
          runtimeWorkdir: loaded.paths.runtimeWorkdir,
          entries: receipt.currentFiles.map((entry) => {
            if (isNativeMigrationFile(entry))
              throw new Error("Prisma requires timestamped native entries.");
            return entry;
          }),
          binding: parseNativeMigrationBinding(receipt.nativeMigrations),
          databaseUrl,
          assertOwnedTarget,
          assertExpectedBaseline: () => assertExpectedBaseline(baseline),
        });
      } else {
        for (const migration of receipt.candidates.slice(
          before.appliedCandidateCount,
        ))
          if (isNativeMigrationFile(migration))
            throw new Error("SQL execution cannot consume Drizzle identities.");
          else
            await applySql(
              migration,
              loaded.paths.migrationDirectory,
              "candidate",
            );
      }
    },
  };
};
