/**
 * Human-readable CLI output. These functions are intentionally pure so the
 * command and guided workflow modules can focus on orchestration.
 */

import { formatCount } from "../shared/human_output.mjs";
import type { SourceAccessPlan } from "../source/access.mjs";
import type { IdentityClaimPlan } from "../identity/claim.mjs";
import { terminalStyle } from "./terminal.mjs";

type Verbosity = "normal" | "verbose";
type RenderFlags = Readonly<{ plain?: boolean; json?: boolean }>;
type RenderMode = "preview" | "written";

interface RenderMigration {
  readonly filename: string;
  readonly sha256: string;
  readonly status?: string;
}

interface RenderEnvironment {
  readonly kind: string;
  readonly hostedAccess: string;
  readonly outboundNetwork: string;
  readonly authenticationProviders: readonly string[];
  readonly authenticationCallback: string | null;
  readonly barriers: readonly string[];
}

interface RenderBaselineSummary {
  readonly generationId: string;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly verification: string;
}

interface RenderMigrationSummary {
  readonly candidates: readonly RenderMigration[];
  readonly candidateSha256: string;
  readonly candidateCount: number;
  readonly representedCount: number;
}

interface RenderSinglePlan {
  readonly environment: RenderEnvironment;
  readonly baseline: RenderBaselineSummary;
  readonly migrations: RenderMigrationSummary;
  readonly execution: readonly string[];
  readonly guarantee: string;
}

interface RenderStackTarget {
  readonly name: string;
  readonly plan: {
    readonly config: { readonly project: string };
    readonly environment: RenderEnvironment;
    readonly baseline: RenderBaselineSummary;
    readonly migrations: Pick<RenderMigrationSummary, "candidates">;
  };
}

interface RenderStackPlan {
  readonly targets: readonly RenderStackTarget[];
  readonly migrations: Pick<
    RenderMigrationSummary,
    "candidateSha256" | "candidateCount"
  >;
  readonly execution: readonly string[];
  readonly guarantee: string;
}

interface ReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
  readonly remediation?: string;
}

interface ReadinessReport {
  readonly state: string;
  readonly checks: readonly ReadinessCheck[];
  readonly ambientHostedVariables?: {
    readonly presentButQuarantined: readonly string[];
  };
}

interface RenderTable {
  readonly name: string;
  readonly rowCount: number;
  readonly columns: readonly string[];
}

interface CandidateSummary {
  readonly baselineGenerationId: string;
  readonly candidates: readonly RenderMigration[];
  readonly candidateSha256: string;
  readonly candidateCount: number;
  readonly targets?: readonly {
    readonly name: string;
    readonly baselineGenerationId: string;
    readonly candidates: readonly RenderMigration[];
  }[];
}

interface CleanupImage {
  readonly bytes: number;
  readonly tags: readonly string[];
}

interface CleanupTargetPlan {
  readonly project: string;
  readonly projectId: string;
  readonly baselines: {
    readonly available: boolean;
    readonly removed: readonly string[];
    readonly retained: readonly string[];
  };
  readonly runtime: { readonly included: boolean; readonly detected: boolean };
  readonly images: {
    readonly requested: boolean;
    readonly inspected: boolean;
    readonly candidates: readonly CleanupImage[];
  };
}

interface AppliedCleanup {
  readonly baselines: { readonly removed: readonly string[] };
  readonly runtimeRemoved: boolean;
  readonly imagesRemoved: readonly string[];
}

interface CleanupResult {
  readonly mode: RenderMode;
  readonly plan:
    | (CleanupTargetPlan & {
        readonly digest: string;
        readonly docker: {
          readonly resources: readonly unknown[];
          readonly disk: {
            readonly usedBytes: number;
            readonly totalBytes: number;
            readonly availableBytes: number;
            readonly usedPercent: number;
          } | null;
        };
      })
    | {
        readonly targets: readonly {
          readonly name: string;
          readonly plan: CleanupTargetPlan;
        }[];
        readonly digest: string;
      };
  readonly applied?:
    | AppliedCleanup
    | {
        readonly targets: readonly {
          readonly name: string;
          readonly applied: AppliedCleanup;
        }[];
      };
}

