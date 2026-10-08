/**
 * State-aware interactive home screen and first-run flows.
 */

import { access, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as prompts from "@clack/prompts";
import {
  findRehearsalConfigPath,
  inspectDetectedProject,
  loadRehearsalConfig,
} from "../project/configuration.mjs";
import type {
  DetectedProject,
  RehearsalConfigPathOptions,
} from "../project/configuration.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import type { RuntimeTopologyTarget } from "../runtime/topology.mjs";
import type { RehearsalCleanupPlan } from "../runtime/cleanup.mjs";
import type { ChoiceOption } from "./terminal.mjs";
import { validateRuntimeSanitizationPolicy } from "../baseline/sanitization_policy.mjs";
import {
  inspectRehearsalNodeRuntime,
  planRehearsalSetup,
  summarizeRehearsalSetup,
} from "../project/setup.mjs";
import {
  inspectBaselineInputFiles,
  planBaselinePreparation,
  summarizeBaselinePreparation,
} from "../baseline/preparation.mjs";
import { discoverBaselineInputFiles } from "../baseline/input_discovery.mjs";
import {
  applyReviewedPolicy,
  completePolicyDraft,
  createSafeTablePreset,
  readReviewablePolicyDraft,
  suggestPolicyExceptionColumns,
} from "../baseline/policy_review.mjs";
import { formatCount } from "../shared/human_output.mjs";
import { redactDiagnosticValue } from "../shared/diagnostics.mjs";
import { REHEARSAL_NODE_LABEL } from "../shared/node_runtime.mjs";
import {
  renderBaselineInputInspection,
  renderBaselinePreparation,
  renderCleanup,
  renderRefreshWorkflow,
  renderSetup,
} from "./renderers.mjs";
import {
  promptForChoice,
  promptForConfirmation,
  promptForDiscoveredPath,
  promptForMultipleChoice,
  promptForPath,
  promptForSelection,
  terminalStyle,
  useStyledPrompts,
} from "./terminal.mjs";

type GuidedCommandOption = ChoiceOption & { readonly command: string };

interface TopologySummary {
  readonly topology: {
    readonly dependents: readonly unknown[];
    readonly targets: readonly RuntimeTopologyTarget[];
  };
}

interface GuidedState {
  readonly detected: DetectedProject;
  readonly node: ReturnType<typeof inspectRehearsalNodeRuntime>;
  readonly config: "missing" | "invalid" | "valid";
  readonly target?: "supabase" | "postgresql";
  readonly configPath?: string;
  readonly configError?: string;
  readonly baseline: boolean;
  readonly policy?: "missing" | "needs-review" | "reviewed";
  readonly policyPath?: string;
  readonly policyAbsolutePath?: string;
  readonly migrationSummary?: TopologySummary;
  readonly refreshConfigured?: boolean;
  readonly dependentCount?: number;
  readonly runtime: boolean;
}

type GuidedCleanupPlan =
  | RehearsalCleanupPlan
  | Readonly<{
      digest: string;
      targets: readonly Readonly<{
        name: string;
        plan: RehearsalCleanupPlan;
      }>[];
    }>;

interface GuidedRefreshPlan {
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const pathExists = (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    });

const inspectGuidedProject = async ({
  projectRoot,
  planOptions,
  topologyCandidateSummary,
}: {
  projectRoot: string;
  planOptions: RehearsalConfigPathOptions;
  topologyCandidateSummary: (
    options: RehearsalConfigPathOptions,
  ) => Promise<TopologySummary>;
}): Promise<GuidedState> => {
  const detected = await inspectDetectedProject({ projectRoot });
  const node = inspectRehearsalNodeRuntime();
  let configPath;
  try {
    configPath = await findRehearsalConfigPath(planOptions);
  } catch (error) {
    if (!errorMessage(error).startsWith("No Rehearsal configuration")) {
      throw error;
    }
  }
  if (!configPath) {
    return {
      detected,
      node,
      config: "missing",
      target: detected.hasSupabaseConfig ? "supabase" : "postgresql",
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
      configError: String(redactDiagnosticValue(errorMessage(error))),
      baseline: false,
      runtime: false,
    };
  }
  let migrationSummary;
  let topology;
  try {
    const summary = await topologyCandidateSummary(planOptions);
    migrationSummary = summary;
    topology = summary.topology;
  } catch {
    // The doctor command owns the detailed, safely redacted explanation.
  }
  let policy: GuidedState["policy"] = "missing";
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
    target: loaded.config.runtime.target,
    configPath,
    baseline: Boolean(migrationSummary),
    policy,
    policyPath: relative(projectRoot, loaded.paths.sanitizationPolicy),
    policyAbsolutePath: loaded.paths.sanitizationPolicy,
    ...(migrationSummary === undefined ? {} : { migrationSummary }),
    refreshConfigured: Boolean(loaded.config.preparation),
    dependentCount: topology?.dependents.length ?? 0,
    runtime: topology
      ? (
          await Promise.all(
            topology.targets.map((target) =>
              pathExists(join(target.paths.runtimeWorkdir, "baseline.json")),
            ),
          )
        ).every(Boolean)
      : await pathExists(join(loaded.paths.runtimeWorkdir, "baseline.json")),
  };
};

