/** Translate provider-native SQLSTATE evidence into fixed, privacy-safe guidance. */
import {
  parseMigrationFailureSource,
  readMigrationSourceFrame,
  renderMigrationSourceFrame,
  type MigrationFailureSource,
} from "./migration_failure_source.mjs";
export type MigrationFailureClassification =
  | "syntax"
  | "schema"
  | "constraint"
  | "permission"
  | "connectivity"
  | "timeout_or_cancel"
  | "unknown";

export interface MigrationFailureDiagnostic {
  readonly schemaVersion: 1;
  readonly provider: "postgresql" | "supabase";
  readonly classification: MigrationFailureClassification;
  readonly sqlState: string | null;
  readonly evidence: "provider_sqlstate" | "unavailable" | "ambiguous";
  readonly summary: string;
  readonly suggestions: readonly string[];
  readonly source?: MigrationFailureSource;
}

const explanations: Readonly<
  Record<string, readonly [MigrationFailureClassification, string, string]>
> = {
  "42601": [
    "syntax",
    "The database reported a SQL syntax error.",
    "Review the candidate SQL for missing keywords, punctuation or malformed statements; then review the new exact plan before retrying.",
  ],
  "23502": [
    "constraint",
    "Rows do not satisfy a NOT NULL requirement.",
    "Review existing NULL values and any new writes. Backfill or transform incompatible rows before enforcing NOT NULL.",
  ],
  "23503": [
    "constraint",
    "Rows do not satisfy a foreign-key constraint.",
    "Review missing referenced rows and migration ordering before enforcing the foreign key.",
  ],
  "23505": [
    "constraint",
    "Rows do not satisfy a uniqueness requirement.",
    "Review duplicate values and choose a data-preserving resolution before adding the unique constraint or index.",
  ],
  "23514": [
    "constraint",
    "Rows do not satisfy a CHECK constraint.",
    "Existing rows may not satisfy the new constraint. Review and backfill incompatible rows before enforcing it; also check values written by the migration.",
  ],
  "23P01": [
    "constraint",
    "Rows conflict with an exclusion constraint.",
    "Review overlapping or conflicting values before enforcing the exclusion constraint.",
  ],
  "42P01": [
    "schema",
    "The migration references a table that is unavailable in this schema.",
    "Review table names, schema qualification and migration ordering; this is not a confirmed syntax error.",
  ],
  "42703": [
    "schema",
    "The migration references a column that is unavailable in this schema.",
    "Review column names and migration ordering; this is not a confirmed syntax error.",
  ],
  "42704": [
    "schema",
    "The migration references a database object that is unavailable.",
    "Review object names, schema qualification and migration ordering.",
  ],
  "42804": [
    "schema",
    "The migration uses incompatible data types.",
    "Review the column types and any required explicit, data-preserving conversion.",
  ],
  "42P07": [
    "schema",
    "The migration attempts to create a table that already exists.",
    "Review baseline history and candidate ordering instead of deleting migration history.",
  ],
  "42701": [
    "schema",
    "The migration attempts to create a column that already exists.",
    "Review baseline history and candidate ordering instead of deleting migration history.",
  ],
  "42501": [
    "permission",
    "The database denied permission for a migration operation.",
    "Review the intended local role and required privileges; do not switch to hosted credentials or bypass permissions.",
  ],
  "28P01": [
    "permission",
    "The database rejected authentication.",
    "Review the disposable local runtime credentials without printing or sharing them.",
  ],
  "57014": [
    "timeout_or_cancel",
    "The database reported a cancelled statement, possibly from a timeout.",
    "Review statement timeout and cancellation evidence. No automatic retry or successful rollback is implied.",
  ],
};

export const migrationFailureDiagnostic = ({
  provider,
  sqlState = null,
  evidence = sqlState ? "provider_sqlstate" : "unavailable",
}: {
  provider: MigrationFailureDiagnostic["provider"];
  sqlState?: string | null;
  evidence?: MigrationFailureDiagnostic["evidence"];
}): MigrationFailureDiagnostic => {
  const safeCode =
    sqlState &&
    /^[0-9A-Z]{5}$/u.test(sqlState) &&
    !/^(?:00|01|02)/u.test(sqlState)
      ? sqlState
      : null;
  const explanation = safeCode ? explanations[safeCode] : undefined;
  const connectivity = safeCode?.startsWith("08");
  return {
    schemaVersion: 1,
    provider,
    classification:
      explanation?.[0] ?? (connectivity ? "connectivity" : "unknown"),
    sqlState: safeCode,
    evidence: safeCode
      ? "provider_sqlstate"
      : evidence === "ambiguous"
        ? "ambiguous"
        : "unavailable",
    summary:
      explanation?.[1] ??
      (connectivity
        ? "The database reported a connection failure."
        : "The failure could not be classified from recognized provider SQLSTATE evidence. It is not a confirmed syntax error."),
    suggestions: [
      explanation?.[2] ??
        (connectivity
          ? "Check the disposable local database connection and runtime status before retrying."
          : "Review the exact candidate locally and its database requirements. Do not assume syntax, data or permissions are the cause."),
      "No automatic SQL change or retry was performed. The failure itself does not prove rollback or cleanup; inspect runtime status before retrying.",
    ],
  };
};

