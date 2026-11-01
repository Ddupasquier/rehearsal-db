/** Static warnings bound to the existing complete candidate plan, never a safety proof. */
import { join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { RehearsalConfigPathOptions } from "../../project/configuration.mjs";
import {
  REHEARSAL_VERSION,
  RehearsalError,
} from "../../shared/diagnostics.mjs";
import { isMigrationWorkspacePath } from "./migration_failure_source.mjs";
import {
  createMigrationInsightsInput,
  MIGRATION_INSIGHTS_LIMITS,
} from "./migration_insights_input.mjs";
import { scanMigrationSql } from "./migration_sql_scan.mjs";
import { inspectRehearsalMigrations } from "../lifecycle/plan.mjs";
import { inspectRuntimeTopologyCandidates } from "../lifecycle/topology.mjs";

export const MIGRATION_INSIGHT_RULES = Object.freeze({
  drop_table: {
    summary: "A table may be removed.",
    suggestion:
      "Review dependent objects and preserve any required rows before dropping the table.",
  },
  drop_column: {
    summary: "A column and its stored values may be removed.",
    suggestion:
      "Review populated values and dependent application code before dropping the column.",
  },
  truncate: {
    summary: "All rows in the selected table may be removed.",
    suggestion:
      "Confirm the intended data loss and review identity, foreign-key and cascade behavior.",
  },
  broad_update: {
    summary: "An UPDATE has no top-level WHERE clause.",
    suggestion:
      "Review the intended row scope; a nested WHERE does not restrict the outer UPDATE.",
  },
  broad_delete: {
    summary: "A DELETE has no top-level WHERE clause.",
    suggestion:
      "Review the intended row scope; a nested WHERE does not restrict the outer DELETE.",
  },
  not_null: {
    summary: "A NOT NULL requirement may reject existing rows.",
    suggestion:
      "Check existing NULL values and apply a reviewed backfill before enforcing the requirement.",
  },
  new_constraint: {
    summary: "A new constraint may reject existing rows.",
    suggestion:
      "Check NULL, duplicate, orphan and CHECK violations as appropriate; SQL text alone cannot establish compliance.",
  },
  cascade: {
    summary: "CASCADE can affect dependent objects or rows.",
    suggestion:
      "Review the dependency graph; this static warning does not measure the cascade's actual reach.",
  },
});

type Verdict = "static_warnings" | "no_detected_warning" | "unknown";
const verdict = (complete: boolean, warnings: number): Verdict =>
  !complete ? "unknown" : warnings ? "static_warnings" : "no_detected_warning";

const inspectionError = (message: string) =>
  new RehearsalError({
    category: "configuration_invalid",
    code: "CONFIGURATION_INVALID",
    message,
    refused: "No SQL was executed and no database or engine was contacted.",
    suggestions: [
      "Review the documented input limits and request a fresh complete migration inspection.",
    ],
  });

export const inspectMigrationInsights = async (
  options: RehearsalConfigPathOptions = {},
) => {
  const projectRoot = await realpath(
    resolve(options.projectRoot ?? process.cwd()),
  );
  const input = createMigrationInsightsInput(projectRoot);
  const candidates = await inspectRuntimeTopologyCandidates(
    { ...options, projectRoot },
    (selected) => inspectRehearsalMigrations(selected, input.readInventory),
  );
  if (candidates.candidateCount > MIGRATION_INSIGHTS_LIMITS.maximumCandidates)
    throw inspectionError(
      "Migration Insights exceeds its bounded 1,000-candidate plan.",
    );
  let findingCount = 0;
  let unknownCount = 0;
  const targets = candidates.targets.map((target) => {
    const entries = target.summary.candidates.map((candidate) => {
      const path = join(target.paths.migrationDirectory, candidate.filename);
      const source = input.sourceFor(path, candidate.sha256);
      if (source === undefined)
        throw inspectionError(
          "Migration Insights could not retain its exact reviewed input. Refresh the plan.",
        );
      const scan = scanMigrationSql(source);
      const remaining =
        MIGRATION_INSIGHTS_LIMITS.maximumFindings - findingCount;
      const limited = scan.findings.length > remaining;
      const findings = scan.findings
        .slice(0, Math.max(0, remaining))
        .map((finding) => ({
          ...finding,
          ...MIGRATION_INSIGHT_RULES[finding.rule],
        }));
      findingCount += findings.length;
      const complete = scan.complete && !limited;
      if (!complete) unknownCount++;
      const workspacePath = relative(projectRoot, path).split(sep).join("/");
      return {
        ...("nativeIdentity" in candidate
          ? { nativeIdentity: candidate.nativeIdentity }
          : { version: candidate.version }),
        filename: candidate.filename,
        sha256: candidate.sha256,
        workspaceRelativePath: isMigrationWorkspacePath(workspacePath)
          ? workspacePath
          : null,
        verdict: verdict(complete, findings.length),
        coverage: complete
          ? ("recognized_lexical_rules" as const)
          : ("incomplete" as const),
        unknownReasons: [
          ...new Set([
            ...scan.unknownReasons,
            ...(limited ? ["input_limit" as const] : []),
          ]),
        ],
        findings,
      };
    });
    return {
      name: target.name,
      provider: target.config.runtime.target,
      baselineGenerationId: target.summary.baselineGenerationId,
      candidateSha256: target.summary.candidateSha256,
      entries,
    };
  });
  return {
    schemaVersion: 1 as const,
    inspectorVersion: REHEARSAL_VERSION,
    candidateSha256: candidates.candidateSha256,
    candidateCount: candidates.candidateCount,
    verdict: verdict(unknownCount === 0, findingCount),
    summary: { findingCount, unknownCount },
    targets,
    limits: MIGRATION_INSIGHTS_LIMITS,
    safety: {
      readsSqlBodies: true,
      executesSql: false,
      startsEngine: false,
      contactsDatabase: false,
      includesSqlOrRowValues: false,
    },
    limitation:
      "Static lexical warnings only. No detected warning is not a safety or syntax-validity verdict; data impact, permissions, locks and production behavior are not measured.",
  };
};

export const renderMigrationInsights = (
  report: Awaited<ReturnType<typeof inspectMigrationInsights>>,
): string =>
  [
    "MIGRATION INSIGHTS — STATIC, READ ONLY",
    `${report.candidateCount} pending candidates · ${report.summary.findingCount} warnings · ${report.summary.unknownCount} incomplete analyses`,
    `Exact candidate digest: ${report.candidateSha256}`,
    ...report.targets.flatMap((target) =>
      target.entries.flatMap((entry) => [
        `${target.name}/${entry.filename}: ${entry.verdict.replaceAll("_", " ")}`,
        ...entry.findings.map(
          (finding) =>
            `  ${finding.line}:${finding.column} ${finding.rule}: ${finding.summary} ${finding.suggestion}`,
        ),
        ...(entry.unknownReasons.length
          ? [
              "  Unsupported, malformed or bounded input remains unknown; review this file manually.",
            ]
          : []),
      ]),
    ),
    report.limitation,
  ].join("\n");
