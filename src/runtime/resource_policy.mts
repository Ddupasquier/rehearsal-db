/** Project-local resource budgets and scheduled review; never deletes or starts anything. */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NormalizedRehearsalConfig } from "../project/configuration.mjs";
import type { RehearsalResourceInventory } from "./resource_inventory.mjs";

export type ResourcePolicy = NormalizedRehearsalConfig["resources"];
export const RESOURCE_REVIEW_RECEIPT_FILENAME = "resource-review-receipt.json";

export interface ResourcePolicyStatus {
  readonly schemaVersion: 1;
  readonly retainedEnvironmentCount: number | null;
  readonly maximumRetainedEnvironmentCount: number;
  readonly ownedVolumeBytes: number | null;
  readonly maximumBytes: number | null;
  readonly quota: "disabled" | "within-limit" | "exceeded" | "unavailable";
  readonly staleAfterSeconds: number | null;
  readonly cleanupSchedule: ResourcePolicy["cleanupSchedule"];
  readonly cleanupReview: "manual" | "due" | "scheduled";
  readonly nextReviewAt: string | null;
  readonly warnings: readonly string[];
}

export const evaluateResourcePolicy = ({
  inventory,
  policy,
  lastReviewedAt = null,
  now = new Date(),
}: {
  readonly inventory: RehearsalResourceInventory;
  readonly policy: ResourcePolicy;
  readonly lastReviewedAt?: string | null;
  readonly now?: Date;
}): ResourcePolicyStatus => {
  const known =
    inventory.engine.state === "running" &&
    inventory.environments.every((entry) => entry.state !== "unavailable");
  const retained = known
    ? inventory.environments.filter(
        (entry) => entry.containerCount > 0 || entry.volumeCount > 0,
      ).length
    : null;
  const measurable =
    known &&
    inventory.environments.every(
      (entry) => entry.volumeCount === 0 || entry.diskUsageBytes !== null,
    );
  const bytes = measurable
    ? inventory.environments.reduce(
        (sum, entry) => sum + (entry.diskUsageBytes ?? 0),
        0,
      )
    : null;
  const ownedVolumeBytes =
    bytes !== null && Number.isSafeInteger(bytes) ? bytes : null;
  const quota =
    policy.maximumBytes === null
      ? "disabled"
      : ownedVolumeBytes === null
        ? "unavailable"
        : ownedVolumeBytes > policy.maximumBytes
          ? "exceeded"
          : "within-limit";
  const interval =
    policy.cleanupSchedule === "daily-preview"
      ? 86400_000
      : policy.cleanupSchedule === "weekly-preview"
        ? 7 * 86400_000
        : null;
  const previous = lastReviewedAt === null ? NaN : Date.parse(lastReviewedAt);
  const due =
    interval !== null &&
    (!Number.isFinite(previous) ||
      previous > now.getTime() ||
      previous + interval <= now.getTime());
  const nextReviewAt =
    interval === null
      ? null
      : due
        ? now.toISOString()
        : new Date(previous + interval).toISOString();
  const warnings: string[] = [];
  if (retained !== null && retained > policy.retainedEnvironmentCount) {
    warnings.push(
      `${retained} configured environments retain data; the advisory limit is ${policy.retainedEnvironmentCount}. Review stop or discard explicitly; no retained data was removed.`,
    );
  }
  if (quota === "unavailable")
    warnings.push(
      "The configured owned-volume quota cannot be measured. Starting a runtime is refused until a complete measurement is available or the owner reviews the quota setting.",
    );
  if (quota === "exceeded")
    warnings.push(
      "Measured owned volumes exceed the configured byte quota. Review a non-destructive stop or exact cleanup plan; Rehearsal never silently deletes retained databases.",
    );
  if (due)
    warnings.push(
      "A resource cleanup review is due. Open an exact cleanup preview; no scheduled process, shared-image deletion, or persistent-data deletion runs automatically.",
    );
  return Object.freeze({
    schemaVersion: 1,
    retainedEnvironmentCount: retained,
    maximumRetainedEnvironmentCount: policy.retainedEnvironmentCount,
    ownedVolumeBytes,
    maximumBytes: policy.maximumBytes,
    quota,
    staleAfterSeconds: policy.staleAfterSeconds,
    cleanupSchedule: policy.cleanupSchedule,
    cleanupReview: interval === null ? "manual" : due ? "due" : "scheduled",
    nextReviewAt,
    warnings: Object.freeze(warnings),
  });
};

export const assertResourcePolicyAllowsStartup = (
  status: ResourcePolicyStatus,
): void => {
  if (status.quota === "unavailable" || status.quota === "exceeded") {
    throw new Error(
      status.quota === "unavailable"
        ? "The configured resource byte quota cannot be verified. No runtime was started. Inspect rehearsal resources or review resources.maximumBytes."
        : "Owned data volumes exceed resources.maximumBytes. No runtime was started; review rehearsal resources and an exact cleanup preview.",
    );
  }
};

const receiptIdentity = (projectRoot: string, policy: ResourcePolicy): string =>
  createHash("sha256")
    .update(JSON.stringify({ projectRoot: resolve(projectRoot), policy }))
    .digest("hex");

const ensureOwnedReceiptParent = async (
  projectRoot: string,
  path: string,
): Promise<void> => {
  const root = resolve(projectRoot);
  const parents = relative(root, dirname(resolve(path)));
  if (parents.startsWith("..") || isAbsolute(parents))
    throw new Error("Resource review receipts must remain inside the project.");
  let current = root;
  for (const part of parents.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error(
        "Resource review receipt paths cannot traverse symbolic links or non-directories.",
      );
  }
};

export const readResourceReviewReceipt = async ({
  path,
  projectRoot,
  policy,
  now = new Date(),
}: {
  readonly path: string;
  readonly projectRoot: string;
  readonly policy: ResourcePolicy;
  readonly now?: Date;
}): Promise<string | null> => {
  try {
    const details = await lstat(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > 4096 ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid())
    )
      return null;
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.identity !== receiptIdentity(projectRoot, policy) ||
      typeof receipt.reviewedAt !== "string"
    )
      return null;
    const time = Date.parse(receipt.reviewedAt);
    return Number.isFinite(time) && time <= now.getTime()
      ? receipt.reviewedAt
      : null;
  } catch {
    return null;
  }
};

/** Call only after an explicitly approved cleanup review completes; inspection stays read-only. */
export const writeResourceReviewReceipt = async ({
  path,
  projectRoot,
  policy,
  now = new Date(),
}: {
  readonly path: string;
  readonly projectRoot: string;
  readonly policy: ResourcePolicy;
  readonly now?: Date;
}): Promise<void> => {
  await ensureOwnedReceiptParent(projectRoot, path);
  try {
    const details = await lstat(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid())
    ) {
      throw new Error(
        "Refusing to replace a resource review receipt that is not an owner-only regular file.",
      );
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, identity: receiptIdentity(projectRoot, policy), reviewedAt: now.toISOString() })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};