interface RefreshPlan {
  readonly digest: string;
  readonly review: {
    readonly currentBaseline: string;
    readonly source: { readonly readerExpiresAt: string };
    readonly runtimeTargets: readonly string[];
    readonly retention: {
      readonly generations: number;
      readonly removeAfterReplacement: readonly string[];
    };
    readonly steps: readonly string[];
  };
}

interface SourceRetirementPlan {
  readonly digest: string;
  readonly review: {
    readonly targetFingerprint: string;
    readonly readerRole: string;
    readonly exportSchema: string;
    readonly accessMode: "managed" | "external";
    readonly views: readonly string[];
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const renderPlan = (
  plan: RenderSinglePlan | RenderStackPlan,
  verbosity: Verbosity,
): string => {
  if ("targets" in plan) {
    return [
      "REHEARSAL STACK PLAN",
      "",
      ...plan.targets.flatMap((target) => [
        `${target.name} — ${target.plan.config.project}`,
        `  ✓ ${target.plan.environment.kind}`,
        ...(target.plan.environment.authenticationProviders.length
          ? [
              `  ✓ External identity providers ${target.plan.environment.authenticationProviders.join(", ")}`,
              ...(target.plan.environment.authenticationCallback
                ? [
                    `  → Register callback ${target.plan.environment.authenticationCallback}`,
                  ]
                : []),
            ]
          : []),
        `  ✓ baseline ${target.plan.baseline.generationId}`,
        `  ✓ ${formatCount(target.plan.baseline.tableCount, "table")}; ${formatCount(target.plan.baseline.rowCount, "row")}`,
        ...(target.plan.migrations.candidates.length
          ? target.plan.migrations.candidates.map(
              (migration) => `  → ${migration.filename}`,
            )
          : ["  ✓ No candidate migrations"]),
        "",
      ]),
      `Combined candidate digest: ${plan.migrations.candidateSha256}`,
      "",
      "Execution plan",
      ...plan.execution.map((step, index) => `  ${index + 1}. ${step}`),
      ...(verbosity === "normal"
        ? []
        : [
            "",
            ...plan.targets.flatMap((target) =>
              target.plan.environment.barriers.map(
                (barrier) => `  ✓ ${target.name}: ${barrier}`,
              ),
            ),
          ]),
      "",
      plan.guarantee,
      "",
      plan.migrations.candidateCount
        ? "Next: run rehearsal run to review and confirm this exact cross-target migration set."
        : "Next: run rehearsal run to verify the runtime stack and project proofs.",
    ].join("\n");
  }
  const candidates = plan.migrations.candidates.length
    ? plan.migrations.candidates
        .map((entry) => `  → ${entry.filename} (${entry.sha256.slice(0, 12)})`)
        .join("\n")
    : "  ✓ No candidate migrations";
  const verbose =
    verbosity === "normal"
      ? []
      : [
          "",
          "Safety barriers",
          ...plan.environment.barriers.map((barrier) => `  ✓ ${barrier}`),
          `  ✓ Candidate digest: ${plan.migrations.candidateSha256}`,
        ];
  return [
    "REHEARSAL PLAN",
    "",
    "Environment",
    `  ✓ ${plan.environment.kind}`,
    `  ✓ Hosted access ${plan.environment.hostedAccess}`,
    `  ✓ Hosted target configuration ${plan.environment.outboundNetwork}`,
    ...(plan.environment.authenticationProviders.length
      ? [
          `  ✓ External identity providers ${plan.environment.authenticationProviders.join(", ")}`,
          ...(plan.environment.authenticationCallback
            ? [
                `  → Register callback ${plan.environment.authenticationCallback}`,
              ]
            : []),
        ]
      : []),
    "",
    "Baseline",
    `  ✓ ${plan.baseline.generationId}`,
    `  ✓ ${formatCount(plan.baseline.tableCount, "table")}; ${formatCount(plan.baseline.rowCount, "row")}`,
    `  ✓ ${plan.baseline.verification}`,
    "",
    "Migrations",
    `  ✓ ${plan.migrations.representedCount} represented by baseline`,
    candidates,
    "",
    "Execution plan",
    ...plan.execution.map((step, index) => `  ${index + 1}. ${step}`),
    ...verbose,
    "",
    plan.guarantee,
    "",
    plan.migrations.candidateCount
      ? "Next: run rehearsal run to review and confirm this exact candidate set."
      : "Next: run rehearsal run to verify the baseline and application proof.",
  ].join("\n");
};

export const renderDoctor = (
  doctor: ReadinessReport,
  verbosity: Verbosity,
): string => {
  const lines = doctor.checks.map((check) => {
    const marker = check.status === "pass" ? "✓" : "✗";
    const detail =
      verbosity === "normal" && check.status === "pass"
        ? ""
        : ` — ${check.detail}`;
    return `${marker} ${check.label}${detail}`;
  });
  for (const check of doctor.checks.filter(
    (entry) => entry.status === "fail",
  )) {
    if (check.remediation) lines.push(`  Try: ${check.remediation}`);
  }
  if (doctor.ambientHostedVariables?.presentButQuarantined.length) {
    lines.push(
      `! ${doctor.ambientHostedVariables.presentButQuarantined.length} ambient hosted credential variables detected and quarantined.`,
    );
  }
  return [
    ...lines,
    "",
    doctor.state,
    "",
    doctor.state === "READY"
      ? "Next: run rehearsal explain to review the migration plan."
      : "Next: fix the items above, then run rehearsal doctor again.",
  ].join("\n");
};

export const renderBaseline = (baseline: {
  rehearsalVersion: string;
  generationId: string;
  createdAt?: string | null;
  formatVersion: number;
  tableCount: number;
  rowCount: number;
  migrationCount: number;
  migrationCutoff: string;
  dataSha256: string;
  sanitizationPolicySha256: string;
  verification: string;
}): string =>
  [
    "REHEARSAL BASELINE",
    `Rehearsal: ${baseline.rehearsalVersion}`,
    `Generation: ${baseline.generationId}`,
    `Created: ${baseline.createdAt ?? "unknown"}`,
    `Format: ${baseline.formatVersion}`,
    `Tables: ${baseline.tableCount}`,
    `Rows: ${baseline.rowCount}`,
    `Migrations: ${baseline.migrationCount} through ${baseline.migrationCutoff}`,
    `Data SHA-256: ${baseline.dataSha256}`,
    `Sanitization policy SHA-256: ${baseline.sanitizationPolicySha256}`,
    `Verification: ${baseline.verification}`,
    "Source rows and sensitive values are never printed by inspect.",
  ].join("\n");

export const renderMigrations = (
  inspection: {
    baselineGenerationId: string;
    baselineCutoff: string;
    candidateSha256: string;
    migrations: readonly (RenderMigration & { status: string })[];
  },
  verbosity: Verbosity,
): string => {
  const entries = inspection.migrations.map((migration) => {
    const digest = verbosity === "normal" ? "" : ` (${migration.sha256})`;
    return `${migration.status.padEnd(28)} ${migration.filename}${digest}`;
  });
  return [
    "REHEARSAL MIGRATIONS",
    `Baseline: ${inspection.baselineGenerationId} through ${inspection.baselineCutoff}`,
    `Candidate digest: ${inspection.candidateSha256}`,
    "",
    ...entries,
  ].join("\n");
};

export const renderCandidates = (
  summary: CandidateSummary,
  verbosity: Verbosity,
): string => {
  const multipleTargets = (summary.targets?.length ?? 0) > 1;
  return [
    "REHEARSAL CANDIDATES",
    ...(multipleTargets
      ? (summary.targets ?? []).flatMap((target) => [
          "",
          `${target.name} — baseline ${target.baselineGenerationId}`,
          ...(target.candidates.length
            ? target.candidates.map((migration) =>
                verbosity === "normal"
                  ? `  → ${migration.filename}`
                  : `  → ${migration.filename} (${migration.sha256})`,
              )
            : ["  ✓ No candidate migrations"]),
        ])
      : [
          `Baseline: ${summary.baselineGenerationId}`,
          ...(summary.candidates.length
            ? summary.candidates.map((migration) =>
                verbosity === "normal"
                  ? `  → ${migration.filename}`
                  : `  → ${migration.filename} (${migration.sha256})`,
              )
            : ["  ✓ No candidate migrations"]),
        ]),
    "",
    `${multipleTargets ? "Combined candidate digest" : "Candidate digest"}: ${summary.candidateSha256}`,
    `${multipleTargets ? "Pending across all targets" : "Pending"}: ${summary.candidateCount}`,
    "",
    summary.candidateCount
      ? "Next: run rehearsal run for a guided confirmation, or pass the full digest in automation."
      : "Next: run rehearsal run to verify the baseline and application proof.",
  ].join("\n");
};

export const renderInit = (result: {
  mode: RenderMode;
  destination: string;
  detected: {
    packageManager: string;
    hasSupabaseConfig: boolean;
    hasMigrations: boolean;
  };
  availableOptions?: readonly { path: string; summary: string }[];
  source?: string | null;
  nextAction: string;
}): string =>
  [
    `REHEARSAL INIT — ${result.mode.toUpperCase()}`,
    `Destination: ${result.destination}`,
    `Detected package manager: ${result.detected.packageManager}`,
    `Detected Supabase config: ${result.detected.hasSupabaseConfig ? "yes" : "no"}`,
    `Detected migrations: ${result.detected.hasMigrations ? "yes" : "no"}`,
    ...(result.availableOptions?.length
      ? [
          "",
          "AVAILABLE BUT NOT ENABLED",
          ...result.availableOptions.map(
            (option) => `  → ${option.path}: ${option.summary}`,
          ),
        ]
      : []),
    ...(result.source ? ["", result.source] : []),
    result.nextAction,
  ].join("\n");

const summarizeSetupReadinessChecks = (
  readiness: ReadinessReport,
): string[] => {
  const failures = readiness.checks.filter((check) => check.status === "fail");
  const policyMissing = failures.some(
    (check) =>
      check.id === "sanitization-policy" &&
      /ENOENT|no such file/iu.test(check.detail),
  );
  const baselineMissing = failures.some(
    (check) =>
      check.id === "baseline" && /ENOENT|no such file/iu.test(check.detail),
  );
  const hidden = new Set([
    ...(policyMissing ? ["sanitization-policy"] : []),
    ...(baselineMissing
      ? ["baseline", "baseline-permissions", "migration-history"]
      : []),
  ]);
  if (
    policyMissing &&
    failures.some(
      (check) =>
        check.id === "paths" && /sanitization-policy/iu.test(check.detail),
    )
  ) {
    hidden.add("paths");
  }
  const passed = readiness.checks.filter(
    (check) => check.status === "pass",
  ).length;
  return [
    ...(passed ? [`  ✓ ${passed} environment and safety checks passed`] : []),
    ...failures
      .filter((check) => !hidden.has(check.id))
      .map((check) => `  ○ ${check.label}: ${check.detail}`),
    ...(policyMissing
      ? ["  ○ Baseline policy: not created yet (next guided step)"]
      : []),
    ...(baselineMissing
      ? ["  ○ Verified baseline: not created yet (after policy review)"]
      : []),
  ];
};

export const renderSetup = (result: {
  mode: RenderMode;
  project: string;
  configurationPath: string;
  configurationAction: "create" | "update" | "unchanged";
  rootConfigGenerationSkipped?: boolean;
  target: "postgresql" | "supabase";
  projectId: string;
  applicationUrl: string;
  ports: Readonly<Record<string, number>> & { readonly database: number };
  files: readonly {
    action: "create" | "update" | "unchanged";
    path: string;
  }[];
  safety: readonly string[];
  readiness?: ReadinessReport;
  nextAction: string;
}): string => {
  const actionMarker: Record<"create" | "update" | "unchanged", string> = {
    create: "+",
    update: "~",
    unchanged: "=",
  };
  return [
    `REHEARSAL SETUP — ${result.mode.toUpperCase()}`,
    `Project: ${result.project}`,
    `Configuration: ${result.configurationPath} (${
      result.configurationAction === "create"
        ? result.mode === "written"
          ? "created"
          : "will create"
        : "existing"
    })`,
    ...(result.rootConfigGenerationSkipped
      ? [
          "Root config: not created because the existing supported configuration remains active.",
        ]
      : []),
    `Database: ${result.target === "postgresql" ? "PostgreSQL" : "Supabase"}`,
    `Runtime ID: ${result.projectId}`,
    `Application: ${result.applicationUrl}`,
    result.target === "postgresql"
      ? `Port: database ${result.ports.database}`
      : `Ports: API ${result.ports.api}, database ${result.ports.database}, Studio ${result.ports.studio}`,
    "",
    "Files",
    ...result.files.map(
      (file) => `  ${actionMarker[file.action]} ${file.action} ${file.path}`,
    ),
    "",
    "Safety boundaries",
    ...result.safety.map((barrier) => `  ✓ ${barrier}`),
    ...(result.readiness
      ? [
          "",
          `Readiness — ${result.readiness.state}`,
          ...summarizeSetupReadinessChecks(result.readiness),
        ]
      : []),
    "",
    result.nextAction,
  ].join("\n");
};

export const renderBaselinePreparation = (
  result: {
    mode: RenderMode;
    destination: string;
    rowCount: number;
    recordsPath: string;
    migrationCount: number;
    migrationCutoff: string;
    tables: readonly RenderTable[];
    nextAction: string;
  },
  flags: RenderFlags = {},
): string =>
  [
    `BASELINE POLICY — ${result.mode.toUpperCase()}`,
    `Destination: ${result.destination}`,
    `Records: ${formatCount(result.rowCount, "row")} from ${result.recordsPath}`,
    `Migrations: ${formatCount(result.migrationCount, "migration")} through ${result.migrationCutoff}`,
    "",
    "Detected shape (values are never printed)",
    ...result.tables.map(
      (table) =>
        `  ${terminalStyle(flags, "36", "→")} ${table.name}: ${formatCount(table.rowCount, "row")}; ${table.columns.join(", ")}`,
    ),
    "",
    "Every column is marked REVIEW REQUIRED for action, generated status, identity, and foreign key metadata.",
    "The draft cannot be activated until those decisions are completed.",
    "",
    result.nextAction,
  ].join("\n");

export const renderBaselineInputInspection = (
  result: {
    rowCount: number;
    recordsPath: string;
    migrationCount: number;
    migrationCutoff: string;
    ledgerPath: string;
    assetsPath?: string;
    assetCount: number;
    tables: readonly RenderTable[];
  },
  flags: RenderFlags = {},
): string =>
  [
    "BASELINE INPUTS — READY",
    `Records: ${formatCount(result.rowCount, "row")} across ${formatCount(result.tables.length, "table")} from ${result.recordsPath}`,
    `Migrations: ${formatCount(result.migrationCount, "migration")} through ${result.migrationCutoff} from ${result.ledgerPath}`,
    result.assetsPath
      ? `Storage: ${formatCount(result.assetCount, "asset")} from ${result.assetsPath}`
      : "Storage: no asset manifest selected",
    "",
    "Detected tables (values are never printed)",
    ...result.tables.map(
      (table) =>
        `  ${terminalStyle(flags, "36", "→")} ${table.name}: ${formatCount(table.rowCount, "row")}`,
    ),
    "",
    "All inputs are project-local regular files and passed structural validation.",
  ].join("\n");

export const renderSupportReport = (report: {
  rehearsalVersion: string;
  system: {
    platform: string;
    architecture: string;
    release: string;
    node: string;
  };
  tools: Record<
    "npm" | "supabase" | "dockerClient" | "dockerServer",
    { status: string; version?: string }
  >;
  readiness: {
    state: string;
    checks: readonly Omit<ReadinessCheck, "detail">[];
    quarantinedHostedVariableCount: number;
  };
  supportUrl: string;
}): string => {
  const toolLine = (
    label: string,
    tool: { status: string; version?: string },
  ): string =>
    `${label}: ${tool.status === "available" ? tool.version : tool.status.replaceAll("_", " ")}`;
  return [
    "REHEARSAL SUPPORT REPORT",
    "",
    `Rehearsal: ${report.rehearsalVersion}`,
    `System: ${report.system.platform} ${report.system.architecture} (${report.system.release})`,
    `Node.js: ${report.system.node}`,
    toolLine("npm", report.tools.npm),
    toolLine("Supabase CLI", report.tools.supabase),
    toolLine("Docker client", report.tools.dockerClient),
    toolLine("Docker server", report.tools.dockerServer),
    "",
    `Readiness: ${report.readiness.state}`,
    ...report.readiness.checks.map((check) =>
      check.status === "pass"
        ? `  ✓ ${check.label}`
        : `  ✗ ${check.label}${check.remediation ? ` — ${check.remediation}` : ""}`,
    ),
    ...(report.readiness.quarantinedHostedVariableCount
      ? [
          `  ! ${formatCount(report.readiness.quarantinedHostedVariableCount, "ambient hosted variable")} detected and quarantined`,
        ]
      : []),
    "",
    "Privacy: no row values, credentials, project paths, migration SQL, or baseline identifiers are included.",
    "Review this report before sharing it.",
    `Report a reproducible issue: ${report.supportUrl}`,
  ].join("\n");
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unit;
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? "B"}`;
};

export const renderCleanup = (result: CleanupResult): string => {
  const plan = result.plan;
  if ("targets" in plan) {
    const selectedCount = plan.targets.reduce(
      (total, target) =>
        total +
        target.plan.baselines.removed.length +
        (target.plan.runtime.included && target.plan.runtime.detected ? 1 : 0) +
        target.plan.images.candidates.length,
      0,
    );
    return [
      `REHEARSAL STACK CLEANUP — ${result.mode.toUpperCase()}`,
      ...plan.targets.flatMap((target) => [
        "",
        `${target.name} — ${target.plan.project}`,
        target.plan.baselines.available
          ? `  ${target.plan.baselines.removed.length ? "→" : "✓"} ${formatCount(target.plan.baselines.removed.length, "old baseline generation")} selected; keeping ${target.plan.baselines.retained.length}`
          : "  ○ No active baseline found",
        !target.plan.runtime.detected
          ? "  ✓ No runtime found"
          : target.plan.runtime.included
            ? `  → Runtime ${target.plan.projectId} selected`
            : `  ○ Runtime ${target.plan.projectId} preserved`,
        ...(target.plan.images.requested
          ? target.plan.images.inspected
            ? target.plan.images.candidates.length
              ? [
                  `  → ${formatCount(target.plan.images.candidates.length, "older unused Supabase image")} selected`,
                  ...target.plan.images.candidates.flatMap((image) =>
                    image.tags.map((tag) => `    ${tag}`),
                  ),
                ]
              : ["  ✓ No older unused Supabase images found"]
            : ["  ! Docker is unavailable; shared images were not inspected"]
          : []),
      ]),
      "",
      ...(result.mode === "preview"
        ? selectedCount
          ? [
              "Nothing has been removed.",
              `Combined cleanup set: ${plan.digest.slice(0, 12)}`,
              `Exact confirmation: --confirm-cleanup=${plan.digest}`,
              "Review every target above, then rerun with --write and this exact confirmation.",
            ]
          : ["Nothing has been removed, and nothing is currently selected."]
        : result.applied && "targets" in result.applied
          ? result.applied.targets.map(
              (target) =>
                `${target.name}: removed ${formatCount(target.applied.baselines.removed.length, "old baseline generation")}; runtime ${target.applied.runtimeRemoved ? "removed" : "preserved"}; removed ${formatCount(target.applied.imagesRemoved.length, "unused image tag")}.`,
            )
          : []),
    ].join("\n");
  }
  const imageBytes = plan.images.candidates.reduce(
    (total, image) => total + image.bytes,
    0,
  );
  const dockerImages = plan.docker.resources.find(
    (
      resource,
    ): resource is { Type: string; Size: string; Reclaimable: string } =>
      isObject(resource) &&
      resource.Type === "Images" &&
      typeof resource.Size === "string" &&
      typeof resource.Reclaimable === "string",
  );
  const selectedCount =
    plan.baselines.removed.length +
    (plan.runtime.included && plan.runtime.detected ? 1 : 0) +
    plan.images.candidates.length;
  return [
    `REHEARSAL CLEANUP — ${result.mode.toUpperCase()}`,
    `Project: ${plan.project}`,
    ...(dockerImages
      ? [
          `Docker images: ${dockerImages.Size}; ${dockerImages.Reclaimable} reclaimable across Docker`,
        ]
      : ["Docker usage: unavailable"]),
    ...(plan.docker.disk
      ? [
          `Container disk: ${formatBytes(plan.docker.disk.usedBytes)} used of ${formatBytes(plan.docker.disk.totalBytes)}; ${formatBytes(plan.docker.disk.availableBytes)} free (${plan.docker.disk.usedPercent}% used)`,
        ]
      : []),
    "",
    "Project-owned files",
    plan.baselines.available
      ? `  ${plan.baselines.removed.length ? "→" : "✓"} ${formatCount(plan.baselines.removed.length, "old baseline generation")} selected; keeping ${plan.baselines.retained.length}`
      : "  ○ No active baseline found",
    "",
    "Disposable runtime",
    !plan.runtime.detected
      ? "  ✓ No runtime found"
      : plan.runtime.included
        ? "  → Current project runtime selected"
        : "  ○ Current project runtime preserved (add --include-runtime to select it)",
    "",
    "Shared Docker images",
    !plan.images.requested
      ? "  ○ Not inspected (add --include-images to inspect older unused Supabase images)"
      : !plan.images.inspected
        ? "  ! Docker is unavailable; images could not be inspected"
        : plan.images.candidates.length
          ? `  → ${formatCount(plan.images.candidates.length, "older unused Supabase image")} selected; approximately ${formatBytes(imageBytes)}`
          : "  ✓ No older unused Supabase images found",
    ...(plan.images.candidates.length
      ? plan.images.candidates.flatMap((image) =>
          image.tags.map((tag) => `    ${tag}`),
        )
      : []),
    "",
    ...(result.mode === "preview"
      ? selectedCount
        ? [
            "Nothing has been removed.",
            `Cleanup set: ${plan.digest.slice(0, 12)}`,
            `Exact confirmation: --confirm-cleanup=${plan.digest}`,
            "Review this list, then rerun the same command with --write and the exact confirmation above.",
          ]
        : [
            "Nothing has been removed, and nothing is currently selected.",
            "Use --include-runtime or --include-images only when you want those shared resources considered.",
          ]
      : [
          `Removed ${formatCount(!result.applied || "targets" in result.applied ? 0 : result.applied.baselines.removed.length, "old baseline generation")}.`,
          result.applied &&
          !("targets" in result.applied) &&
          result.applied.runtimeRemoved
            ? "Removed this project's disposable runtime and volumes."
            : "Preserved this project's disposable runtime.",
          `Removed ${formatCount(!result.applied || "targets" in result.applied ? 0 : result.applied.imagesRemoved.length, "unused image tag")}.`,
        ]),
  ].join("\n");
};

export const renderSourceAccessPlan = (plan: SourceAccessPlan): string =>
  [
    "SOURCE ACCESS — PREVIEW",
    "",
    `Target fingerprint: ${plan.review.targetFingerprint}`,
    plan.review.reader.mode === "managed"
      ? `Managed temporary reader: ${plan.review.reader.role} (${plan.review.reader.validForMinutes} minutes)`
      : `Externally managed reader: ${plan.review.reader.role} (maximum ${plan.review.reader.maximumValidForMinutes} minutes remaining)`,
    `Source changes by Rehearsal: ${plan.review.reader.sourceChanges ? "export views and temporary roles" : "none"}`,
    `Export schema: ${plan.review.exportSchema}`,
    ...plan.review.relations.map(
      (relation) =>
        `  → ${relation.source.schema}.${relation.source.table} → ${relation.view}: ${relation.columns.join(", ")} (${relation.rowScope.kind})`,
    ),
    ...(plan.review.assets.length
      ? plan.review.assets.map(
          (asset) =>
            `  → Storage ${asset.bucket}/${
              "prefix" in asset
                ? asset.prefix
                : `[private prefix from ${asset.prefixEnvironmentVariable}]`
            } (${asset.rights})`,
        )
      : ["  ○ No source assets declared"]),
    "",
    "Deny checks",
    ...plan.review.denyChecks.map((check) => `  ✓ ${check}`),
    "",
    "No source changes have been made.",
    `Exact confirmation: --confirm-source-access=${plan.digest}`,
  ].join("\n");

export const renderRefreshWorkflow = ({
  mode,
  plan,
  refreshed,
  runtime,
  cleanup,
}: {
  mode: RenderMode;
  plan: RefreshPlan;
  refreshed?: { generationId: string };
  runtime?: { targets?: readonly unknown[] };
  cleanup?:
    | { state: "complete"; removed: readonly string[] }
    | { state: string; remaining: number };
}): string => {
  const cleanupLine = cleanup
    ? "removed" in cleanup
      ? `Cleanup complete: ${formatCount(cleanup.removed.length, "old generation")} removed.`
      : `Cleanup incomplete: ${formatCount(cleanup.remaining, "old generation")} still eligible. Run rehearsal cleanup.`
    : "Cleanup status unavailable.";
  return [
    `DATABASE COPY REFRESH — ${mode.toUpperCase()}`,
    "",
    `Current baseline: ${plan.review.currentBaseline}`,
    `Source access expires: ${plan.review.source.readerExpiresAt}`,
    `Runtime targets reset: ${plan.review.runtimeTargets.join(", ")}`,
    `Baseline retention: ${formatCount(plan.review.retention.generations, "generation")}`,
    ...(plan.review.retention.removeAfterReplacement.length
      ? [
          "Old generations removed after success:",
          ...plan.review.retention.removeAfterReplacement.map(
            (generation) => `  → ${generation}`,
          ),
        ]
      : ["Old generations removed after success: none"]),
    "",
    ...plan.review.steps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    ...(mode === "preview"
      ? [
          "Nothing has changed. The current baseline and runtime remain intact.",
          `Exact confirmation: --confirm-refresh=${plan.digest}`,
        ]
      : [
          `Activated baseline: ${refreshed?.generationId ?? "unknown"}`,
          `Runtime reset: ${runtime?.targets?.length ?? 1} target(s)`,
          cleanupLine,
          "",
          "Next: retire source access when no other refresh is needed, then run a rehearsal.",
        ]),
  ].join("\n");
};

export const renderSourceRetirement = ({
  mode,
  plan,
}: {
  mode: RenderMode;
  plan: SourceRetirementPlan;
}): string =>
  [
    `SOURCE ACCESS RETIREMENT — ${mode.toUpperCase()}`,
    `Target fingerprint: ${plan.review.targetFingerprint}`,
    `Reader: ${plan.review.readerRole}`,
    `Export schema: ${plan.review.exportSchema}`,
    ...(plan.review.accessMode === "managed"
      ? plan.review.views.map((view) => `  → remove view ${view}`)
      : [
          "  → remove only Rehearsal's local credential and receipt",
          "  ✓ preserve the provider-owned reader and export views",
        ]),
    "",
    ...(mode === "preview"
      ? [
          "Nothing has been removed.",
          `Exact confirmation: --confirm-source-retirement=${plan.digest}`,
        ]
      : [
          plan.review.accessMode === "managed"
            ? "The exact reader, export views, and local credential files were retired."
            : "Rehearsal's local credential and receipt were removed. Provider-owned database resources were preserved.",
        ]),
  ].join("\n");

export const renderIdentityPlan = ({
  mode,
  plan,
}: {
  mode: RenderMode;
  plan: IdentityClaimPlan;
}): string =>
  [
    `LOCAL IDENTITY — ${mode.toUpperCase()}`,
    `Identity: ${plan.review.name}`,
    `Matcher: ${plan.review.matcher.type}`,
    plan.review.matcher.type === "verified-email"
      ? `Providers: ${plan.review.matcher.providers.join(", ")}`
      : `Provider: ${plan.review.matcher.provider}`,
    plan.review.matcher.type === "verified-email"
      ? `Approved email receipt: ${plan.review.matcher.approvedEmailSha256}`
      : `Approved subject receipt: ${plan.review.matcher.approvedSubjectSha256}`,
    `Relational references: ${plan.review.references.length}`,
    `Nested JSON references: ${plan.review.jsonReferences.length}`,
    `Signup defaults: ${plan.review.signupDefaults.length}`,
    `Storage path references: ${plan.review.pathReferences.length}`,
    `Asset scopes: ${plan.review.assets.length}`,
    `Token hook assertion: ${plan.review.tokenHook ? "configured" : "not configured"}`,
    "",
    ...(mode === "preview"
      ? [
          "No local account was changed.",
          `Exact confirmation: --confirm-identity=${plan.digest}`,
        ]
      : ["The verified local identity now owns the declared copied graph."]),
  ].join("\n");
