/** Bound failed startup cleanup to exact, newly activated project-owned containers. */
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SpawnSyncReturns } from "node:child_process";
import { loadRehearsalConfig } from "../../project/configuration.mjs";
import type { NormalizedRehearsalConfig } from "../../project/configuration.mjs";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
import { inspectProjectOperationState } from "../../shared/operation_guard.mjs";
import {
  reachOperationCancellationCheckpoint,
  withOperationCancellationShield,
} from "../../shared/cancellation.mjs";
import { runOwnedProcess } from "../../shared/owned_process.mjs";
import { assertDockerResourceLabels } from "../../targets/docker_resource_ownership.mjs";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "../engines/local_docker_context.mjs";
import {
  assertRuntimeConfigurationBinding,
  runtimeConfigurationSha256,
} from "./configuration_binding.mjs";
import { runtimeCompletionAction } from "./persistence.mjs";

export interface StartupContainer {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  readonly startedAt: string | null;
}
type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) => SpawnSyncReturns<string>;
const inspectCommand: Runner = (command, args, cwd, environment) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env:
      environment ??
      (command === "docker"
        ? scopedDockerEnvironment()
        : createCleanProcessEnvironment()),
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
const INSPECTION_FORMAT =
  "{{json .Id}}\t{{json .Name}}\t{{json .State.Running}}\t{{json .State.StartedAt}}\t{{json .Config.Labels}}";
const startupScopes = new AsyncLocalStorage<{ readonly capture: () => void }>();
/** Capture after explicit engine/preflight success, before the first target mutation. */
export const captureRuntimeStartupOwnership = (): void =>
  startupScopes.getStore()?.capture();

export const parseStartupContainers = ({
  output,
  ids,
  projectId,
  provider,
}: {
  readonly output: string;
  readonly ids: readonly string[];
  readonly projectId: string;
  readonly provider: "supabase" | "postgresql";
}): readonly StartupContainer[] => {
  const lines = output.trim().split("\n").filter(Boolean);
  if (
    ids.length > 1000 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)) ||
    lines.length !== ids.length
  )
    throw new Error("Bounded startup ownership inspection is incomplete.");
  const containers = lines.map((line): StartupContainer => {
    const fields = line.split("\t");
    if (fields.length !== 5)
      throw new Error("Startup ownership metadata is malformed.");
    const [id, rawName, running, rawStartedAt, labels]: unknown[] = fields.map(
      (field) => JSON.parse(field),
    );
    if (
      typeof id !== "string" ||
      !ids.includes(id) ||
      typeof rawName !== "string" ||
      !/^\/[a-zA-Z0-9_.-]{1,128}$/u.test(rawName) ||
      typeof running !== "boolean" ||
      typeof rawStartedAt !== "string"
    )
      throw new Error("Startup container identity or state is unavailable.");
    const startedAt =
      Number.isFinite(Date.parse(rawStartedAt)) && Date.parse(rawStartedAt) > 0
        ? rawStartedAt
        : null;
    if (running && startedAt === null)
      throw new Error("Running container startup time is unavailable.");
    assertDockerResourceLabels({
      labels,
      expectedLabel:
        provider === "supabase"
          ? "com.supabase.cli.project"
          : "com.rehearsal-db.project",
      projectId,
    });
    return Object.freeze({ id, name: rawName.slice(1), running, startedAt });
  });
  if (
    new Set(containers.map((entry) => entry.id)).size !== ids.length ||
    new Set(containers.map((entry) => entry.name)).size !== ids.length
  )
    throw new Error("Startup container identities are ambiguous.");
  return Object.freeze(containers);
};

export const selectNewStartupWorkloads = (
  before: readonly StartupContainer[],
  after: readonly StartupContainer[],
): readonly StartupContainer[] => {
  const runningNames = new Set(
    before.filter((entry) => entry.running).map((entry) => entry.name),
  );
  return after.filter((entry) => {
    if (!entry.running || runningNames.has(entry.name)) return false;
    const previous = before.find((container) => container.id === entry.id);
    if (previous?.running) return false;
    if (previous && entry.startedAt === previous.startedAt)
      throw new Error(
        "A stopped container's new startup could not be proved; owned resources were retained.",
      );
    return true;
  });
};

