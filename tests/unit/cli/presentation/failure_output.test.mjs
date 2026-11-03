import { describe, expect, it } from "vitest";
import {
  normalizeCliFailure,
  renderCliFailureOutput,
} from "../../../../dist/src/cli/presentation/failure_output.mjs";
import { executeRuntimeTargetStack } from "../../../../dist/src/cli/runtime/runtime_stack_execution.mjs";
import { migrationFailureDiagnostic } from "../../../../dist/src/runtime/migrations/migration_failure.mjs";
import {
  RehearsalError,
  normalizeRehearsalError,
  renderHumanError,
  serializeRehearsalError,
} from "../../../../dist/src/shared/diagnostics.mjs";
import { createOperationCancelledError } from "../../../../dist/src/shared/cancellation.mjs";
import {
  markKnexFailure,
  readKnexFailureFrame,
  renderKnexFailureFrame,
} from "../../../../dist/src/runtime/migrations/native/knex/knex_failure_diagnostic.mjs";

const cleanupWarning =
  "The runtime stack failed and one or more receipt-proven targets could not complete configured cleanup. Cleanup may be partial; inspect each target before retrying.";
const diagnostic = migrationFailureDiagnostic({
  provider: "postgresql",
  sqlState: "23514",
});

const migrationError = (context = { migrationFailure: diagnostic }) =>
  new RehearsalError({
    category: "migration_candidate_failure",
    code: "CANDIDATE_MIGRATION_FAILED",
    message: "PRIVATE_ORIGINAL_SQL",
    expected: "PRIVATE_EXPECTED",
    actual: "PRIVATE_ROW",
    context,
    suggestions: ["PRIVATE_ORIGINAL_SUGGESTION"],
  });
const wrap = (error, depth = 1) => {
  for (let index = 0; index < depth; index += 1)
    error = new AggregateError(
      [error, new Error("PRIVATE_CLEANUP_ERROR")],
      cleanupWarning,
    );
  return error;
};

describe("CLI aggregate failure output", () => {
  it("retains original fixed migration diagnosis and actual stack cleanup warning in JSON and human output", async () => {
    let aggregate;
    try {
      await executeRuntimeTargetStack({
        targets: ["primary", "publication"],
        cleanupOnFailure: true,
        execute: async (target) => {
          if (target === "publication") throw migrationError();
          return target;
        },
        stop: async () => {
          throw new Error("PRIVATE_CLEANUP_ERROR");
        },
      });
    } catch (error) {
      aggregate = error;
    }
    expect(aggregate).toBeInstanceOf(AggregateError);
    const existing = normalizeRehearsalError(aggregate);
    const failure = normalizeCliFailure(aggregate);
    expect(failure.category).toBe(existing.category);
    expect(failure.exitCode).toBe(existing.exitCode);
    expect(failure.message).toBe(cleanupWarning);
    expect(failure.context).toEqual({ migrationFailure: diagnostic });
    for (const debug of [false, true]) {
      const json = serializeRehearsalError(failure, { debug });
      const human = renderHumanError(failure, { debug });
      expect(json.error.context.migrationFailure).toEqual(diagnostic);
      expect(json.error.message).toBe(cleanupWarning);
      expect(human).toContain(cleanupWarning);
      expect(human).toContain(diagnostic.summary);
      for (const suggestion of diagnostic.suggestions)
        expect(human).toContain(suggestion);
      expect(JSON.stringify(json) + human).not.toContain("PRIVATE_");
    }
    expect(aggregate.errors).toHaveLength(2);
  });

  it("follows at most four original wrappers and refuses cleanup siblings, cause chains and malformed metadata", () => {
    const invalid = migrationError({
      migrationFailure: { ...diagnostic, summary: "PRIVATE_RAW_ERROR" },
    });
    const cycle = new AggregateError([], cleanupWarning);
    cycle.errors.push(cycle, migrationError());
    for (const [error, retained] of [
      [wrap(migrationError()), true],
      [wrap(migrationError(), 4), true],
      [wrap(migrationError(), 5), false],
      [
        new AggregateError(
          [new Error("Unknown"), migrationError()],
          cleanupWarning,
        ),
        false,
      ],
      [wrap(new Error("Unknown", { cause: migrationError() })), false],
      [wrap(invalid), false],
      [new AggregateError([], cleanupWarning), false],
      [cycle, false],
    ]) {
      const failure = normalizeCliFailure(error);
      expect(failure.context?.migrationFailure).toEqual(
        retained ? diagnostic : undefined,
      );
      expect(failure.message).toBe(cleanupWarning);
      expect(JSON.stringify(serializeRehearsalError(failure))).not.toContain(
        "PRIVATE_",
      );
    }
  });

  it("never borrows cleanup diagnosis after cancellation or claims aggregate cleanup completed", () => {
    const cancelled = createOperationCancelledError("SIGINT");
    expect(normalizeCliFailure(cancelled)).toBe(cancelled);
    const aggregate = new AggregateError(
      [cancelled, migrationError()],
      "Application handoff was cancelled and its owned process could not be stopped.",
    );
    const failure = normalizeCliFailure(aggregate);
    expect(failure.exitCode).toBe(normalizeRehearsalError(aggregate).exitCode);
    expect(failure.category).not.toBe("operation_cancelled");
    expect(failure.context).toBeUndefined();
    expect(renderHumanError(failure)).toContain("could not be stopped");
    expect(renderHumanError(failure)).not.toContain(diagnostic.summary);
  });

  it("preserves direct failures and existing default remediation for unrelated errors", () => {
    const direct = migrationError();
    expect(normalizeCliFailure(direct)).toBe(direct);
    const overrides = {
      expected: "Safe operation",
      refused: "No further action",
      suggestions: ["Run rehearsal doctor."],
    };
    const unexpected = new Error("Unexpected fault");
    expect(normalizeCliFailure(unexpected, overrides)).toMatchObject(
      normalizeRehearsalError(unexpected, overrides),
    );
    expect(
      normalizeCliFailure(wrap(migrationError()), overrides).suggestions,
    ).toEqual([...diagnostic.suggestions, ...overrides.suggestions]);
  });
});

