/** Ownership proof for the optional, guarded release of a Colima engine. */

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
import { assertLocalDockerContext } from "./local_docker_context.mjs";

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
) => SpawnSyncReturns<string>;

const defaultRunner: CommandRunner = (command, args, cwd) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

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
  const context = run("docker", ["context", "show"], projectRoot);
  if (context.status !== 0 || context.stdout.trim() !== "colima") return null;
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
  state: "disabled" | "preserved" | "stopped" | "already-stopped";
  message: string;
}>;

export const releaseOwnedColimaWhenIdle = ({
  projectRoot,
  targets,
  run = defaultRunner,
}: {
  readonly projectRoot: string;
  readonly targets: readonly RuntimeTopologyTarget[];
  readonly run?: CommandRunner;
}): ColimaReleaseResult => {
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
  const docker = run("docker", ["info"], projectRoot);
  if (docker.status !== 0) {
    return {
      state: "already-stopped",
      message: "Shared container engine is already stopped.",
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
  const stopped = run("colima", ["stop"], projectRoot);
  if (stopped.status !== 0) {
    return {
      state: "preserved",
      message:
        "Shared container engine preserved: Colima did not stop successfully. No container or volume was removed.",
    };
  }
  for (const { path } of valid) {
    try {
      unlinkSync(path);
    } catch {
      // A stale retained receipt is safe: a stopped engine cannot satisfy it.
    }
  }
  return {
    state: "stopped",
    message:
      "Stopped the Colima boot Rehearsal started after every shared-engine container was already stopped. Containers and volumes were preserved.",
  };
};
