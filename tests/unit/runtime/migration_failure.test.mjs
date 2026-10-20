import { describe, expect, it } from "vitest";
import {
  diagnoseMigrationFailure,
  parseMigrationFailureDiagnostic,
  readManagerMigrationFailure,
  renderMigrationFailureDiagnostic,
} from "../../../dist/src/runtime/migration_failure.mjs";
import {
  parseMigrationFailureSource,
  renderMigrationSourceFrame,
} from "../../../dist/src/runtime/migration_failure_source.mjs";

const source = () => ({
  schemaVersion: 1,
  kind: "candidate",
  filename: "20261020000100_broken.sql",
  sha256: "a".repeat(64),
  workspaceRelativePath: "db/migrations/20261020000100_broken.sql",
  line: null,
  column: null,
  evidence: "owned_execution_input",
});

describe("safe provider migration diagnoses", () => {
  it.each([
    ["42601", "syntax", "SQL syntax"],
    ["23502", "constraint", "NOT NULL"],
    ["23503", "constraint", "foreign-key"],
    ["23505", "constraint", "uniqueness"],
    ["23514", "constraint", "CHECK constraint"],
    ["23P01", "constraint", "exclusion"],
    ["42P01", "schema", "table"],
    ["42703", "schema", "column"],
    ["42501", "permission", "permission"],
    ["28P01", "permission", "authentication"],
    ["08006", "connectivity", "connection"],
    ["57014", "timeout_or_cancel", "cancelled"],
    ["XX000", "unknown", "not a confirmed syntax error"],
  ])(
    "maps native SQLSTATE %s without inspecting private values",
    (code, classification, summary) => {
      for (const provider of ["postgresql", "supabase"]) {
        const stderr =
          provider === "postgresql"
            ? `psql:<stdin>:9: ERROR: ${code}\nDETAIL: PRIVATE_ROW_CANARY\nCONTEXT: PRIVATE_SQL_CANARY`
            : `ERROR: PRIVATE_SQL_CANARY (SQLSTATE ${code})\nDETAIL: PRIVATE_ROW_CANARY`;
        const diagnostic = diagnoseMigrationFailure({ provider, stderr });
        expect(diagnostic).toMatchObject({
          schemaVersion: 1,
          provider,
          sqlState: code,
          classification,
          evidence: "provider_sqlstate",
        });
        expect(diagnostic.summary).toContain(summary);
        expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_");
        expect(parseMigrationFailureDiagnostic(diagnostic)).toEqual(diagnostic);
      }
    },
  );

  it.each([
    "syntax error at PRIVATE_SQL_CANARY",
    "DETAIL: user said ERROR: 42601: syntax error",
    "SQLSTATE 42601",
    "NOTICE: ERROR: 42601: syntax error",
    "ERROR: 23514x",
    "ERROR: 00000",
    "PRIVATE_SQL_CANARY\n".repeat(10000),
  ])("does not guess from unsupported or oversized evidence", (stderr) => {
    const result = diagnoseMigrationFailure({ provider: "postgresql", stderr });
    expect(result.classification).toBe("unknown");
    expect(result.sqlState).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("refuses conflicting native SQLSTATE evidence instead of choosing a cause", () => {
    const result = diagnoseMigrationFailure({
      provider: "postgresql",
      stderr: "ERROR: 42601\nERROR: 23514",
    });
    expect(result).toMatchObject({
      classification: "unknown",
      sqlState: null,
      evidence: "ambiguous",
    });
  });

  it("rejects private or changed structured diagnostic fields", () => {
    const valid = diagnoseMigrationFailure({
      provider: "postgresql",
      stderr: "ERROR: 23514",
    });
    for (const invalid of [
      { ...valid, summary: "PRIVATE_ROW_CANARY" },
      { ...valid, suggestions: ["echo PRIVATE_SQL_CANARY"] },
      { ...valid, sql: "PRIVATE_SQL_CANARY" },
      { ...valid, evidence: "guessed" },
      { ...valid, sqlState: "PRIVATE" },
      { ...valid, classification: "syntax" },
      { ...valid, provider: "other" },
      { ...valid, provider: ["postgresql"] },
    ])
      expect(() => parseMigrationFailureDiagnostic(invalid)).toThrow(
        "Invalid safe migration diagnostic",
      );
  });

  it("reconstructs only canonical explanations from the private manager boundary", () => {
    const diagnostic = diagnoseMigrationFailure({
      provider: "postgresql",
      stderr: "ERROR: 23514",
    });
    const header =
      "Error: The confirmed candidate PostgreSQL migration failed (exit 3; stderr 99 bytes). SQL and provider output are withheld.";
    expect(
      readManagerMigrationFailure(
        `${header}\n${renderMigrationFailureDiagnostic(diagnostic)}\nPRIVATE_ROW_CANARY`,
      ),
    ).toEqual(diagnostic);
    expect(
      readManagerMigrationFailure("Migration SQLSTATE: 23514."),
    ).toBeUndefined();
  });

  it("retains optional attempted input while old diagnostics remain unchanged", () => {
    const diagnostic = diagnoseMigrationFailure({
      provider: "postgresql",
      stderr: "ERROR: 42601",
    });
    expect(parseMigrationFailureDiagnostic(diagnostic)).not.toHaveProperty(
      "source",
    );
    const attributed = { ...diagnostic, source: source() };
    expect(parseMigrationFailureDiagnostic(attributed)).toEqual(attributed);
    const header =
      "Error: The confirmed candidate PostgreSQL migration failed (exit 3; stderr 99 bytes). SQL and provider output are withheld.";
    expect(
      readManagerMigrationFailure(
        `${header}\n${renderMigrationFailureDiagnostic(attributed)}`,
      ),
    ).toEqual(attributed);
    expect(attributed.source.line).toBeNull();
    expect(attributed.source.column).toBeNull();
  });

  it("rejects unsafe paths, metadata and invented source positions", () => {
    for (const invalid of [
      { ...source(), filename: "20261020000100_private\nrow.sql" },
      { ...source(), filename: "20261020000100_Uppercase.sql" },
      { ...source(), kind: ["candidate"] },
      { ...source(), line: 4 },
      { ...source(), column: 20 },
      { ...source(), sql: "PRIVATE_SQL_CANARY" },
      ...[
        "/tmp/file.sql",
        "../file.sql",
        "a/../file.sql",
        "a//file.sql",
        "a/./file.sql",
        "C:/file.sql",
        "a\\file.sql",
        "a/%2e%2e/file.sql",
        "a/\u202efile.sql",
        "a/\nfile.sql",
        "a/file.sql",
        `${"a".repeat(1025)}/${source().filename}`,
      ].map((workspaceRelativePath) => ({
        ...source(),
        workspaceRelativePath,
      })),
    ])
      expect(() => parseMigrationFailureSource(invalid)).toThrow(
        "Invalid migration input provenance",
      );
  });

  it("omits malformed, duplicate, displaced or oversized manager attribution without guessing", () => {
    const header =
      "Error: The confirmed candidate PostgreSQL migration failed (exit 3; stderr 99 bytes). SQL and provider output are withheld.";
    const code = "Migration SQLSTATE: 42601.";
    const frame = renderMigrationSourceFrame(source());
    const prefix = "Rehearsal migration input v1: ";
    for (const output of [
      `${header}\n${code}\n${frame}\n${frame}`,
      `${frame}\n${header}\n${code}\n${frame}`,
      `${header}\n${code}\nOther line\n${frame}`,
      `${header}\n${code}\n${prefix}NOT_CANONICAL!`,
      `${header}\n${code}\n${prefix}${"x".repeat(4097)}`,
      `${header}\n${code}\n${prefix}${Buffer.from(JSON.stringify({ ...source(), line: 2 })).toString("base64url")}`,
    ]) {
      const diagnostic = readManagerMigrationFailure(output);
      expect(diagnostic.sqlState).toBe("42601");
      expect(diagnostic).not.toHaveProperty("source");
    }
    expect(
      readManagerMigrationFailure(
        `${header}\n${code}\n${frame}\n${"x".repeat(128 * 1024)}`,
      ),
    ).toBeUndefined();
  });
});