const readContainers = ({
  projectRoot,
  endpoint,
  projectId,
  provider,
  run,
  ids,
}: {
  projectRoot: string;
  endpoint: string;
  projectId: string;
  provider: "supabase" | "postgresql";
  run: Runner;
  ids?: readonly string[];
}): readonly StartupContainer[] => {
  let selected = ids;
  if (selected === undefined) {
    const listed = run(
      "docker",
      [
        "--host",
        endpoint,
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${provider === "supabase" ? "com.supabase.cli.project" : "com.rehearsal-db.project"}=${projectId}`,
        "--format",
        "{{.ID}}",
      ],
      projectRoot,
    );
    if (listed.status !== 0)
      throw new Error(
        "Container engine startup ownership is unavailable; start or diagnose the local engine explicitly. No new target action was performed.",
      );
    selected = listed.stdout.trim().split(/\s+/u).filter(Boolean);
  }
  if (!selected.length) return Object.freeze([]);
  if (
    selected.length > 1000 ||
    selected.some((id) => !/^[a-f0-9]{64}$/u.test(id))
  )
    throw new Error("The bounded startup container list is unsafe.");
  const inspected = run(
    "docker",
    [
      "--host",
      endpoint,
      "container",
      "inspect",
      "--format",
      INSPECTION_FORMAT,
      ...selected,
    ],
    projectRoot,
  );
  if (inspected.status !== 0)
    throw new Error(
      "Startup container ownership or state could not be inspected; owned resources were retained.",
    );
  return parseStartupContainers({
    output: inspected.stdout,
    ids: selected,
    projectId,
    provider,
  });
};

export const withRuntimeStartupCleanup = async <Value,>({
  projectRoot,
  configPath,
  config,
  action,
  ownerOperationId,
  task,
  run = inspectCommand,
  inspectOwner = inspectProjectOperationState,
  loadConfiguration = loadRehearsalConfig,
  inspectEngine = assertLocalDockerContext,
  executeStop = runOwnedProcess,
}: {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly config: NormalizedRehearsalConfig;
  readonly action: string;
  readonly ownerOperationId: string | undefined;
  readonly task: () => Promise<Value>;
  readonly run?: Runner;
  readonly inspectOwner?: typeof inspectProjectOperationState;
  readonly loadConfiguration?: typeof loadRehearsalConfig;
  readonly inspectEngine?: typeof assertLocalDockerContext;
  readonly executeStop?: typeof runOwnedProcess;
}): Promise<Value> => {
  if (
    ownerOperationId === undefined ||
    (action !== "start" &&
      !(
        action === "run" &&
        runtimeCompletionAction(config.lifecycle.run) !== null
      ))
  )
    return task();
  if (!/^[a-f0-9]{64}$/u.test(ownerOperationId))
    throw new Error("The startup owner operation binding is invalid.");
  const expectedConfiguration = runtimeConfigurationSha256(config);
  const engine = inspectEngine({
    cwd: projectRoot,
    ...(process.env.REHEARSAL_DOCKER_CONTEXT
      ? { context: process.env.REHEARSAL_DOCKER_CONTEXT }
      : {}),
  });
  const assertBinding = async (): Promise<void> => {
    const currentEngine = inspectEngine({
      cwd: projectRoot,
      context: engine.context,
    });
    if (
      currentEngine.identity !== engine.identity ||
      (process.env.REHEARSAL_DOCKER_IDENTITY !== undefined &&
        currentEngine.identity !== process.env.REHEARSAL_DOCKER_IDENTITY)
    )
      throw new Error(
        "The startup engine endpoint changed; owned resources were retained.",
      );
    assertRuntimeConfigurationBinding({
      config: (await loadConfiguration({ projectRoot, configPath })).config,
      expected: expectedConfiguration,
    });
    const owner = await inspectOwner({ projectRoot });
    if (
      owner.state !== "busy" ||
      owner.operation?.progress?.operationId !== ownerOperationId
    )
      throw new Error(
        "The startup project operation owner changed; owned resources were retained.",
      );
  };
  await assertBinding();
  const environment = scopedDockerEnvironment({ endpoint: engine.endpoint });
  const scopedRun: Runner = (command, args, cwd, env) =>
    run(command, args, cwd, env ?? environment);
  const target = {
    projectRoot,
    endpoint: engine.endpoint,
    projectId: config.runtime.projectId,
    provider: config.runtime.target,
    run: scopedRun,
  };
  let before: readonly StartupContainer[] | null = null;
  const capture = (): void => {
    if (before !== null) return;
    if (
      inspectEngine({ cwd: projectRoot, context: engine.context }).identity !==
      engine.identity
    )
      throw new Error(
        "The startup engine endpoint changed before target work; no new target action was performed.",
      );
    before = readContainers(target);
  };
  return startupScopes.run({ capture }, async () => {
    try {
      const value = await task();
      await reachOperationCancellationCheckpoint();
      return value;
    } catch (operationError) {
      const original = before;
      if (original === null) throw operationError;
      try {
        await withOperationCancellationShield(async () => {
          await assertBinding();
          const after = readContainers(target);
          const selected = selectNewStartupWorkloads(original, after);
          if (!selected.length) return;
          await assertBinding();
          const ids = selected.map((container) => container.id);
          const current = readContainers({ ...target, ids });
          if (
            selected.some(
              (entry) =>
                !current.some(
                  (candidate) =>
                    candidate.id === entry.id &&
                    candidate.name === entry.name &&
                    candidate.running === entry.running &&
                    candidate.startedAt === entry.startedAt,
                ),
            )
          )
            throw new Error(
              "Startup workloads changed before stopping; owned resources were retained.",
            );
          const result = await executeStop({
            command: "docker",
            args: [
              "--host",
              engine.endpoint,
              "container",
              "stop",
              "--time",
              "5",
              ...ids,
            ],
            cwd: projectRoot,
            env: environment,
            stdin: "ignore",
            signal: AbortSignal.timeout(20_000),
            cancellationGraceMs: 5000,
          });
          if (result.error || result.status !== 0)
            throw new Error(
              "Proven new startup workloads could not be stopped; inspect retained resources before retrying.",
            );
          const stopped = readContainers({ ...target, ids });
          if (stopped.some((container) => container.running))
            throw new Error(
              "A startup workload resumed during teardown; retained resources need review.",
            );
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [operationError, cleanupError],
          "Runtime startup failed and exact owned cleanup could not be proved. Resources and data were retained; inspect activity and status before retrying.",
        );
      }
      throw operationError;
    }
  });
};
