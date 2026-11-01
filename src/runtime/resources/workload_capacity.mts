/** Measured, cooperative headroom checks. Never starts, stops or kills workloads. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RehearsalResourcePolicy } from "../../project/configuration_contract.mjs";
import type { RuntimeTopologyTarget } from "../lifecycle/topology.mjs";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "../engines/local_docker_context.mjs";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
import { throwIfOperationCancelled } from "../../shared/cancellation.mjs";
import { RehearsalError } from "../../shared/diagnostics.mjs";

type Policy = NonNullable<RehearsalResourcePolicy["capacityAdmission"]>;
type ActivePolicy = Required<Omit<Policy, "enabled">> & { enabled: true };
type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) => SpawnSyncReturns<string>;

export interface WorkloadCapacitySnapshot {
  readonly schemaVersion: 1;
  readonly measuredAt: string;
  readonly host: {
    readonly measuredAvailableBytes: number;
    readonly measurement: "linux-memavailable" | "macos-free-speculative";
    readonly pressure: "normal" | "not-measured";
  };
  readonly engine: {
    readonly context: string;
    readonly identity: string;
    readonly daemonId: string;
    readonly totalBytes: number;
    readonly measuredAvailableBytes: number;
    readonly runningContainers: number;
    readonly standingContainerMemoryBytes: number;
    readonly measurement: "colima-memavailable";
  };
}

const maximumOutputBytes = 256 * 1024;
const maximumContainers = 1024;
const validBytes = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveBytes = (value: unknown): value is number =>
  validBytes(value) && value > 0;
const refuse = (message: string): never => {
  throw new RehearsalError({
    category: "runtime_dependency_failure",
    code: "WORKLOAD_CAPACITY_REFUSED",
    message,
    expected:
      "fresh measured host and local-engine headroom within reviewed budgets",
    actual: "capacity is unknown, inconsistent or below the reviewed reserve",
    refused:
      "No selected runtime phase was started; existing workloads were preserved.",
    suggestions: [
      "Review workload budgets and current machine use; finish owned workloads or retry when capacity is available.",
      "Use a supported local capacity probe; never clear another workload or infer available memory from VM capacity alone.",
    ],
  });
};
const run: Runner = (command, args, cwd, environment) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env:
      environment ??
      (command === "docker"
        ? scopedDockerEnvironment()
        : createCleanProcessEnvironment()),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: maximumOutputBytes,
  });

export const parseLinuxAvailableMemory = (output: string): number | null => {
  const matches = [...output.matchAll(/^MemAvailable:\s+(\d+)\s+kB\s*$/gmu)];
  if (matches.length !== 1) return null;
  const bytes = Number(matches[0]![1]) * 1024;
  return validBytes(bytes) ? bytes : null;
};

export const parseMacosAvailableMemory = (output: string): number | null => {
  const pageSize = /page size of (\d+) bytes/u.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\.\s*$/mu.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\.\s*$/mu.exec(output)?.[1];
  if (!pageSize || free === undefined || speculative === undefined) return null;
  const bytes = (Number(free) + Number(speculative)) * Number(pageSize);
  return positiveBytes(Number(pageSize)) && validBytes(bytes) ? bytes : null;
};

export const parseEngineAvailableMemory = (
  output: string,
): { totalBytes: number; measuredAvailableBytes: number } | null => {
  const lines = output.split("\n").map((line) => line.trim());
  const matches = lines.filter((line) => line.startsWith("Mem:"));
  if (
    matches.length !== 1 ||
    !lines.some((line) => /\bavailable\b/u.test(line))
  )
    return null;
  const columns = matches[0]!.split(/\s+/u);
  if (columns.length !== 7) return null;
  const totalBytes = Number(columns[1]);
  const measuredAvailableBytes = Number(columns[6]);
  if (
    !positiveBytes(totalBytes) ||
    !validBytes(measuredAvailableBytes) ||
    measuredAvailableBytes > totalBytes
  )
    return null;
  return { totalBytes, measuredAvailableBytes };
};

const memoryUsageBytes = (input: string): number | null => {
  const match =
    /^([\d]+(?:\.[\d]+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/u.exec(
      input.trim(),
    );
  if (!match) return null;
  const scale: Record<string, number> = {
    B: 1,
    kB: 1000,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  const bytes = Math.ceil(Number(match[1]) * scale[match[2]!]!);
  return validBytes(bytes) ? bytes : null;
};

/** All running IDs must have one finite sample; missing data is never treated as zero. */
export const parseStandingContainerMemory = (
  output: string,
  ids: readonly string[],
): number | null => {
  const lines = output.trim() ? output.trim().split("\n") : [];
  if (
    ids.length > maximumContainers ||
    new Set(ids).size !== ids.length ||
    lines.length !== ids.length
  )
    return null;
  const expected = new Set(ids);
  let total = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { id?: unknown; memory?: unknown };
      if (
        typeof row.id !== "string" ||
        !expected.delete(row.id) ||
        typeof row.memory !== "string"
      )
        return null;
      const parts = row.memory.split("/");
      if (parts.length !== 2) return null;
      const usage = memoryUsageBytes(parts[0]!);
      const limit = memoryUsageBytes(parts[1]!);
      if (usage === null || limit === null || limit < usage || limit === 0)
        return null;
      total += usage;
      if (!validBytes(total)) return null;
    } catch {
      return null;
    }
  }
  return expected.size === 0 ? total : null;
};

