/**
 * Read-only Docker capacity and project-runtime inventory. This module never
 * starts Docker and recognizes ownership only through the configured project
 * id plus provider-owned labels.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import { loadRuntimeTopology } from "./topology.mjs";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import {
  buildResourceCatalog,
  inspectCatalogImages,
} from "./resource_catalog.mjs";
import type { ResourceCatalog, CatalogContainer } from "./resource_catalog.mjs";
import {
  inspectEnvironmentProvenanceEvidence,
  type EnvironmentProvenance,
} from "./resource_provenance.mjs";
import {
  classifyConfiguredEnvironment,
  type EnvironmentClassification,
} from "./environment_classification.mjs";
import {
  assertLocalDockerContext,
  runtimeDockerEnvironment,
  runtimeDockerContext,
} from "./local_docker_context.mjs";
import {
  evaluateResourcePolicy,
  readResourceReviewReceipt,
  RESOURCE_REVIEW_RECEIPT_FILENAME,
  type ResourcePolicyStatus,
} from "./resource_policy.mjs";

export const RESOURCE_INVENTORY_SCHEMA_VERSION = 1;

export interface ContainerDiskUsage {
  readonly backend: "colima";
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly usedPercent: number;
}

export interface DockerResourceUsage {
  readonly type: string;
  readonly totalCount: number | null;
  readonly activeCount: number | null;
  readonly size: string | null;
  readonly reclaimable: string | null;
}

export interface RehearsalEnvironmentInventoryEntry {
  readonly target: string;
  readonly displayName: string;
  readonly protected: boolean;
  readonly projectId: string;
  readonly provider: "supabase" | "postgresql";
  readonly configPath: string;
  readonly state: "running" | "stopped" | "absent" | "mixed" | "unavailable";
  readonly containerCount: number;
  readonly runningContainerCount: number;
  readonly volumeCount: number;
  readonly diskUsageBytes: number | null;
  readonly cpuPercent: number | null;
  readonly memoryUsageBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly retention: "persistent" | "disposable";
  readonly cleanupEligibility:
    "running" | "preview-required" | "not-present" | "inspection-unavailable";
  readonly restartPolicies: readonly string[];
  /** Recorded local receipts and configured endpoints; not fresh database verification. */
  readonly provenance?: EnvironmentProvenance;
  readonly classification?: EnvironmentClassification;
}

export interface RehearsalResourceInventory {
  readonly policy?: ResourcePolicyStatus;
  readonly schemaVersion: 1;
  readonly inspectedAt: string;
  readonly engine: Readonly<{
    state: "running" | "stopped";
    context: string | null;
    disk: ContainerDiskUsage | null;
    resources: readonly DockerResourceUsage[];
  }>;
  readonly environments: readonly RehearsalEnvironmentInventoryEntry[];
  readonly catalog?: ResourceCatalog | null;
  readonly stale: Readonly<{
    stoppedCount: number;
    digest: string | null;
    targets: readonly string[];
  }>;
}

interface DockerContainerInspection extends CatalogContainer {
  readonly Id?: string;
  readonly Created?: string;
  readonly Config?: { readonly Labels?: Record<string, string> | null };
  readonly HostConfig?: { readonly RestartPolicy?: { readonly Name?: string } };
  readonly State?: {
    readonly Running?: boolean;
    readonly StartedAt?: string;
    readonly FinishedAt?: string;
  };
}

interface DockerContainerStats {
  readonly Container?: string;
  readonly CPUPerc?: string;
  readonly MemUsage?: string;
}