/** Read only known provider error envelopes, never arbitrary mentions of SQLSTATE. */
export const diagnoseMigrationFailure = ({
  provider,
  stderr,
}: {
  provider: MigrationFailureDiagnostic["provider"];
  stderr: string;
}): MigrationFailureDiagnostic => {
  // Truncation could hide a conflicting error. Refuse rather than guess from a slice.
  if (Buffer.byteLength(stderr) > 128 * 1024)
    return migrationFailureDiagnostic({ provider });
  const codes = new Set<string>();
  for (const line of stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)) {
    const match =
      provider === "postgresql"
        ? line.match(
            /^(?:psql:(?:<stdin>|[^\r\n]+):\d+:\s*)?(?:ERROR|FATAL):\s+([0-9A-Z]{5})(?::(?:\s|$)|\s*$)/u,
          )
        : line.match(/^ERROR:\s+[^\r\n]*\(SQLSTATE ([0-9A-Z]{5})\)\s*$/u);
    if (match?.[1] && !/^(?:00|01|02)/u.test(match[1])) codes.add(match[1]);
  }
  return migrationFailureDiagnostic({
    provider,
    sqlState: codes.size === 1 ? [...codes][0]! : null,
    evidence: codes.size > 1 ? "ambiguous" : "unavailable",
  });
};

export const renderMigrationFailureDiagnostic = (
  diagnostic: MigrationFailureDiagnostic,
): string =>
  [
    `Migration SQLSTATE: ${diagnostic.sqlState ?? diagnostic.evidence}.`,
    ...(diagnostic.source === undefined
      ? []
      : [renderMigrationSourceFrame(diagnostic.source)]),
    diagnostic.summary,
    ...diagnostic.suggestions,
  ].join("\n");

/** Closed public projection: reject free text or metadata not generated by this owner. */
export const parseMigrationFailureDiagnostic = (
  value: unknown,
): MigrationFailureDiagnostic => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid safe migration diagnostic.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record)
      .filter((key) => key !== "source")
      .sort()
      .join(",") !==
      "classification,evidence,provider,schemaVersion,sqlState,suggestions,summary" ||
    record.schemaVersion !== 1 ||
    typeof record.provider !== "string" ||
    !["postgresql", "supabase"].includes(record.provider) ||
    !(record.sqlState === null || typeof record.sqlState === "string") ||
    !["provider_sqlstate", "unavailable", "ambiguous"].includes(
      String(record.evidence),
    )
  )
    throw new Error("Invalid safe migration diagnostic.");
  const canonical = migrationFailureDiagnostic({
    provider: record.provider as MigrationFailureDiagnostic["provider"],
    sqlState: record.sqlState as string | null,
    evidence: record.evidence as MigrationFailureDiagnostic["evidence"],
  });
  if (
    record.classification !== canonical.classification ||
    record.sqlState !== canonical.sqlState ||
    record.evidence !== canonical.evidence ||
    record.summary !== canonical.summary ||
    JSON.stringify(record.suggestions) !== JSON.stringify(canonical.suggestions)
  )
    throw new Error("Invalid safe migration diagnostic.");
  return record.source === undefined
    ? canonical
    : { ...canonical, source: parseMigrationFailureSource(record.source) };
};

/** Parse only Rehearsal's fixed migration header and adjacent fixed code line. */
export const readManagerMigrationFailure = (
  output: string,
): MigrationFailureDiagnostic | undefined => {
  if (Buffer.byteLength(output) > 128 * 1024) return undefined;
  const match = output.match(
    /^(?:[\t ]*Error:[\t ]*)?The (?:confirmed candidate|baseline) (PostgreSQL|Supabase) migration failed \(exit (?:-?\d+|unknown); stderr \d+ bytes\)\. SQL and provider output are withheld\.\r?\n[\t ]*Migration SQLSTATE: ([0-9A-Z]{5}|unavailable|ambiguous)\.[\t ]*$/mu,
  );
  if (!match) return undefined;
  const code = match[2]!;
  const diagnostic = migrationFailureDiagnostic({
    provider: match[1] === "PostgreSQL" ? "postgresql" : "supabase",
    sqlState: /^[0-9A-Z]{5}$/u.test(code) ? code : null,
    evidence: code === "ambiguous" ? "ambiguous" : "unavailable",
  });
  const afterCode = output
    .slice(match.index! + match[0].length)
    .replace(/^\r?\n/u, "")
    .split(/\r?\n/u)[0];
  const source = readMigrationSourceFrame(output, afterCode);
  const expectedKind = /The baseline /u.test(match[0])
    ? "baseline"
    : "candidate";
  return source === undefined ||
    source.kind !== expectedKind ||
    diagnostic.provider !== "postgresql"
    ? diagnostic
    : { ...diagnostic, source };
};
