/** Read-only editor plan. Dependencies express the verified ordered prefix, not guessed SQL safety. */
import { inspectRehearsalMigrations } from "./plan.mjs";
import { inspectRuntimeTopologyCandidates } from "./topology.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";

type Inspection = Awaited<ReturnType<typeof inspectRehearsalMigrations>>;
export const migrationReviewEntries = (
  target: string,
  migrations: Inspection["migrations"],
) => {
  if (migrations.length > 10000)
    throw new Error("Migration review exceeds the bounded 10,000-file plan.");
  return migrations.map((migration, index) => ({
    ...migration,
    target,
    id: `${target}:${migration.version}`,
    order: index,
    timestamp: migration.version,
    required: migration.status === "candidate",
    dependsOn: index ? [`${target}:${migrations[index - 1]!.version}`] : [],
    warnings:
      migration.status === "candidate" ? ["sql_safety_not_inferred"] : [],
    selectionReason:
      migration.status === "candidate"
        ? "Every candidate is required: the reviewed ordered suffix cannot be skipped or reordered."
        : "Already represented or applied; shown for history review only.",
  }));
};

export const inspectMigrationReviewPlan = async (
  options: RehearsalConfigPathOptions = {},
  inspectMigrations: typeof inspectRehearsalMigrations = inspectRehearsalMigrations,
) => {
  const inspections = new Map<string, Inspection>();
  const candidates = await inspectRuntimeTopologyCandidates(
    options,
    inspectMigrations,
    (target, inspection) => inspections.set(target.configPath, inspection),
  );
  const targets = [];
  for (const target of candidates.targets) {
    const inspection = inspections.get(target.configPath)!;
    targets.push({
      name: target.name,
      provider: target.config.runtime.target,
      baselineGenerationId: inspection.baselineGenerationId,
      candidateSha256: inspection.candidateSha256,
      ...(inspection.migrationTool
        ? { migrationTool: inspection.migrationTool }
        : {}),
      entries: migrationReviewEntries(target.name, inspection.migrations),
    });
  }
  if (
    targets.reduce((total, target) => total + target.entries.length, 0) > 10000
  )
    throw new Error(
      "Combined migration review exceeds the bounded 10,000-file plan.",
    );
  return {
    schemaVersion: 1 as const,
    candidateSha256: candidates.candidateSha256,
    candidateCount: candidates.candidateCount,
    selection: "complete-ordered-suffix" as const,
    targets,
    safety: {
      readsSqlBodiesForSafety: false,
      executesSql: false,
      startsEngine: false,
    },
  };
};
