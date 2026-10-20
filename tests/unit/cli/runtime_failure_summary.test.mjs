import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { summarizeRuntimeManagerFailure } from "../../../dist/src/cli/runtime_failure_summary.mjs";
import { runtimePortFailureGuidance } from "../../../dist/src/cli/runtime_failure_summary.mjs";
import { classifyManagerFailure } from "../../../dist/src/cli/runtime_commands.mjs";
import { normalizeRehearsalError } from "../../../dist/src/shared/diagnostics.mjs";
import {
  diagnoseMigrationFailure,
  readManagerMigrationFailure,
  renderMigrationFailureDiagnostic,
} from "../../../dist/src/runtime/migration_failure.mjs";

describe("runtime manager failure summary", () => {
  it("reconstructs only validated source frames and keeps bounded cleanup guidance for long paths", () => {
    const source = {
      schemaVersion: 1,
      kind: "candidate",
      filename: "20261020000100_broken.sql",
      sha256: "a".repeat(64),
      workspaceRelativePath: "migrations/20261020000100_broken.sql",
      line: null,
      column: null,
      evidence: "owned_execution_input",
    };
    const diagnostic = {
      ...diagnoseMigrationFailure({
        provider: "postgresql",
        stderr: "ERROR: 23514",
      }),
      source,
    };
    const header =
      "Error: The confirmed candidate PostgreSQL migration failed (exit 3; stderr 99 bytes). SQL and provider output are withheld.";
    const summary = summarizeRuntimeManagerFailure(
      `${header}\n${renderMigrationFailureDiagnostic(diagnostic)}\nPRIVATE_ROW_CANARY`,
    );
    expect(readManagerMigrationFailure(summary)).toEqual(diagnostic);
    expect(summary).not.toContain("PRIVATE_");
    const longSource = {
      ...source,
      workspaceRelativePath: `${"a".repeat(980)}/${source.filename}`,
    };
    const complete = `AggregateError: The runtime operation failed and its owned runtime could not be removed automatically.\n${header}\n${renderMigrationFailureDiagnostic({ ...diagnostic, source: longSource })}`;
    expect(readManagerMigrationFailure(complete).source).toEqual(longSource);
    const bounded = summarizeRuntimeManagerFailure(complete);
    expect(bounded.length).toBeLessThanOrEqual(2000);
    expect(bounded).toContain("Resources may remain");
    expect(bounded).toContain("Rows do not satisfy a CHECK constraint");
  });
  it.each(["PostgreSQL", "Supabase"])(
    "preserves %s port guidance without echoing private bind output",
    (provider) => {
      const summary = summarizeRuntimeManagerFailure(
        `Error: ${provider} startup failed (exit 1).\nReported startup evidence: port_unavailable.\nPort guidance: PRIVATE_ROW_CANARY\nFor PRIVATE_SQL_CANARY\nProvider logs, paths, environment values and connection URLs are omitted. This summary does not establish the underlying cause.`,
      );
      expect(summary).toContain(
        "netsh interface ipv4 show excludedportrange protocol=tcp",
      );
      expect(summary).toContain("does not prove");
      expect(summary).not.toContain("PRIVATE_");
      expect(runtimePortFailureGuidance(summary).join("\n")).not.toMatch(
        /increase|capacity|memory/u,
      );
      for (const action of ["run", "migrate"])
        expect(
          classifyManagerFailure({
            action,
            output: summary,
            inferredCategory: "internal_failure",
          }),
        ).toBe("runtime_dependency_failure");
    },
  );
  it("retains fixed constraint guidance through Node aggregate errors without leaking provider details", () => {
    const summary = summarizeRuntimeManagerFailure(
      "AggregateError: The runtime operation failed and its owned runtime could not be removed automatically.\nError: The confirmed candidate PostgreSQL migration failed (exit 3; stderr 99 bytes). SQL and provider output are withheld.\nMigration SQLSTATE: 23514.\nPRIVATE_ROW_CANARY\nError: PRIVATE_ROLLBACK_CANARY",
    );
    expect(summary).toContain("Rows do not satisfy a CHECK constraint");
    expect(summary).toContain("Existing rows may not satisfy");
    expect(summary).toContain("Resources may remain");
    expect(summary).not.toContain("PRIVATE_");
  });
  it("preserves the actual original migration phase and a retention warning across Node aggregate formatting", () => {
    for (const phase of ["confirmed candidate", "baseline"]) {
      const failure = `The ${phase} PostgreSQL migration failed (exit 3; stderr 25 bytes). SQL and provider output are withheld.`;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `throw new AggregateError([new Error(${JSON.stringify(failure)}),new Error("PRIVATE_ROLLBACK_CANARY")],"The runtime operation failed and its owned runtime could not be removed automatically.");`,
        ],
        { encoding: "utf8" },
      );
      const summary = summarizeRuntimeManagerFailure(result.stderr);
      expect(summary).toContain(failure);
      expect(summary).toContain("Resources may remain");
      expect(summary).not.toContain("PRIVATE_ROLLBACK_CANARY");
      expect(summary).not.toContain("throw new");
      expect(
        classifyManagerFailure({
          action: "run",
          output: summary,
          inferredCategory: normalizeRehearsalError(new Error(summary))
            .category,
        }),
      ).toBe(
        phase === "baseline"
          ? "baseline_invalid"
          : "migration_candidate_failure",
      );
    }
  });
  it("removes source literals and successful baseline progress before categorizing a candidate failure", () => {
    const summary = summarizeRuntimeManagerFailure(
      `Restored Rehearsal baseline synthetic: 2 rows.\nfile:///private/driver.mjs:25\nthrow new Error('PRIVATE_SOURCE_CANARY');\n^\nError: The confirmed candidate PostgreSQL migration failed (exit 3; stderr 25 bytes). SQL and provider output are withheld.\nat applyMigration (...)\nNode.js v24.21.0`,
    );
    expect(summary).toContain(
      "confirmed candidate PostgreSQL migration failed",
    );
    expect(summary).not.toContain("Restored Rehearsal baseline");
    expect(summary).not.toContain("PRIVATE_SOURCE_CANARY");
    expect(summary).not.toContain("throw new");
  });
  it("keeps startup evidence rather than trailing debug advice and Node frames", () => {
    const output = `file:///private/candidate-acceptance/start.mjs:20
throw new Error(message);
^
Error: Supabase startup failed (exit 1).
Reported startup evidence: health_check.
Reported service states: auth=starting.
Provider logs, paths, environment values and connection URLs are omitted. This summary does not establish the underlying cause.
Try rerunning the command with --debug to troubleshoot the error.
at startLocalSupabase (file:///private/candidate-acceptance/start.mjs:20:2)
at async startRuntime (file:///private/candidate-acceptance/runtime.mjs:50:3)
Node.js v24.21.0`;
    const summary = summarizeRuntimeManagerFailure(output);
    expect(summary).toContain("auth=starting");
    expect(summary).not.toContain("candidate-acceptance");
    expect(summary).not.toContain("Node.js");
    expect(summary).not.toContain("at async");
    expect(summary).not.toContain("--debug");
  });

  it("removes URLs, assignments and paths before category inference", () => {
    const summary = summarizeRuntimeManagerFailure(
      "Error: runtime command failed at /private/candidate-acceptance/file.mjs\nAPI_URL=https://private.example/callback?token=private-canary\nDB_URL=postgresql://owner:private-password@localhost/private",
    );
    for (const value of [
      "private-canary",
      "private-password",
      "private.example",
      "candidate-acceptance",
    ])
      expect(summary).not.toContain(value);
    expect(summary).toContain("runtime command failed");
  });

  it("preserves a safe explicit retention warning when startup cleanup also fails", () => {
    const summary = summarizeRuntimeManagerFailure(
      "AggregateError: Runtime startup failed and exact owned cleanup could not be proved. Resources and data were retained; inspect activity and status before retrying.\nError: Supabase startup failed (exit 1).\nReported startup evidence: health_check.\nReported service states: auth=starting.\nProvider logs, paths, environment values and connection URLs are omitted. This summary does not establish the underlying cause.\nprivate-row-canary",
    );
    expect(summary).toContain("auth=starting");
    expect(summary).toContain("resources and data were retained");
    expect(summary).not.toContain("private-row-canary");
  });
});
