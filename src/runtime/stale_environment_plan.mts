/** Exact, non-destructive review of long-running configured environments. No idle daemon. */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import type { RehearsalConfigPathOptions } from "../project/configuration.mjs";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "./local_docker_context.mjs";
import {
  evaluateObservableEnvironmentReview,
  observableContainerTime,
} from "./environment_classification.mjs";
import {
  loadRuntimeTopology,
  type RuntimeTopologyTarget,
} from "./topology.mjs";
export { stopReviewedStaleTarget } from "./stale_environment_stop.mjs";

type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) => SpawnSyncReturns<string>;
const runCommand: Runner = (command, args, cwd, environment) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment ?? scopedDockerEnvironment(),
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

interface Container {
  readonly Id?: string;
  readonly Config?: {
    readonly Labels?: Readonly<Record<string, string>> | null;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly StartedAt?: string;
    readonly FinishedAt?: string;
  };
}

export interface StopStaleTarget {
  readonly target: string;
  readonly projectId: string;
  readonly provider: "postgresql" | "supabase";
  readonly displayName: string;
  readonly configPath: string;
  readonly configurationSha256: string;
  readonly staleAfterSeconds: number;
  readonly lastObservableActivityAt: string;
  readonly containers: readonly Readonly<{
    id: string;
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
  }>[];
}

