/** Ownership proof for the optional, guarded release of a Colima engine. */

import {
  runOwnedColimaStop,
  type OwnedColimaStopResult,
} from "./owned_colima_stop.mjs";
export {
  runOwnedColimaStop,
  OWNED_COLIMA_SHUTDOWN_TIMEOUT_MS,
} from "./owned_colima_stop.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  qualifyColimaDefault,
  confirmColimaStopped,
  type ColimaBackendOptions,
  type QualifiedColimaProof,
} from "./engine_colima_backend.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import type { RuntimeTopologyTarget } from "./topology.mjs";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "./local_docker_context.mjs";

export const CONTAINER_ENGINE_RECEIPT_FILENAME =
  "container-engine-start-receipt.json";
const RECEIPT_SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 16 * 1024;
const BOOT_ID_PATTERN = /^[a-f0-9-]{16,64}$/u;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/u;

export interface ContainerEngineStartReceipt {
  readonly schemaVersion: 1;
  readonly engine: "colima";
  readonly context: "colima";
  readonly engineIdentity: string;
  readonly bootId: string;
  readonly projectRootSha256: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly createdAt: string;
}

export interface ContainerEngineReceiptInput {
  readonly path: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly operationId: string;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  timeoutMs?: number,
) => SpawnSyncReturns<string>;

/** Metadata retains its existing 10-second bound. */
export const runContainerEngineOwnershipCommand: CommandRunner = (
  command,
  args,
  cwd,
  environment,
  timeoutMs,
) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env:
      environment ??
      (command === "docker"
        ? scopedDockerEnvironment()
        : createCleanProcessEnvironment()),
    maxBuffer: 1024 * 1024,
    timeout: Math.min(10_000, timeoutMs ?? 10_000),
    stdio: ["ignore", "pipe", "pipe"],
  });

const defaultRunner = runContainerEngineOwnershipCommand;

const projectRootSha256 = (projectRoot: string): string =>
  createHash("sha256").update(resolve(projectRoot)).digest("hex");

/** A failed Docker probe is not evidence that a manually started Colima VM is stopped. */
export const assertDefaultColimaCanBeStarted = ({
  projectRoot,
  run = defaultRunner,
}: {
  projectRoot: string;
  run?: CommandRunner;
}): void => {
  const listing = run("colima", ["list", "--json"], projectRoot);
  try {
    const entries = listing.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (
      listing.status !== 0 ||
      entries.length > 100 ||
      entries.some(
        (entry) =>
          typeof entry.name !== "string" || typeof entry.status !== "string",
      )
    )
      throw new Error();
    const defaults = entries.filter((entry) => entry.name === "default");
    if (
      defaults.length > 1 ||
      defaults.some((entry) => entry.status !== "Stopped")
    )
      throw new Error();
  } catch {
    throw new Error(
      "Docker is unavailable, but Rehearsal cannot prove the default Colima VM is stopped. It will not start or claim an existing VM; inspect colima status and retry manually.",
    );
  }
};

const readCurrentColimaIdentity = (
  run: CommandRunner,
  projectRoot: string,
): {
  readonly context: "colima";
  readonly bootId: string;
  readonly engineIdentity: string;
} | null => {
  let engineIdentity: string;
  try {
    const local = assertLocalDockerContext({ cwd: projectRoot, runner: run });
    if (local.context !== "colima") return null;
    engineIdentity = local.identity;
  } catch {
    return null;
  }
  const boot = run(
    "colima",
    ["ssh", "--", "cat", "/proc/sys/kernel/random/boot_id"],
    projectRoot,
  );
  const bootId = boot.stdout.trim().toLowerCase();
  return boot.status === 0 && BOOT_ID_PATTERN.test(bootId)
    ? { context: "colima", bootId, engineIdentity }
    : null;
};

const isReceipt = (value: unknown): value is ContainerEngineStartReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const receipt = value as Record<string, unknown>;
  return (
    receipt.schemaVersion === RECEIPT_SCHEMA_VERSION &&
    receipt.engine === "colima" &&
    receipt.context === "colima" &&
    typeof receipt.engineIdentity === "string" &&
    /^[a-f0-9]{64}$/u.test(receipt.engineIdentity) &&
    typeof receipt.bootId === "string" &&
    BOOT_ID_PATTERN.test(receipt.bootId) &&
    typeof receipt.projectRootSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(receipt.projectRootSha256) &&
    typeof receipt.projectId === "string" &&
    /^[a-z0-9][a-z0-9-]{1,62}$/u.test(receipt.projectId) &&
    typeof receipt.operationId === "string" &&
    OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.createdAt === "string" &&
    Number.isFinite(Date.parse(receipt.createdAt))
  );
};

