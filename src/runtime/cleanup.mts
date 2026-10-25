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
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
  type DockerContextRunner,
} from "./local_docker_context.mjs";
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
  readonly daemonId?: string | null;
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
  readonly run?: DockerContextRunner;
  readonly inspectDockerUsage?: (
    projectRoot: string,
    session?: DockerSession | null,
  ) => DockerUsage;
  readonly runtimeDetected?: (
    loaded: LoadedConfiguration,
    session?: DockerSession | null,
  ) => Promise<boolean>;
  readonly inspectUnusedImages?: (
    projectRoot: string,
    session?: DockerSession | null,
  ) => ImageCandidate[];
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

interface DockerSession {
  readonly engine: ReturnType<typeof assertLocalDockerContext>;
  readonly daemonId: string | null;
  readonly query: (
    args: readonly string[],
    allowFailure?: boolean,
  ) => SpawnSyncReturns<string>;
  readonly revalidate: () => void;
}
const commandResult: DockerContextRunner = (
  command,
  args,
  projectRoot,
  environment,
) =>
  spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment ?? scopedDockerEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const selectedDocker = (
  projectRoot: string,
  runner: DockerContextRunner = commandResult,
): DockerSession => {
  const inheritedEnvironment = { ...process.env };
  const engine = assertLocalDockerContext({
    cwd: projectRoot,
    runner,
    inheritedEnvironment,
  });
  const environment = scopedDockerEnvironment({
    inheritedEnvironment,
    endpoint: engine.endpoint,
  });
  const query = (args: readonly string[], allowFailure = false) => {
    const result = runner(
      "docker",
      ["--host", engine.endpoint, ...args],
      projectRoot,
      environment,
    );
    if (!allowFailure && (result.error || result.status !== 0))
      throw new Error(
        "The selected local Docker cleanup probe failed; no fallback engine was used.",
      );
    return result;
  };
  const readDaemon = () => {
    const result = query(["info", "--format", "{{json .ID}}"], true);
    if (result.status !== 0 || result.error) return null;
    try {
      const id: unknown = JSON.parse(result.stdout);
      return typeof id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(id)
        ? id
        : null;
    } catch {
      return null;
    }
  };
  const daemonId = readDaemon();
  return {
    engine,
    daemonId,
    query,
    revalidate: () => {
      const current = assertLocalDockerContext({
        cwd: projectRoot,
        context: engine.context,
        runner,
        inheritedEnvironment,
      });
      if (
        current.identity !== engine.identity ||
        current.dockerConfig !== engine.dockerConfig ||
        !daemonId ||
        readDaemon() !== daemonId
      )
        throw new Error(
          "The Docker endpoint or daemon changed after preview. Nothing further was removed; preview again.",
        );
    },
  };
};
const runDocker = (
  args: readonly string[],
  {
    session,
    allowFailure = false,
  }: {
    projectRoot: string;
    session?: DockerSession | null;
    allowFailure?: boolean;
  },
) => {
  if (!session)
    throw new Error(
      "A reviewed local Docker cleanup session is required; preview again.",
    );
  return session.query(args, allowFailure);
};

const nonEmptyLines = (value: unknown): string[] =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const dockerAvailable = (
  _projectRoot: string,
  session: DockerSession | null = null,
): boolean => !!session?.daemonId;
const inspectDockerUsage = (
  _projectRoot: string,
  session: DockerSession | null = null,
): DockerUsage => {
  if (!session?.daemonId)
    return { available: false, resources: [], disk: null };
  const result = session.query(["system", "df", "--format", "{{json .}}"]);
  return {
    available: true,
    resources: nonEmptyLines(result.stdout).map((line) => JSON.parse(line)),
    disk: null,
    engineIdentity: session.engine.identity,
    daemonId: session.daemonId,
  };
};

const inspectUsedImageIds = (
  projectRoot: string,
  session: DockerSession | null = null,
): Set<string> => {
  const containers = nonEmptyLines(
    runDocker(["container", "ls", "--all", "--quiet"], { projectRoot, session })
      .stdout,
  );
  if (containers.length === 0) return new Set();
  return new Set(
    nonEmptyLines(
      runDocker(
        ["container", "inspect", "--format", "{{.Image}}", ...containers],
        { projectRoot, session },
      ).stdout,
    ),
  );
};