export const inspectWorkloadCapacity = async ({
  projectRoot,
  runner = run,
  platform = process.platform,
  home = userInfo().homedir,
  readText = (path: string) => readFile(path, "utf8"),
}: {
  projectRoot: string;
  runner?: Runner;
  platform?: NodeJS.Platform;
  kernelRelease?: string;
  home?: string;
  readText?: (path: string) => Promise<string>;
}): Promise<WorkloadCapacitySnapshot> => {
  const startedAt = performance.now();
  const inheritedEnvironment = { ...process.env };
  let dockerEnvironment: NodeJS.ProcessEnv | undefined;
  const query = (command: string, args: readonly string[]) => {
    throwIfOperationCancelled();
    const result = runner(
      command,
      args,
      projectRoot,
      command === "docker" ? dockerEnvironment : undefined,
    );
    if (
      result.status !== 0 ||
      result.error ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > maximumOutputBytes
    )
      return refuse(
        "A bounded local capacity probe did not return a complete measurement.",
      );
    return result.stdout;
  };
  let host: WorkloadCapacitySnapshot["host"];
  if (platform === "linux") {
    let output: string;
    try {
      output = await readText("/proc/meminfo");
    } catch {
      return refuse("Host available-memory measurement is unavailable.");
    }
    const bytes =
      Buffer.byteLength(output) <= maximumOutputBytes
        ? parseLinuxAvailableMemory(output)
        : null;
    if (bytes === null)
      return refuse("Host available-memory measurement is invalid.");
    host = {
      measuredAvailableBytes: bytes,
      measurement: "linux-memavailable",
      pressure: "not-measured",
    };
  } else if (platform === "darwin") {
    if (
      query("/usr/sbin/sysctl", [
        "-n",
        "kern.memorystatus_vm_pressure_level",
      ]).trim() !== "1"
    )
      return refuse("macOS memory pressure is elevated or unknown.");
    const bytes = parseMacosAvailableMemory(query("/usr/bin/vm_stat", []));
    if (bytes === null)
      return refuse("Host available-memory measurement is invalid.");
    host = {
      measuredAvailableBytes: bytes,
      measurement: "macos-free-speculative",
      pressure: "normal",
    };
  } else
    return refuse(
      "Measured capacity admission currently requires macOS or Linux.",
    );
  const local = assertLocalDockerContext({
    cwd: projectRoot,
    runner,
    inheritedEnvironment,
  });
  dockerEnvironment = scopedDockerEnvironment({
    inheritedEnvironment,
    endpoint: local.endpoint,
  });
  const docker = (args: readonly string[]) =>
    query("docker", ["--host", local.endpoint, ...args]);
  const infoArguments = [
    "info",
    "--format",
    '{"id":{{json .ID}},"memoryBytes":{{json .MemTotal}},"runningContainers":{{json .ContainersRunning}},"kernel":{{json .KernelVersion}}}',
  ];
  const readInfo = () => {
    let value: {
      id?: unknown;
      memoryBytes?: unknown;
      runningContainers?: unknown;
      kernel?: unknown;
    };
    try {
      value = JSON.parse(docker(infoArguments));
    } catch {
      return refuse("Local engine capacity could not be verified.");
    }
    if (
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(value.id) ||
      !positiveBytes(value.memoryBytes) ||
      !validBytes(value.runningContainers) ||
      value.runningContainers > maximumContainers ||
      typeof value.kernel !== "string"
    )
      return refuse("Local engine capacity is incomplete or invalid.");
    return {
      id: value.id,
      totalBytes: value.memoryBytes,
      runningContainers: value.runningContainers,
      kernel: value.kernel,
    };
  };
  const before = readInfo();
  const readIds = () => {
    const output = docker(["ps", "--quiet", "--no-trunc"]).trim();
    const ids = output ? output.split("\n").sort() : [];
    if (
      ids.length !== before.runningContainers ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[a-f0-9]{64}$/u.test(id))
    )
      return refuse(
        "The complete standing-container inventory could not be verified.",
      );
    return ids;
  };
  const ids = readIds();
  const standing =
    ids.length === 0
      ? 0
      : parseStandingContainerMemory(
          docker([
            "stats",
            "--no-stream",
            "--no-trunc",
            "--format",
            '{"id":{{json .ID}},"memory":{{json .MemUsage}}}',
            ...ids,
          ]),
          ids,
        );
  if (standing === null || standing > before.totalBytes)
    return refuse(
      "Standing-container memory usage is unknown or inconsistent.",
    );
  let available: number;
  let measurement: WorkloadCapacitySnapshot["engine"]["measurement"];
  // Equal kernel release strings do not establish a shared memory domain:
  // namespaces and finite cgroup ancestors can constrain Docker independently.
  // Until that domain is measured, native Linux engines fail closed too.
  {
    const match = /^colima(?:-([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}))?$/u.exec(
      local.context,
    );
    const profile = match?.[1] ?? "default";
    if (
      !match ||
      local.endpoint !==
        `unix://${join(home, ".colima", profile, "docker.sock")}`
    )
      return refuse(
        "Available memory of this local engine cannot be measured safely; kernel release equality does not establish its namespace/cgroup memory domain, and VM capacity alone is insufficient.",
      );
    const verifyGuestDaemon = () => {
      const id = query("colima", [
        "--profile",
        profile,
        "ssh",
        "--",
        "docker",
        "info",
        "--format",
        "{{.ID}}",
      ]).trim();
      if (id !== before.id)
        return refuse(
          "The measured Colima guest daemon does not match the reviewed local engine identity.",
        );
    };
    verifyGuestDaemon();
    const memory = parseEngineAvailableMemory(
      query("colima", ["--profile", profile, "ssh", "--", "free", "-b"]),
    );
    verifyGuestDaemon();
    // Linux reports MemTotal slightly below the assigned VM capacity. A mismatch
    // above 1% or16MiB is not the same reviewed engine and is never accepted.
    const tolerance = Math.max(
      16 * 1024 ** 2,
      Math.ceil(before.totalBytes / 100),
    );
    if (!memory || Math.abs(memory.totalBytes - before.totalBytes) > tolerance)
      return refuse(
        "The measured VM does not match the reviewed local engine capacity.",
      );
    available = Math.min(
      memory.measuredAvailableBytes,
      before.totalBytes - standing,
    );
    measurement = "colima-memavailable";
  }
  const after = readInfo();
  const finalIds = readIds();
  const finalLocal = assertLocalDockerContext({
    cwd: projectRoot,
    runner,
    context: local.context,
    inheritedEnvironment,
  });
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(ids) !== JSON.stringify(finalIds) ||
    finalLocal.identity !== local.identity
  )
    return refuse(
      "The engine or standing workloads changed during capacity measurement; review a fresh attempt.",
    );
  if (performance.now() - startedAt > 30_000)
    return refuse(
      "Capacity measurements exceeded their freshness deadline; no runtime phase was started.",
    );
  throwIfOperationCancelled();
  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    host,
    engine: {
      context: local.context,
      identity: local.identity,
      daemonId: before.id,
      totalBytes: before.totalBytes,
      measuredAvailableBytes: available,
      runningContainers: before.runningContainers,
      standingContainerMemoryBytes: standing,
      measurement,
    },
  };
};

