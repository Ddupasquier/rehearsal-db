/** Engine-scoped metadata and readiness; never starts Docker or an application. */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadRehearsalConfig } from "../../project/configuration.mjs";
import type { RehearsalConfigPathOptions } from "../../project/configuration.mjs";
import { REHEARSAL_VERSION } from "../../shared/diagnostics.mjs";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
import { getOperationCancellationSignal } from "../../shared/cancellation.mjs";
import { inspectHostPlatform } from "../../shared/host_platform.mjs";
import {
  readSqliteBaseline,
  sqliteCandidatePlan,
} from "../../baseline/producers/sqlite_baseline.mjs";
import { sqliteSha256 } from "./sqlite_files.mjs";
import {
  runSqliteWorkerJob,
  SqliteWorkerFailure,
} from "./sqlite_worker_process.mjs";
import { readVerifiedSqliteRuntimeReceipt } from "./sqlite_manager.mjs";
type Loaded = Awaited<ReturnType<typeof loadRehearsalConfig>>;
const FEATURES = [
  "snapshot",
  "restore",
  "schema",
  "migrations",
  "privacy",
  "applicationConnection",
  "recovery",
  "persistence",
  "cleanup",
  "transactionalDdl",
  "auth",
  "storage",
] as const;
export const inspectDatabaseCapabilities = async (
  options: RehearsalConfigPathOptions = {},
) => {
  const loaded = await loadRehearsalConfig(options);
  const sqlite = loaded.config.runtime.target === "sqlite";
  let availability: "available" | "unavailable" | "unknown" = "unknown";
  let version: string | null = null;
  if (sqlite) {
    try {
      version = (
        await runSqliteWorkerJob(
          {
            operation: "probe",
            maximumBytes: loaded.config.sqlite!.maximumBytes,
          },
          {
            timeoutMs: 5000,
            ...(getOperationCancellationSignal()
              ? { signal: getOperationCancellationSignal()! }
              : {}),
          },
        )
      ).sqliteVersion;
      availability = "available";
    } catch (error) {
      if (
        getOperationCancellationSignal()?.aborted ||
        (error instanceof SqliteWorkerFailure &&
          (error.cleanupUnconfirmed || error.kind === "cancelled"))
      )
        throw error;
      availability =
        error instanceof SqliteWorkerFailure &&
        error.kind === "backend-unavailable"
          ? "unavailable"
          : "unknown";
    }
  }
  const service = loaded.config.runtime.target;
  const capabilities = Object.fromEntries(
    FEATURES.map((feature) => {
      const notApplicable =
        (feature === "auth" || feature === "storage") && service !== "supabase";
      return [
        feature,
        {
          state: notApplicable ? "not-applicable" : "supported",
          reason: notApplicable ? "not_applicable" : "qualified",
          scope: sqlite
            ? "sqlite-v1-reviewed-sql"
            : `${service}-existing-contract`,
        },
      ];
    }),
  );
  return {
    schemaVersion: 1 as const,
    target: "primary",
    engine: { family: sqlite ? "sqlite" : "postgresql", service, version },
    backend: sqlite ? "native" : "container",
    availability,
    assurance: "inspection",
    capabilities,
  };
};
export const inspectSqliteMigrations = async (loaded: Loaded) => {
  const plan = sqliteCandidatePlan(loaded);
  let applied = new Set<string>();
  try {
    const marker = await readVerifiedSqliteRuntimeReceipt(loaded);
    if (
      marker &&
      marker.candidateSha256 === plan.candidateSha256 &&
      marker.baselineGenerationId === plan.baseline.generationId
    )
      applied = new Set(
        (marker.history ?? []).map((x) => `${x.filename}:${x.sha256}`),
      );
  } catch (error) {
    if (
      getOperationCancellationSignal()?.aborted ||
      (error instanceof SqliteWorkerFailure &&
        (error.cleanupUnconfirmed || error.kind === "cancelled"))
    )
      throw error;
    /* Missing/untrusted runtime evidence never upgrades a candidate. */
  }
  return {
    baselineGenerationId: plan.baseline.generationId,
    migrationTool: undefined,
    baselineHistorySha256: undefined,
    baselinePrefixVerification: undefined,
    baselineCutoff: plan.baseline.history.at(-1)?.filename.slice(0, 14) ?? null,
    candidateSha256: plan.candidateSha256,
    migrations: plan.files.map((file, index) => ({
      version: file.version,
      name: file.name,
      filename: file.filename,
      sha256: file.sha256,
      status:
        index < plan.baseline.history.length
          ? "represented_by_baseline"
          : applied.has(`${file.filename}:${file.sha256}`)
            ? "applied_to_current_runtime"
            : "candidate",
    })),
    definitions: {
      represented_by_baseline:
        "Exact current-input checksum in the owner-declared baseline prefix; not recovered historical file bytes.",
      applied_to_current_runtime:
        "Private owned runtime receipt and native journal agree with this candidate set.",
      candidate: "Not yet proved in the owned runtime.",
      modified: "Changed baseline prefixes refuse before review.",
      invalid: "Malformed, aliased or reordered sources refuse before review.",
    },
  };
};
export const sqliteBaselineSummary = (loaded: Loaded) => {
  const { manifest } = readSqliteBaseline(loaded);
  return {
    rehearsalVersion: REHEARSAL_VERSION,
    formatVersion: 6 as const,
    engine: manifest.engine,
    generationId: manifest.generationId,
    createdAt: manifest.createdAt,
    migrationCutoff: manifest.history.at(-1)?.filename.slice(0, 14) ?? null,
    migrationHistorySha256: sqliteSha256(JSON.stringify(manifest.history)),
    sourceSchemaSha256: manifest.schemaSha256,
    sanitizationPolicySha256: manifest.sanitizationPolicySha256,
    dataSha256: manifest.databaseSha256,
    tableCount: manifest.tableCount,
    rowCount: manifest.rowCount,
    migrationCount: manifest.history.length,
    verification: "checksums_verified" as const,
  };
};
export const buildSqlitePlan = (loaded: Loaded) => {
  const plan = sqliteCandidatePlan(loaded);
  const { sqliteSourceDatabase: _privateSource, ...paths } = loaded.paths;
  return {
    backend: "native" as const,
    config: {
      schemaVersion: 1 as const,
      sha256: sqliteSha256(JSON.stringify(loaded.config)),
      path: loaded.configPath,
      project: loaded.config.project.name,
    },
    paths,
    environment: {
      kind: "Owned embedded SQLite file",
      provider: "sqlite" as const,
      target: "sqlite" as const,
      projectId: loaded.config.runtime.projectId,
      ports: {},
      hostedAccess: "disabled" as const,
      outboundNetwork: "deny" as const,
      authenticationProviders: [],
      authenticationCallback: null,
      barriers: [
        "Owned private embedded file; original source opened read-only for a consistent native snapshot.",
        "Mandatory exhaustive column decisions; fresh sanitized database rebuild.",
        "No extensions, attached databases, virtual/generated tables or automatic runtime installation.",
        "Trusted application code is not isolated from the same user's filesystem privileges.",
      ],
    },
    baseline: sqliteBaselineSummary(loaded),
    migrations: {
      representedCount: plan.baseline.history.length,
      candidateCount: plan.candidates.length,
      candidateSha256: plan.candidateSha256,
      candidates: plan.candidates.map(({ filename, sha256 }) => ({
        filename,
        sha256,
      })),
    },
    lifecycle: {
      run: loaded.config.lifecycle.run,
      open: loaded.config.lifecycle.open,
      openIdleTimeoutSeconds: loaded.config.lifecycle.openIdleTimeoutSeconds,
      dataOnStop: "preserved" as const,
    },
    application: {
      activity: loaded.config.application.activity,
      startCommand: loaded.config.application.startCommand,
      proofCommand: loaded.config.application.proofCommand,
      readiness: loaded.config.application.readiness,
    },
    cleanup: {
      retainBaselineGenerations:
        loaded.config.cleanup.retainBaselineGenerations,
    },
    execution: [
      "Verify exact owned file and immutable SQLite generation.",
      "Restore the verified baseline only after explicit reset consent.",
      "Apply the confirmed SQL suffix as one transaction with foreign keys enforced.",
      "Run the existing configured application proof; preserve data on stop.",
    ],
    guarantee:
      "This review binds the declared SQLite slice and exact inputs; it does not certify production, ORM history, or arbitrary application code.",
  };
};
export const inspectSqliteBaseline = (loaded: Loaded) => {
  const summary = sqliteBaselineSummary(loaded);
  return {
    ...summary,
    backend: "native" as const,
    project: loaded.config.project.name,
    privacy: {
      sourceRowsExposed: false,
      sensitiveValuesIncludedInReport: false,
    },
    provenance: {
      historyEvidence: "owner-declared-current-input-checksums",
      sanitizationPolicySha256: summary.sanitizationPolicySha256,
    },
  };
};

