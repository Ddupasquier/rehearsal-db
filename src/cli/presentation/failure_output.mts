/** Normalize CLI failures and format their human/JSON presentation without writing output. */
import {
  RehearsalError,
  normalizeRehearsalError,
  renderHumanError,
  serializeRehearsalError,
  type RehearsalErrorOverrides,
} from "../../shared/diagnostics.mjs";
import {
  parseMigrationFailureDiagnostic,
  type MigrationFailureDiagnostic,
} from "../../runtime/migrations/migration_failure.mjs";

const aggregateMigrationFailure = (
  error: AggregateError,
): MigrationFailureDiagnostic | undefined => {
  try {
    let original: unknown = error;
    for (let depth = 0; depth <= 4; depth += 1) {
      if (original instanceof AggregateError) {
        if (depth === 4 || !Array.isArray(original.errors)) return undefined;
        original = original.errors[0];
        continue;
      }
      if (
        original instanceof RehearsalError &&
        original.category !== "operation_cancelled" &&
        original.context !== null &&
        typeof original.context === "object" &&
        !Array.isArray(original.context) &&
        "migrationFailure" in original.context
      )
        return parseMigrationFailureDiagnostic(
          original.context.migrationFailure,
        );
      return undefined;
    }
  } catch {
    /* Untrusted metadata is not evidence; retain the aggregate's existing failure. */
  }
  return undefined;
};

export const normalizeCliFailure = (
  error: unknown,
  overrides: RehearsalErrorOverrides = {},
): RehearsalError => {
  const failure = normalizeRehearsalError(error, overrides);
  if (!(error instanceof AggregateError)) return failure;
  const migrationFailure = aggregateMigrationFailure(error);
  if (migrationFailure === undefined) return failure;
  // Keep outer category/exit and cleanup warning. Project no original/sibling text.
  return new RehearsalError({
    category: failure.category,
    code: failure.code,
    message: failure.message,
    expected: failure.expected,
    actual: failure.actual,
    context: { migrationFailure },
    ...(failure.refused === undefined ? {} : { refused: failure.refused }),
    suggestions: [...migrationFailure.suggestions, ...failure.suggestions],
    cause: failure.cause,
  });
};

export const renderCliFailureOutput = (
  error: unknown,
  argv: readonly string[],
): Readonly<{ json: boolean; text: string; exitCode: number }> => {
  const failure = normalizeCliFailure(error, {
    expected: "a safe, versioned, local-only Rehearsal operation",
    actual: error instanceof Error ? error.message : String(error),
    refused: "No further Rehearsal action was performed.",
    suggestions: ["Run rehearsal doctor for actionable readiness checks."],
  });
  const json = argv.includes("--json");
  const debug = argv.includes("--debug");
  return {
    json,
    text: json
      ? JSON.stringify(serializeRehearsalError(failure, { debug }), null, 2)
      : renderHumanError(failure, { debug }),
    exitCode: failure.exitCode,
  };
};
