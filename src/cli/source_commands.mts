/**
 * CLI orchestration for temporary production-source access and safe baseline
 * replacement. Domain validation remains in src/source and src/baseline.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  activateBaselineGeneration,
  planBaselineGenerationPrune,
  planBaselineReplacementPrune,
  pruneBaselineGenerations,
  verifyActiveBaseline,
} from "../baseline/artifact.mjs";
import type { BaselineStorageAsset } from "../baseline/artifact.mjs";
import {
  createPrivacyEngine,
  readPrivacyKey,
} from "../baseline/privacy_engine.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import type { CliSessionState } from "./command_contract.mjs";
import {
  createSourceAccessPlan,
  validateSourceAccessPolicy,
} from "../source/access.mjs";
import { streamApprovedSupabaseAssets } from "../source/asset_transfer.mjs";
import { refreshPostgresqlBaseline } from "../source/baseline.mjs";
import { resolvePrivacyMappedAssets } from "../source/privacy_paths.mjs";
import {
  applyPostgresqlSourceAccess,
  planPostgresqlSourceAccessRetirement,
  resolvePostgresqlSourceStatePaths,
  retirePostgresqlSourceAccess,
} from "../source/postgresql_access.mjs";
import { loadRuntimeTopology } from "../runtime/topology.mjs";
import type { RuntimeTopologyTarget } from "../runtime/topology.mjs";
import {
  isOperationCancelled,
  throwIfOperationCancelled,
  withOperationCancellationShield,
} from "../shared/cancellation.mjs";

interface SourceAccessReceipt {
  readonly targetFingerprint: string;
  readonly planDigest: string;
  readonly expiresAt: string;
}

const parseSourceAccessReceipt = (source: string): SourceAccessReceipt => {
  const parsed = JSON.parse(source) as Partial<SourceAccessReceipt>;
  if (
    typeof parsed.targetFingerprint !== "string" ||
    typeof parsed.planDigest !== "string" ||
    typeof parsed.expiresAt !== "string"
  ) {
    throw new Error("The source-access receipt has an invalid shape.");
  }
  return parsed as SourceAccessReceipt;
};

type RuntimeTopology = Awaited<ReturnType<typeof loadRuntimeTopology>>;
type RefreshPlanContext = Awaited<ReturnType<typeof buildRefreshWorkflowPlan>>;

interface SourceCommandInput {
  readonly flags: RehearsalCliFlags;
  readonly planOptions: RehearsalConfigPathOptions;
}

export const loadPreparationContext = async (
  planOptions: RehearsalConfigPathOptions,
) => {
  const loaded = await loadRehearsalConfig(planOptions);
  if (!loaded.config.preparation) {
    throw new Error(
      "Source preparation is not configured. Review docs/standalone-workflow.md, then enable config.preparation.",
    );
  }
  if (!loaded.paths.sourcePolicy || !loaded.paths.privacyKey) {
    throw new Error("Source preparation paths are incomplete.");
  }
  const sourcePolicyBytes = await readFile(loaded.paths.sourcePolicy);
  const sourcePolicy = validateSourceAccessPolicy(
    JSON.parse(sourcePolicyBytes.toString("utf8")),
  );
  return { loaded, sourcePolicy, sourcePolicyBytes };
};

export const runSourceAccess = async ({
  flags,
  planOptions,
}: SourceCommandInput) => {
  const { loaded, sourcePolicy } = await loadPreparationContext(planOptions);
  const plan = createSourceAccessPlan({ policy: sourcePolicy });
  if (!flags.sourceAccessConfirmation)
    return { mode: "preview" as const, plan };
  const applied = await applyPostgresqlSourceAccess({
    plan,
    confirmation: flags.sourceAccessConfirmation,
    projectRoot: loaded.projectRoot,
    artifactRoot: loaded.paths.artifactDirectory,
  });
  return {
    mode: "written" as const,
    plan,
    receipt: applied.receipt,
    credentialFile: relative(loaded.projectRoot, applied.credentialPath),
  };
};

export const runSourceRetirement = async ({
  flags,
  planOptions,
}: SourceCommandInput) => {
  const { loaded, sourcePolicy } = await loadPreparationContext(planOptions);
  const plan = await planPostgresqlSourceAccessRetirement({
    projectRoot: loaded.projectRoot,
    artifactRoot: loaded.paths.artifactDirectory,
    targetFingerprint: sourcePolicy.targetFingerprint,
  });
  if (!flags.sourceRetirementConfirmation)
    return { mode: "preview" as const, plan };
  await retirePostgresqlSourceAccess({
    plan,
    confirmation: flags.sourceRetirementConfirmation,
    ...(sourcePolicy.administratorEnvironmentVariable
      ? {
          administratorEnvironmentVariable:
            sourcePolicy.administratorEnvironmentVariable,
        }
      : {}),
    projectRoot: loaded.projectRoot,
    artifactRoot: loaded.paths.artifactDirectory,
    credentialFile: sourcePolicy.reader.credentialFile,
  });
  return { mode: "written" as const, plan };
};

const readSourceReaderCredential = async (path: string): Promise<string> => {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error(
      "Source reader credential must be an owner-only regular file.",
    );
  }
  const lines = (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean);
  if (
    lines.length !== 1 ||
    !lines[0]?.startsWith("REHEARSAL_SOURCE_DATABASE_URL=")
  ) {
    throw new Error("Source reader credential file has an invalid shape.");
  }
  const value = lines[0]!.slice("REHEARSAL_SOURCE_DATABASE_URL=".length);
  if (!value) throw new Error("Source reader credential file is empty.");
  return value;
};

export const runSourceBaselineRefresh = async ({
  planOptions,
}: Pick<SourceCommandInput, "planOptions">) => {
  const { loaded, sourcePolicy } = await loadPreparationContext(planOptions);
  const preparation = loaded.config.preparation;
  const privacyKeyPath = loaded.paths.privacyKey;
  if (!preparation || !privacyKeyPath) {
    throw new Error("Source preparation configuration is incomplete.");
  }
  const { credentialPath } = resolvePostgresqlSourceStatePaths({
    projectRoot: loaded.projectRoot,
    artifactRoot: loaded.paths.artifactDirectory,
    credentialFile: sourcePolicy.reader.credentialFile,
  });
  const [
    sourceAccessReceipt,
    privacyPolicyBytes,
    privacyKey,
    connectionString,
  ] = await Promise.all([
    readFile(
      join(loaded.paths.artifactDirectory, "source-access-receipt.json"),
      "utf8",
    ).then(parseSourceAccessReceipt),
    readFile(loaded.paths.sanitizationPolicy),
    readPrivacyKey(privacyKeyPath),
    readSourceReaderCredential(credentialPath),
  ]);
  const privacyPolicy = JSON.parse(privacyPolicyBytes.toString("utf8"));
  const assetPrivacyEngine = createPrivacyEngine({
    policy: privacyPolicy,
    key: privacyKey,
  });
  const assetDeclarations = resolvePrivacyMappedAssets({
    sourcePolicy,
    privacyPolicy,
  });
  return refreshPostgresqlBaseline({
    connectionString,
    sourcePolicy,
    sourceAccessReceipt,
    privacyPolicyBytes,
    privacyKey,
    artifactRoot: loaded.paths.artifactDirectory,
    migrationDirectory: loaded.paths.migrationDirectory,
    limits: {
      batchRows: preparation.batchRows,
      maximumRows: preparation.maximumRows,
      maximumBytes: preparation.maximumBytes,
      diskHeadroomBytes: preparation.diskHeadroomBytes,
    },
    assets: sourcePolicy.assetReader
      ? streamApprovedSupabaseAssets({
          baseUrl:
            process.env[sourcePolicy.assetReader.baseUrlEnvironmentVariable] ??
            "",
          token:
            process.env[sourcePolicy.assetReader.tokenEnvironmentVariable] ??
            "",
          declarations: assetDeclarations,
          maximumObjects: sourcePolicy.assetReader.maximumObjects,
          maximumObjectBytes: sourcePolicy.assetReader.maximumObjectBytes,
          maximumTotalBytes: sourcePolicy.assetReader.maximumTotalBytes,
          pathMapper: ({ mapping, value }) =>
            assetPrivacyEngine.remapPath({ mapping, value }),
        })
      : [],
  });
};

export const buildRefreshWorkflowPlan = async (
  planOptions: RehearsalConfigPathOptions,
) => {
  const [{ loaded, sourcePolicy, sourcePolicyBytes }, topology] =
    await Promise.all([
      loadPreparationContext(planOptions),
      loadRuntimeTopology(planOptions),
    ]);
  const hashFile = async (path: string | null): Promise<string | null> =>
    path
      ? createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      : null;
  const [
    currentBaseline,
    sourceAccessReceipt,
    replacementCleanup,
    privacyPolicySha256,
    runtimeConfigurations,
  ] = await Promise.all([
    verifyActiveBaseline({ artifactRoot: loaded.paths.artifactDirectory }),
    readFile(
      join(loaded.paths.artifactDirectory, "source-access-receipt.json"),
      "utf8",
    ).then(parseSourceAccessReceipt),
    planBaselineReplacementPrune({
      artifactRoot: loaded.paths.artifactDirectory,
      retain: loaded.config.cleanup.retainBaselineGenerations,
    }),
    hashFile(loaded.paths.sanitizationPolicy),
    Promise.all(
      topology.targets.map(async (target) => ({
        target: target.name,
        configSha256: await hashFile(target.configPath),
        runtimePolicySha256: await hashFile(target.paths.runtimePolicy),
        runtimeAdapterSha256: await hashFile(target.paths.runtimeAdapter),
        localServiceConfigSha256: await hashFile(target.paths.rehearsalConfig),
      })),
    ),
  ]);
  if (
    sourceAccessReceipt.targetFingerprint !== sourcePolicy.targetFingerprint ||
    !/^[a-f0-9]{64}$/u.test(sourceAccessReceipt.planDigest ?? "")
  ) {
    throw new Error(
      "The source-access receipt does not match the selected refresh policy.",
    );
  }
  const sourceReaderExpiry = new Date(sourceAccessReceipt.expiresAt).valueOf();
  if (
    !Number.isFinite(sourceReaderExpiry) ||
    sourceReaderExpiry <= Date.now()
  ) {
    throw new Error(
      "The temporary source reader has expired. Preview and apply source access again before refreshing.",
    );
  }
  const review = {
    planVersion: 1,
    operation: "refresh-and-replace-local-copy",
    currentBaseline: currentBaseline.generationId,
    source: {
      targetFingerprint: sourcePolicy.targetFingerprint,
      accessPlanDigest: sourceAccessReceipt.planDigest,
      readerExpiresAt: sourceAccessReceipt.expiresAt,
      sourcePolicySha256: createHash("sha256")
        .update(sourcePolicyBytes)
        .digest("hex"),
      privacyPolicySha256,
    },
    runtimeConfigurations,
    runtimeTargets: topology.targets.map((target) => target.name),
    dependentPreparations: topology.dependents.flatMap((target) =>
      target.declaration?.prepareCommand
        ? [{ target: target.name, command: target.declaration.prepareCommand }]
        : [],
    ),
    retention: {
      generations: loaded.config.cleanup.retainBaselineGenerations,
      removeAfterReplacement: replacementCleanup.removedAfterReplacement,
      keepFromCurrent: replacementCleanup.retainedAfterReplacement,
    },
    steps: [
      "build and verify a new immutable baseline beside the current baseline",
      "activate the new baseline only after verification",
      "discard runtime edits and reset the complete local runtime stack",
      "run configured dependent preparation commands",
      "remove only the old baseline generations listed in this plan",
    ],
  };
  return {
    loaded,
    topology,
    plan: {
      review,
      digest: createHash("sha256")
        .update(`${JSON.stringify(review, null, "\t")}\n`)
        .digest("hex"),
    },
  };
};

export const createRefreshWorkflow =
  ({
    runRuntimeStack,
    prepareDependentTargets,
    topologyCommandEnvironment,
    buildPlan = buildRefreshWorkflowPlan,
    refreshBaseline = runSourceBaselineRefresh,
    activateBaseline = activateBaselineGeneration,
  }: {
    runRuntimeStack: (input: {
      command: "reset";
      flags: RehearsalCliFlags;
      planOptions: RehearsalConfigPathOptions;
      session: CliSessionState;
    }) => Promise<{ runtime: unknown; topology: RuntimeTopology }>;
    prepareDependentTargets: (input: {
      topology: RuntimeTopology;
      environment: NodeJS.ProcessEnv;
    }) => Promise<unknown[]>;
    topologyCommandEnvironment: (
      topology: RuntimeTopology,
    ) => NodeJS.ProcessEnv;
    buildPlan?: (
      options: RehearsalConfigPathOptions,
    ) => Promise<RefreshPlanContext>;
    refreshBaseline?: typeof runSourceBaselineRefresh;
    activateBaseline?: typeof activateBaselineGeneration;
  }) =>
  async ({
    flags,
    planOptions,
    session,
  }: SourceCommandInput & { session: CliSessionState }) => {
    const context = await buildPlan(planOptions);
    if (!flags.refreshConfirmation) {
      return { mode: "preview" as const, plan: context.plan };
    }
    if (flags.refreshConfirmation !== context.plan.digest) {
      throw new Error(
        `Refresh confirmation does not match this exact plan. Expected ${context.plan.digest}. Nothing changed.`,
      );
    }
    let refreshed:
      Awaited<ReturnType<typeof runSourceBaselineRefresh>> | undefined;
    let runtime: unknown;
    let preparations: unknown[] = [];
    try {
      throwIfOperationCancelled();
      refreshed = await refreshBaseline({ planOptions });
      throwIfOperationCancelled();
      const stack = await runRuntimeStack({
        command: "reset",
        flags,
        planOptions,
        session,
      });
      throwIfOperationCancelled();
      runtime = stack.runtime;
      preparations = await prepareDependentTargets({
        topology: stack.topology,
        environment: topologyCommandEnvironment(stack.topology),
      });
      throwIfOperationCancelled();
    } catch (error) {
      if (refreshed) {
        try {
          await withOperationCancellationShield(async () => {
            await activateBaseline({
              artifactRoot: context.loaded.paths.artifactDirectory,
              generationId: context.plan.review.currentBaseline,
            });
            const rollback = await runRuntimeStack({
              command: "reset",
              flags,
              planOptions,
              session,
            });
            await prepareDependentTargets({
              topology: rollback.topology,
              environment: topologyCommandEnvironment(rollback.topology),
            });
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "The refreshed runtime failed and the previous local runtime could not be restored automatically. The previous immutable baseline is active; run rehearsal reset after correcting the reported problem.",
          );
        }
        if (isOperationCancelled(error)) throw error;
        throw new Error(
          "The refreshed runtime failed verification. Rehearsal restored the previous baseline and local runtime.",
          { cause: error },
        );
      }
      throw error;
    }

    let cleanup;
    try {
      const result = await pruneBaselineGenerations({
        artifactRoot: context.loaded.paths.artifactDirectory,
        retain: context.plan.review.retention.generations,
        expectedRemoved: context.plan.review.retention.removeAfterReplacement,
      });
      cleanup = { state: "complete", removed: result.removed };
    } catch {
      const remaining = await planBaselineGenerationPrune({
        artifactRoot: context.loaded.paths.artifactDirectory,
        retain: context.plan.review.retention.generations,
      }).catch(() => ({ removed: [] }));
      cleanup = { state: "incomplete", remaining: remaining.removed.length };
    }
    return {
      mode: "written" as const,
      plan: context.plan,
      refreshed,
      runtime,
      preparations,
      cleanup,
    };
  };
