/**
 * State-aware interactive home screen and first-run flows.
 */

import * as prompts from "@clack/prompts";
import { inspectGuidedProject } from "./guided_project.mjs";
import type { GuidedState, TopologySummary } from "./guided_project.mjs";
import { createGuidedUpdates } from "./updates/guided_updates.mjs";
import {
  renderGuidedNodeHelp,
  renderSqliteBaselineHelp,
} from "./presentation/guided_help.mjs";
import { renderCleanup } from "./presentation/cleanup_rendering.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import type { CliSessionState } from "./command_contract.mjs";
import type { RehearsalCleanupPlan } from "../runtime/resources/cleanup.mjs";
import type { ChoiceOption } from "./presentation/terminal.mjs";
import {
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
  renderRefreshWorkflow,
  renderSetup,
} from "./presentation/renderers.mjs";
import {
  promptForChoice,
  promptForConfirmation,
  promptForDiscoveredPath,
  promptForMultipleChoice,
  promptForPath,
  promptForSelection,
  terminalStyle,
  useStyledPrompts,
} from "./presentation/terminal.mjs";

type GuidedCommandOption = ChoiceOption & { readonly command: string };

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
  showUpdates: boolean,
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
    if (state.target === "sqlite") {
      options.push({
        label: "SQLite baseline instructions",
        hint: "Review the file, column policy and current SQL ledger",
        command: "sqlite-help",
      });
    } else if (state.policy === "missing") {
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
    if (state.identityConfigured) {
      options.push({
        label: "Connect my copied account",
        hint: "Sign in normally, review once, then open the copied profile",
        command: "identity connect",
      });
    }
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
  if (
    state.node.supported &&
    state.config === "valid" &&
    state.target !== "sqlite"
  ) {
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
    ...(showUpdates
      ? [{ label: "Check for updates", command: "check-updates" }]
      : []),
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
    `${marker(state.target === "sqlite" ? state.config === "valid" : state.target === "supabase" ? state.detected.hasSupabaseConfig : state.detected.hasPostgresqlMigrations)} ${state.target === "sqlite" ? "SQLite" : state.target === "supabase" ? "Supabase" : "PostgreSQL"} project detected`,
    `${marker(state.target === "sqlite" ? state.baseline : state.target === "supabase" ? state.detected.hasMigrations : state.detected.hasPostgresqlMigrations)} ${state.target === "sqlite" ? "Declared SQL prefix verified" : "Migration history detected"}`,
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
    ...(state.runtime
      ? [
          `${marker(true)} ${state.target === "sqlite" ? "Local SQLite runtime receipt detected" : "Disposable runtime created"}`,
        ]
      : []),
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
  session,
}: {
  flags: RehearsalCliFlags;
  planOptions: RehearsalConfigPathOptions;
  planRuntimeStackCleanup: (input: {
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
  }) => Promise<GuidedCleanupPlan>;
  session: CliSessionState;
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
  session.cleanupPlan = cleanupPlan;
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
  session,
}: {
  state: GuidedState;
  selected: GuidedCommandOption;
  flags: RehearsalCliFlags;
  planOptions: RehearsalConfigPathOptions;
  projectRoot: string;
  session: CliSessionState;
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
      session.preparationPlan = preparationPlan;
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

export const createGuidedHome = ({
  projectRoot,
  topologyCandidateSummary,
  buildRefreshWorkflowPlan,
  planRuntimeStackCleanup,
  getLastGuidedDetails,
  session,
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
  session: CliSessionState;
}) => {
  const updates = createGuidedUpdates({ projectRoot });
  return async ({
    flags,
    planOptions,
  }: {
    flags: RehearsalCliFlags;
    planOptions: RehearsalConfigPathOptions;
  }): Promise<string | null> => {
    if (await updates(flags)) return null;
    const state = await inspectGuidedProject({
      projectRoot,
      planOptions,
      topologyCandidateSummary,
    });
    const lastDetails = getLastGuidedDetails();
    const options = guidedOptions(
      state,
      Boolean(lastDetails),
      !flags.json &&
        Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
        !process.env.CI &&
        !process.env.CODEX_CI &&
        process.env.REHEARSAL_UPDATE_CHECK !== "off",
    );
    showGuidedStatus({ state, options, flags });
    const selected = await promptForChoice({
      message: "What would you like to do?",
      options,
      flags,
      optionsAlreadyShown: !useStyledPrompts(flags),
    });
    if (!selected || selected.command === "exit") return null;
    if (selected.command === "sqlite-help") {
      console.log(renderSqliteBaselineHelp());
      return "home";
    }
    if (selected.command === "check-updates") {
      return (await updates(flags, true)) ? null : "home";
    }
    if (selected.command === "node-help") {
      console.log(renderGuidedNodeHelp(state.node.version, flags));
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
      return guideCleanup({
        flags,
        planOptions,
        planRuntimeStackCleanup,
        session,
      });
    }
    if (["baseline-guide", "baseline-prepare"].includes(selected.command)) {
      return guideBaseline({
        state,
        selected,
        flags,
        planOptions,
        projectRoot,
        session,
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
    session.setupPlan = setupPlan;
    flags.write = true;
    return "setup";
  };
};
