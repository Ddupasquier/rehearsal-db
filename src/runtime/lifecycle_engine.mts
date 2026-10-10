/** Shared, target-neutral orchestration for disposable runtime lifecycles. */

import { readFile, writeFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import {
  resolveActiveBaselinePaths,
  verifyActiveBaseline,
} from "../baseline/artifact.mjs";
import type {
  ActiveBaselinePaths,
  BaselineManifest,
} from "../baseline/artifact.mjs";
import { readBoundRuntimeSanitizationPolicy } from "../baseline/sanitization_policy.mjs";
import type { RuntimeSanitizationPolicy } from "../baseline/sanitization_policy.mjs";
import { readMigrationFileInventory } from "./migration_history.mjs";
import type { MigrationFileEntry } from "./migration_history.mjs";
import { createCandidateMigrationReceipt } from "./restore.mjs";
import {
  reachOperationCancellationCheckpoint,
  withOperationCancellationShield,
} from "../shared/cancellation.mjs";

export type RuntimeLifecycleAction =
  | "reset"
  | "start"
  | "status"
  | "candidates"
  | "migrate"
  | "verify"
  | "run"
  | "stop"
  | "discard";

export interface ActiveRuntimeInput {
  readonly baseline: BaselineManifest;
  readonly paths: ActiveBaselinePaths;
  readonly manifest: RuntimeSanitizationPolicy;
}

export interface CandidateMigrationPlan {
  readonly currentFiles: readonly MigrationFileEntry[];
  readonly candidates: readonly MigrationFileEntry[];
  readonly candidateSha256: string;
}

export interface RuntimeLifecycleOperations {
  readonly reset: () => Promise<unknown>;
  readonly start: () => Promise<unknown>;
  readonly status: () => Promise<unknown>;
  readonly candidates: () => Promise<unknown>;
  readonly migrate: () => Promise<unknown>;
  readonly verify: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly discard: () => Promise<unknown>;
}

export const readActiveRuntimeInput = async ({
  artifactRoot,
  manifestPath,
  validate,
}: {
  artifactRoot: string;
  manifestPath: PathLike;
  validate?: (input: ActiveRuntimeInput) => void | Promise<void>;
}): Promise<ActiveRuntimeInput> => {
  const [baseline, paths, policyBytes] = await Promise.all([
    verifyActiveBaseline({ artifactRoot }),
    resolveActiveBaselinePaths({ artifactRoot }),
    readFile(manifestPath),
  ]);
  const manifest = readBoundRuntimeSanitizationPolicy({
    bytes: policyBytes,
    expectedSha256: baseline.sanitizationPolicySha256,
  });
  const input = { baseline, paths, manifest };
  await validate?.(input);
  return input;
};

export const readCandidateMigrationPlan = async ({
  baseline,
  migrationDirectory,
}: {
  baseline: BaselineManifest;
  migrationDirectory: URL;
}): Promise<CandidateMigrationPlan> => {
  const currentFiles = await readMigrationFileInventory(migrationDirectory);
  return {
    currentFiles,
    ...createCandidateMigrationReceipt({
      baselineManifest: baseline,
      currentFiles,
    }),
  };
};

export const assertCandidateConfirmation = ({
  plan,
  confirmation,
  allowUnconfirmedEmpty = false,
}: {
  plan: CandidateMigrationPlan;
  confirmation: string | undefined;
  allowUnconfirmedEmpty?: boolean;
}): void => {
  if (allowUnconfirmedEmpty && plan.candidates.length === 0) return;
  if (confirmation !== plan.candidateSha256) {
    throw new Error(
      "Candidate migration confirmation is missing or does not match the exact SHA-256.",
    );
  }
};

export const writeCandidateMigrationReceipt = async ({
  path,
  target,
  baseline,
  plan,
}: {
  path: PathLike;
  target: string;
  baseline: BaselineManifest;
  plan: CandidateMigrationPlan;
}): Promise<void> => {
  await writeFile(
    path,
    `${JSON.stringify(
      {
        formatVersion: 1,
        target,
        baselineGenerationId: baseline.generationId,
        candidateSha256: plan.candidateSha256,
        candidates: plan.candidates.map((candidate) => ({
          filename: candidate.filename,
          sha256: candidate.fileSha256,
        })),
      },
      null,
      "\t",
    )}\n`,
    { mode: 0o600 },
  );
};

export const writeRuntimeMarker = async ({
  path,
  marker,
}: {
  path: PathLike;
  marker: Readonly<Record<string, unknown>>;
}): Promise<void> => {
  await writeFile(path, `${JSON.stringify(marker, null, "\t")}\n`, {
    mode: 0o600,
  });
};

export const readMatchingRuntimeMarker = async ({
  path,
  expected,
  mismatchMessage,
}: {
  path: PathLike;
  expected: Readonly<Record<string, unknown>>;
  mismatchMessage: string;
}): Promise<Readonly<Record<string, unknown>>> => {
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(mismatchMessage, { cause: error });
  }
  if (
    marker === null ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    Object.entries(expected).some(
      ([key, value]) =>
        !Object.is((marker as Record<string, unknown>)[key], value),
    )
  ) {
    throw new Error(mismatchMessage);
  }
  return marker as Readonly<Record<string, unknown>>;
};

export const withOwnedRuntimeRollback = async <Result,>({
  operation,
  rollback,
}: {
  operation: () => Promise<Result>;
  rollback: () => Promise<unknown>;
}): Promise<Result> => {
  try {
    const result = await operation();
    await reachOperationCancellationCheckpoint();
    return result;
  } catch (error) {
    try {
      await withOperationCancellationShield(rollback);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "The runtime operation failed and its owned runtime could not be removed automatically.",
      );
    }
    throw error;
  }
};

export const runRuntimeLifecycle = async ({
  action,
  operations,
}: {
  action: string;
  operations: RuntimeLifecycleOperations;
}): Promise<void> => {
  switch (action) {
    case "reset":
      await operations.reset();
      return;
    case "start":
      await operations.start();
      return;
    case "status":
      await operations.status();
      return;
    case "candidates":
      await operations.candidates();
      return;
    case "migrate":
      await operations.migrate();
      return;
    case "verify":
      await operations.verify();
      return;
    case "run":
      await operations.reset();
      await operations.migrate();
      await operations.verify();
      return;
    case "stop":
      await operations.stop();
      return;
    case "discard":
      await operations.discard();
      return;
    default:
      throw new Error(`Unknown Rehearsal database action: ${action}`);
  }
};
