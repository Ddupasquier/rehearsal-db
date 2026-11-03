/** Human-readable review and outcomes for project/stack cleanup; performs no cleanup. */
import type { RenderMode } from "../command_contract.mjs";
import { formatCount } from "../../shared/human_output.mjs";

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
