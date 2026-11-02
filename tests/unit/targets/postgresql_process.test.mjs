import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runOwnedPostgresqlMigration,
  runOwnedPostgresqlSql,
} from "../../../dist/src/targets/postgresql_process.mjs";
import { normalizeRehearsalError } from "../../../dist/src/shared/diagnostics.mjs";
import { runOwnedSupabaseMigration } from "../../../dist/src/targets/supabase_process.mjs";
import { readManagerMigrationFailure } from "../../../dist/src/runtime/migrations/migration_failure.mjs";
import { createUnitTemporaryDirectory } from "../../helpers/unit_temporary_global.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const inputForTest = async (sql, filename = "20261020000100_broken.sql") => {
  const root = await createUnitTemporaryDirectory("rehearsal-migration-input-");
  roots.push(root);
  const directory = join(root, "project migrations ü");
  await mkdir(directory);
  await writeFile(join(directory, filename), sql);
  return {
    root,
    directory,
    migration: {
      filename,
      version: "20261020000100",
      name: "broken",
      fileSha256: createHash("sha256").update(sql).digest("hex"),
    },
  };
};
const failedProcess = () =>
  vi.fn(async () => ({
    status: 3,
    signal: null,
    stdout: "PRIVATE_ROW_CANARY",
    stderr: "psql:<stdin>:99: ERROR: 42601\nPRIVATE_SQL_CANARY",
    stdoutByteCount: 18,
    stderrByteCount: 60,
  }));