export interface StopStalePlan {
  readonly schemaVersion: 1;
  readonly action: "stop-stale";
  readonly context: string;
  readonly engineIdentity: string;
  readonly projectRootSha256: string;
  readonly targets: readonly StopStaleTarget[];
  readonly skipped: readonly Readonly<{ target: string; reason: string }>[];
  readonly digest: string;
  readonly preserves: readonly string[];
  readonly activityLimitation: string;
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const createStopStalePlan = ({
  projectRoot,
  targets,
  containers,
  engineIdentity,
  context = "default",
  now = new Date(),
}: {
  readonly projectRoot: string;
  readonly targets: readonly RuntimeTopologyTarget[];
  readonly containers: readonly Container[];
  readonly engineIdentity: string;
  readonly context?: string;
  readonly now?: Date;
}): StopStalePlan => {
  if (!/^[a-f0-9]{64}$/u.test(engineIdentity) || containers.length > 1000)
    throw new Error(
      "The local engine or bounded container inventory cannot be verified.",
    );
  const selected: StopStaleTarget[] = [];
  const skipped: Array<{ target: string; reason: string }> = [];
  for (const target of targets) {
    const cutoff = target.config.resources.staleAfterSeconds;
    const label =
      target.config.runtime.target === "supabase"
        ? "com.supabase.cli.project"
        : "com.rehearsal-db.project";
    const projectId = target.config.runtime.projectId;
    const owned = containers.filter(
      (container) => container.Config?.Labels?.[label] === projectId,
    );
    const conflict = owned.some((container) =>
      ["com.supabase.cli.project", "com.rehearsal-db.project"].some(
        (key) =>
          container.Config?.Labels?.[key] !== undefined &&
          container.Config.Labels[key] !== projectId,
      ),
    );
    const reason =
      cutoff === null
        ? "No stale review cutoff is configured."
        : conflict
          ? "Conflicting ownership labels; this environment cannot be selected."
          : !owned.some((container) => container.State?.Running === true)
            ? "The environment is already stopped or absent."
            : null;
    if (reason) {
      skipped.push({ target: target.name, reason });
      continue;
    }
    if (
      owned.some(
        (container) =>
          !container.Id ||
          !/^[a-f0-9]{64}$/u.test(container.Id) ||
          typeof container.State?.Running !== "boolean",
      ) ||
      new Set(owned.map((container) => container.Id)).size !== owned.length
    ) {
      throw new Error(
        "An owned container has incomplete or conflicting inspection evidence. No environment was stopped.",
      );
    }
    const bindings = owned
      .map((container) =>
        Object.freeze({
          id: container.Id!,
          running: container.State!.Running!,
          startedAt: observableContainerTime(container.State!.StartedAt, now),
          finishedAt: observableContainerTime(container.State!.FinishedAt, now),
        }),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const review = evaluateObservableEnvironmentReview({
      inspectionAvailable: true,
      staleAfterSeconds: cutoff,
      containers: bindings,
      now,
    });
    if (review.state === "unknown") {
      skipped.push({
        target: target.name,
        reason:
          "A running container has no trustworthy start time; activity is unknown.",
      });
      continue;
    }
    const last = review.lastObservableActivityAt;
    if (review.state !== "due" || !last) {
      skipped.push({
        target: target.name,
        reason:
          "The last observable container activity is newer than the configured review cutoff.",
      });
      continue;
    }
    selected.push(
      Object.freeze({
        target: target.name,
        projectId,
        provider: target.config.runtime.target,
        displayName: target.config.runtime.displayName,
        configPath: target.configPath,
        configurationSha256: hash(target.config),
        staleAfterSeconds: cutoff!,
        lastObservableActivityAt: last,
        containers: Object.freeze(bindings),
      }),
    );
  }
  const identity = {
    context,
    engineIdentity,
    projectRootSha256: hash(resolve(projectRoot)),
    targets: selected,
  };
  return Object.freeze({
    schemaVersion: 1,
    action: "stop-stale",
    ...identity,
    targets: Object.freeze(selected),
    skipped: Object.freeze(skipped),
    digest: hash(identity),
    preserves: Object.freeze([
      "database contents",
      "Storage contents",
      "containers",
      "volumes",
      "images",
      "immutable baselines",
      "shared engine",
      "other projects",
    ]),
    activityLimitation:
      "Stale means no recent observable container start/stop. It does not prove application or database inactivity. Stop only after reviewing your active sessions.",
  });
};

export const inspectStopStalePlan = async (
  options: RehearsalConfigPathOptions = {},
  {
    run = runCommand,
    now = () => new Date(),
  }: { readonly run?: Runner; readonly now?: () => Date } = {},
): Promise<StopStalePlan> => {
  const topology = await loadRuntimeTopology(options);
  const inheritedEnvironment = { ...process.env };
  const engine = assertLocalDockerContext({
    cwd: topology.projectRoot,
    inheritedEnvironment,
    runner: run,
  });
  const prefix = ["--host", engine.endpoint];
  const environment = scopedDockerEnvironment({
    inheritedEnvironment,
    endpoint: engine.endpoint,
  });
  const info = run(
    "docker",
    [...prefix, "info"],
    topology.projectRoot,
    environment,
  );
  if (info.status !== 0)
    throw new Error(
      "The local engine is unavailable. Stop-stale inspection never starts it; start your engine explicitly and retry.",
    );
  const listing = run(
    "docker",
    [...prefix, "container", "ls", "--all", "--quiet"],
    topology.projectRoot,
    environment,
  );
  const ids = listing.stdout.trim().split(/\s+/u).filter(Boolean);
  if (
    listing.status !== 0 ||
    ids.length > 1000 ||
    ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id))
  )
    throw new Error("The bounded container inventory cannot be verified.");
  let containers: Container[] = [];
  if (ids.length) {
    const inspected = run(
      "docker",
      [...prefix, "container", "inspect", ...ids],
      topology.projectRoot,
      environment,
    );
    try {
      const value: unknown = JSON.parse(inspected.stdout);
      if (
        inspected.status !== 0 ||
        !Array.isArray(value) ||
        value.length !== ids.length
      )
        throw new Error();
      containers = value as Container[];
    } catch {
      throw new Error(
        "Container inspection is incomplete or changed. Refresh before stopping anything.",
      );
    }
  }
  return createStopStalePlan({
    projectRoot: topology.projectRoot,
    targets: topology.targets,
    containers,
    engineIdentity: engine.identity,
    context: engine.context,
    now: now(),
  });
};

/** Caller holds the project-operation lock; recheck exact bindings immediately before each stop. */
export const applyStopStalePlan = async ({
  preview,
  confirmation,
  refresh,
  stop,
}: {
  readonly preview: StopStalePlan;
  readonly confirmation: string;
  readonly refresh: () => Promise<StopStalePlan>;
  readonly stop: (target: StopStaleTarget) => Promise<void>;
}): Promise<readonly string[]> => {
  const current = await refresh();
  if (confirmation !== preview.digest || current.digest !== preview.digest)
    throw new Error(
      "The exact stop-stale confirmation is missing or stale. No environment was stopped; review a fresh preview.",
    );
  const stopped: string[] = [];
  for (const target of [...preview.targets].reverse()) {
    const fresh = await refresh();
    if (
      fresh.engineIdentity !== preview.engineIdentity ||
      fresh.projectRootSha256 !== preview.projectRootSha256 ||
      hash(fresh.targets.find((entry) => entry.target === target.target)) !==
        hash(target)
    )
      throw new Error(
        "The environment, configuration, activity, or engine changed before stopping. Remaining targets were preserved; review a fresh preview.",
      );
    await stop(target);
    stopped.push(target.target);
  }
  return Object.freeze(stopped);
};