interface DockerVolumeInspection {
  readonly CreatedAt?: string;
  readonly Labels?: Record<string, string> | null;
  readonly Name?: string;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => SpawnSyncReturns<string>;

const defaultCommandRunner: CommandRunner = (command, args, cwd) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment({
      overrides:
        command === "docker" && args[0] !== "context"
          ? runtimeDockerEnvironment()
          : {},
    }),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

export const inspectContainerDiskUsage = ({
  cwd = process.cwd(),
  run = defaultCommandRunner,
}: {
  readonly cwd?: string;
  readonly run?: CommandRunner;
} = {}): ContainerDiskUsage | null => {
  const context = readContext(run, cwd);
  return inspectDisk(run, cwd, context);
};

export const assertContainerCapacityForRuntime = ({
  cwd = process.cwd(),
  warningPercent,
  minimumFreeBytes,
  run = defaultCommandRunner,
}: {
  readonly cwd?: string;
  readonly warningPercent: number;
  readonly minimumFreeBytes: number;
  readonly run?: CommandRunner;
}): { readonly warning: string | null } => {
  const disk = inspectContainerDiskUsage({ cwd, run });
  if (!disk) return { warning: null };
  if (disk.availableBytes < minimumFreeBytes) {
    throw new Error(
      `The ${disk.backend} Docker disk has ${(disk.availableBytes / 1024 ** 3).toFixed(1)} GiB free; this runtime requires at least ${(minimumFreeBytes / 1024 ** 3).toFixed(1)} GiB of headroom. Rehearsal did not start any services. Run rehearsal environments and rehearsal cleanup for an ownership-safe preview, or increase the Docker VM disk.`,
    );
  }
  return {
    warning:
      disk.usedPercent >= warningPercent
        ? `Docker disk usage is ${disk.usedPercent}% (${(disk.availableBytes / 1024 ** 3).toFixed(1)} GiB free). Review rehearsal environments and cleanup before space becomes critical.`
        : null,
  };
};

const lines = (value: unknown): string[] =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const parsePosixDiskUsage = (
  output: string,
): Omit<ContainerDiskUsage, "backend"> | null => {
  const columns = lines(output).at(-1)?.split(/\s+/u) ?? [];
  if (columns.length < 6) return null;
  const values = columns.slice(1, 4).map(Number);
  const usedPercent = Number.parseInt(columns[4] ?? "", 10);
  if (![...values, usedPercent].every(Number.isFinite)) return null;
  return {
    totalBytes: values[0]! * 1024,
    usedBytes: values[1]! * 1024,
    availableBytes: values[2]! * 1024,
    usedPercent,
  };
};

const readContext = (run: CommandRunner, cwd: string): string | null => {
  if (run === defaultCommandRunner && runtimeDockerContext() !== null)
    return runtimeDockerContext();
  const result = run("docker", ["context", "show"], cwd);
  return result.status === 0 ? result.stdout.trim() || null : null;
};

const inspectDisk = (
  run: CommandRunner,
  cwd: string,
  context: string | null,
): ContainerDiskUsage | null => {
  if (context !== "colima") return null;
  const result = run(
    "colima",
    ["ssh", "--", "df", "-Pk", "/var/lib/docker"],
    cwd,
  );
  const usage = result.status === 0 ? parsePosixDiskUsage(result.stdout) : null;
  return usage ? { backend: "colima", ...usage } : null;
};

const parseResourceUsage = (output: string): DockerResourceUsage[] =>
  lines(output).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const nullableNumber = (entry: unknown): number | null => {
        const parsed = Number(entry);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const nullableString = (entry: unknown): string | null =>
        typeof entry === "string" && entry ? entry : null;
      return [
        {
          type: String(value.Type ?? "unknown"),
          totalCount: nullableNumber(value.TotalCount),
          activeCount: nullableNumber(value.Active),
          size: nullableString(value.Size),
          reclaimable: nullableString(value.Reclaimable),
        },
      ];
    } catch {
      return [];
    }
  });

const inspectContainers = (
  run: CommandRunner,
  cwd: string,
): readonly DockerContainerInspection[] => {
  const listing = run("docker", ["container", "ls", "--all", "--quiet"], cwd);
  if (listing.status !== 0)
    throw new Error(
      "Container ownership cannot be inspected. Refresh when Docker is available.",
    );
  const ids = lines(listing.stdout);
  if (ids.length > 1000)
    throw new Error("Container inventory exceeds its 1000-container bound.");
  if (ids.length === 0) return [];
  const result = run("docker", ["container", "inspect", ...ids], cwd);
  if (result.status !== 0)
    throw new Error(
      "Containers changed during inspection. Refresh the inventory.",
    );
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== ids.length)
      throw new Error("Container inventory is incomplete.");
    return parsed as DockerContainerInspection[];
  } catch {
    throw new Error("Container inventory is invalid or incomplete.");
  }
};

