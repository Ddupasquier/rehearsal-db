import { describe, expect, it } from "vitest";
import { normalizeCliFailure } from "../../../dist/src/cli/failure_output.mjs";
import { executeRuntimeTargetStack } from "../../../dist/src/cli/runtime_stack_execution.mjs";
import { migrationFailureDiagnostic } from "../../../dist/src/runtime/migration_failure.mjs";
import {
  RehearsalError,
  normalizeRehearsalError,
  renderHumanError,
  serializeRehearsalError,
} from "../../../dist/src/shared/diagnostics.mjs";
import { createOperationCancelledError } from "../../../dist/src/shared/cancellation.mjs";

const cleanupWarning =
  "The runtime stack failed and one or more successfully started targets could not be stopped. Their data and the shared engine were not deleted; inspect status before retrying.";
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