export const writeContainerEngineStartReceipt = ({
  input,
  run = defaultRunner,
  now = () => new Date(),
}: {
  readonly input: ContainerEngineReceiptInput;
  readonly run?: CommandRunner;
  readonly now?: () => Date;
}): ContainerEngineStartReceipt => {
  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new Error(
      "Refusing to write an invalid container-engine operation receipt.",
    );
  }
  const identity = readCurrentColimaIdentity(run, input.projectRoot);
  if (!identity) {
    throw new Error(
      "Colima started, but Rehearsal could not bind its startup receipt to the current engine boot. The engine will not be stopped automatically.",
    );
  }
  const receipt: ContainerEngineStartReceipt = Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    engine: "colima",
    context: identity.context,
    engineIdentity: identity.engineIdentity,
    bootId: identity.bootId,
    projectRootSha256: projectRootSha256(input.projectRoot),
    projectId: input.projectId,
    operationId: input.operationId,
    createdAt: now().toISOString(),
  });
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
  const temporary = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, input.path);
  return receipt;
};

export const readValidContainerEngineStartReceipt = ({
  input,
  run = defaultRunner,
}: {
  readonly input: Omit<ContainerEngineReceiptInput, "operationId">;
  readonly run?: CommandRunner;
}): ContainerEngineStartReceipt | null => {
  try {
    const status = lstatSync(input.path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size > MAX_RECEIPT_BYTES ||
      (status.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid())
    )
      return null;
    const parsed: unknown = JSON.parse(readFileSync(input.path, "utf8"));
    if (!isReceipt(parsed)) return null;
    if (
      parsed.projectRootSha256 !== projectRootSha256(input.projectRoot) ||
      parsed.projectId !== input.projectId
    )
      return null;
    const current = readCurrentColimaIdentity(run, input.projectRoot);
    if (
      !current ||
      current.bootId !== parsed.bootId ||
      current.engineIdentity !== parsed.engineIdentity
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
};

export type ColimaReleaseResult = Readonly<{
  state: "disabled" | "preserved" | "stopped" | "already-stopped" | "unknown";
  message: string;
  warning?: "shutdown-command-failed";
  shutdown?: {
    command: {
      status: number | null;
      signal: string | null;
      errorCode: string | null;
      elapsedMilliseconds: number;
      exitObserved: boolean;
      closeObserved: boolean;
      retired: boolean;
    };
    confirmed: { profileStopped: boolean; vmProcessAbsent: boolean };
  };
}>;

export const releaseOwnedColimaWhenIdle = async ({
  projectRoot,
  targets,
  run: suppliedRun = defaultRunner,
  dependencies = {},
}: {
  readonly projectRoot: string;
  readonly targets: readonly RuntimeTopologyTarget[];
  readonly run?: CommandRunner;
  readonly dependencies?: {
    qualify?: typeof qualifyColimaDefault;
    confirm?: typeof confirmColimaStopped;
    now?: () => number;
    wait?: () => Promise<void>;
  };
}): Promise<ColimaReleaseResult> => {
  if (
    targets.length === 0 ||
    targets.some(
      (target) => !target.config.containerRuntime.stopOwnedColimaWhenIdle,
    )
  ) {
    return {
      state: "disabled",
      message:
        "Shared container engine preserved: automatic idle shutdown is not enabled for every selected target.",
    };
  }
  // Resolve selectors before any daemon probe; never mistake a remote/default engine for the owned Colima boot.
  const inheritedEnvironment = { ...process.env };
  let local: ReturnType<typeof assertLocalDockerContext>;
  try {
    local = assertLocalDockerContext({
      cwd: projectRoot,
      runner: suppliedRun,
      inheritedEnvironment,
    });
  } catch {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: local engine selection could not be verified.",
    };
  }
  const environment = scopedDockerEnvironment({
    inheritedEnvironment,
    endpoint: local.endpoint,
  });
  const run: CommandRunner = (command, args, cwd, env, timeoutMs) =>
    suppliedRun(
      command,
      args,
      cwd,
      env ??
        (command === "docker"
          ? args[0] === "context"
            ? scopedDockerEnvironment({ inheritedEnvironment })
            : environment
          : undefined),
      timeoutMs,
    );
  const docker = run("docker", ["info"], projectRoot);
  if (docker.status !== 0) {
    return {
      state: "unknown",
      message:
        "The Docker daemon is unavailable; that does not prove the Colima VM stopped. Ownership receipts were retained.",
    };
  }
  const current = readCurrentColimaIdentity(run, projectRoot);
  if (!current) {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: the active engine is not a verifiable Colima boot.",
    };
  }
  const valid = targets.flatMap((target) => {
    const path = join(
      target.paths.artifactDirectory,
      CONTAINER_ENGINE_RECEIPT_FILENAME,
    );
    const receipt = readValidContainerEngineStartReceipt({
      input: {
        path,
        projectRoot,
        projectId: target.config.runtime.projectId,
      },
      run,
    });
    return receipt ? [{ path, receipt }] : [];
  });
  if (valid.length === 0) {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: no current owner-only receipt proves Rehearsal started this Colima boot.",
    };
  }
  const running = run("docker", ["container", "ls", "--quiet"], projectRoot);
  if (running.status !== 0) {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: Rehearsal could not prove that every container is stopped.",
    };
  }
  const runningCount = running.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean).length;
  if (runningCount > 0) {
    return {
      state: "preserved",
      message: `Shared container engine preserved: ${runningCount} other running container${runningCount === 1 ? " remains" : "s remain"}.`,
    };
  }
  const backend: ColimaBackendOptions = {
    environment: inheritedEnvironment,
    platform: process.platform,
    architecture: process.arch,
    run: (command, args, env) => {
      const value = run(command, args, projectRoot, env);
      return {
        status: value.error || value.signal ? null : value.status,
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? "",
      };
    },
  };
  let proof: QualifiedColimaProof;
  try {
    const daemon = run("docker", ["info", "--format", "{{.ID}}"], projectRoot);
    if (
      daemon.status !== 0 ||
      !daemon.stdout.trim() ||
      daemon.stdout.trim().length > 256
    )
      throw new Error();
    proof = await (dependencies.qualify ?? qualifyColimaDefault)(
      backend,
      local.endpoint,
      daemon.stdout.trim(),
    );
    if (
      proof.bootId !== current.bootId ||
      proof.endpoint !== local.endpoint ||
      proof.daemonId !== daemon.stdout.trim()
    )
      throw new Error();
  } catch {
    return {
      state: "preserved",
      message:
        "Automatic Colima shutdown is unqualified: the profile, boot and captured VM process could not be verified. Ownership receipts were retained.",
    };
  }
  const immediatelyBeforeStop = readCurrentColimaIdentity(run, projectRoot);
  if (
    !immediatelyBeforeStop ||
    immediatelyBeforeStop.bootId !== current.bootId ||
    immediatelyBeforeStop.engineIdentity !== current.engineIdentity
  ) {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: the engine context or boot changed during idle shutdown review.",
    };
  }
  const finalDaemon = run(
    "docker",
    ["info", "--format", "{{.ID}}"],
    projectRoot,
  );
  if (
    finalDaemon.status !== 0 ||
    finalDaemon.error ||
    finalDaemon.signal ||
    finalDaemon.stdout.trim() !== proof.daemonId
  )
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: daemon identity changed during idle shutdown review.",
    };
  // Identity probes take time: another project may start a workload after the
  // first idle observation. Make the final observation immediately before stop.
  // This narrows the race; it is not an atomic lease over external Docker clients.
  const finalRunning = run(
    "docker",
    ["container", "ls", "--quiet"],
    projectRoot,
  );
  if (finalRunning.status !== 0 || finalRunning.stdout.trim() !== "") {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: container activity changed or became unavailable during idle shutdown review.",
    };
  }
  const cancellation = getOperationCancellationSignal();
  if (cancellation?.aborted)
    return {
      state: "preserved",
      message:
        "Automatic Colima shutdown was cancelled before dispatch. Ownership receipts were retained.",
    };
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  let stopped: Pick<OwnedColimaStopResult, "status" | "signal" | "error"> &
    Partial<
      Pick<OwnedColimaStopResult, "exitObserved" | "closeObserved" | "retired">
    >;
  try {
    stopped =
      suppliedRun === defaultRunner
        ? await runOwnedColimaStop(projectRoot, proof.environment, {
            ...(cancellation ? { signal: cancellation } : {}),
          })
        : run("colima", ["stop"], projectRoot, proof.environment);
  } catch {
    stopped = {
      status: null,
      signal: null,
      error: new Error("Unobserved stop result"),
    };
  }
  const failureCode = (stopped.error as NodeJS.ErrnoException | undefined)
    ?.code;
  const command = {
    status:
      Number.isInteger(stopped.status) &&
      stopped.status !== null &&
      stopped.status >= 0 &&
      stopped.status <= 255
        ? stopped.status
        : null,
    signal:
      stopped.signal &&
      [
        "SIGTERM",
        "SIGKILL",
        "SIGINT",
        "SIGHUP",
        "SIGABRT",
        "SIGTRAP",
        "SIGSEGV",
      ].includes(stopped.signal)
        ? stopped.signal
        : null,
    errorCode: stopped.error
      ? typeof failureCode === "string" &&
        [
          "ETIMEDOUT",
          "ENOENT",
          "EACCES",
          "EPERM",
          "EIO",
          "EINVAL",
          "ENOBUFS",
          "E2BIG",
          "ABORT_ERR",
          "ECLOSE_UNCONFIRMED",
          "ESIGNAL_UNCONFIRMED",
        ].includes(failureCode)
        ? failureCode
        : "unclassified"
      : null,
    elapsedMilliseconds: Math.max(0, Math.round(now() - started)),
    exitObserved:
      stopped.exitObserved ??
      (stopped.status !== null || Boolean(stopped.signal)),
    closeObserved:
      stopped.closeObserved ??
      (stopped.status !== null || Boolean(stopped.signal)),
    retired: stopped.retired ?? false,
  };
  let confirmed = { profileStopped: false, vmProcessAbsent: false };
  const until = now() + 10_000;
  const verification: ColimaBackendOptions = {
    ...backend,
    run: (cmd, args, env) => {
      const remaining = Math.floor(until - now());
      if (remaining <= 0)
        throw new Error("Stop observation deadline exhausted");
      const value = run(
        cmd,
        args,
        projectRoot,
        env,
        Math.min(10_000, remaining),
      );
      return {
        status: value.error || value.signal ? null : value.status,
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? "",
      };
    },
  };
  do {
    try {
      confirmed = await (dependencies.confirm ?? confirmColimaStopped)(
        verification,
        proof,
      );
    } catch {
      confirmed = { profileStopped: false, vmProcessAbsent: false };
    }
    if (confirmed.profileStopped && confirmed.vmProcessAbsent) break;
    if (now() >= until) break;
    await (dependencies.wait ?? (() => delay(100)))();
  } while (now() < until);
  const shutdown = { command, confirmed };
  if (!confirmed.profileStopped || !confirmed.vmProcessAbsent) {
    return {
      state: "unknown",
      message:
        "Colima shutdown was requested, but stopped-profile and captured-VM exit were not both confirmed. Ownership receipts were retained; inspect the engine before retrying.",
      shutdown,
    };
  }
  for (const { path, receipt } of valid) {
    try {
      const status = lstatSync(path);
      if (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1 &&
        (status.mode & 0o077) === 0 &&
        (typeof process.getuid !== "function" ||
          status.uid === process.getuid()) &&
        status.size <= MAX_RECEIPT_BYTES &&
        JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) ===
          JSON.stringify(receipt)
      )
        unlinkSync(path);
    } catch {
      // A stale retained receipt is safe: a stopped engine cannot satisfy it.
    }
  }
  const commandFailed =
    stopped.status !== 0 || Boolean(stopped.error) || Boolean(stopped.signal);
  return {
    state: "stopped",
    shutdown,
    ...(commandFailed ? { warning: "shutdown-command-failed" as const } : {}),
    message:
      "Stopped the Colima boot Rehearsal started after every shared-engine container was already stopped. Containers and volumes were preserved." +
      (commandFailed
        ? "\nColima reported an unsuccessful stop command; independent profile and captured-VM observations confirm the VM is off. Orderly provider shutdown was not established."
        : ""),
  };
};