const inspectVolumes = (
  run: CommandRunner,
  cwd: string,
): readonly DockerVolumeInspection[] => {
  const listing = run("docker", ["volume", "ls", "--quiet"], cwd);
  if (listing.status !== 0)
    throw new Error(
      "Volume ownership cannot be inspected. Refresh the inventory.",
    );
  const ids = lines(listing.stdout);
  if (ids.length > 1000)
    throw new Error("Volume inventory exceeds its 1000-volume bound.");
  if (ids.length === 0) return [];
  const result = run("docker", ["volume", "inspect", ...ids], cwd);
  if (result.status !== 0)
    throw new Error(
      "Volumes changed during inspection. Refresh the inventory.",
    );
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== ids.length)
      throw new Error("Volume inventory is incomplete.");
    return parsed as DockerVolumeInspection[];
  } catch {
    throw new Error("Volume inventory is invalid or incomplete.");
  }
};

export const parseDockerSizeBytes = (value: string): number | null => {
  const match = /^([0-9]+(?:\.[0-9]+)?)([kmgt]?b)$/iu.exec(value.trim());
  if (!match) return null;
  const unit = match[2]!.toLowerCase() as "b" | "kb" | "mb" | "gb" | "tb";
  const multiplier = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
  }[unit];
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : null;
};

export const parseDockerMemoryBytes = (value: string): number | null => {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]i?b|b)$/iu.exec(value.trim());
  if (!match) return null;
  const unit = match[2]!.toLowerCase();
  const multiplier = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  }[unit];
  const amount = Number(match[1]);
  return multiplier && Number.isFinite(amount)
    ? Math.round(amount * multiplier)
    : null;
};

const parseDockerStats = (
  run: CommandRunner,
  cwd: string,
  ids: readonly string[],
): ReadonlyMap<
  string,
  Readonly<{
    cpuPercent: number;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
  }>
> => {
  if (ids.length === 0) return new Map();
  const result = run(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", ...ids],
    cwd,
  );
  if (result.status !== 0) return new Map();
  return new Map(
    lines(result.stdout).flatMap((line) => {
      try {
        const entry = JSON.parse(line) as DockerContainerStats;
        const id = entry.Container?.trim();
        const cpuPercent = Number.parseFloat(
          entry.CPUPerc?.replace(/%$/u, "") ?? "",
        );
        if (!id || !Number.isFinite(cpuPercent)) return [];
        const [usage, limit] = entry.MemUsage?.split("/").map((part) =>
          parseDockerMemoryBytes(part.trim()),
        ) ?? [null, null];
        return [
          [
            id,
            {
              cpuPercent,
              memoryUsageBytes: usage ?? null,
              memoryLimitBytes: limit ?? null,
            },
          ] as const,
        ];
      } catch {
        return [];
      }
    }),
  );
};

const inspectVolumeSizes = (
  run: CommandRunner,
  cwd: string,
): ReadonlyMap<string, number> => {
  const result = run(
    "docker",
    ["system", "df", "--verbose", "--format", "{{json .}}"],
    cwd,
  );
  if (result.status !== 0) return new Map();
  try {
    const value = JSON.parse(result.stdout) as { readonly Volumes?: unknown };
    if (!Array.isArray(value.Volumes)) return new Map();
    return new Map(
      value.Volumes.flatMap((entry) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as { Name?: unknown }).Name !== "string" ||
          typeof (entry as { Size?: unknown }).Size !== "string"
        )
          return [];
        const item = entry as { Name: string; Size: string };
        const bytes = parseDockerSizeBytes(item.Size);
        return bytes === null ? [] : ([[item.Name, bytes]] as const);
      }),
    );
  } catch {
    return new Map();
  }
};

const latestIsoTime = (
  values: readonly (string | undefined)[],
): string | null =>
  values
    .filter((value): value is string =>
      Boolean(value && Number.isFinite(Date.parse(value))),
    )
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

