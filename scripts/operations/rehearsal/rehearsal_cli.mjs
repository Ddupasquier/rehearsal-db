#!/usr/bin/env node
/**
 * Purpose: Run the versioned, project-configured Rehearsal developer CLI for
 * initialization, readiness, planning, inspection, and verified local execution.
 * Run: `npm run rehearsal -- doctor` or `npm run rehearsal -- explain`.
 */

import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import {
  RehearsalError,
  createRehearsalResult,
  normalizeRehearsalError,
  redactDiagnosticValue,
  renderHumanError,
  serializeRehearsalError,
} from "../../lib/rehearsal/diagnostics.mjs";
import {
  inspectDetectedProject,
  findRehearsalConfigPath,
  loadRehearsalConfig,
  renderDetectedConfig,
  validateRuntimeSanitizationPolicy,
} from "../../lib/rehearsal/configuration.mjs";
import {
  buildRehearsalPlan,
  inspectRehearsalBaseline,
  inspectRehearsalMigrations,
  runRehearsalDoctor,
} from "../../lib/rehearsal/plan.mjs";
import { createSyntheticBaselineFromFiles } from "../../lib/rehearsal/baseline_builder.mjs";
import {
  applyBaselinePreparation,
  inspectBaselineInputFiles,
  planBaselinePreparation,
  summarizeBaselinePreparation,
} from "../../lib/rehearsal/baseline_preparation.mjs";
import { discoverBaselineInputFiles } from "../../lib/rehearsal/input_discovery.mjs";
import {
  applyRehearsalSetup,
  inspectRehearsalNodeRuntime,
  planRehearsalSetup,
  summarizeRehearsalSetup,
} from "../../lib/rehearsal/setup.mjs";
import { formatCount } from "../../lib/rehearsal/human_output.mjs";
import {
  applyReviewedPolicy,
  completePolicyDraft,
  createSafeTablePreset,
  readReviewablePolicyDraft,
  suggestPolicyExceptionColumns,
} from "../../lib/rehearsal/policy_review.mjs";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectRoot = process.cwd();
const commandStartedAt = new Date();
const commandStartedMs = performance.now();
const managerPath = join(
  packageRoot,
  "scripts/operations/database/manage_rehearsal_database.mjs",
);
let lastGuidedDetails;