const activePolicy = (policy: Policy): ActivePolicy => {
  if (
    !policy.enabled ||
    !positiveBytes(policy.hostReserveBytes) ||
    !positiveBytes(policy.engineReserveBytes) ||
    !positiveBytes(policy.maximumRunningContainers) ||
    policy.maximumRunningContainers > maximumContainers ||
    !policy.targetMemoryBytes ||
    ![
      policy.targetMemoryBytes.postgresql,
      policy.targetMemoryBytes.supabaseApplication,
      policy.targetMemoryBytes.supabaseFull,
    ].every(positiveBytes)
  )
    return refuse(
      "Capacity admission requires explicit reviewed memory and container budgets.",
    );
  return policy as ActivePolicy;
};

export const evaluateWorkloadCapacity = ({
  policy,
  targets,
  snapshot,
}: {
  policy: Policy;
  targets: readonly Pick<RuntimeTopologyTarget, "config">[];
  snapshot: WorkloadCapacitySnapshot;
}) => {
  const reviewed = activePolicy(policy);
  if (targets.length === 0 || targets.length > 32)
    return refuse("The selected capacity demand is empty or unbounded.");
  let requiredMemoryBytes = 0;
  let requiredContainers = 0;
  for (const { config } of targets) {
    if (config.runtime.target === "postgresql") {
      requiredMemoryBytes += reviewed.targetMemoryBytes.postgresql;
      requiredContainers += 1;
      if (config.postgresql?.migrationTool?.kind === "knex") {
        requiredMemoryBytes += 268435456;
        requiredContainers += 1;
      }
    } else if (
      config.runtime.target === "supabase" &&
      config.supabase?.serviceProfile === "application"
    ) {
      requiredMemoryBytes += reviewed.targetMemoryBytes.supabaseApplication;
      requiredContainers += 6;
    } else if (
      config.runtime.target === "supabase" &&
      config.supabase?.serviceProfile === "full"
    ) {
      requiredMemoryBytes += reviewed.targetMemoryBytes.supabaseFull;
      requiredContainers += 13;
    } else
      return refuse(
        "The selected service profile has no reviewed capacity budget.",
      );
  }
  const available = snapshot?.host?.measuredAvailableBytes;
  const engine = snapshot?.engine;
  const ageMs = Date.now() - Date.parse(snapshot?.measuredAt ?? "");
  if (
    snapshot?.schemaVersion !== 1 ||
    !Number.isFinite(ageMs) ||
    ageMs < -1000 ||
    ageMs > 30_000 ||
    (snapshot.host.measurement === "macos-free-speculative" &&
      snapshot.host.pressure !== "normal")
  )
    return refuse("Fresh normal-pressure capacity evidence is required.");
  if (
    !validBytes(requiredMemoryBytes) ||
    !validBytes(available) ||
    !engine ||
    !positiveBytes(engine.totalBytes) ||
    !validBytes(engine.measuredAvailableBytes) ||
    engine.measuredAvailableBytes > engine.totalBytes ||
    !validBytes(engine.runningContainers) ||
    !validBytes(engine.standingContainerMemoryBytes) ||
    engine.standingContainerMemoryBytes > engine.totalBytes
  )
    return refuse("Fresh measured capacity is unavailable or inconsistent.");
  if (available - requiredMemoryBytes < reviewed.hostReserveBytes)
    return refuse(
      "Measured host memory does not leave the reviewed workload and host reserve.",
    );
  if (
    engine.measuredAvailableBytes - requiredMemoryBytes <
    reviewed.engineReserveBytes
  )
    return refuse(
      "Measured local-engine memory does not leave the reviewed workload and engine reserve.",
    );
  if (
    engine.runningContainers + requiredContainers >
    reviewed.maximumRunningContainers
  )
    return refuse(
      "Existing standing containers plus selected demand exceed the reviewed container budget.",
    );
  return {
    schemaVersion: 1 as const,
    decision: "admitted" as const,
    scope: "cooperative-measured-headroom" as const,
    requiredMemoryBytes,
    requiredContainers,
    snapshot,
    limitations: [
      "Budgets are reviewed estimates, not guaranteed peak demand.",
      "Unrelated tools do not obey this cooperative lease and can consume capacity after measurement.",
      "No workload, container, volume or shared engine was stopped to admit this request.",
    ],
  };
};

export const assertRuntimeWorkloadCapacity = async ({
  policy,
  targets,
  projectRoot,
  inspect = inspectWorkloadCapacity,
}: {
  policy: Policy;
  targets: readonly RuntimeTopologyTarget[];
  projectRoot: string;
  inspect?: typeof inspectWorkloadCapacity;
}) => {
  activePolicy(policy);
  const snapshot = await inspect({ projectRoot });
  evaluateWorkloadCapacity({ policy, targets, snapshot });
  return snapshot.engine;
};
