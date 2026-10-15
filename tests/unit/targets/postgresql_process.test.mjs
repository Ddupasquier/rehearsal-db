import { describe, expect, it, vi } from "vitest";
import { runOwnedPostgresqlSql } from "../../../dist/src/targets/postgresql_process.mjs";
import { normalizeRehearsalError } from "../../../dist/src/shared/diagnostics.mjs";
import { runOwnedSupabaseMigration } from "../../../dist/src/targets/supabase_process.mjs";

describe("PostgreSQL migration failure boundary", () => {
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