describe("CLI entry failure presentation", () => {
  it("preserves closed Knex phase and cleanup evidence across the entry formatter without exposing frames or private errors", () => {
    const primary = markKnexFailure(new Error("PRIVATE_NATIVE_SQL"), {
      phase: "restore",
      stage: "sql",
      reason: "deadline",
    });
    const cleanup = markKnexFailure(new Error("PRIVATE_NATIVE_CLEANUP"), {
      phase: "lifecycle",
      stage: "cleanup",
      reason: "cleanup-unconfirmed",
    });
    const nonce = "a".repeat(64);
    const frame = renderKnexFailureFrame(
      new AggregateError([primary, cleanup], "PRIVATE_NATIVE_AGGREGATE"),
      nonce,
    );
    const { nativeFailure } = readKnexFailureFrame(frame + "\n", nonce);
    expect(nativeFailure).toMatchObject({
      primary: { phase: "restore", stage: "sql", reason: "deadline" },
      cleanup: {
        phase: "lifecycle",
        stage: "cleanup",
        reason: "cleanup-unconfirmed",
      },
    });
    const failure = new RehearsalError({
      category: "runtime_dependency_failure",
      code: "RUNTIME_DEPENDENCY_FAILED",
      message: "The scoped Knex phase failed and cleanup is unconfirmed.",
      context: { nativeFailure },
    });
    for (const argv of [["--plain"], ["--json"], ["--json", "--debug"]]) {
      const output = renderCliFailureOutput(failure, argv);
      expect(output.exitCode).toBe(failure.exitCode);
      if (output.json)
        expect(JSON.parse(output.text).error.context.nativeFailure).toEqual(
          nativeFailure,
        );
      else expect(output.text).toContain("knex-native-failure");
      expect(output.text).not.toContain("PRIVATE_");
      expect(output.text).not.toContain("Rehearsal native failure:");
      expect(output.text).not.toContain(nonce);
    }
  });

  it.each(
    [
      [],
      ["--plain"],
      ["--debug"],
      ["--json"],
      ["--json", "--plain"],
      ["--json", "--debug"],
      ["--json=1"],
    ].map((argv) => ({ argv })),
  )(
    "preserves exact raw flags $argv and fixed aggregate guidance without leaking original errors",
    ({ argv }) => {
      const error = wrap(migrationError());
      const result = renderCliFailureOutput(error, argv);
      expect(result.json).toBe(argv.includes("--json"));
      expect(result.exitCode).toBe(normalizeCliFailure(error).exitCode);
      expect(result.text).not.toContain("PRIVATE_");
      if (result.json) {
        const output = JSON.parse(result.text);
        expect(output.status).toBe("error");
        expect(output.error.message).toBe(cleanupWarning);
        expect(output.error.context.migrationFailure).toEqual(diagnostic);
      } else {
        expect(result.text).toContain("Rehearsal stopped: " + cleanupWarning);
        expect(result.text).toContain(diagnostic.summary);
      }
      for (const suggestion of diagnostic.suggestions)
        expect(result.text).toContain(suggestion);
    },
  );

  it("keeps cancellation's nonzero exit and branding instead of trusting lookalike metadata", () => {
    const cancelled = createOperationCancelledError("SIGINT");
    const cancellation = renderCliFailureOutput(cancelled, ["--json"]);
    expect(cancellation.exitCode).toBe(cancelled.exitCode);
    expect(cancellation.exitCode).toBe(130);
    expect(JSON.parse(cancellation.text).error.category).toBe(
      "operation_cancelled",
    );
    const lookalike = renderCliFailureOutput(
      { category: "operation_cancelled", exitCode: 0 },
      ["--json"],
    );
    expect(lookalike.exitCode).not.toBe(0);
    expect(JSON.parse(lookalike.text).error.category).not.toBe(
      "operation_cancelled",
    );
  });

  it("retains the entry's default remediation and exposes a cause only with the exact debug flag", () => {
    const error = new Error("Safe synthetic fault", {
      cause: new Error("Safe synthetic cause"),
    });
    const ordinary = JSON.parse(
      renderCliFailureOutput(error, ["--json", "--plain"]).text,
    );
    expect(ordinary.error.expected).toBe(
      "a safe, versioned, local-only Rehearsal operation",
    );
    expect(ordinary.error.actual).toBe("Safe synthetic fault");
    expect(ordinary.error.refused).toBe(
      "No further Rehearsal action was performed.",
    );
    expect(ordinary.error.suggestions).toContain(
      "Run rehearsal doctor for actionable readiness checks.",
    );
    expect(ordinary.error).not.toHaveProperty("cause");
    const debug = JSON.parse(
      renderCliFailureOutput(error, ["--json", "--debug"]).text,
    );
    expect(debug.error.cause).toBe("Safe synthetic fault");
    expect(
      JSON.parse(renderCliFailureOutput(error, ["--json", "--debug=1"]).text)
        .error,
    ).not.toHaveProperty("cause");
  });
});