export const runSqliteDoctor = async (loaded: Loaded) => {
  const capabilities = await inspectDatabaseCapabilities({
    projectRoot: loaded.projectRoot,
    configPath: loaded.configPath,
  });
  const host = await inspectHostPlatform({ projectRoot: loaded.projectRoot });
  const lsof = spawnSync("lsof", ["-v"], {
    env: createCleanProcessEnvironment(),
    timeout: 2000,
    maxBuffer: 65536,
    encoding: "utf8",
  });
  const checks: Array<{
    id: string;
    label: string;
    status: "pass" | "fail";
    detail: string;
    remediation: string;
  }> = [
    {
      id: "configuration",
      label: "SQLite configuration",
      status: "pass",
      detail: "Explicit native SQLite target; no database service port.",
      remediation: "Review configuration.",
    },
    {
      id: "operating-system",
      label: "Operating-system safety",
      status: host.supported ? "pass" : "fail",
      detail: host.detail,
      remediation: host.remediation ?? "Use an explicitly supported host.",
    },
    {
      id: "sqlite-backend",
      label: "SQLite binding and engine",
      status: capabilities.availability === "available" ? "pass" : "fail",
      detail:
        capabilities.availability === "available"
          ? "SQLite3.53.4 binding and authorizer are available."
          : capabilities.availability === "unavailable"
            ? "This executable lacks the required SQLite binding/version."
            : "The bounded SQLite probe did not establish backend readiness.",
      remediation:
        capabilities.availability === "unknown"
          ? "Inspect retained diagnostics and worker closure before retrying. A failed probe does not establish a missing binding."
          : "Use a qualified Node24 runtime with SQLite3.53.4; no runtime is installed automatically.",
    },
    {
      id: "sqlite-open-handles",
      label: "Exact open-handle inspection",
      status: !lsof.error && lsof.status === 0 ? "pass" : "fail",
      detail:
        !lsof.error && lsof.status === 0
          ? "Bounded lsof inspection is available."
          : "File-handle ownership cannot be established for reset/discard.",
      remediation:
        "Provide the documented host open-handle inspector before destructive SQLite actions.",
    },
  ];
  try {
    sqliteCandidatePlan(loaded);
    checks.push({
      id: "baseline",
      label: "SQLite baseline and SQL history",
      status: "pass",
      detail: "Checksums and the exact declared migration prefix verify.",
      remediation: "Review the baseline.",
    });
  } catch {
    checks.push({
      id: "baseline",
      label: "SQLite baseline and SQL history",
      status: "fail",
      detail: "No valid matching SQLite baseline is available.",
      remediation:
        "Review the source, exhaustive SQLite privacy policy and current-file ledger, then create the SQLite baseline.",
    });
  }
  return {
    backend: "native" as const,
    state: checks.every((c) => c.status === "pass") ? "READY" : "NOT READY",
    checks,
    databaseCapabilities: capabilities,
    ambientHostedVariables: {
      presentButQuarantined: [],
      note: "Application children receive an allowlisted environment.",
    },
    runtimeExists: existsSync(
      join(loaded.paths.runtimeWorkdir, "sqlite", "runtime.json"),
    ),
  };
};