const parseArguments = (arguments_) => {
  const flags = {
    json: false,
    help: false,
    verbosity: "normal",
    dryRun: false,
    write: false,
    plain: false,
    configPath: undefined,
    confirmation: undefined,
    recordsPath: undefined,
    ledgerPath: undefined,
    assetsPath: undefined,
  };
  const positionals = [];
  for (const argument of arguments_) {
    if (argument === "--json") flags.json = true;
    else if (argument === "--help" || argument === "-h") flags.help = true;
    else if (argument === "--verbose") flags.verbosity = "verbose";
    else if (argument === "--debug") flags.verbosity = "debug";
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (argument === "--write") flags.write = true;
    else if (argument === "--plain") flags.plain = true;
    else if (argument.startsWith("--config=")) {
      flags.configPath = argument.slice("--config=".length);
    } else if (argument.startsWith("--confirm-candidates=")) {
      flags.confirmation = argument.slice("--confirm-candidates=".length);
    } else if (argument.startsWith("--records=")) {
      flags.recordsPath = argument.slice("--records=".length);
    } else if (argument.startsWith("--ledger=")) {
      flags.ledgerPath = argument.slice("--ledger=".length);
    } else if (argument.startsWith("--assets=")) {
      flags.assetsPath = argument.slice("--assets=".length);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown Rehearsal option: ${argument}.`);
    } else positionals.push(argument);
  }
  return { flags, positionals };
};

const renderPlan = (plan, verbosity) => {
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
    `  ✓ Application/provider-data egress ${plan.environment.outboundNetwork}`,
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

const renderDoctor = (doctor, verbosity) => {
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

const renderBaseline = (baseline) =>
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

const renderMigrations = (inspection, verbosity) => {
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

const candidateSummary = (inspection) => {
  const candidates = inspection.migrations.filter(
    (migration) => migration.status === "candidate",
  );
  return {
    baselineGenerationId: inspection.baselineGenerationId,
    candidateSha256: inspection.candidateSha256,
    candidateCount: candidates.length,
    candidates,
  };
};

const renderCandidates = (summary, verbosity) =>
  [
    "REHEARSAL CANDIDATES",
    `Baseline: ${summary.baselineGenerationId}`,
    `Candidate digest: ${summary.candidateSha256}`,
    `Pending: ${summary.candidateCount}`,
    ...(summary.candidates.length
      ? summary.candidates.map((migration) =>
          verbosity === "normal"
            ? `  → ${migration.filename}`
            : `  → ${migration.filename} (${migration.sha256})`,
        )
      : ["  ✓ No candidate migrations"]),
    "",
    summary.candidateCount
      ? "Next: run rehearsal run for a guided confirmation, or pass the full digest in automation."
      : "Next: run rehearsal run to verify the baseline and application proof.",
  ].join("\n");

const pathExists = (path) =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });

const useColor = (flags) =>
  !flags.plain &&
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const terminalStyle = (flags, code, value) =>
  useColor(flags) ? `\u001B[${code}m${value}\u001B[0m` : value;

const isHumanTerminal = (flags) =>
  !flags.json && process.stdin.isTTY && process.stdout.isTTY;

const useStyledPrompts = (flags) => isHumanTerminal(flags) && useColor(flags);

const formatDuration = (durationMs) =>
  durationMs < 1_000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;

const promptForChoice = async ({ message, options, flags = {} }) => {
  if (useStyledPrompts(flags)) {
    const selected = await prompts.select({
      message,
      options: options.map((option) => ({
        value: option,
        label: option.label,
        hint: option.hint,
      })),
    });
    return prompts.isCancel(selected)
      ? options.find((option) => option.command === "exit")
      : selected;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = (await prompt.question(`${message} [1]: `)).trim();
      const selected = answer === "" ? 1 : Number(answer);
      if (
        Number.isInteger(selected) &&
        selected >= 1 &&
        selected <= options.length
      ) {
        return options[selected - 1];
      }
      console.log(`Choose a number from 1 to ${options.length}.`);
    }
  } finally {
    prompt.close();
  }
};

const promptForConfirmation = async (
  message,
  flags = {},
  { cancelValue = false } = {},
) => {
  if (useStyledPrompts(flags)) {
    const accepted = await prompts.confirm({ message, initialValue: false });
    return prompts.isCancel(accepted) ? cancelValue : accepted;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question(`${message} (y/N) `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
};

const promptForPath = async ({
  message,
  defaultValue,
  optional = false,
  flags = {},
  validate,
}) => {
  if (useStyledPrompts(flags)) {
    const answer = await prompts.text({
      message,
      placeholder: defaultValue ?? (optional ? "Leave blank for none" : ""),
      defaultValue,
      validate: (value) => {
        const resolved = String(value ?? defaultValue ?? "").trim();
        if (!optional && !resolved) return "Enter a value.";
        return resolved && validate ? validate(resolved) : undefined;
      },
    });
    if (prompts.isCancel(answer)) return undefined;
    return String(answer || defaultValue || "").trim() || undefined;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const suffix = defaultValue
        ? ` [${defaultValue}]`
        : optional
          ? ""
          : " (required)";
      const answer = (await prompt.question(`${message}${suffix}: `)).trim();
      const value = answer || defaultValue || "";
      const invalid = value && validate ? validate(value) : undefined;
      if (invalid) {
        console.log(invalid);
        continue;
      }
      if (value || optional) return value || undefined;
      console.log("Enter a project-relative path.");
    }
  } finally {
    prompt.close();
  }
};

const promptForDiscoveredPath = async ({
  message,
  candidates,
  optional = false,
  flags,
}) => {
  if (candidates.length <= 1 && !optional) {
    return promptForPath({
      message,
      defaultValue: candidates[0],
      flags,
    });
  }
  if (candidates.length === 0) {
    return promptForPath({ message, optional, flags });
  }
  const noneValue = "\0none";
  const manualValue = "\0manual";
  const selected = await promptForSelection({
    message,
    flags,
    options: [
      ...(optional
        ? [
            {
              label: "No storage assets",
              hint: "Continue without an asset manifest",
              value: noneValue,
            },
          ]
        : []),
      ...candidates.map((path) => ({ label: path, value: path })),
      { label: "Enter another path", value: manualValue },
    ],
  });
  if (!selected || selected === noneValue) return undefined;
  if (selected !== manualValue) return selected;
  return promptForPath({ message, optional, flags });
};

const promptForSelection = async ({ message, options, flags }) => {
  const selected = await promptForChoice({ message, options, flags });
  return selected?.value;
};

const promptForMultipleChoice = async ({
  message,
  options,
  initialValues = [],
  flags,
}) => {
  if (useStyledPrompts(flags)) {
    const selected = await prompts.multiselect({
      message,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.hint,
      })),
      initialValues,
      required: false,
    });
    return prompts.isCancel(selected) ? undefined : selected;
  }
  const initial = new Set(initialValues);
  console.log("");
  console.log(message);
  for (const [index, option] of options.entries()) {
    console.log(
      `  ${index + 1}. ${option.label}${initial.has(option.value) ? " (suggested)" : ""}`,
    );
  }
  const defaultNumbers = options
    .map((option, index) => (initial.has(option.value) ? index + 1 : undefined))
    .filter(Boolean)
    .join(",");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const suffix = defaultNumbers ? ` [${defaultNumbers}]` : " [none]";
      const answer = (
        await prompt.question(
          `Choose comma-separated numbers, all, or none${suffix}: `,
        )
      )
        .trim()
        .toLowerCase();
      if (!answer) return [...initialValues];
      if (answer === "none") return [];
      if (answer === "all") return options.map((option) => option.value);
      const indexes = answer.split(",").map((value) => Number(value.trim()));
      if (
        indexes.length > 0 &&
        indexes.every(
          (index) =>
            Number.isInteger(index) && index >= 1 && index <= options.length,
        )
      ) {
        return [...new Set(indexes)].map((index) => options[index - 1].value);
      }
      console.log(`Choose numbers from 1 to ${options.length}, all, or none.`);
    }
  } finally {
    prompt.close();
  }
};

const inspectGuidedProject = async (planOptions) => {
  const detected = await inspectDetectedProject({ projectRoot });
  const node = inspectRehearsalNodeRuntime();
  let configPath;
  try {
    configPath = await findRehearsalConfigPath(planOptions);
  } catch (error) {
    if (
      !String(error?.message ?? error).startsWith("No Rehearsal configuration")
    ) {
      throw error;
    }
  }
  if (!configPath) {
    return {
      detected,
      node,
      config: "missing",
      baseline: false,
      runtime: false,
    };
  }
  let loaded;
  try {
    loaded = await loadRehearsalConfig(planOptions);
  } catch (error) {
    return {
      detected,
      node,
      config: "invalid",
      configPath,
      configError: redactDiagnosticValue(String(error?.message ?? error)),
      baseline: false,
      runtime: false,
    };
  }
  let migrationSummary;
  try {
    migrationSummary = candidateSummary(
      await inspectRehearsalMigrations(planOptions),
    );
  } catch {
    // Doctor owns the detailed, safely redacted explanation for an invalid or
    // absent baseline. The home screen only needs enough state to guide users.
  }
  let policy = "missing";
  if (await pathExists(loaded.paths.sanitizationPolicy)) {
    try {
      validateRuntimeSanitizationPolicy(
        JSON.parse(await readFile(loaded.paths.sanitizationPolicy, "utf8")),
      );
      policy = "reviewed";
    } catch {
      policy = "needs-review";
    }
  }
  return {
    detected,
    node,
    config: "valid",
    configPath,
    baseline: Boolean(migrationSummary),
    policy,
    policyPath: relative(projectRoot, loaded.paths.sanitizationPolicy),
    policyAbsolutePath: loaded.paths.sanitizationPolicy,
    migrationSummary,
    runtime: await pathExists(
      join(loaded.paths.runtimeWorkdir, "baseline.json"),
    ),
  };
};

const reviewPolicyInteractively = async ({ state, flags }) => {
  const { source, draft } = await readReviewablePolicyDraft(
    state.policyAbsolutePath,
  );
  const totalColumns = draft.tables.reduce(
    (total, table) => total + (table.columns?.length ?? 0),
    0,
  );
  const tableSummaries = [];
  let individuallyReviewed = 0;
  if (useStyledPrompts(flags)) {
    prompts.note(
      [
        `${formatCount(totalColumns, "column")} across ${formatCount(draft.tables.length, "table")} require explicit review.`,
        "No row values are displayed or changed by this step.",
        "Safe defaults replace values, mark generated NEVER and identity NO, and set no foreign key.",
        "Likely structural columns start selected for individual review.",
      ].join("\n"),
      "Review the script",
    );
  }
  const reviewColumn = async ({ table, column }) => {
    individuallyReviewed += 1;
    const label = `${table}.${column}`;
    const action = await promptForSelection({
      message: `${label}: how should this value be handled?`,
      flags,
      options: [
        {
          label: "Replace with synthetic data",
          hint: "Safest default",
          value: "REPLACE WITH SYNTHETIC",
        },
        {
          label: "Pseudonymize consistently",
          hint: "Stable links without original values",
          value: "PSEUDONYMIZE",
        },
        {
          label: "Derive a safe value",
          value: "DERIVE",
        },
        { label: "Exclude this field", value: "EXCLUDE" },
        {
          label: "Keep exactly",
          hint: "Only for values explicitly safe to retain",
          value: "KEEP EXACTLY",
        },
      ],
    });
    if (!action) throw new Error("Policy review was cancelled.");
    const generated = await promptForSelection({
      message: `${label}: is this column always database-generated?`,
      flags,
      options: [
        { label: "No", value: "NEVER" },
        { label: "Yes", value: "ALWAYS" },
      ],
    });
    if (!generated) throw new Error("Policy review was cancelled.");
    const identity = await promptForSelection({
      message: `${label}: is this an identity column?`,
      flags,
      options: [
        { label: "No", value: "NO" },
        { label: "Yes", value: "YES" },
      ],
    });
    if (!identity) throw new Error("Policy review was cancelled.");
    const hasForeignKey = await promptForConfirmation(
      `${label}: does this column reference another table?`,
      flags,
      { cancelValue: null },
    );
    if (hasForeignKey === null) {
      throw new Error("Policy review was cancelled.");
    }
    let foreignKey = null;
    if (hasForeignKey) {
      const schema = await promptForPath({
        message: `${label}: referenced schema`,
        defaultValue: "public",
        flags,
        validate: (value) =>
          /^[a-z][a-z0-9_]{0,62}$/u.test(value)
            ? undefined
            : "Use a lowercase PostgreSQL identifier.",
      });
      const referencedTable = await promptForPath({
        message: `${label}: referenced table`,
        flags,
        validate: (value) =>
          /^[a-z][a-z0-9_]{0,62}$/u.test(value)
            ? undefined
            : "Use a lowercase PostgreSQL identifier.",
      });
      const referencedColumn = await promptForPath({
        message: `${label}: referenced column`,
        flags,
        validate: (value) =>
          /^[a-z][a-z0-9_]{0,62}$/u.test(value)
            ? undefined
            : "Use a lowercase PostgreSQL identifier.",
      });
      if (!schema || !referencedTable || !referencedColumn) {
        throw new Error("Policy review was cancelled.");
      }
      foreignKey = {
        schema,
        table: referencedTable,
        column: referencedColumn,
      };
    }
    return { action, generated, identity, foreignKey };
  };
  const policy = await completePolicyDraft({
    draft,
    reviewColumn,
    reviewTable: async ({ table, columns }) => {
      if (columns.length === 1) {
        tableSummaries.push({ table, defaulted: 0, individual: 1 });
        return {};
      }
      const mode = await promptForSelection({
        message: `${table}: how would you like to review ${formatCount(columns.length, "column")}?`,
        flags,
        options: [
          {
            label: "Use safe defaults, then review exceptions",
            hint: "Best for larger tables",
            value: "preset",
          },
          {
            label: "Review every column individually",
            value: "individual",
          },
        ],
      });
      if (!mode) throw new Error("Policy review was cancelled.");
      if (mode === "individual") {
        tableSummaries.push({
          table,
          defaulted: 0,
          individual: columns.length,
        });
        return {};
      }
      const suggested = suggestPolicyExceptionColumns(columns);
      const exceptions = await promptForMultipleChoice({
        message: `${table}: select columns that need individual review`,
        flags,
        options: columns.map((column) => ({ label: column, value: column })),
        initialValues: suggested,
      });
      if (!exceptions) throw new Error("Policy review was cancelled.");
      const tableDecisions = createSafeTablePreset(columns);
      for (const column of exceptions) delete tableDecisions[column];
      tableSummaries.push({
        table,
        defaulted: columns.length - exceptions.length,
        individual: exceptions.length,
      });
      if (useStyledPrompts(flags)) {
        prompts.log.info(
          `${table}: ${formatCount(columns.length - exceptions.length, "safe default")}; ${formatCount(exceptions.length, "exception")}.`,
        );
      }
      return tableDecisions;
    },
  });
  const defaultedColumns = totalColumns - individuallyReviewed;
  const summaryLines = tableSummaries.map(
    (summary) =>
      `${summary.table}: ${formatCount(summary.defaulted, "safe default")}; ${formatCount(summary.individual, "individual review")}`,
  );
  if (useStyledPrompts(flags)) {
    prompts.note(summaryLines.join("\n"), "Review summary");
  } else {
    console.log(["", "Review summary", ...summaryLines, ""].join("\n"));
  }
  const accepted = await promptForConfirmation(
    `Save ${formatCount(totalColumns, "classified column")} and activate this policy?`,
    flags,
  );
  if (!accepted) return false;
  await applyReviewedPolicy({
    path: state.policyAbsolutePath,
    originalSource: source,
    policy,
  });
  const result = `${formatCount(totalColumns, "column")} classified (${formatCount(defaultedColumns, "safe default")}; ${formatCount(individuallyReviewed, "individual review")}).`;
  if (useStyledPrompts(flags)) {
    prompts.log.success(`${result} The policy is ready for baseline creation.`);
  } else {
    console.log(`Reviewed policy saved: ${result}`);
  }
  return true;
};

const runGuidedHome = async ({ flags, planOptions }) => {
  const state = await inspectGuidedProject(planOptions);
  const marker = (complete) =>
    complete ? terminalStyle(flags, "32", "✓") : terminalStyle(flags, "2", "○");
  const options = [];

  if (!state.node.supported) {
    options.push({
      label: "Show Node.js 24 setup instructions",
      hint: "Required before Rehearsal can change this project",
      command: "node-help",
    });
  } else if (state.config === "missing") {
    options.push({
      label: "Set the stage",
      hint: "Create safe local configuration",
      command: "setup-write",
    });
  } else if (state.baseline) {
    options.push(
      { label: "Run a rehearsal", command: "run" },
      { label: "Review the migration plan", command: "explain" },
      { label: "Show candidate migrations", command: "candidates" },
      { label: "Check readiness", command: "doctor" },
    );
  } else if (state.node.supported && state.config === "valid") {
    if (state.policy === "missing") {
      options.push({
        label: "Prepare the script",
        hint: "Create a reviewable policy draft",
        command: "baseline-prepare",
      });
    } else if (state.policy === "needs-review") {
      options.push({
        label: "Review the script",
        hint: "Apply table presets and review exceptions",
        command: "policy-review",
      });
    } else {
      options.push({
        label: "Create the baseline",
        hint: "Activate reviewed local inputs",
        command: "baseline-guide",
      });
    }
    options.push({ label: "Check readiness", command: "doctor" });
  } else {
    options.push({ label: "Check readiness", command: "doctor" });
  }
  if (state.node.supported && state.runtime) {
    options.push({
      label: "Manage the local runtime",
      hint: "Status, verification, and cleanup",
      command: "manage-runtime",
    });
  }
  if (lastGuidedDetails) {
    options.push({
      label: "Show details from the last action",
      command: "last-details",
    });
  }
  options.push(
    { label: "Show all commands", command: "help" },
    { label: "Exit", command: "exit" },
  );

  const statusLines = [
    `${marker(state.node.supported)} Node.js ${state.node.version}${state.node.supported ? "" : " (Node.js 24 required)"}`,
    `${marker(state.detected.hasSupabaseConfig)} Supabase project detected`,
    `${marker(state.detected.hasMigrations)} Migration history detected`,
    `${marker(state.config === "valid")} Rehearsal configuration${state.config === "invalid" ? " needs attention" : ""}`,
    ...(state.config === "valid"
      ? [
          `${marker(state.policy === "reviewed")} ${state.policy === "needs-review" ? "Baseline policy needs review" : state.policy === "reviewed" ? "Baseline policy reviewed" : "Baseline policy needed"}`,
        ]
      : []),
    `${marker(state.baseline)} Verified baseline`,
    ...(state.runtime ? [`${marker(true)} Disposable runtime created`] : []),
    ...(state.configError
      ? ["", terminalStyle(flags, "33", `! ${state.configError}`)]
      : []),
  ];
  const stage =
    state.config !== "valid"
      ? 1
      : state.policy !== "reviewed"
        ? 2
        : !state.baseline
          ? 3
          : 4;
  if (useStyledPrompts(flags)) {
    prompts.note(
      statusLines.join("\n"),
      `${state.detected.projectName} · Stage ${stage} of 4`,
    );
  } else {
    console.log(
      [
        "",
        terminalStyle(flags, "1;36", "REHEARSAL"),
        "Safe local migration testing",
        "",
        terminalStyle(flags, "1", state.detected.projectName),
        `Stage ${stage} of 4`,
        ...statusLines,
        "",
        "What would you like to do?",
        "",
        ...options.map(
          (option, index) =>
            `  ${index === 0 ? terminalStyle(flags, "36", "›") : " "} ${index + 1}. ${option.label}`,
        ),
        "",
      ].join("\n"),
    );
  }

  const selected = await promptForChoice({
    message: "What would you like to do?",
    options,
    flags,
  });
  if (selected.command === "exit") {
    return null;
  }
  if (selected.command === "node-help") {
    console.log(
      [
        "",
        terminalStyle(flags, "1", "NODE.JS 24 REQUIRED"),
        `This shell is using Node.js ${state.node.version}. Rehearsal has not changed your project.`,
        "",
        "With nvm:",
        "  nvm install 24",
        "  nvm use 24",
        "",
        "Then reinstall Rehearsal in your scratch project and run npx rehearsal again.",
      ].join("\n"),
    );
    return "refresh";
  }
  if (selected.command === "policy-review") {
    try {
      await reviewPolicyInteractively({ state, flags });
    } catch (error) {
      if (String(error?.message ?? error) !== "Policy review was cancelled.") {
        throw error;
      }
      if (useStyledPrompts(flags)) {
        prompts.cancel("Policy review cancelled; the draft was not changed.");
      } else {
        console.log("Policy review cancelled; the draft was not changed.");
      }
    }
    return "refresh";
  }
  if (selected.command === "last-details") {
    if (useStyledPrompts(flags)) {
      prompts.note(lastGuidedDetails, "Technical details");
    } else {
      console.log(`\nTECHNICAL DETAILS\n${lastGuidedDetails}`);
    }
    return "refresh";
  }
  if (selected.command === "manage-runtime") {
    const runtimeAction = await promptForChoice({
      message: "Manage the disposable local runtime",
      flags,
      options: [
        { label: "Show status", command: "status" },
        { label: "Verify runtime", command: "verify" },
        { label: "Reset to the immutable baseline", command: "reset" },
        { label: "Stop runtime", command: "stop" },
        { label: "Discard runtime", command: "discard" },
        { label: "Back", command: "exit" },
      ],
    });
    if (!runtimeAction || runtimeAction.command === "exit") return "refresh";
    if (["reset", "discard"].includes(runtimeAction.command)) {
      const accepted = await promptForConfirmation(
        runtimeAction.command === "reset"
          ? "Reset the disposable runtime and remove its current changes?"
          : "Discard the disposable runtime? The immutable baseline will remain.",
        flags,
      );
      if (!accepted) return "refresh";
    }
    return runtimeAction.command;
  }
  if (["baseline-guide", "baseline-prepare"].includes(selected.command)) {
    console.log(
      [
        "",
        terminalStyle(flags, "1", "CREATE A SAFE BASELINE"),
        "Rehearsal only reads the local files you name here.",
        "It does not extract data or contact a hosted Supabase project.",
        "",
      ].join("\n"),
    );
    const discovered = await discoverBaselineInputFiles({ projectRoot });
    const detectedLines = [
      discovered.records.length
        ? `Records: ${discovered.records.join(", ")}`
        : "Records: none detected",
      discovered.ledgers.length
        ? `Migration ledgers: ${discovered.ledgers.join(", ")}`
        : "Migration ledgers: none detected",
      discovered.assetManifests.length
        ? `Storage manifests: ${discovered.assetManifests.join(", ")}`
        : "Storage manifests: none detected",
      "Only paths and file structure were inspected; row values stay hidden.",
    ];
    if (useStyledPrompts(flags)) {
      prompts.note(detectedLines.join("\n"), "Detected safe local inputs");
    } else {
      console.log(
        ["Detected safe local inputs", ...detectedLines, ""].join("\n"),
      );
    }
    flags.recordsPath = await promptForDiscoveredPath({
      message: "Sanitized NDJSON records",
      candidates: discovered.records,
      flags,
    });
    flags.ledgerPath = await promptForDiscoveredPath({
      message: "Migration ledger",
      candidates: discovered.ledgers,
      flags,
    });
    try {
      if (selected.command === "baseline-prepare") {
        const preparationPlan = await planBaselinePreparation({
          ...planOptions,
          recordsPath: flags.recordsPath,
          ledgerPath: flags.ledgerPath,
        });
        const preview = {
          ...summarizeBaselinePreparation(preparationPlan, {
            mode: "preview",
          }),
          nextAction:
            "Review this schema-only summary. No file is written unless you approve below.",
        };
        console.log(`\n${renderBaselinePreparation(preview, flags)}\n`);
        const accepted = await promptForConfirmation(
          `Create the REVIEW REQUIRED draft at ${preview.destination}?`,
          flags,
        );
        if (!accepted) {
          console.log("No changes made.");
          return "refresh";
        }
        flags.preparationPlan = preparationPlan;
        flags.write = true;
        return "baseline prepare";
      }
      flags.assetsPath = await promptForDiscoveredPath({
        message: "Storage assets",
        candidates: discovered.assetManifests,
        optional: true,
        flags,
      });
      const inspection = await inspectBaselineInputFiles({
        ...planOptions,
        recordsPath: flags.recordsPath,
        ledgerPath: flags.ledgerPath,
        assetsPath: flags.assetsPath,
      });
      console.log(`\n${renderBaselineInputInspection(inspection, flags)}\n`);
      const accepted = await promptForConfirmation(
        "Create and activate this immutable local baseline?",
        flags,
      );
      if (!accepted) {
        console.log("No changes made.");
        return "refresh";
      }
      return "baseline create";
    } catch (error) {
      const message = redactDiagnosticValue(String(error?.message ?? error));
      if (useStyledPrompts(flags)) {
        prompts.cancel("These baseline inputs need attention.");
        prompts.note(message, "How to continue");
      } else {
        console.log(`\nBASELINE INPUTS NEED ATTENTION\n${message}\n`);
      }
      return "refresh";
    }
  }
  if (selected.command !== "setup-write") return selected.command;

  const setupPlan = await planRehearsalSetup({ projectRoot });
  const preview = {
    ...summarizeRehearsalSetup(setupPlan, { mode: "preview" }),
    nextAction:
      "Review this plan. No files are written unless you approve below.",
  };
  console.log(`\n${renderSetup(preview)}\n`);
  const accepted = await promptForConfirmation(
    "Create these project-local files?",
    flags,
  );
  if (!accepted) {
    console.log("No changes made.");
    return "refresh";
  }
  flags.setupPlan = setupPlan;
  flags.write = true;
  return "setup";
};

const prepareCandidateConfirmation = async ({
  command,
  flags,
  planOptions,
}) => {
  if (!["run", "migrate"].includes(command) || flags.dryRun) {
    return true;
  }
  const summary = candidateSummary(
    await inspectRehearsalMigrations(planOptions),
  );
  if (summary.candidateCount === 0) return true;
  if (flags.confirmation === summary.candidateSha256) return true;
  const interactive =
    !flags.json && process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive || flags.confirmation) {
    throw new RehearsalError({
      category: "migration_candidate_failure",
      code: "CANDIDATE_CONFIRMATION_REQUIRED",
      message: flags.confirmation
        ? "The candidate migration confirmation does not match the current candidate set."
        : "Candidate migration confirmation is required in noninteractive use.",
      expected: summary.candidateSha256,
      actual: flags.confirmation ?? "missing",
      context: {
        command,
        candidateCount: summary.candidateCount,
        candidates: summary.candidates.map((migration) => migration.filename),
      },
      refused:
        "Rehearsal did not reset, start, or modify the disposable runtime.",
      suggestions: [
        "Run rehearsal candidates, review every file, then pass the current digest with --confirm-candidates=.",
      ],
    });
  }
  console.log(
    [
      "",
      terminalStyle(
        flags,
        "1",
        `${summary.candidateCount} candidate migration${summary.candidateCount === 1 ? "" : "s"}`,
      ),
      "",
      ...summary.candidates.map((migration) => `  → ${migration.filename}`),
      "",
      `Candidate set: ${summary.candidateSha256.slice(0, 12)}`,
      "",
      "Rehearsal will apply only this exact set to the disposable local runtime.",
    ].join("\n"),
  );
  const accepted = await promptForConfirmation(
    `Apply exactly ${summary.candidateCount === 1 ? "this migration" : "these migrations"}?`,
    flags,
  );
  if (!accepted) {
    console.log("No changes made.");
    return false;
  }
  // The manager independently recomputes this digest. A file changed after this
  // review is therefore rejected before candidate SQL is applied.
  flags.confirmation = summary.candidateSha256;
  return true;
};

const emit = ({ command, data, flags, render, status = "success" }) => {
  const result = createRehearsalResult({
    command,
    status,
    data,
    startedAt: commandStartedAt,
    durationMs: Math.round((performance.now() - commandStartedMs) * 100) / 100,
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(render(data, flags.verbosity));
};

const runManager = ({ action, flags }) => {
  const args = [managerPath, action];
  if (flags.confirmation) {
    args.push(`--confirm-candidates=${flags.confirmation}`);
  }
  const environment = Object.fromEntries(
    [
      "CI",
      "COLORTERM",
      "FORCE_COLOR",
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  const runtimeStartedMs = performance.now();
  const actionDescription = {
    run: "Restoring the baseline and applying reviewed migrations",
    start: "Starting the disposable local runtime",
    migrate: "Applying reviewed migrations to the current runtime",
    reset: "Restoring the immutable baseline",
    status: "Inspecting the disposable local runtime",
    stop: "Stopping the disposable local runtime",
    discard: "Removing the disposable local runtime",
    verify: "Verifying the current local runtime",
  }[action];
  const spinner = useStyledPrompts(flags) ? prompts.spinner() : null;
  if (spinner) {
    spinner.start(`${actionDescription}. This can take a moment.`);
  } else if (isHumanTerminal(flags)) {
    console.log(
      `\n${terminalStyle(flags, "1;36", action === "run" ? "REHEARSING" : "REHEARSAL")}\n${terminalStyle(flags, "36", "→")} ${actionDescription}. This can take a moment.`,
    );
  }
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (spinner) spinner.stop(`${actionDescription} did not complete.`);
    throw result.error;
  }
  if (result.status !== 0) {
    if (spinner) spinner.stop(`${actionDescription} did not complete.`);
    const completeOutput = [
      String(result.stdout ?? ""),
      String(result.stderr ?? ""),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
    const inferred = normalizeRehearsalError(
      new Error(completeOutput || `Rehearsal ${action} failed.`),
    );
    const conciseOutput = completeOutput
      .replaceAll(String.fromCodePoint(27), "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join("\n")
      .slice(-2_000);
    throw new RehearsalError({
      category: inferred.category,
      code: `MANAGER_${action.toUpperCase()}_FAILED`,
      message: `The local Rehearsal ${action} operation did not complete.`,
      expected: "the isolated runtime operation to finish and verify",
      actual: conciseOutput || `exit ${result.status}`,
      context: { action },
      refused: "The runtime was not reported as trusted.",
      suggestions: [
        "Review the concise failure above, then rerun rehearsal doctor before retrying.",
        "Use --debug only when the safe diagnostic detail is needed.",
      ],
      cause: new Error(completeOutput || `exit ${result.status}`),
    });
  }
  const durationMs = performance.now() - runtimeStartedMs;
  if (spinner) {
    spinner.stop(
      `${actionDescription} completed in ${formatDuration(durationMs)}.`,
    );
  } else if (isHumanTerminal(flags)) {
    console.log(
      `${terminalStyle(flags, "32", "✓")} Local runtime step completed in ${formatDuration(durationMs)}.`,
    );
  }
  return {
    action,
    durationMs: Math.round(durationMs * 100) / 100,
    output: redactDiagnosticValue(String(result.stdout ?? "").trim()),
  };
};

const parseCommand = (source) => {
  const values = [];
  let current = "";
  let quote = null;
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) {
      if (current) values.push(current);
      current = "";
    } else current += character;
  }
  if (quote)
    throw new Error("Application proof command contains an unmatched quote.");
  if (current) values.push(current);
  if (values.length === 0)
    throw new Error("Application proof command is empty.");
  return values;
};

const runApplicationProof = async (planOptions) => {
  const { config, projectRoot: configuredRoot } =
    await loadRehearsalConfig(planOptions);
  const [command, ...args] = parseCommand(config.application.proofCommand);
  const environment = Object.fromEntries(
    [
      "CI",
      "COLORTERM",
      "FORCE_COLOR",
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  const result = spawnSync(command, args, {
    cwd: configuredRoot,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new RehearsalError({
      category: "application_proof_failure",
      code: "APPLICATION_PROOF_FAILED",
      message: "The configured application proof did not pass.",
      expected: `${config.application.proofCommand} exits successfully`,
      actual: result.error?.message ?? result.stderr ?? `exit ${result.status}`,
      context: { project: config.project.name },
      refused:
        "Rehearsal did not report the migrated runtime as fully verified.",
      suggestions: [
        "Run the proof command directly in the same project and correct the failure.",
      ],
      cause: result.error,
    });
  }
  return {
    command: config.application.proofCommand,
    output: redactDiagnosticValue(String(result.stdout ?? "").trim()),
  };
};

const runInit = async ({ flags }) => {
  const detected = await inspectDetectedProject({ projectRoot });
  const source = renderDetectedConfig(detected);
  const destination = join(projectRoot, "rehearsal.config.mjs");
  let existingPath = null;
  try {
    existingPath = await findRehearsalConfigPath({ projectRoot });
  } catch (error) {
    if (
      !String(error?.message ?? error).startsWith("No Rehearsal configuration")
    ) {
      throw error;
    }
  }
  if (existingPath) {
    if (flags.write) {
      throw new Error(
        `A Rehearsal configuration already exists at ${relative(projectRoot, existingPath)}; Rehearsal will not overwrite it.`,
      );
    }
    return {
      mode: "existing",
      destination: relative(projectRoot, existingPath),
      detected,
      source: "",
      nextAction:
        "Review the existing configuration, then run rehearsal doctor.",
    };
  }
  if (flags.write)
    await writeFile(destination, source, { flag: "wx", mode: 0o600 });
  return {
    mode: flags.write ? "written" : "preview",
    destination: relative(projectRoot, destination),
    detected,
    source,
    nextAction: flags.write
      ? "Review the generated safety settings and run rehearsal doctor."
      : "Review this preview, then rerun rehearsal init --write to create it.",
  };
};

const renderInit = (result) =>
  [
    `REHEARSAL INIT — ${result.mode.toUpperCase()}`,
    `Destination: ${result.destination}`,
    `Detected package manager: ${result.detected.packageManager}`,
    `Detected Supabase config: ${result.detected.hasSupabaseConfig ? "yes" : "no"}`,
    `Detected migrations: ${result.detected.hasMigrations ? "yes" : "no"}`,
    ...(result.source ? ["", result.source] : []),
    result.nextAction,
  ].join("\n");

const runSetup = async ({ flags, planOptions }) => {
  const plan = flags.setupPlan ?? (await planRehearsalSetup({ projectRoot }));
  if (flags.write) await applyRehearsalSetup(plan);
  const result = summarizeRehearsalSetup(plan, {
    mode: flags.write ? "written" : "preview",
  });
  if (!flags.write) return result;
  const readiness = await runRehearsalDoctor(planOptions);
  const needsBaselinePolicy = readiness.checks.some(
    (check) => check.id === "sanitization-policy" && check.status === "fail",
  );
  return {
    ...result,
    readiness,
    nextAction:
      readiness.state === "READY"
        ? "Next: run rehearsal explain to review the migration plan."
        : needsBaselinePolicy
          ? flags.guided
            ? "Next: choose Prepare the script to create a reviewable policy draft."
            : "Next: run rehearsal again and choose Prepare a reviewable baseline policy draft."
          : "Next: complete the remaining readiness items shown above.",
  };
};

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

const renderSetup = (result) => {
  const actionMarker = { create: "+", update: "~", unchanged: "=" };
  return [
    `REHEARSAL SETUP — ${result.mode.toUpperCase()}`,
    `Project: ${result.project}`,
    `Runtime ID: ${result.projectId}`,
    `Application: ${result.applicationUrl}`,
    `Ports: API ${result.ports.api}, database ${result.ports.database}, Studio ${result.ports.studio}`,
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

const runBaselinePreparation = async ({ flags, planOptions }) => {
  const plan =
    flags.preparationPlan ??
    (await planBaselinePreparation({
      ...planOptions,
      recordsPath: flags.recordsPath,
      ledgerPath: flags.ledgerPath,
    }));
  if (flags.write) await applyBaselinePreparation(plan);
  const result = summarizeBaselinePreparation(plan, {
    mode: flags.write ? "written" : "preview",
  });
  return flags.guided && flags.write
    ? {
        ...result,
        nextAction:
          "Next: choose Review the script to classify every column interactively.",
      }
    : result;
};

const renderBaselinePreparation = (result, flags = {}) =>
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

const renderBaselineInputInspection = (result, flags = {}) =>
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

const usage = () => `Usage: rehearsal <command> [options]

Commands:
  guide                       Open the interactive, state-aware home screen
  setup [--write]             Preview or create safe first-run scaffolding
  init [--write]              Preview or explicitly write safe starter config
  baseline prepare --records= --ledger= [--write] Create a fail-closed policy draft
  baseline create --records= --ledger= [--assets=] Create a baseline from safe local inputs
  doctor                     Check whether Rehearsal is safe and ready
  explain                    Show the immutable execution plan
  run --dry-run              Alias the exact explain plan without mutations
  run --confirm-candidates=  Execute reset, migration, and verification locally
  candidates                 Show the exact pending migration digest
  inspect baseline           Show verified baseline provenance
  inspect migrations         Classify represented, applied, and candidate migrations
  start                      Start an existing verified local runtime
  migrate --confirm-candidates= Apply the exact candidate suffix without resetting
  reset                      Restore and verify the immutable local baseline
  status                     Report the disposable local runtime state
  stop                       Stop only this project's local runtime
  discard                    Remove only this project's disposable runtime
  verify                     Verify the current local Rehearsal runtime

Options: --json --verbose --debug --plain --config=<path>`;

const executeCommand = async ({ command, flags, planOptions, guided }) => {
  if (command === "help" || flags.help) {
    console.log(usage());
    return;
  }
  if (command === "setup") {
    const data = await runSetup({ flags, planOptions });
    emit({ command, data, flags, render: renderSetup });
    return;
  }
  if (command === "init") {
    const data = await runInit({ flags });
    emit({ command, data, flags, render: renderInit });
    return;
  }
  if (command === "baseline prepare") {
    const data = await runBaselinePreparation({ flags, planOptions });
    emit({
      command,
      data,
      flags,
      render: (result) => renderBaselinePreparation(result, flags),
    });
    return;
  }
  if (command === "baseline create") {
    await inspectBaselineInputFiles({
      ...planOptions,
      recordsPath: flags.recordsPath,
      ledgerPath: flags.ledgerPath,
      assetsPath: flags.assetsPath,
    });
    const data = await createSyntheticBaselineFromFiles({
      ...planOptions,
      recordsPath: flags.recordsPath,
      ledgerPath: flags.ledgerPath,
      assetsPath: flags.assetsPath,
    });
    emit({
      command,
      data,
      flags,
      render: (baseline) =>
        [
          `Activated synthetic baseline ${baseline.generationId}: ${formatCount(baseline.rowCount, "row")} across ${formatCount(baseline.tableCount, "table")}; ${formatCount(baseline.migrationCount, "migration")} through ${baseline.migrationCutoff}.`,
          "",
          flags.guided
            ? "Next: choose Run a rehearsal when you are ready."
            : "Next: run rehearsal doctor to check readiness.",
        ].join("\n"),
    });
    return;
  }
  if (command === "doctor") {
    const data = await runRehearsalDoctor(planOptions);
    emit({
      command,
      data,
      flags,
      render: renderDoctor,
      status: data.state === "READY" ? "success" : "not_ready",
    });
    if (data.state !== "READY" && !guided) process.exitCode = 1;
    return;
  }
  if (command === "explain" || (command === "run" && flags.dryRun)) {
    const data = await buildRehearsalPlan(planOptions);
    emit({ command, data, flags, render: renderPlan });
    return;
  }
  if (command === "inspect baseline") {
    const data = await inspectRehearsalBaseline(planOptions);
    emit({ command, data, flags, render: renderBaseline });
    return;
  }
  if (command === "inspect migrations") {
    const data = await inspectRehearsalMigrations(planOptions);
    emit({ command, data, flags, render: renderMigrations });
    return;
  }
  if (command === "candidates") {
    const data = candidateSummary(
      await inspectRehearsalMigrations(planOptions),
    );
    emit({ command, data, flags, render: renderCandidates });
    return;
  }
  if (
    [
      "run",
      "start",
      "migrate",
      "reset",
      "status",
      "stop",
      "discard",
      "verify",
    ].includes(command)
  ) {
    if (flags.dryRun && command !== "run") {
      throw new Error("--dry-run is supported only by rehearsal run.");
    }
    if (
      !(await prepareCandidateConfirmation({ command, flags, planOptions }))
    ) {
      return;
    }
    const runtime = runManager({ action: command, flags });
    let applicationProof;
    if (command === "run") {
      const proofSpinner = useStyledPrompts(flags) ? prompts.spinner() : null;
      if (proofSpinner) {
        proofSpinner.start("Running the project-owned application proof.");
      } else if (isHumanTerminal(flags)) {
        console.log(
          `${terminalStyle(flags, "36", "→")} Running the project-owned application proof.`,
        );
      }
      try {
        applicationProof = await runApplicationProof(planOptions);
      } catch (error) {
        if (proofSpinner) proofSpinner.stop("Application proof failed.");
        throw error;
      }
      if (proofSpinner) {
        proofSpinner.stop("Application proof passed.");
      } else if (isHumanTerminal(flags)) {
        console.log(
          `${terminalStyle(flags, "32", "✓")} Application proof passed.`,
        );
      }
    }
    const data = command === "run" ? { runtime, applicationProof } : runtime;
    if (guided) {
      lastGuidedDetails = [runtime.output, applicationProof?.output]
        .filter(Boolean)
        .join("\n");
    }
    emit({
      command,
      data,
      flags,
      render: (value) => {
        const runtimeResult = value.runtime ?? value;
        const nextAction = {
          run: "Next: exercise the local application, then run rehearsal verify.",
          start:
            "Next: exercise the local application or run rehearsal status.",
          migrate: "Next: run rehearsal verify to prove the current runtime.",
          reset: "Next: run rehearsal verify or continue testing locally.",
          status: "Next: run rehearsal verify, reset, stop, or discard.",
          stop: "Next: run rehearsal start when you want to resume.",
          discard:
            "The disposable runtime was removed; the immutable baseline remains.",
          verify:
            "Next: continue testing, reset to the baseline, or stop the runtime.",
        }[runtimeResult.action];
        if (guided) {
          const title =
            runtimeResult.action === "run"
              ? "REHEARSAL PASSED"
              : "ACTION COMPLETE";
          return [
            title,
            `✓ ${runtimeResult.action} completed in ${formatDuration(runtimeResult.durationMs)}`,
            value.applicationProof
              ? `✓ Application proof passed: ${value.applicationProof.command}`
              : null,
            "",
            "Technical output is available from Show details in the guide.",
          ]
            .filter(Boolean)
            .join("\n");
        }
        return [
          runtimeResult.output ||
            `Rehearsal ${runtimeResult.action} completed.`,
          value.applicationProof
            ? `Application proof passed: ${value.applicationProof.command}`
            : null,
          nextAction ? "" : null,
          nextAction,
        ]
          .filter((entry) => entry !== null)
          .join("\n");
      },
    });
    return;
  }
  throw new Error(`Unknown Rehearsal command: ${command}.\n\n${usage()}`);
};

const resetGuidedFlags = (flags) => {
  flags.dryRun = false;
  flags.write = false;
  flags.confirmation = undefined;
  flags.recordsPath = undefined;
  flags.ledgerPath = undefined;
  flags.assetsPath = undefined;
  flags.setupPlan = undefined;
  flags.preparationPlan = undefined;
};

const main = async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2));
  const command = positionals.join(" ") || "help";
  const planOptions = {
    projectRoot,
    configPath: flags.configPath,
  };
  const wantsAutomaticGuide =
    positionals.length === 0 &&
    !flags.help &&
    !flags.json &&
    process.stdin.isTTY &&
    process.stdout.isTTY;
  const guided = command === "guide" || wantsAutomaticGuide;
  if (!guided) {
    await executeCommand({ command, flags, planOptions, guided: false });
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "The guided home screen requires an interactive terminal. Run rehearsal --help to list scriptable commands.",
    );
  }
  flags.guided = true;
  if (useStyledPrompts(flags)) {
    prompts.intro("REHEARSAL · Safe local migration testing");
  }
  while (true) {
    resetGuidedFlags(flags);
    const selected = await runGuidedHome({ flags, planOptions });
    if (!selected) break;
    if (selected === "refresh") continue;
    await executeCommand({
      command: selected,
      flags,
      planOptions,
      guided: true,
    });
  }
  if (useStyledPrompts(flags)) {
    prompts.outro("See you at the next rehearsal.");
  } else {
    console.log("See you at the next rehearsal.");
  }
};

try {
  await main();
} catch (error) {
  const failure = normalizeRehearsalError(error, {
    expected: "a safe, versioned, local-only Rehearsal operation",
    actual: String(error?.message ?? error),
    refused: "No further Rehearsal action was performed.",
    suggestions: ["Run rehearsal doctor for actionable readiness checks."],
  });
  const wantsJson = process.argv.includes("--json");
  const debug = process.argv.includes("--debug");
  if (wantsJson)
    console.log(
      JSON.stringify(serializeRehearsalError(failure, { debug }), null, 2),
    );
  else console.error(renderHumanError(failure, { debug }));
  process.exitCode = failure.exitCode;
}
