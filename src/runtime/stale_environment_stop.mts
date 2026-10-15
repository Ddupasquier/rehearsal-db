/** Stop only reviewed immutable container IDs; never delete, reset, or release an engine. */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { assertDockerResourceLabels } from "../targets/docker_resource_ownership.mjs";
import { assertLocalDockerContext } from "./local_docker_context.mjs";
import type {
  StopStalePlan,
  StopStaleTarget,
} from "./stale_environment_plan.mjs";

type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => SpawnSyncReturns<string>;
const runInspection: Runner = (command, args, cwd) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface ContainerBinding {
  Id?: string;
  Config?: { Labels?: unknown };
  State?: { Running?: boolean; StartedAt?: string; FinishedAt?: string };
}

const inspectBindings = (
  projectRoot: string,
  endpoint: string,
  target: StopStaleTarget,
  run: Runner,
): ContainerBinding[] => {
  const result = run(
    "docker",
    [
      "--host",
      endpoint,
      "container",
      "inspect",
      ...target.containers.map((container) => container.id),
    ],
    projectRoot,
  );
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      result.status !== 0 ||
      !Array.isArray(parsed) ||
      parsed.length !== target.containers.length
    )
      throw new Error();
    const containers = parsed as ContainerBinding[];
    const ids = new Set(containers.map((container) => container.Id));
    if (
      ids.size !== containers.length ||
      target.containers.some((binding) => !ids.has(binding.id))
    )
      throw new Error();
    for (const container of containers)
      assertDockerResourceLabels({
        labels: container.Config?.Labels,
        expectedLabel:
          target.provider === "supabase"
            ? "com.supabase.cli.project"
            : "com.rehearsal-db.project",
        projectId: target.projectId,
      });
    return containers;
  } catch {
    throw new Error(
      "Reviewed container identity or ownership changed. No further stop action was performed; review a fresh plan.",
    );
  }
};

const normalizedTime = (time: string | undefined): string | null =>
  time && Number.isFinite(Date.parse(time)) && Date.parse(time) > 0
    ? time
    : null;

export const stopReviewedStaleTarget = async ({
  projectRoot,
  plan,
  target,
  run = runInspection,
  execute = runOwnedProcess,
}: {
  readonly projectRoot: string;
  readonly plan: StopStalePlan;
  readonly target: StopStaleTarget;
  readonly run?: Runner;
  readonly execute?: typeof runOwnedProcess;
}): Promise<void> => {
  if (
    hash(resolve(projectRoot)) !== plan.projectRootSha256 ||
    !plan.targets.some((entry) => hash(entry) === hash(target)) ||
    !target.containers.length ||
    target.containers.length > 1000 ||
    target.containers.some((container) => !/^[a-f0-9]{64}$/u.test(container.id))
  )
    throw new Error(
      "The stop target is not bound to the reviewed project and immutable container set.",
    );
  const engine = assertLocalDockerContext({
    cwd: projectRoot,
    context: plan.context,
    runner: run,
  });
  if (engine.identity !== plan.engineIdentity)
    throw new Error(
      "The reviewed local Docker endpoint changed before stopping.",
    );
  const containers = inspectBindings(projectRoot, engine.endpoint, target, run);
  for (const binding of target.containers) {
    const container = containers.find((entry) => entry.Id === binding.id)!;
    if (
      container.State?.Running !== binding.running ||
      normalizedTime(container.State?.StartedAt) !== binding.startedAt ||
      normalizedTime(container.State?.FinishedAt) !== binding.finishedAt
    )
      throw new Error(
        "Reviewed container state or activity changed before stopping. Review a fresh plan.",
      );
  }
  const ids = target.containers
    .filter((container) => container.running)
    .map((container) => container.id);
  if (!ids.length) return;
  const timeout = AbortSignal.timeout(60_000);
  const cancellation = getOperationCancellationSignal();
  const result = await execute({
    command: "docker",
    args: ["--host", engine.endpoint, "container", "stop", ...ids],
    cwd: projectRoot,
    env: createCleanProcessEnvironment(),
    stdin: "ignore",
    signal: cancellation ? AbortSignal.any([cancellation, timeout]) : timeout,
    cancellationGraceMs: 5000,
  });
  throwIfOperationCancelled();
  if (result.error || result.status !== 0 || timeout.aborted)
    throw new Error(
      "The reviewed container stop did not complete. Data and the shared engine were not deleted; inspect current state before retrying.",
    );
  const stopped = inspectBindings(projectRoot, engine.endpoint, target, run);
  if (stopped.some((container) => container.State?.Running !== false))
    throw new Error(
      "A reviewed container resumed or its stopped state could not be proved. No new container was stopped; inspect current state.",
    );
};
