/**
 * Purpose: Preview and apply narrowly scoped Rehearsal cleanup without global
 * Docker pruning or deletion of unowned database resources.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  planBaselineGenerationPrune,
  pruneBaselineGenerations,
} from "../baseline/artifact.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import { parsePosixDiskUsage } from "./resource_inventory.mjs";
import { assertLocalDockerContext } from "./local_docker_context.mjs";
import {
  writeResourceReviewReceipt,
  RESOURCE_REVIEW_RECEIPT_FILENAME,
} from "./resource_policy.mjs";
import {
  selectOlderUnusedSupabaseImages,
  selectImageCleanupSubset,
} from "./resource_images.mjs";
export { selectOlderUnusedSupabaseImages } from "./resource_images.mjs";
export { parsePosixDiskUsage } from "./resource_inventory.mjs";

type LoadedConfiguration = Awaited<ReturnType<typeof loadRehearsalConfig>>;

interface DiskUsage {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly usedPercent: number;
}

interface ContainerDiskUsage extends DiskUsage {
  readonly backend: "colima";
}

interface DockerUsage {
  readonly available: boolean;
  readonly resources: unknown[];
  readonly disk: ContainerDiskUsage | null;
  readonly engineIdentity?: string | null;
}

interface DockerImage {
  readonly Id: string;
  readonly Created: string;
  readonly Size: number;
  readonly RepoTags?: readonly string[];
}

interface ImageCandidate {
  readonly id: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly tags: string[];
}

interface CleanupInspection {
  readonly inspectDockerUsage: (projectRoot: string) => DockerUsage;
  readonly runtimeDetected: (loaded: LoadedConfiguration) => Promise<boolean>;
  readonly inspectUnusedImages?: (projectRoot: string) => ImageCandidate[];
}

export interface RehearsalCleanupPlan {
  readonly project: string;
  readonly projectId: string;
  readonly target: "supabase" | "postgresql";
  readonly retainBaselineGenerations: number;
  readonly imagesOnly: boolean;
  readonly selectedImageIds?: readonly string[];
  readonly baselines: Readonly<{
    available: boolean;
    retained: string[];
    removed: string[];
  }>;
  readonly runtime: Readonly<{
    included: boolean;
    detected: boolean;
    protected: boolean;
  }>;
  readonly images: Readonly<{
    requested: boolean;
    inspected: boolean;
    candidates: ImageCandidate[];
  }>;
  readonly docker: DockerUsage;
  readonly digest: string;
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const commandResult = (
  command: string,
  args: readonly string[],
  { projectRoot }: { projectRoot: string },
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

const runDocker = (
  args: readonly string[],
  {
    projectRoot,
    allowFailure = false,
  }: { projectRoot: string; allowFailure?: boolean },
): SpawnSyncReturns<string> => {
  const result = commandResult("docker", args, { projectRoot });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `docker ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result;
};

const nonEmptyLines = (value: unknown): string[] =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const dockerAvailable = (projectRoot: string): boolean =>
  runDocker(["info"], { projectRoot, allowFailure: true }).status === 0;

const inspectContainerDisk = (
  projectRoot: string,
): ContainerDiskUsage | null => {
  const context = commandResult("docker", ["context", "show"], {
    projectRoot,
  });
  if (context.status !== 0 || context.stdout.trim() !== "colima") return null;
  const result = commandResult(
    "colima",
    ["ssh", "--", "df", "-Pk", "/var/lib/docker"],
    { projectRoot },
  );
  const usage = result.status === 0 ? parsePosixDiskUsage(result.stdout) : null;
  return usage ? { backend: "colima", ...usage } : null;
};

const inspectDockerUsage = (projectRoot: string): DockerUsage => {
  if (!dockerAvailable(projectRoot)) {
    return { available: false, resources: [], disk: null };
  }
  const result = runDocker(["system", "df", "--format", "{{json .}}"], {
    projectRoot,
  });
  return {
    available: true,
    resources: nonEmptyLines(result.stdout).map((line) => JSON.parse(line)),
    disk: inspectContainerDisk(projectRoot),
  };
};

const inspectUsedImageIds = (projectRoot: string): Set<string> => {
  const containers = nonEmptyLines(
    runDocker(["container", "ls", "--all", "--quiet"], { projectRoot }).stdout,
  );
  if (containers.length === 0) return new Set();
  return new Set(
    nonEmptyLines(
      runDocker(
        ["container", "inspect", "--format", "{{.Image}}", ...containers],
        { projectRoot },
      ).stdout,
    ),
  );
};

const inspectUnusedImages = (projectRoot: string): ImageCandidate[] => {
  const imageIds = [
    ...new Set(
      nonEmptyLines(
        runDocker(["image", "ls", "--quiet", "--no-trunc"], {
          projectRoot,
        }).stdout,
      ),
    ),
  ];
  if (imageIds.length === 0) return [];
  const images = nonEmptyLines(
    runDocker(["image", "inspect", "--format", "{{json .}}", ...imageIds], {
      projectRoot,
    }).stdout,
  ).map((line) => JSON.parse(line) as DockerImage);
  return selectOlderUnusedSupabaseImages({
    images,
    usedImageIds: inspectUsedImageIds(projectRoot),
  });
};

const runtimeDetected = async ({
  config,
  paths,
  projectRoot,
}: LoadedConfiguration): Promise<boolean> => {
  try {
    await stat(paths.runtimeWorkdir);
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  if (!dockerAvailable(projectRoot)) return false;
  if (config.runtime.target === "postgresql") {
    const containers = runDocker(
      [
        "container",
        "ls",
        "--all",
        "--filter",
        `label=com.rehearsal-db.project=${config.runtime.projectId}`,
        "--quiet",
      ],
      { projectRoot },
    );
    const volumes = runDocker(
      [
        "volume",
        "ls",
        "--filter",
        `label=com.rehearsal-db.project=${config.runtime.projectId}`,
        "--quiet",
      ],
      { projectRoot },
    );
    return (
      nonEmptyLines(containers.stdout).length > 0 ||
      nonEmptyLines(volumes.stdout).length > 0
    );
  }
  const containers = runDocker(
    [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=com.supabase.cli.project=${config.runtime.projectId}`,
      "--quiet",
    ],
    { projectRoot },
  );
  const volumes = nonEmptyLines(
    runDocker(["volume", "ls", "--format", "{{.Name}}"], { projectRoot })
      .stdout,
  );
  return (
    nonEmptyLines(containers.stdout).length > 0 ||
    volumes.some((name) => name.endsWith(`_${config.runtime.projectId}`))
  );
};

const inspectBaselineCleanup = async ({
  artifactRoot,
  retain,
}: {
  artifactRoot: string;
  retain: number;
}): Promise<{
  available: boolean;
  retained: string[];
  removed: string[];
}> => {
  try {
    return {
      available: true,
      ...(await planBaselineGenerationPrune({ artifactRoot, retain })),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { available: false, retained: [], removed: [] };
    }
    throw error;
  }
};

const cleanupIdentity = (plan: Omit<RehearsalCleanupPlan, "digest">) => ({
  projectId: plan.projectId,
  engineIdentity: plan.docker.engineIdentity ?? null,
  imagesOnly: plan.imagesOnly,
  protectedRuntime: plan.runtime.protected,
  retainBaselineGenerations: plan.retainBaselineGenerations,
  baselineGenerations: plan.baselines.removed,
  runtime: plan.runtime.included && plan.runtime.detected,
  images: plan.images.candidates.map(({ id, tags }) => ({ id, tags })),
});

const cleanupDigest = (plan: Omit<RehearsalCleanupPlan, "digest">): string =>
  createHash("sha256")
    .update(JSON.stringify(cleanupIdentity(plan)))
    .digest("hex");

export const planRehearsalCleanup = async ({
  projectRoot = process.cwd(),
  configPath,
  includeRuntime = false,
  includeImages = false,
  selectedImageIds,
  imagesOnly = false,
  inspection = { inspectDockerUsage, runtimeDetected },
}: {
  projectRoot?: string;
  configPath?: string;
  includeRuntime?: boolean;
  includeImages?: boolean;
  selectedImageIds?: readonly string[];
  imagesOnly?: boolean;
  inspection?: CleanupInspection;
} = {}): Promise<RehearsalCleanupPlan> => {
  const loaded = await loadRehearsalConfig({
    projectRoot,
    ...(configPath === undefined ? {} : { configPath }),
  });
  if (imagesOnly && includeRuntime)
    throw new Error("Image-only cleanup cannot include a database runtime.");
  if (selectedImageIds !== undefined && !includeImages)
    throw new Error(
      "Image selection requires --include-images or --images-only.",
    );
  if (includeRuntime && loaded.config.runtime.protected)
    throw new Error(
      "This environment is protected. Unprotect it in the reviewed configuration before runtime cleanup.",
    );
  const engine =
    includeImages && inspection.inspectDockerUsage === inspectDockerUsage
      ? assertLocalDockerContext({ cwd: loaded.projectRoot })
      : null;
  const docker = {
    ...inspection.inspectDockerUsage(loaded.projectRoot),
    engineIdentity: engine?.identity ?? null,
  };
  if (selectedImageIds !== undefined && !docker.available)
    throw new Error(
      "Docker is stopped or unavailable. Image selections cannot be verified.",
    );
  const baselines = imagesOnly
    ? { available: false, retained: [], removed: [] }
    : await inspectBaselineCleanup({
        artifactRoot: loaded.paths.artifactDirectory,
        retain: loaded.config.cleanup.retainBaselineGenerations,
      });
  const images = {
    requested: includeImages,
    inspected: includeImages && docker.available,
    candidates:
      includeImages && docker.available
        ? selectImageCleanupSubset(
            (inspection.inspectUnusedImages ?? inspectUnusedImages)(
              loaded.projectRoot,
            ),
            selectedImageIds,
          )
        : [],
  };
  const plan: Omit<RehearsalCleanupPlan, "digest"> = {
    project: loaded.config.project.name,
    projectId: loaded.config.runtime.projectId,
    target: loaded.config.runtime.target,
    retainBaselineGenerations: loaded.config.cleanup.retainBaselineGenerations,
    imagesOnly,
    ...(selectedImageIds === undefined
      ? {}
      : { selectedImageIds: [...selectedImageIds].sort() }),
    baselines,
    runtime: {
      included: includeRuntime,
      detected: imagesOnly
        ? false
        : await inspection.runtimeDetected({ ...loaded }),
      protected: loaded.config.runtime.protected,
    },
    images,
    docker,
  };
  return Object.freeze({ ...plan, digest: cleanupDigest(plan) });
};

const removePlannedImages = ({
  candidates,
  projectRoot,
  engineIdentity,
}: {
  candidates: readonly ImageCandidate[];
  projectRoot: string;
  engineIdentity: string | null;
}): string[] => {
  if (candidates.length === 0) return [];
  const removed: string[] = [];
  for (const candidate of candidates) {
    const engine = assertLocalDockerContext({ cwd: projectRoot });
    if (engine.identity !== engineIdentity)
      throw new Error(
        "The Docker engine changed after preview. Nothing further was removed; preview again.",
      );
    const usedImageIds = inspectUsedImageIds(projectRoot);
    if (usedImageIds.has(candidate.id)) {
      throw new Error(
        `Cleanup stopped because a container began using ${candidate.id}. Preview the cleanup again.`,
      );
    }
    for (const tag of candidate.tags) {
      const inspection = runDocker(
        ["image", "inspect", "--format", "{{.Id}}", tag],
        { projectRoot, allowFailure: true },
      );
      if (inspection.status !== 0)
        throw new Error(
          "A selected image tag disappeared after preview. Cleanup stopped; refresh and preview again.",
        );
      if (inspection.stdout.trim() !== candidate.id) {
        throw new Error(
          `Cleanup stopped because ${tag} changed after the preview. Preview the cleanup again.`,
        );
      }
      const currentEngine = assertLocalDockerContext({ cwd: projectRoot });
      if (currentEngine.identity !== engineIdentity)
        throw new Error(
          "The Docker engine changed after preview. Cleanup stopped.",
        );
      runDocker(["--context", currentEngine.context, "image", "rm", tag], {
        projectRoot,
      });
      removed.push(tag);
    }
  }
  return removed;
};

export const applyRehearsalCleanup = async ({
  plan,
  confirmation,
  projectRoot = process.cwd(),
  configPath,
  removeRuntime = async () => undefined,
  inspection,
}: {
  plan?: RehearsalCleanupPlan;
  confirmation?: string;
  projectRoot?: string;
  configPath?: string;
  removeRuntime?: () => Promise<unknown>;
  inspection?: CleanupInspection;
} = {}) => {
  if (!plan || confirmation !== plan.digest) {
    throw new Error(
      "Cleanup requires the exact --confirm-cleanup digest from a fresh preview. Nothing was removed.",
    );
  }
  const refreshed = await planRehearsalCleanup({
    projectRoot,
    ...(configPath === undefined ? {} : { configPath }),
    includeRuntime: plan.runtime.included,
    includeImages: plan.images.inspected,
    imagesOnly: plan.imagesOnly,
    ...(plan.selectedImageIds === undefined
      ? {}
      : { selectedImageIds: plan.selectedImageIds }),
    ...(inspection ? { inspection } : {}),
  });
  if (refreshed.digest !== plan.digest) {
    throw new Error(
      "Cleanup targets changed after the preview. Nothing was removed; preview the cleanup again.",
    );
  }
  if (plan.images.requested && !refreshed.images.inspected) {
    throw new Error(
      "Docker is unavailable, so Rehearsal cannot verify or remove unused images.",
    );
  }
  if (refreshed.runtime.included && refreshed.runtime.detected) {
    await removeRuntime();
  }
  const loaded = await loadRehearsalConfig({
    projectRoot,
    ...(configPath === undefined ? {} : { configPath }),
  });
  const baselines = refreshed.baselines.available
    ? await pruneBaselineGenerations({
        artifactRoot: loaded.paths.artifactDirectory,
        retain: refreshed.retainBaselineGenerations,
        expectedRemoved: refreshed.baselines.removed,
      })
    : { retained: [], removed: [] };
  const images = removePlannedImages({
    candidates: refreshed.images.candidates,
    projectRoot: loaded.projectRoot,
    engineIdentity: refreshed.docker.engineIdentity ?? null,
  });
  await writeResourceReviewReceipt({
    path: join(
      loaded.paths.artifactDirectory,
      RESOURCE_REVIEW_RECEIPT_FILENAME,
    ),
    projectRoot: loaded.projectRoot,
    policy: loaded.config.resources,
  });
  return {
    project: refreshed.project,
    projectId: refreshed.projectId,
    baselines,
    runtimeRemoved: refreshed.runtime.included && refreshed.runtime.detected,
    imagesRemoved: images,
  };
};
