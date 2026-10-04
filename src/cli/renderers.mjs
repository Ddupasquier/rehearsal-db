/**
 * Human-readable CLI output. These functions are intentionally pure so the
 * command and guided workflow modules can focus on orchestration.
 */

import { formatCount } from "../shared/human_output.mjs";
import { terminalStyle } from "./terminal.mjs";

export const renderPlan = (plan, verbosity) => {
  if (plan.targets) {
    return [
      "REHEARSAL STACK PLAN",
      "",
      ...plan.targets.flatMap((target) => [
        `${target.name} — ${target.plan.config.project}`,
        `  ✓ ${target.plan.environment.kind}`,
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

export const renderDoctor = (doctor, verbosity) => {
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

export const renderBaseline = (baseline) =>
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

export const renderMigrations = (inspection, verbosity) => {
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

export const renderCandidates = (summary, verbosity) =>
  [
    "REHEARSAL CANDIDATES",
    ...(summary.targets?.length > 1
      ? summary.targets.flatMap((target) => [
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
    `${summary.targets?.length > 1 ? "Combined candidate digest" : "Candidate digest"}: ${summary.candidateSha256}`,
    `${summary.targets?.length > 1 ? "Pending across all targets" : "Pending"}: ${summary.candidateCount}`,
    "",
    summary.candidateCount
      ? "Next: run rehearsal run for a guided confirmation, or pass the full digest in automation."
      : "Next: run rehearsal run to verify the baseline and application proof.",
  ].join("\n");

export const renderInit = (result) =>
  [
    `REHEARSAL INIT — ${result.mode.toUpperCase()}`,
    `Destination: ${result.destination}`,
    `Detected package manager: ${result.detected.packageManager}`,
    `Detected Supabase config: ${result.detected.hasSupabaseConfig ? "yes" : "no"}`,
    `Detected migrations: ${result.detected.hasMigrations ? "yes" : "no"}`,
    ...(result.source ? ["", result.source] : []),
    result.nextAction,
  ].join("\n");

const summarizeSetupReadinessChecks = (readiness) => {
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

export const renderSetup = (result) => {
  const actionMarker = { create: "+", update: "~", unchanged: "=" };
  return [
    `REHEARSAL SETUP — ${result.mode.toUpperCase()}`,
    `Project: ${result.project}`,
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

export const renderBaselinePreparation = (result, flags = {}) =>
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

export const renderBaselineInputInspection = (result, flags = {}) =>
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

export const renderSupportReport = (report) => {
  const toolLine = (label, tool) =>
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

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unit;
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

export const renderCleanup = (result) => {
  const plan = result.plan;
  if (plan.targets) {
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
        : result.applied.targets.map(
            (target) =>
              `${target.name}: removed ${formatCount(target.applied.baselines.removed.length, "old baseline generation")}; runtime ${target.applied.runtimeRemoved ? "removed" : "preserved"}; removed ${formatCount(target.applied.imagesRemoved.length, "unused image tag")}.`,
          )),
    ].join("\n");
  }
  const imageBytes = plan.images.candidates.reduce(
    (total, image) => total + image.bytes,
    0,
  );
  const dockerImages = plan.docker.resources.find(
    (resource) => resource.Type === "Images",
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
          `Removed ${formatCount(result.applied.baselines.removed.length, "old baseline generation")}.`,
          result.applied.runtimeRemoved
            ? "Removed this project's disposable runtime and volumes."
            : "Preserved this project's disposable runtime.",
          `Removed ${formatCount(result.applied.imagesRemoved.length, "unused image tag")}.`,
        ]),
  ].join("\n");
};

export const renderSourceAccessPlan = (plan) =>
  [
    "SOURCE ACCESS — PREVIEW",
    "",
    `Target fingerprint: ${plan.review.targetFingerprint}`,
    `Temporary reader: ${plan.review.reader.role} (${plan.review.reader.validForMinutes} minutes)`,
    `Export schema: ${plan.review.exportSchema}`,
    ...plan.review.relations.map(
      (relation) =>
        `  → ${relation.source.schema}.${relation.source.table} → ${relation.view}: ${relation.columns.join(", ")} (${relation.rowScope.kind})`,
    ),
    ...(plan.review.assets.length
      ? plan.review.assets.map(
          (asset) =>
            `  → Storage ${asset.bucket}/${asset.prefix} (${asset.rights})`,
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
}) =>
  [
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
          `Activated baseline: ${refreshed.generationId}`,
          `Runtime reset: ${runtime.targets?.length ?? 1} target(s)`,
          cleanup.state === "complete"
            ? `Cleanup complete: ${formatCount(cleanup.removed.length, "old generation")} removed.`
            : `Cleanup incomplete: ${formatCount(cleanup.remaining, "old generation")} still eligible. Run rehearsal cleanup.`,
          "",
          "Next: retire source access when no other refresh is needed, then run a rehearsal.",
        ]),
  ].join("\n");

export const renderSourceRetirement = ({ mode, plan }) =>
  [
    `SOURCE ACCESS RETIREMENT — ${mode.toUpperCase()}`,
    `Target fingerprint: ${plan.review.targetFingerprint}`,
    `Reader: ${plan.review.readerRole}`,
    `Export schema: ${plan.review.exportSchema}`,
    ...plan.review.views.map((view) => `  → remove view ${view}`),
    "",
    ...(mode === "preview"
      ? [
          "Nothing has been removed.",
          `Exact confirmation: --confirm-source-retirement=${plan.digest}`,
        ]
      : [
          "The exact reader, export views, and local credential files were retired.",
        ]),
  ].join("\n");

export const renderIdentityPlan = ({ mode, plan }) =>
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
