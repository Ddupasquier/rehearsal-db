/** Bind aggregate-only sandbox measurements to exact reviewed pending inputs. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import { verifyActiveBaseline } from "../baseline/artifact.mjs";
import { REHEARSAL_VERSION, RehearsalError } from "../shared/diagnostics.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { inspectRehearsalMigrations } from "./plan.mjs";
import { inspectRuntimeTopologyCandidates } from "./topology.mjs";
import {
  createMigrationInsightsInput,
  MIGRATION_INSIGHTS_LIMITS,
} from "./migration_insights_input.mjs";
import {
  planMigrationImpactSql,
  type MigrationImpactTask,
  type MigrationImpactUnknownReason,
} from "./migration_impact_plan.mjs";
import {
  buildMigrationImpactScript,
  parseMigrationImpactBatchOutput,
  MIGRATION_IMPACT_LIMITS,
  type MigrationImpactCount,
} from "./migration_impact_queries.mjs";
import {
  openMigrationImpactRuntime,
  MigrationImpactRuntimeError,
} from "../targets/migration_impact_runtime.mjs";

type CountUnknownReason =
  | "unsupported_runtime_metadata"
  | "unsupported_server_version"
  | "query_failed"
  | "lock_timeout"
  | "statement_timeout"
  | "total_timeout"
  | "input_limit";
interface PreparedEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly tasks: readonly MigrationImpactTask[];
  readonly unknownReasons: readonly MigrationImpactUnknownReason[];
}

const refusal = (message: string, unsafe = false): RehearsalError =>
  new RehearsalError({
    category: unsafe ? "unsafe_environment" : "configuration_invalid",
    code: unsafe ? "UNSAFE_ENVIRONMENT" : "CONFIGURATION_INVALID",
    message,
    refused:
      "No migration was applied, no runtime was started or repaired, and no row contents are returned.",
    suggestions: [
      "Review a fresh impact plan and explicitly select its already-running disposable local target.",
    ],
  });

const prepare = async (
  options: RehearsalConfigPathOptions,
  targetName: string | undefined,
) => {
  if (typeof targetName !== "string" || !targetName || targetName.length > 128)
    throw refusal(
      "Impact review requires one explicit configured --target name, including primary.",
    );
  const projectRoot = await realpath(
    resolve(options.projectRoot ?? process.cwd()),
  );
  const input = createMigrationInsightsInput(projectRoot);
  const candidates = await inspectRuntimeTopologyCandidates(
    { ...options, projectRoot },
    (selected) => inspectRehearsalMigrations(selected, input.readInventory),
  );
  if (candidates.candidateCount > MIGRATION_INSIGHTS_LIMITS.maximumCandidates)
    throw refusal("Impact review exceeds its bounded pending-migration input.");
  const target = candidates.targets.find((entry) => entry.name === targetName);
  if (!target)
    throw refusal(
      "Impact review requires one target from this project's configuration.",
    );
  let remaining = MIGRATION_IMPACT_LIMITS.maximumMeasurements;
  const entries: PreparedEntry[] = target.summary.candidates.map(
    (candidate) => {
      const source = input.sourceFor(
        join(target.paths.migrationDirectory, candidate.filename),
        candidate.sha256,
      );
      if (source === undefined)
        throw refusal(
          "The exact impact-review input could not be retained. Refresh the plan.",
        );
      const plan = planMigrationImpactSql(source);
      const tasks = plan.tasks.slice(0, remaining);
      remaining -= tasks.length;
      const unknownReasons = [
        ...new Set([
          ...plan.unknownReasons,
          ...(tasks.length < plan.tasks.length ? ["input_limit" as const] : []),
        ]),
      ];
      return {
        filename: candidate.filename,
        sha256: candidate.sha256,
        tasks,
        unknownReasons,
      };
    },
  );
  const baseline = await verifyActiveBaseline({
    artifactRoot: target.paths.artifactDirectory,
  });
  if (baseline.generationId !== target.summary.baselineGenerationId)
    throw refusal(
      "The active baseline changed during impact review. Refresh the plan.",
    );
  const binding = createHash("sha256")
    .update(
      JSON.stringify({
        candidateSha256: candidates.candidateSha256,
        target: target.name,
        config: target.config,
        paths: target.paths,
        baseline,
        inputs: entries.map((entry) => ({
          filename: entry.filename,
          sha256: entry.sha256,
        })),
      }),
    )
    .digest("hex");
  return {
    projectRoot,
    target,
    baseline,
    entries,
    binding,
    candidateSha256: candidates.candidateSha256,
    candidateCount: candidates.candidateCount,
  };
};

type Prepared = Awaited<ReturnType<typeof prepare>>;
const reportFor = ({
  prepared,
  measured = false,
  counts,
  reason,
  snapshotAt = null,
  runtimeIdentitySha256 = null,
  contactedDatabase = false,
}: {
  prepared: Prepared;
  measured?: boolean;
  counts?: readonly MigrationImpactCount[];
  reason?: CountUnknownReason;
  snapshotAt?: string | null;
  runtimeIdentitySha256?: string | null;
  contactedDatabase?: boolean;
}) => {
  let index = 0;
  let measuredCount = 0;
  let unknownMeasurementCount = 0;
  let unknownEntryCount = 0;
  const entries = prepared.entries.map((entry) => {
    const measurements = entry.tasks.map((task) => {
      const count = counts?.[index++];
      const unknownReason = reason ?? count?.reason ?? null;
      const evidence = !measured
        ? ("planned" as const)
        : count?.count !== null &&
            count?.count !== undefined &&
            unknownReason === null
          ? ("measured_current_snapshot" as const)
          : ("unknown" as const);
      if (evidence === "measured_current_snapshot") measuredCount++;
      if (evidence === "unknown") unknownMeasurementCount++;
      return {
        operation: task.operation,
        metric: task.metric,
        line: task.line,
        column: task.column,
        evidence,
        count: evidence === "measured_current_snapshot" ? count!.count : null,
        unknownReason:
          evidence === "unknown" ? (unknownReason ?? "query_failed") : null,
      };
    });
    if (
      entry.unknownReasons.length ||
      measurements.some((entry) => entry.evidence === "unknown")
    )
      unknownEntryCount++;
    return {
      filename: entry.filename,
      sha256: entry.sha256,
      coverage: entry.unknownReasons.length
        ? ("incomplete" as const)
        : ("recognized_forms" as const),
      unknownReasons: entry.unknownReasons,
      measurements,
    };
  });
  const plannedCount = entries.reduce(
    (total, entry) => total + entry.measurements.length,
    0,
  );
  const measurementStatus = !measured
    ? ("planned" as const)
    : unknownEntryCount
      ? measuredCount
        ? ("partial" as const)
        : ("unknown" as const)
      : plannedCount
        ? ("measured" as const)
        : ("not_required" as const);
  return {
    schemaVersion: 1 as const,
    inspectorVersion: REHEARSAL_VERSION,
    candidateSha256: prepared.candidateSha256,
    candidateCount: prepared.candidateCount,
    target: {
      name: prepared.target.name,
      provider: prepared.target.config.runtime.target,
      baselineGenerationId: prepared.baseline.generationId,
      candidateSha256: prepared.target.summary.candidateSha256,
    },
    mode: measured ? ("measurement" as const) : ("preview" as const),
    measurementStatus,
    snapshotAt,
    runtimeIdentitySha256,
    entries,
    summary: {
      plannedCount,
      measuredCount,
      unknownMeasurementCount,
      unknownEntryCount,
    },
    limits: MIGRATION_IMPACT_LIMITS,
    safety: {
      appliesMigrations: false,
      startsOrRepairsRuntime: false,
      returnsRowContents: false,
      returnsSqlOrObjectNames: false,
      contactsDatabase: contactedDatabase,
      transaction:
        measured && snapshotAt !== null
          ? ("repeatable_read_read_only" as const)
          : null,
    },
    limitation:
      "Counts describe one current disposable-sandbox snapshot before any pending migration. They do not simulate sequential migration effects, establish SQL validity or safety, measure cascade/trigger effects, or predict production locks and performance. Unsupported objects, expressions and incomplete evidence stay unknown.",
  };
};

export type MigrationImpactReport = ReturnType<typeof reportFor>;

export const inspectMigrationImpact = async (
  options: RehearsalConfigPathOptions = {},
  targetName?: string,
): Promise<MigrationImpactReport> =>
  reportFor({ prepared: await prepare(options, targetName) });

export const measureMigrationImpact = async (
  {
    options = {},
    targetName,
    confirmation,
  }: {
    options?: RehearsalConfigPathOptions;
    targetName?: string | undefined;
    confirmation?: string | undefined;
  },
  implementation: { openRuntime?: typeof openMigrationImpactRuntime } = {},
): Promise<MigrationImpactReport> => {
  const controller = new AbortController();
  const externalSignal = getOperationCancellationSignal();
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  const deadline =
    performance.now() + MIGRATION_IMPACT_LIMITS.totalTimeoutMilliseconds;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MIGRATION_IMPACT_LIMITS.totalTimeoutMilliseconds);
  const checkpoint = () => {
    throwIfOperationCancelled();
    if (timedOut || performance.now() >= deadline) {
      timedOut = true;
      controller.abort();
      throw new MigrationImpactRuntimeError("cancelled");
    }
  };
  try {
    const prepared = await prepare(options, targetName);
    if (confirmation !== prepared.candidateSha256)
      throw refusal(
        "Measurement requires the exact whole-plan --confirm-candidates digest from a fresh impact review.",
      );
    const tasks = prepared.entries.flatMap((entry) => entry.tasks);
    let contactedDatabase = false;
    try {
      checkpoint();
      if (!tasks.length) return reportFor({ prepared, measured: true });
      const runtime = await (
        implementation.openRuntime ?? openMigrationImpactRuntime
      )({
        projectRoot: prepared.projectRoot,
        target: prepared.target,
        baseline: prepared.baseline,
        signal,
      });
      checkpoint();
      try {
        buildMigrationImpactScript(tasks);
      } catch {
        return reportFor({ prepared, measured: true, reason: "input_limit" });
      }
      contactedDatabase = true;
      const result = parseMigrationImpactBatchOutput(
        await runtime.runSql(() => {
          checkpoint();
          const script = buildMigrationImpactScript(
            tasks,
            Math.max(1, Math.floor(deadline - performance.now())),
          );
          checkpoint();
          return script;
        }),
        tasks.length,
      );
      checkpoint();
      await runtime.assertCurrent();
      checkpoint();
      const current = await prepare(options, targetName);
      checkpoint();
      if (prepared.binding !== current.binding)
        throw refusal(
          "The reviewed configuration, baseline or migration inputs changed during measurement. No counts are returned.",
        );
      return reportFor({
        prepared,
        measured: true,
        counts: result.counts,
        snapshotAt: result.snapshotAt,
        runtimeIdentitySha256: runtime.identitySha256,
        contactedDatabase,
      });
    } catch (error) {
      throwIfOperationCancelled();
      if (error instanceof RehearsalError) throw error;
      if (
        error instanceof MigrationImpactRuntimeError &&
        ["runtime_unavailable", "ownership_mismatch", "stale_runtime"].includes(
          error.reason,
        )
      )
        throw refusal(
          "The selected sandbox is not a verified, unchanged running local runtime. No counts are returned.",
          true,
        );
      const reason =
        timedOut ||
        (error instanceof MigrationImpactRuntimeError &&
          error.reason === "transaction_timeout")
          ? "total_timeout"
          : error instanceof MigrationImpactRuntimeError &&
              ["lock_timeout", "statement_timeout"].includes(error.reason)
            ? (error.reason as "lock_timeout" | "statement_timeout")
            : "query_failed";
      return reportFor({ prepared, measured: true, reason, contactedDatabase });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

export const renderMigrationImpact = (report: MigrationImpactReport): string =>
  [
    `MIGRATION DATA IMPACT — ${report.measurementStatus.toUpperCase()}`,
    `${report.target.name}: ${report.summary.measuredCount} measured / ${report.summary.plannedCount} planned aggregates; ${report.summary.unknownEntryCount} incomplete files`,
    `Exact whole-plan digest: ${report.candidateSha256}`,
    ...(report.snapshotAt
      ? [`Current-row snapshot: ${report.snapshotAt}`]
      : []),
    ...report.entries.flatMap((entry) => [
      entry.filename,
      ...entry.measurements.map((metric) =>
        `  ${metric.line}:${metric.column} ${metric.metric}: ${metric.count ?? metric.evidence} ${metric.unknownReason ?? ""}`.trimEnd(),
      ),
      ...(entry.unknownReasons.length
        ? ["  Unsupported or bounded SQL remains unknown."]
        : []),
    ]),
    report.limitation,
  ].join("\n");