const earliestIsoTime = (
  values: readonly (string | undefined)[],
): string | null =>
  values
    .filter((value): value is string =>
      Boolean(value && Number.isFinite(Date.parse(value))),
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

const labelsFor = (
  container: DockerContainerInspection,
): Record<string, string> => container.Config?.Labels ?? {};

const OWNERSHIP_LABELS = Object.freeze([
  "com.supabase.cli.project",
  "com.rehearsal-db.project",
]);

const ownershipConflicts = (
  labels: Readonly<Record<string, string>>,
  expectedLabel: string,
  projectId: string,
): boolean =>
  labels[expectedLabel] === projectId &&
  OWNERSHIP_LABELS.some(
    (label) =>
      label !== expectedLabel &&
      labels[label] !== undefined &&
      labels[label] !== projectId,
  );

const staleDigest = (
  entries: readonly RehearsalEnvironmentInventoryEntry[],
): string | null => {
  const stopped = entries
    .filter((entry) => entry.cleanupEligibility === "preview-required")
    .map(
      ({
        target,
        projectId,
        provider,
        state,
        containerCount,
        volumeCount,
        diskUsageBytes,
      }) => ({
        target,
        projectId,
        provider,
        state,
        containerCount,
        volumeCount,
        diskUsageBytes,
      }),
    );
  return stopped.length
    ? createHash("sha256").update(JSON.stringify(stopped)).digest("hex")
    : null;
};

export const inspectRehearsalResources = async (
  options: RehearsalConfigPathOptions = {},
  dependencies: {
    readonly run?: CommandRunner;
    readonly now?: () => Date;
    readonly includeDetails?: boolean;
  } = {},
): Promise<RehearsalResourceInventory> => {
  const topology = await loadRuntimeTopology(options);
  const run = dependencies.run ?? defaultCommandRunner;
  const now = dependencies.now ?? (() => new Date());
  const inspectedAt = now();
  const cwd = topology.projectRoot;
  const provenance = await Promise.all(
    topology.targets.map((target) =>
      inspectEnvironmentProvenanceEvidence({
        projectRoot: cwd,
        runtimeWorkdir: target.paths.runtimeWorkdir,
        provider: target.config.runtime.target,
        ports: target.config.runtime.ports,
        applicationUrl: target.config.runtime.applicationUrl,
      }),
    ),
  );
  const withPolicy = async (
    inventory: RehearsalResourceInventory,
  ): Promise<RehearsalResourceInventory> => {
    const reviewedAt = await readResourceReviewReceipt({
      path: join(
        topology.primary.paths.artifactDirectory,
        RESOURCE_REVIEW_RECEIPT_FILENAME,
      ),
      projectRoot: cwd,
      policy: topology.primary.config.resources,
      now: new Date(inventory.inspectedAt),
    });
    return Object.freeze({
      ...inventory,
      policy: evaluateResourcePolicy({
        inventory,
        policy: topology.primary.config.resources,
        lastReviewedAt: reviewedAt,
        now: new Date(inventory.inspectedAt),
      }),
    });
  };
  if (dependencies.includeDetails)
    assertLocalDockerContext({ cwd, runner: run });
  const info = run("docker", ["info"], cwd);
  if (info.status !== 0) {
    return withPolicy(
      Object.freeze({
        schemaVersion: RESOURCE_INVENTORY_SCHEMA_VERSION,
        inspectedAt: inspectedAt.toISOString(),
        engine: Object.freeze({
          state: "stopped",
          context: readContext(run, cwd),
          disk: null,
          resources: Object.freeze([]),
        }),
        ...(dependencies.includeDetails ? { catalog: null } : {}),
        environments: Object.freeze(
          topology.targets.map((target, index) =>
            Object.freeze({
              target: target.name,
              displayName: target.config.runtime.displayName,
              protected: target.config.runtime.protected,
              projectId: target.config.runtime.projectId,
              provider: target.config.runtime.target,
              configPath: target.configPath,
              state: "unavailable" as const,
              containerCount: 0,
              runningContainerCount: 0,
              volumeCount: 0,
              diskUsageBytes: null,
              cpuPercent: null,
              memoryUsageBytes: null,
              memoryLimitBytes: null,
              createdAt: null,
              lastActivityAt: null,
              retention: "persistent" as const,
              cleanupEligibility: "inspection-unavailable" as const,
              restartPolicies: Object.freeze([]),
              provenance: provenance[index]!.provenance,
              classification: classifyConfiguredEnvironment({
                inspectionAvailable: false,
                containerCount: 0,
                volumeCount: 0,
                ...provenance[index]!,
                staleAfterSeconds: target.config.resources.staleAfterSeconds,
                containers: [],
                now: inspectedAt,
              }),
            }),
          ),
        ),
        stale: Object.freeze({
          stoppedCount: 0,
          digest: null,
          targets: Object.freeze([]),
        }),
      }),
    );
  }

  const context = readContext(run, cwd);
  const containers = inspectContainers(run, cwd);
  const volumes = inspectVolumes(run, cwd);
  const volumeSizes = inspectVolumeSizes(run, cwd);
  const ownershipTargets = topology.targets.map((target) => ({
    label:
      target.config.runtime.target === "supabase"
        ? "com.supabase.cli.project"
        : "com.rehearsal-db.project",
    projectId: target.config.runtime.projectId,
  }));
  const stats = parseDockerStats(
    run,
    cwd,
    containers.flatMap((container) => {
      if (!container.Id || container.State?.Running !== true) return [];
      const labels = labelsFor(container);
      return ownershipTargets.some(
        ({ label, projectId }) =>
          labels[label] === projectId &&
          !ownershipConflicts(labels, label, projectId),
      )
        ? [container.Id]
        : [];
    }),
  );
  const environments = topology.targets.map((target, index) => {
    const provider = target.config.runtime.target;
    const projectId = target.config.runtime.projectId;
    const labelName =
      provider === "supabase"
        ? "com.supabase.cli.project"
        : "com.rehearsal-db.project";
    const conflictingContainers = containers.filter((container) =>
      ownershipConflicts(labelsFor(container), labelName, projectId),
    );
    const conflictingVolumes = volumes.filter((volume) =>
      ownershipConflicts(volume.Labels ?? {}, labelName, projectId),
    );
    const hasConflict =
      conflictingContainers.length > 0 || conflictingVolumes.length > 0;
    const owned = hasConflict
      ? []
      : containers.filter(
          (container) => labelsFor(container)[labelName] === projectId,
        );
    const ownedVolumes = hasConflict
      ? []
      : volumes.filter(
          (volume) => (volume.Labels ?? {})[labelName] === projectId,
        );
    const running = owned.filter(
      (container) => container.State?.Running === true,
    );
    const state = hasConflict
      ? ("unavailable" as const)
      : owned.length === 0 && ownedVolumes.length === 0
        ? ("absent" as const)
        : running.length === 0
          ? ("stopped" as const)
          : running.length === owned.length
            ? ("running" as const)
            : ("mixed" as const);
    return Object.freeze({
      target: target.name,
      displayName: target.config.runtime.displayName,
      protected: target.config.runtime.protected,
      projectId,
      provider,
      configPath: target.configPath,
      state,
      containerCount: owned.length,
      runningContainerCount: running.length,
      volumeCount: ownedVolumes.length,
      diskUsageBytes:
        !hasConflict &&
        ownedVolumes.every(
          (volume) => volume.Name && volumeSizes.has(volume.Name),
        )
          ? ownedVolumes.reduce(
              (total, volume) => total + volumeSizes.get(volume.Name!)!,
              0,
            )
          : null,
      cpuPercent:
        running.length === 0 ||
        running.some((entry) => !stats.has(entry.Id ?? ""))
          ? null
          : running.reduce(
              (total, entry) =>
                total + (stats.get(entry.Id ?? "")?.cpuPercent ?? 0),
              0,
            ),
      memoryUsageBytes:
        running.length === 0 ||
        running.some(
          (entry) =>
            stats.get(entry.Id ?? "")?.memoryUsageBytes === null ||
            stats.get(entry.Id ?? "") === undefined,
        )
          ? null
          : running.reduce(
              (total, entry) =>
                total + stats.get(entry.Id ?? "")!.memoryUsageBytes!,
              0,
            ),
      memoryLimitBytes:
        running.length === 0 ||
        running.some(
          (entry) =>
            stats.get(entry.Id ?? "")?.memoryLimitBytes === null ||
            stats.get(entry.Id ?? "") === undefined,
        )
          ? null
          : running.reduce(
              (total, entry) =>
                total + stats.get(entry.Id ?? "")!.memoryLimitBytes!,
              0,
            ),
      createdAt: earliestIsoTime([
        ...owned.map((entry) => entry.Created),
        ...ownedVolumes.map((entry) => entry.CreatedAt),
      ]),
      lastActivityAt: latestIsoTime([
        ...owned.flatMap((entry) => [
          entry.State?.StartedAt,
          entry.State?.FinishedAt,
        ]),
        ...ownedVolumes.map((entry) => entry.CreatedAt),
      ]),
      retention: "persistent" as const,
      cleanupEligibility:
        state === "unavailable"
          ? ("inspection-unavailable" as const)
          : state === "absent"
            ? ("not-present" as const)
            : running.length > 0
              ? ("running" as const)
              : target.config.runtime.protected
                ? ("inspection-unavailable" as const)
                : ("preview-required" as const),
      restartPolicies: Object.freeze(
        [
          ...new Set(
            owned.map(
              (entry) => entry.HostConfig?.RestartPolicy?.Name ?? "unknown",
            ),
          ),
        ].sort(),
      ),
      provenance: provenance[index]!.provenance,
      classification: classifyConfiguredEnvironment({
        inspectionAvailable: !hasConflict,
        containerCount: owned.length,
        volumeCount: ownedVolumes.length,
        ...provenance[index]!,
        staleAfterSeconds: target.config.resources.staleAfterSeconds,
        containers: owned.map((entry) => ({
          running: entry.State?.Running,
          startedAt: entry.State?.StartedAt,
          finishedAt: entry.State?.FinishedAt,
        })),
        now: inspectedAt,
      }),
    });
  });
  const digest = staleDigest(environments);
  return withPolicy(
    Object.freeze({
      schemaVersion: RESOURCE_INVENTORY_SCHEMA_VERSION,
      inspectedAt: inspectedAt.toISOString(),
      engine: Object.freeze({
        state: "running",
        context,
        disk: inspectDisk(run, cwd, context),
        resources: Object.freeze(
          parseResourceUsage(
            run("docker", ["system", "df", "--format", "{{json .}}"], cwd)
              .stdout,
          ),
        ),
      }),
      environments: Object.freeze(environments),
      ...(dependencies.includeDetails
        ? {
            catalog: buildResourceCatalog({
              containers,
              volumes,
              images: inspectCatalogImages(run, cwd),
              volumeSizes,
              targets: topology.targets.map((target) => ({
                name: target.name,
                projectId: target.config.runtime.projectId,
                provider: target.config.runtime.target,
                protected: target.config.runtime.protected,
              })),
            }),
          }
        : {}),
      stale: Object.freeze({
        stoppedCount: environments.filter(
          (entry) => entry.cleanupEligibility === "preview-required",
        ).length,
        digest,
        targets: Object.freeze(
          environments
            .filter((entry) => entry.cleanupEligibility === "preview-required")
            .map((entry) => entry.target),
        ),
      }),
    }),
  );
};

export const assertContainerCapacity = async (
  options: RehearsalConfigPathOptions = {},
): Promise<{ readonly warning: string | null }> => {
  const topology = await loadRuntimeTopology(options);
  const inventory = await inspectRehearsalResources(options);
  const disk = inventory.engine.disk;
  if (!disk) return { warning: null };
  const warningPercent = Math.max(
    ...topology.targets.map(
      (target) => target.config.containerRuntime.diskWarningPercent,
    ),
  );
  const requiredBytes = Math.max(
    ...topology.targets.map(
      (target) => target.config.containerRuntime.minimumFreeBytes,
    ),
  );
  return assertContainerCapacityForRuntime({
    cwd: topology.projectRoot,
    warningPercent,
    minimumFreeBytes: requiredBytes,
  });
};