const reviewColumn = async ({
  table,
  column,
  flags,
}: {
  table: string;
  column: string;
  flags: RehearsalCliFlags;
}) => {
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
      { label: "Derive a safe value", value: "DERIVE" },
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
  if (hasForeignKey === null) throw new Error("Policy review was cancelled.");
  let foreignKey = null;
  if (hasForeignKey) {
    const identifier = (value: string): string | undefined =>
      /^[a-z][a-z0-9_]{0,62}$/u.test(value)
        ? undefined
        : "Use a lowercase PostgreSQL identifier.";
    const schema = await promptForPath({
      message: `${label}: referenced schema`,
      defaultValue: "public",
      flags,
      validate: identifier,
    });
    const referencedTable = await promptForPath({
      message: `${label}: referenced table`,
      flags,
      validate: identifier,
    });
    const referencedColumn = await promptForPath({
      message: `${label}: referenced column`,
      flags,
      validate: identifier,
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

const reviewPolicyInteractively = async ({
  state,
  flags,
}: {
  state: GuidedState;
  flags: RehearsalCliFlags;
}): Promise<boolean> => {
  if (!state.policyAbsolutePath) {
    throw new Error("The policy path is unavailable.");
  }
  const { source, draft } = await readReviewablePolicyDraft(
    state.policyAbsolutePath,
  );
  const totalColumns = draft.tables.reduce(
    (total, table) => total + (table.columns?.length ?? 0),
    0,
  );
  const tableSummaries: Array<{
    table: string;
    defaulted: number;
    individual: number;
  }> = [];
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
  const policy = await completePolicyDraft({
    draft,
    reviewColumn: async (column) => {
      individuallyReviewed += 1;
      return reviewColumn({ ...column, flags });
    },
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
          { label: "Review every column individually", value: "individual" },
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
      const exceptions = await promptForMultipleChoice({
        message: `${table}: select columns that need individual review`,
        flags,
        options: columns.map((column) => ({ label: column, value: column })),
        initialValues: suggestPolicyExceptionColumns(columns),
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

const guidedOptions = (
  state: GuidedState,
  hasLastDetails: boolean,
): GuidedCommandOption[] => {
  const options: GuidedCommandOption[] = [];
  if (!state.node.supported) {
    options.push({
      label: "Show supported Node.js versions",
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
      ...(state.refreshConfigured
        ? [
            {
              label: "Refresh the database copy",
              hint: "Replace safely, reset locally, then remove old copies",
              command: "refresh-guide",
            },
          ]
        : []),
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
      label: "Open the sandbox app",
      hint: "Keep it running for hands-on testing",
      command: "open",
    });
    options.push({
      label: "Manage the local runtime",
      hint: "Status, verification, and cleanup",
      command: "manage-runtime",
    });
  }
  if (state.node.supported && state.config === "valid") {
    options.push({
      label: "Clean up disk space",
      hint: "Preview old baselines, the runtime, and unused images",
      command: "cleanup-guide",
    });
  }
  if (hasLastDetails) {
    options.push({
      label: "Show details from the last action",
      command: "last-details",
    });
  }
  options.push(
    {
      label: "Get help",
      hint: "Create a safe, copy-ready support report",
      command: "support",
    },
    { label: "Show all commands", command: "help" },
    { label: "Exit", command: "exit" },
  );
  return options;
};

const showGuidedStatus = ({
  state,
  options,
  flags,
}: {
  state: GuidedState;
  options: readonly GuidedCommandOption[];
  flags: RehearsalCliFlags;
}): void => {
  const marker = (complete: boolean) =>
    complete ? terminalStyle(flags, "32", "✓") : terminalStyle(flags, "2", "○");
  const statusLines = [
    `${marker(state.node.supported)} Node.js ${state.node.version}${state.node.supported ? "" : ` (${REHEARSAL_NODE_LABEL} required)`}`,
    `${marker(state.target === "supabase" ? state.detected.hasSupabaseConfig : state.detected.hasPostgresqlMigrations)} ${state.target === "supabase" ? "Supabase" : "PostgreSQL"} project detected`,
    `${marker(state.target === "supabase" ? state.detected.hasMigrations : state.detected.hasPostgresqlMigrations)} Migration history detected`,
    `${marker(state.config === "valid")} Rehearsal configuration${state.config === "invalid" ? " needs attention" : ""}`,
    ...(state.dependentCount
      ? [
          `${marker(true)} ${formatCount(state.dependentCount, "dependent database")} included`,
        ]
      : []),
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
};

const guideCleanup = async ({
  flags,
  planOptions,
  planRuntimeStackCleanup,
}: {
  flags: RehearsalCliFlags;
  planOptions: RehearsalConfigPathOptions;
  planRuntimeStackCleanup: (input: {
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
  }) => Promise<GuidedCleanupPlan>;
}): Promise<string> => {
  const cleanupScope = await promptForChoice({
    message: "What may Rehearsal include in the cleanup preview?",
    flags,
    options: [
      {
        label: "Old baselines only",
        hint: "Keep the configured number of recent generations",
        command: "baselines",
      },
      {
        label: "Old baselines and this project's runtime",
        hint: "Also remove the disposable database and its volumes",
        command: "runtime",
      },
      {
        label: "Old baselines and older unused Supabase images",
        hint: "Images may be shared and can be downloaded again",
        command: "images",
      },
      { label: "Everything above", command: "all" },
      { label: "Back", command: "exit" },
    ],
  });
  if (!cleanupScope || cleanupScope.command === "exit") return "home";
  flags.includeRuntime = ["runtime", "all"].includes(cleanupScope.command);
  flags.includeImages = ["images", "all"].includes(cleanupScope.command);
  const cleanupPlan = await planRuntimeStackCleanup({ flags, planOptions });
  flags.cleanupPlan = cleanupPlan;
  console.log(`\n${renderCleanup({ mode: "preview", plan: cleanupPlan })}`);
  const selectedCount =
    "targets" in cleanupPlan
      ? cleanupPlan.targets.reduce(
          (total, target) =>
            total +
            target.plan.baselines.removed.length +
            (target.plan.runtime.included && target.plan.runtime.detected
              ? 1
              : 0) +
            target.plan.images.candidates.length,
          0,
        )
      : cleanupPlan.baselines.removed.length +
        (cleanupPlan.runtime.included && cleanupPlan.runtime.detected ? 1 : 0) +
        cleanupPlan.images.candidates.length;
  if (selectedCount === 0) return "home";
  const accepted = await promptForConfirmation(
    "Remove exactly the resources shown above?",
    flags,
  );
  if (!accepted) return "home";
  flags.write = true;
  flags.cleanupConfirmation = cleanupPlan.digest;
  return "cleanup";
};

const guideBaseline = async ({
  state,
  selected,
  flags,
  planOptions,
  projectRoot,
}: {
  state: GuidedState;
  selected: GuidedCommandOption;
  flags: RehearsalCliFlags;
  planOptions: RehearsalConfigPathOptions;
  projectRoot: string;
}): Promise<string> => {
  console.log(
    [
      "",
      terminalStyle(flags, "1", "CREATE A SAFE BASELINE"),
      "Rehearsal only reads the local files you name here.",
      "It does not extract data or contact a hosted database.",
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
    ...(state.target === "supabase"
      ? [
          discovered.assetManifests.length
            ? `Storage manifests: ${discovered.assetManifests.join(", ")}`
            : "Storage manifests: none detected",
        ]
      : []),
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
  if (!flags.recordsPath || !flags.ledgerPath) {
    throw new Error(
      "Baseline creation requires record and migration-ledger paths.",
    );
  }
  try {
    if (selected.command === "baseline-prepare") {
      const preparationPlan = await planBaselinePreparation({
        ...planOptions,
        recordsPath: flags.recordsPath,
        ledgerPath: flags.ledgerPath,
      });
      const preview = {
        ...summarizeBaselinePreparation(preparationPlan, { mode: "preview" }),
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
        return "home";
      }
      flags.preparationPlan = preparationPlan;
      flags.write = true;
      return "baseline prepare";
    }
    flags.assetsPath =
      state.target === "supabase"
        ? await promptForDiscoveredPath({
            message: "Storage assets",
            candidates: discovered.assetManifests,
            optional: true,
            flags,
          })
        : undefined;
    const inspection = await inspectBaselineInputFiles({
      ...planOptions,
      recordsPath: flags.recordsPath,
      ledgerPath: flags.ledgerPath,
      ...(flags.assetsPath === undefined
        ? {}
        : { assetsPath: flags.assetsPath }),
    });
    console.log(`\n${renderBaselineInputInspection(inspection, flags)}\n`);
    const accepted = await promptForConfirmation(
      "Create and activate this immutable local baseline?",
      flags,
    );
    if (!accepted) {
      console.log("No changes made.");
      return "home";
    }
    return "baseline create";
  } catch (error) {
    const message = String(redactDiagnosticValue(errorMessage(error)));
    if (useStyledPrompts(flags)) {
      prompts.cancel("These baseline inputs need attention.");
      prompts.note(message, "How to continue");
    } else {
      console.log(`\nBASELINE INPUTS NEED ATTENTION\n${message}\n`);
    }
    return "home";
  }
};

export const createGuidedHome =
  ({
    projectRoot,
    topologyCandidateSummary,
    buildRefreshWorkflowPlan,
    planRuntimeStackCleanup,
    getLastGuidedDetails,
  }: {
    projectRoot: string;
    topologyCandidateSummary: (
      options: RehearsalConfigPathOptions,
    ) => Promise<TopologySummary>;
    buildRefreshWorkflowPlan: (
      options: RehearsalConfigPathOptions,
    ) => Promise<{ plan: GuidedRefreshPlan }>;
    planRuntimeStackCleanup: (input: {
      flags: RehearsalCliFlags;
      planOptions: RehearsalConfigPathOptions;
    }) => Promise<GuidedCleanupPlan>;
    getLastGuidedDetails: () => string | undefined;
  }) =>
  async ({
    flags,
    planOptions,
  }: {
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
  }): Promise<string | null> => {
    const state = await inspectGuidedProject({
      projectRoot,
      planOptions,
      topologyCandidateSummary,
    });
    const lastDetails = getLastGuidedDetails();
    const options = guidedOptions(state, Boolean(lastDetails));
    showGuidedStatus({ state, options, flags });
    const selected = await promptForChoice({
      message: "What would you like to do?",
      options,
      flags,
      optionsAlreadyShown: !useStyledPrompts(flags),
    });
    if (!selected || selected.command === "exit") return null;
    if (selected.command === "node-help") {
      console.log(
        [
          "",
          terminalStyle(flags, "1", "SUPPORTED NODE.JS REQUIRED"),
          `This shell is using Node.js ${state.node.version}. Rehearsal has not changed your project.`,
          `Supported releases: ${REHEARSAL_NODE_LABEL}.`,
          "",
          "Recommended with nvm:",
          "  nvm install --lts",
          "  nvm use --lts",
          "",
          "Then reinstall Rehearsal in your scratch project and run npx rehearsal again.",
        ].join("\n"),
      );
      return "home";
    }
    if (selected.command === "policy-review") {
      try {
        await reviewPolicyInteractively({ state, flags });
      } catch (error) {
        if (errorMessage(error) !== "Policy review was cancelled.") {
          throw error;
        }
        if (useStyledPrompts(flags)) {
          prompts.cancel("Policy review cancelled; the draft was not changed.");
        } else {
          console.log("Policy review cancelled; the draft was not changed.");
        }
      }
      return "home";
    }
    if (selected.command === "last-details") {
      if (useStyledPrompts(flags)) {
        prompts.note(lastDetails, "Technical details");
      } else {
        console.log(`\nTECHNICAL DETAILS\n${lastDetails}`);
      }
      return "home";
    }
    if (selected.command === "refresh-guide") {
      const { plan } = await buildRefreshWorkflowPlan(planOptions);
      console.log(`\n${renderRefreshWorkflow({ mode: "preview", plan })}\n`);
      const accepted = await promptForConfirmation(
        "Create this replacement, discard current runtime edits, and remove exactly the listed old copies after success?",
        flags,
      );
      if (!accepted) return "home";
      flags.refreshConfirmation = plan.digest;
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
      if (!runtimeAction || runtimeAction.command === "exit") return "home";
      if (["reset", "discard"].includes(runtimeAction.command)) {
        const accepted = await promptForConfirmation(
          runtimeAction.command === "reset"
            ? "Reset the disposable runtime and remove its current changes?"
            : "Discard the disposable runtime? The immutable baseline will remain.",
          flags,
        );
        if (!accepted) return "home";
      }
      return runtimeAction.command;
    }
    if (selected.command === "cleanup-guide") {
      return guideCleanup({ flags, planOptions, planRuntimeStackCleanup });
    }
    if (["baseline-guide", "baseline-prepare"].includes(selected.command)) {
      return guideBaseline({
        state,
        selected,
        flags,
        planOptions,
        projectRoot,
      });
    }
    if (selected.command !== "setup-write") return selected.command;

    const targetChoice = await promptForChoice({
      message: "Which database should Rehearsal use?",
      flags,
      options:
        state.target === "supabase"
          ? [
              { label: "Supabase", command: "supabase" },
              { label: "PostgreSQL", command: "postgresql" },
            ]
          : [
              { label: "PostgreSQL", command: "postgresql" },
              { label: "Supabase", command: "supabase" },
            ],
    });
    if (!targetChoice) return "home";
    if (
      targetChoice.command !== "supabase" &&
      targetChoice.command !== "postgresql"
    ) {
      throw new Error("Unsupported guided runtime target.");
    }
    const target = targetChoice.command;
    flags.target = target;
    const setupPlan = await planRehearsalSetup({
      projectRoot,
      target,
    });
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
      return "home";
    }
    flags.setupPlan = setupPlan;
    flags.write = true;
    return "setup";
  };
