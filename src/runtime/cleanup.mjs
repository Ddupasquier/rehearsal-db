/**
 * Purpose: Preview and apply narrowly scoped Rehearsal cleanup without global
 * Docker pruning or deletion of unowned database resources.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  planBaselineGenerationPrune,
  pruneBaselineGenerations,
} from "../baseline/artifact.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";

const SUPABASE_IMAGE_PREFIX = "public.ecr.aws/supabase/";

const commandResult = (command, args, { projectRoot }) =>
  spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const runDocker = (args, { projectRoot, allowFailure = false }) => {
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

const nonEmptyLines = (value) =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const dockerAvailable = (projectRoot) =>
  runDocker(["info"], { projectRoot, allowFailure: true }).status === 0;

export const parsePosixDiskUsage = (output) => {
  const columns = nonEmptyLines(output).at(-1)?.split(/\s+/u) ?? [];
  if (columns.length < 6) return null;
  const totalKiB = Number(columns[1]);
  const usedKiB = Number(columns[2]);
  const availableKiB = Number(columns[3]);
  const usedPercent = Number.parseInt(columns[4], 10);
  if (![totalKiB, usedKiB, availableKiB, usedPercent].every(Number.isFinite)) {
    return null;
  }
  return {
    totalBytes: totalKiB * 1024,
    usedBytes: usedKiB * 1024,
    availableBytes: availableKiB * 1024,
    usedPercent,
  };
};

const inspectContainerDisk = (projectRoot) => {
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

const inspectDockerUsage = (projectRoot) => {
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

const inspectUsedImageIds = (projectRoot) => {
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

const splitImageTag = (value) => {
  const separator = value.lastIndexOf(":");
  if (separator <= value.lastIndexOf("/")) return null;
  return {
    repository: value.slice(0, separator),
    tag: value.slice(separator + 1),
  };
};

export const selectOlderUnusedSupabaseImages = ({ images, usedImageIds }) => {
  const byRepository = new Map();
  for (const image of images) {
    for (const fullTag of image.RepoTags ?? []) {
      const parsed = splitImageTag(fullTag);
      if (!parsed?.repository.startsWith(SUPABASE_IMAGE_PREFIX)) continue;
      const entries = byRepository.get(parsed.repository) ?? [];
      entries.push({
        id: image.Id,
        createdAt: image.Created,
        bytes: image.Size,
        fullTag,
      });
      byRepository.set(parsed.repository, entries);
    }
  }

  const candidatesById = new Map();
  for (const entries of byRepository.values()) {
    const newestId = [...entries].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )[0]?.id;
    for (const entry of entries) {
      if (entry.id === newestId || usedImageIds.has(entry.id)) continue;
      const existing = candidatesById.get(entry.id) ?? {
        id: entry.id,
        createdAt: entry.createdAt,
        bytes: entry.bytes,
        tags: [],
      };
      existing.tags.push(entry.fullTag);
      candidatesById.set(entry.id, existing);
    }
  }
  return [...candidatesById.values()]
    .map((entry) => ({ ...entry, tags: [...new Set(entry.tags)].sort() }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

const inspectUnusedImages = (projectRoot) => {
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
  ).map((line) => JSON.parse(line));
  return selectOlderUnusedSupabaseImages({
    images,
    usedImageIds: inspectUsedImageIds(projectRoot),
  });
};

const runtimeDetected = async ({ config, paths, projectRoot }) => {
  try {
    await stat(paths.runtimeWorkdir);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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

const inspectBaselineCleanup = async ({ artifactRoot, retain }) => {
  try {
    return {
      available: true,
      ...(await planBaselineGenerationPrune({ artifactRoot, retain })),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { available: false, retained: [], removed: [] };
    }
    throw error;
  }
};

const cleanupIdentity = (plan) => ({
  projectId: plan.projectId,
  retainBaselineGenerations: plan.retainBaselineGenerations,
  baselineGenerations: plan.baselines.removed,
  runtime: plan.runtime.included && plan.runtime.detected,
  images: plan.images.candidates.map(({ id, tags }) => ({ id, tags })),
});

const cleanupDigest = (plan) =>
  createHash("sha256")
    .update(JSON.stringify(cleanupIdentity(plan)))
    .digest("hex");

export const planRehearsalCleanup = async ({
  projectRoot = process.cwd(),
  configPath,
  includeRuntime = false,
  includeImages = false,
  inspection = { inspectDockerUsage, runtimeDetected },
} = {}) => {
  const loaded = await loadRehearsalConfig({ projectRoot, configPath });
  const docker = inspection.inspectDockerUsage(loaded.projectRoot);
  const baselines = await inspectBaselineCleanup({
    artifactRoot: loaded.paths.artifactDirectory,
    retain: loaded.config.cleanup.retainBaselineGenerations,
  });
  const images = {
    requested: includeImages,
    inspected: includeImages && docker.available,
    candidates:
      includeImages && docker.available
        ? inspectUnusedImages(loaded.projectRoot)
        : [],
  };
  const plan = {
    project: loaded.config.project.name,
    projectId: loaded.config.runtime.projectId,
    target: loaded.config.runtime.target,
    retainBaselineGenerations: loaded.config.cleanup.retainBaselineGenerations,
    baselines,
    runtime: {
      included: includeRuntime,
      detected: await inspection.runtimeDetected({ ...loaded }),
    },
    images,
    docker,
  };
  return Object.freeze({ ...plan, digest: cleanupDigest(plan) });
};

const removePlannedImages = ({ candidates, projectRoot }) => {
  if (candidates.length === 0) return [];
  const usedImageIds = inspectUsedImageIds(projectRoot);
  const removed = [];
  for (const candidate of candidates) {
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
      if (inspection.status !== 0) continue;
      if (inspection.stdout.trim() !== candidate.id) {
        throw new Error(
          `Cleanup stopped because ${tag} changed after the preview. Preview the cleanup again.`,
        );
      }
      runDocker(["image", "rm", tag], { projectRoot });
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
} = {}) => {
  if (confirmation !== plan?.digest) {
    throw new Error(
      "Cleanup requires the exact --confirm-cleanup digest from a fresh preview. Nothing was removed.",
    );
  }
  const refreshed = await planRehearsalCleanup({
    projectRoot,
    configPath,
    includeRuntime: plan.runtime.included,
    includeImages: plan.images.inspected,
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
  const loaded = await loadRehearsalConfig({ projectRoot, configPath });
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
  });
  return {
    project: refreshed.project,
    projectId: refreshed.projectId,
    baselines,
    runtimeRemoved: refreshed.runtime.included && refreshed.runtime.detected,
    imagesRemoved: images,
  };
};