const inspectUnusedImages = (
  projectRoot: string,
  session: DockerSession | null = null,
): ImageCandidate[] => {
  const imageIds = [
    ...new Set(
      nonEmptyLines(
        runDocker(["image", "ls", "--quiet", "--no-trunc"], {
          projectRoot,
          session,
        }).stdout,
      ),
    ),
  ];
  if (imageIds.length === 0) return [];
  const images = nonEmptyLines(
    runDocker(["image", "inspect", "--format", "{{json .}}", ...imageIds], {
      projectRoot,
      session,
    }).stdout,
  ).map((line) => JSON.parse(line) as DockerImage);
  return selectOlderUnusedSupabaseImages({
    images,
    usedImageIds: inspectUsedImageIds(projectRoot, session),
  });
};

const runtimeDetected = async (
  { config, paths, projectRoot }: LoadedConfiguration,
  session: DockerSession | null = null,
): Promise<boolean> => {
  try {
    await stat(paths.runtimeWorkdir);
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  if (!dockerAvailable(projectRoot, session)) return false;
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
      { projectRoot, session },
    );
    const volumes = runDocker(
      [
        "volume",
        "ls",
        "--filter",
        `label=com.rehearsal-db.project=${config.runtime.projectId}`,
        "--quiet",
      ],
      { projectRoot, session },
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
    { projectRoot, session },
  );
  const volumes = nonEmptyLines(
    runDocker(["volume", "ls", "--format", "{{.Name}}"], {
      projectRoot,
      session,
    }).stdout,
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
  cleanupProtocol: 2,
  engineIdentity: plan.images.requested
    ? (plan.docker.engineIdentity ?? null)
    : null,
  daemonId: plan.images.requested ? (plan.docker.daemonId ?? null) : null,
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
  inspection = {},
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
  let session: DockerSession | null = null;
  if (!inspection.inspectDockerUsage) {
    try {
      session = selectedDocker(loaded.projectRoot, inspection.run);
    } catch (error) {
      if (
        includeImages ||
        process.env.DOCKER_CONTEXT ||
        process.env.DOCKER_HOST ||
        process.env.DOCKER_CONFIG ||
        process.env.DOCKER_TLS_VERIFY ||
        process.env.DOCKER_TLS ||
        process.env.DOCKER_CERT_PATH
      )
        throw error;
    }
  }
  const docker = (inspection.inspectDockerUsage ?? inspectDockerUsage)(
    loaded.projectRoot,
    session,
  );
  if (
    includeImages &&
    docker.available &&
    (!docker.engineIdentity || !docker.daemonId) &&
    !inspection.inspectDockerUsage
  )
    throw new Error(
      "Image cleanup requires a verified endpoint and daemon; preview again.",
    );
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
              session,
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
        : await (inspection.runtimeDetected ?? runtimeDetected)(
            { ...loaded },
            session,
          ),
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
  daemonId,
  runner,
}: {
  candidates: readonly ImageCandidate[];
  projectRoot: string;
  engineIdentity: string | null;
  daemonId: string | null;
  runner?: DockerContextRunner;
}): string[] => {
  if (!candidates.length) return [];
  if (!engineIdentity || !daemonId)
    throw new Error(
      "Image cleanup requires a fresh endpoint and daemon-bound preview. Nothing was removed.",
    );
  const session = selectedDocker(projectRoot, runner);
  if (
    session.engine.identity !== engineIdentity ||
    session.daemonId !== daemonId
  )
    throw new Error(
      "The Docker endpoint or daemon changed after preview. Nothing was removed; preview again.",
    );
  const removed: string[] = [];
  for (const candidate of candidates) {
    session.revalidate();
    if (inspectUsedImageIds(projectRoot, session).has(candidate.id))
      throw new Error(
        "A selected image is now used by a container. Cleanup stopped; preview again.",
      );
    for (const tag of candidate.tags) {
      const image = session.query(
        ["image", "inspect", "--format", "{{.Id}}", tag],
        true,
      );
      if (
        image.status !== 0 ||
        image.error ||
        image.stdout.trim() !== candidate.id
      )
        throw new Error(
          "A selected image tag changed after preview. Cleanup stopped; preview again.",
        );
      session.revalidate();
      // Recheck use immediately before every mutation; no force or global prune.
      if (inspectUsedImageIds(projectRoot, session).has(candidate.id))
        throw new Error(
          "A container began using the selected image. Cleanup stopped; preview again.",
        );
      session.revalidate();
      session.query(["image", "rm", tag]);
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
    daemonId: refreshed.docker.daemonId ?? null,
    ...(inspection?.run ? { runner: inspection.run } : {}),
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