describe("PostgreSQL migration failure boundary", () => {
  it.each([
    "select 1; select missing syntax;",
    "-- ; comment\nselect ';'; /* ; */ select broken;",
    "do $$ begin perform ';'; end $$;\r\nselect 'é🙂';\r\nselect broken;",
  ])(
    "attributes exact submitted bytes without claiming positions for %s",
    async (sql) => {
      const { root, directory, migration } = await inputForTest(sql);
      const runProcessImplementation = failedProcess();
      const failure = await runOwnedPostgresqlMigration({
        containerName: "synthetic-owned",
        database: "postgres",
        databaseUser: "postgres",
        repositoryRoot: root,
        migration,
        directory,
        migrationKind: "candidate",
        runProcessImplementation,
      }).catch((error) => error);
      const diagnostic = readManagerMigrationFailure(
        `Error: ${failure.message}`,
      );
      expect(diagnostic.source).toEqual({
        schemaVersion: 1,
        kind: "candidate",
        filename: migration.filename,
        sha256: migration.fileSha256,
        workspaceRelativePath: `project migrations ü/${migration.filename}`,
        line: null,
        column: null,
        evidence: "owned_execution_input",
      });
      expect(runProcessImplementation.mock.calls[0][0].input).toBe(sql);
      expect(failure.message).not.toContain(sql);
      expect(failure.message).not.toContain("PRIVATE_");
    },
  );

  it("refuses non-UTF-8 reviewed bytes without substituting input or starting a process", async () => {
    const bytes = Buffer.from([
      0x73, 0x65, 0x6c, 0x65, 0x63, 0x74, 0x20, 0xe9, 0x3b,
    ]);
    const { root, directory, migration } = await inputForTest(bytes);
    const runProcessImplementation = failedProcess();
    const failure = await runOwnedPostgresqlMigration({
      containerName: "synthetic-owned",
      database: "postgres",
      databaseUser: "postgres",
      repositoryRoot: root,
      migration,
      directory,
      migrationKind: "candidate",
      runProcessImplementation,
    }).catch((error) => error);
    expect(failure.message).toContain("not valid UTF-8");
    expect(failure.message).toContain("Save it as UTF-8");
    expect(failure.message).toContain("no migration SQL was started");
    expect(
      readManagerMigrationFailure(`Error: ${failure.message}`),
    ).toBeUndefined();
    expect(runProcessImplementation).not.toHaveBeenCalled();
  });

  it("refuses reviewed-byte drift before process creation and omits unsupported filename telemetry", async () => {
    const { root, directory, migration } = await inputForTest("select 1;");
    await writeFile(join(directory, migration.filename), "select 2;");
    const runProcessImplementation = failedProcess();
    await expect(
      runOwnedPostgresqlMigration({
        containerName: "synthetic-owned",
        database: "postgres",
        databaseUser: "postgres",
        repositoryRoot: root,
        migration,
        directory,
        migrationKind: "candidate",
        runProcessImplementation,
      }),
    ).rejects.toThrow("changed before execution");
    expect(runProcessImplementation).not.toHaveBeenCalled();
    const unsupported = await inputForTest(
      "select 1;",
      "20261020000100_Uppercase.sql",
    );
    const failure = await runOwnedPostgresqlMigration({
      containerName: "synthetic-owned",
      database: "postgres",
      databaseUser: "postgres",
      repositoryRoot: unsupported.root,
      migration: unsupported.migration,
      directory: unsupported.directory,
      migrationKind: "candidate",
      runProcessImplementation,
    }).catch((error) => error);
    expect(runProcessImplementation).toHaveBeenCalledOnce();
    expect(
      readManagerMigrationFailure(`Error: ${failure.message}`),
    ).not.toHaveProperty("source");
  });

  it("withholds private baseline paths while retaining the submitted file identity", async () => {
    const { root, directory, migration } = await inputForTest("select broken;");
    const failure = await runOwnedPostgresqlMigration({
      containerName: "synthetic-owned",
      database: "postgres",
      databaseUser: "postgres",
      repositoryRoot: root,
      migration,
      directory,
      migrationKind: "baseline",
      runProcessImplementation: failedProcess(),
    }).catch((error) => error);
    expect(
      readManagerMigrationFailure(`Error: ${failure.message}`).source,
    ).toMatchObject({
      kind: "baseline",
      filename: migration.filename,
      workspaceRelativePath: null,
      line: null,
      column: null,
    });
  });
  it("keeps the same safe candidate boundary for Supabase", async () => {
    let failure;
    try {
      await runOwnedSupabaseMigration({
        environment: {},
        repositoryRoot: process.cwd(),
        runtimeWorkdir: "synthetic-owned",
        runProcessImplementation: async () => ({
          status: 1,
          signal: null,
          stdout: "PRIVATE_SQL_CANARY",
          stderr: "PRIVATE_ROW_CANARY",
          stdoutByteCount: 18,
          stderrByteCount: 18,
        }),
      });
    } catch (error) {
      failure = error;
    }
    expect(normalizeRehearsalError(failure).category).toBe(
      "migration_candidate_failure",
    );
    expect(failure.message).not.toContain("PRIVATE_");
  });
  it.each([
    ["baseline", "baseline_invalid"],
    ["candidate", "migration_candidate_failure"],
  ])(
    "keeps %s phase identity without printing SQL/provider values",
    async (migrationKind, category) => {
      const runProcessImplementation = vi.fn(async () => ({
        status: 3,
        signal: null,
        stdout: "PRIVATE_ROW_CANARY",
        stderr: "ERROR: PRIVATE_SQL_CANARY",
        stdoutByteCount: 18,
        stderrByteCount: 25,
      }));
      let failure;
      try {
        await runOwnedPostgresqlSql({
          containerName: "synthetic-owned",
          database: "postgres",
          databaseUser: "postgres",
          repositoryRoot: process.cwd(),
          sql: "PRIVATE_SQL_CANARY",
          migrationKind,
          runProcessImplementation,
        });
      } catch (error) {
        failure = error;
      }
      expect(normalizeRehearsalError(failure).category).toBe(category);
      expect(failure.message).toContain("exit 3; stderr 25 bytes");
      expect(failure.message).not.toContain("PRIVATE_");
      expect(runProcessImplementation).toHaveBeenCalledOnce();
      expect(runProcessImplementation.mock.calls[0][0].input).toBe(
        "PRIVATE_SQL_CANARY",
      );
    },
  );
});
