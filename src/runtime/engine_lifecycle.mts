/** Configuration-independent engine review and explicit, data-retaining shutdown. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "./local_docker_context.mjs";
import { inspectHostPlatform } from "../shared/host_platform.mjs";
import { inspectProjectOperationLocks } from "../shared/operation_guard.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { acquireWorkload, inspectWorkloads } from "./workload_queue.mjs";
import {
  colimaProfileEnvironment,
  readColimaDefaultState,
  qualifyColimaDefault,
  confirmColimaStopped,
  inspectStoppedColimaDefault,
  type ColimaBackendOptions,
  type EngineMetadataRunner,
  type QualifiedColimaProof,
} from "./engine_colima_backend.mjs";

export const ENGINE_LIFECYCLE_REASONS = [
  "ready",
  "profile-stopped",
  "unsupported-host",
  "selection-unverified",
  "daemon-unavailable",
  "backend-unqualified",
  "profile-unavailable",
  "ownership-unverified",
  "coordination-active",
  "coordination-unavailable",
  "review-changed",
  "confirmation-required",
  "cancelled-before-dispatch",
  "cancelled-after-dispatch",
  "shutdown-unconfirmed",
  "shutdown-command-failed",
  "shutdown-confirmed",
] as const;
export type EngineLifecycleReason = (typeof ENGINE_LIFECYCLE_REASONS)[number];
export const ENGINE_LIFECYCLE_REASON_LABELS: Readonly<
  Record<EngineLifecycleReason, string>
> = {
  ready:
    "Review the shared engine and affected containers before shutting it down.",
  "profile-stopped":
    "The Colima profile is stopped; this request did not verify a previous VM process exit.",
  "unsupported-host": "Engine shutdown is not qualified on this host.",
  "selection-unverified":
    "The selected local Docker endpoint could not be verified. No alternate engine was selected.",
  "daemon-unavailable":
    "The selected Docker daemon is unavailable; that does not prove a VM is stopped.",
  "backend-unqualified":
    "This selected engine has no qualified shutdown adapter.",
  "profile-unavailable":
    "The exact Colima default profile could not be observed safely.",
  "ownership-unverified":
    "The selected daemon, profile, boot and VM process could not all be bound.",
  "coordination-active":
    "Known Rehearsal work is active or awaiting review. Finish or cancel it before shutting down the engine.",
  "coordination-unavailable":
    "Known Rehearsal operation state could not be inspected safely.",
  "review-changed":
    "The reviewed engine or container activity changed. Review a new shutdown preview.",
  "confirmation-required":
    "Review the engine impact and provide its exact shutdown confirmation digest.",
  "cancelled-before-dispatch":
    "Shutdown was cancelled before an engine stop was dispatched.",
  "cancelled-after-dispatch":
    "Shutdown was interrupted after dispatch. Its actual outcome is uncertain; inspect engine state.",
  "shutdown-unconfirmed":
    "A graceful stop was requested, but stopped profile and VM exit could not both be confirmed.",
  "shutdown-command-failed":
    "The graceful engine stop did not complete successfully. No force or deletion was requested.",
  "shutdown-confirmed":
    "The reviewed Colima profile stopped and the same bound VM process exited. No data deletion was requested.",
};
const safety = () => ({
  globalContextSwitchRequested: false as const,
  dataDeletionRequested: false as const,
  forceRequested: false as const,
  enginesStarted: false as const,
});
export interface EngineSelectionState {
  state: "running" | "unavailable" | "unknown" | "unsupported-host";
  context: string | null;
  endpointIdentity: string | null;
  daemonId: string | null;
}
export interface EngineLifecycleStatus {
  schemaVersion: 1;
  selected: EngineSelectionState;
  colimaDefault: {
    state: "running" | "stopped" | "unknown" | "not-observed";
    profile: "default";
    shutdownSupported: boolean;
    reason: EngineLifecycleReason;
  };
  safety: ReturnType<typeof safety>;
}
export interface EngineShutdownIdentity {
  backend: "colima";
  profile: "default";
  context: string;
  endpointIdentity: string;
  daemonId: string;
  bootId: string;
  vmIdentity: string;
}
export interface EngineContainerImpact {
  id: string;
  name: string;
  state:
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead";
  restartCount: number;
  startedAt: string;
  finishedAt: string;
}
export interface EngineShutdownPlan {
  schemaVersion: 1;
  action: "engine-stop";
  state: "review-required" | "already-stopped" | "unsupported" | "blocked";
  reason: EngineLifecycleReason;
  consentDigest: string | null;
  engine: EngineShutdownIdentity | null;
  impact: { containers: EngineContainerImpact[]; runningCount: number } | null;
  safety: ReturnType<typeof safety>;
}
export interface EngineShutdownResult {
  schemaVersion: 1;
  status:
    | "stopped"
    | "already-stopped"
    | "refused"
    | "failed"
    | "cancelled"
    | "unknown";
  reason: EngineLifecycleReason;
  engine: EngineShutdownIdentity | null;
  confirmed: { profileStopped: boolean; vmProcessAbsent: boolean };
  selectionAfter: EngineSelectionState | null;
  safety: ReturnType<typeof safety>;
}
export interface EngineLifecycleDependencies {
  metadata?: EngineMetadataRunner;
  now?: () => number;
  platform?: NodeJS.Platform;
  architecture?: string;
  hostSupported?: () => Promise<boolean>;
  operationLocks?: () => Promise<readonly string[]>;
  workloads?: typeof inspectWorkloads;
  acquire?: typeof acquireWorkload;
  stop?: (
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<{ status: number | null }>;
}
export interface EngineLifecycleOptions {
  cwd?: string;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  dependencies?: EngineLifecycleDependencies;
}
interface Session {
  options: EngineLifecycleOptions;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  run: EngineMetadataRunner;
  backend: ColimaBackendOptions;
  deadline: number;
  now: () => number;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const session = (options: EngineLifecycleOptions, budget = 30000): Session => {
  const now = options.dependencies?.now ?? (() => performance.now());
  const deadline = now() + budget,
    cwd = options.cwd ?? process.cwd(),
    environment = { ...(options.inheritedEnvironment ?? process.env) };
  const run: EngineMetadataRunner = (command, args, env) => {
    const remaining = deadline - now();
    if (remaining <= 0 || options.signal?.aborted)
      throw Error("Engine observation interrupted.");
    const result = options.dependencies?.metadata
      ? options.dependencies.metadata(command, args, env)
      : (() => {
          const r = spawnSync(command, [...args], {
            cwd,
            env,
            encoding: "utf8",
            timeout: Math.max(1, Math.min(1500, Math.floor(remaining))),
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
          });
          return {
            status: r.error || r.signal ? null : r.status,
            stdout: r.stdout ?? "",
            stderr: r.stderr ?? "",
          };
        })();
    if (now() > deadline || Buffer.byteLength(result.stdout) > 1024 * 1024)
      throw Error("Engine observation exceeded its bound.");
    return result;
  };
  return {
    options,
    cwd,
    environment,
    run,
    deadline,
    now,
    backend: {
      environment,
      run,
      platform: options.dependencies?.platform ?? process.platform,
      architecture: options.dependencies?.architecture ?? process.arch,
    },
  };
};
const text = (s: Session, args: readonly string[], env: NodeJS.ProcessEnv) => {
  const r = s.run("docker", args, env);
  if (r.status !== 0 || Buffer.byteLength(r.stdout) > 65536)
    throw Error("Engine metadata unavailable.");
  return r.stdout.trim();
};
const resolveSelection = (s: Session) =>
  assertLocalDockerContext({
    cwd: s.cwd,
    inheritedEnvironment: s.environment,
    runner: (command, args, _cwd, env) => {
      const r = s.run(command, args, env ?? {});
      return {
        pid: 0,
        output: [null, r.stdout, ""],
        stdout: r.stdout,
        stderr: "",
        status: r.status,
        signal: null,
      };
    },
  });
const selectedState = (s: Session): EngineSelectionState => {
  try {
    const local = resolveSelection(s),
      environment = scopedDockerEnvironment({
        inheritedEnvironment: s.environment,
        endpoint: local.endpoint,
      });
    const info = s.run(
      "docker",
      ["--host", local.endpoint, "info", "--format", "{{.ID}}"],
      environment,
    );
    const id = info.stdout.trim();
    return {
      state:
        info.status === 0 && /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(id)
          ? "running"
          : "unavailable",
      context: local.context,
      endpointIdentity: local.identity,
      daemonId:
        info.status === 0 && /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(id)
          ? id
          : null,
    };
  } catch {
    return {
      state: "unknown",
      context: null,
      endpointIdentity: null,
      daemonId: null,
    };
  }
};
const hostSupported = async (s: Session) =>
  s.options.dependencies?.hostSupported
    ? s.options.dependencies.hostSupported()
    : (await inspectHostPlatform({ projectRoot: s.cwd })).supported;
const queueOptions = (s: Session) =>
  s.environment.REHEARSAL_USER_STATE_DIRECTORY
    ? { stateDirectory: s.environment.REHEARSAL_USER_STATE_DIRECTORY }
    : {};
const coordination = async (
  s: Session,
  held = false,
): Promise<EngineLifecycleReason | null> => {
  try {
    const locks = await (
      s.options.dependencies?.operationLocks ?? inspectProjectOperationLocks
    )();
    if (locks.length) return "coordination-active";
    const queue = await (s.options.dependencies?.workloads ?? inspectWorkloads)(
      queueOptions(s),
    );
    const own = queue.entries.filter(
      (e) =>
        held &&
        e.command === "engine-stop" &&
        e.pid === process.pid &&
        e.phase === "held" &&
        e.owner === "alive",
    );
    if (held && own.length !== 1) return "coordination-unavailable";
    if (queue.entries.some((e) => !own.includes(e)))
      return "coordination-active";
    return null;
  } catch {
    return "coordination-unavailable";
  }
};
export const ENGINE_CONTAINER_IMPACT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State.Status}},"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}}}';
export const parseEngineContainerImpact = (
  output: string,
  ids: readonly string[],
): EngineContainerImpact[] => {
  if (
    Buffer.byteLength(output) > 65536 ||
    ids.length > 128 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9]{64}$/u.test(id))
  )
    throw Error("Container impact unavailable.");
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length !== ids.length) throw Error("Container impact incomplete.");
  const rows = lines.map((line) => JSON.parse(line) as EngineContainerImpact);
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      Object.keys(row).sort().join(",") !==
        "finishedAt,id,name,restartCount,startedAt,state" ||
      !ids.includes(row.id) ||
      seen.has(row.id) ||
      typeof row.name !== "string" ||
      !/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(row.name) ||
      ![
        "created",
        "running",
        "paused",
        "restarting",
        "removing",
        "exited",
        "dead",
      ].includes(row.state) ||
      !Number.isSafeInteger(row.restartCount) ||
      row.restartCount < 0
    )
      throw Error("Container impact invalid.");
    for (const date of [row.startedAt, row.finishedAt])
      if (
        typeof date !== "string" ||
        date.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          date,
        ) ||
        !Number.isFinite(Date.parse(date))
      )
        throw Error("Container activity unknown.");
    seen.add(row.id);
    row.name = row.name.slice(1);
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
};
const inspectEngineImpact = (
  s: Session,
  endpoint: string,
  environment: NodeJS.ProcessEnv,
): NonNullable<EngineShutdownPlan["impact"]> => {
  const ids = text(
    s,
    ["--host", endpoint, "container", "ls", "--all", "--quiet", "--no-trunc"],
    environment,
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  if (
    ids.length > 128 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9]{64}$/u.test(id))
  )
    throw Error("Container impact unavailable.");
  const containers = ids.length
    ? parseEngineContainerImpact(
        text(
          s,
          [
            "--host",
            endpoint,
            "container",
            "inspect",
            "--format",
            ENGINE_CONTAINER_IMPACT_FORMAT,
            ...ids,
          ],
          environment,
        ),
        ids,
      )
    : [];
  return {
    containers,
    runningCount: containers.filter((c) =>
      ["running", "paused", "restarting"].includes(c.state),
    ).length,
  };
};
interface Observation {
  plan: EngineShutdownPlan;
  proof: QualifiedColimaProof | null;
  environment: NodeJS.ProcessEnv | null;
}
const emptyPlan = (
  reason: EngineLifecycleReason,
  state: EngineShutdownPlan["state"] = "unsupported",
): EngineShutdownPlan => ({
  schemaVersion: 1,
  action: "engine-stop",
  state,
  reason,
  consentDigest: null,
  engine: null,
  impact: null,
  safety: safety(),
});
const observePlan = async (s: Session, held = false): Promise<Observation> => {
  let proof: QualifiedColimaProof | null = null,
    environment: NodeJS.ProcessEnv | null = null;
  const empty = (
    reason: EngineLifecycleReason,
    state: EngineShutdownPlan["state"] = "unsupported",
  ): Observation => ({
    plan: emptyPlan(reason, state),
    proof: null,
    environment: null,
  });
  if (!(await hostSupported(s))) return empty("unsupported-host");
  const busy = await coordination(s, held);
  if (busy) return empty(busy, "blocked");
  let local: ReturnType<typeof resolveSelection>;
  try {
    local = resolveSelection(s);
  } catch {
    return empty("selection-unverified");
  }
  try {
    if (s.backend.platform !== "darwin" || s.backend.architecture !== "arm64")
      return empty("backend-unqualified");
    const homes = await colimaProfileEnvironment(s.backend);
    if (local.endpoint !== homes.endpoint) return empty("backend-unqualified");
    const profile = readColimaDefaultState(s.run, homes.environment);
    if (profile === "stopped")
      return (await inspectStoppedColimaDefault(s.backend))
        ? empty("profile-stopped", "already-stopped")
        : empty("ownership-unverified");
    environment = scopedDockerEnvironment({
      inheritedEnvironment: s.environment,
      endpoint: local.endpoint,
    });
    let daemonId: string;
    try {
      daemonId = text(
        s,
        ["--host", local.endpoint, "info", "--format", "{{.ID}}"],
        environment,
      );
    } catch {
      return empty("daemon-unavailable");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(daemonId))
      return empty("daemon-unavailable");
    proof = await qualifyColimaDefault(s.backend, local.endpoint, daemonId);
    const impact = inspectEngineImpact(s, local.endpoint, environment);
    if (
      text(
        s,
        ["--host", local.endpoint, "info", "--format", "{{.ID}}"],
        environment,
      ) !== daemonId
    )
      return empty("ownership-unverified");
    const engine: EngineShutdownIdentity = {
      backend: "colima",
      profile: "default",
      context: local.context,
      endpointIdentity: local.identity,
      daemonId,
      bootId: proof.bootId,
      vmIdentity: proof.identity,
    };
    const reviewed = {
      engine,
      impact,
      clientConfiguration: s.environment.DOCKER_CONFIG ?? null,
    };
    return {
      plan: {
        schemaVersion: 1,
        action: "engine-stop",
        state: "review-required",
        reason: "ready",
        consentDigest: digest(reviewed),
        engine,
        impact,
        safety: safety(),
      },
      proof,
      environment,
    };
  } catch {
    return empty(proof ? "ownership-unverified" : "profile-unavailable");
  }
};
export async function inspectEngineLifecycle(
  options: EngineLifecycleOptions = {},
): Promise<EngineLifecycleStatus> {
  const s = session(options),
    supported = await hostSupported(s);
  const selected: EngineSelectionState = supported
    ? selectedState(s)
    : {
        state: "unsupported-host",
        context: null,
        endpointIdentity: null,
        daemonId: null,
      };
  let state: EngineLifecycleStatus["colimaDefault"]["state"] = "not-observed",
    reason: EngineLifecycleReason = supported
      ? "backend-unqualified"
      : "unsupported-host",
    shutdownSupported = false;
  if (
    supported &&
    s.backend.platform === "darwin" &&
    s.backend.architecture === "arm64"
  ) {
    try {
      const homes = await colimaProfileEnvironment(s.backend);
      state = readColimaDefaultState(s.run, homes.environment);
      if (state === "stopped") {
        if (await inspectStoppedColimaDefault(s.backend))
          reason = "profile-stopped";
        else {
          state = "unknown";
          reason = "ownership-unverified";
        }
      } else {
        const observed = await observePlan(s);
        reason = observed.plan.reason;
        shutdownSupported = observed.plan.state === "review-required";
      }
    } catch {
      state = "unknown";
      reason = "profile-unavailable";
    }
  }
  return {
    schemaVersion: 1,
    selected,
    colimaDefault: { state, profile: "default", shutdownSupported, reason },
    safety: safety(),
  };
}
export async function planEngineShutdown(
  options: EngineLifecycleOptions = {},
): Promise<EngineShutdownPlan> {
  return (await observePlan(session(options))).plan;
}
export async function shutdownEngine(
  options: EngineLifecycleOptions & { confirmDigest?: string } = {},
): Promise<EngineShutdownResult> {
  const s = session(options, 105000);
  const reportState: { value: EngineShutdownResult | null } = { value: null };
  let engine: EngineShutdownIdentity | null = null,
    dispatched = false,
    confirmed = { profileStopped: false, vmProcessAbsent: false };
  const finish = (
    status: EngineShutdownResult["status"],
    reason: EngineLifecycleReason,
  ): EngineShutdownResult =>
    (reportState.value = {
      schemaVersion: 1,
      status,
      reason,
      engine,
      confirmed,
      selectionAfter: dispatched
        ? selectedState(
            session(
              { ...s.options, signal: undefined },
              Math.max(1, Math.min(2000, s.deadline - s.now())),
            ),
          )
        : null,
      safety: safety(),
    });
  if (options.signal?.aborted)
    return finish("cancelled", "cancelled-before-dispatch");
  if (!options.confirmDigest || !/^[a-f0-9]{64}$/u.test(options.confirmDigest))
    return finish("refused", "confirmation-required");
  let lease: Awaited<ReturnType<typeof acquireWorkload>> | null = null;
  try {
    lease = await (options.dependencies?.acquire ?? acquireWorkload)({
      ...queueOptions(s),
      command: "engine-stop",
      waitTimeoutSeconds: 0,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const observed = await observePlan(s, true);
    engine = observed.plan.engine;
    if (observed.plan.state === "already-stopped") {
      confirmed = { profileStopped: true, vmProcessAbsent: false };
      return finish("already-stopped", "profile-stopped");
    }
    if (observed.plan.state !== "review-required" || !observed.proof)
      return finish("refused", observed.plan.reason);
    if (observed.plan.consentDigest !== options.confirmDigest)
      return finish("refused", "review-changed");
    if (options.signal?.aborted)
      return finish("cancelled", "cancelled-before-dispatch");
    const again = await observePlan(s, true);
    if (again.plan.consentDigest !== options.confirmDigest || !again.proof)
      return finish("refused", "review-changed");
    const finalProof = await qualifyColimaDefault(
      s.backend,
      again.proof.endpoint,
      again.plan.engine!.daemonId,
    );
    if (
      finalProof.identity !== again.proof.identity ||
      finalProof.bootId !== again.proof.bootId
    )
      return finish("refused", "review-changed");
    const busy = await coordination(s, true);
    if (busy) return finish("refused", busy);
    const finalSelection = resolveSelection(s);
    if (finalSelection.identity !== again.plan.engine!.endpointIdentity)
      return finish("refused", "review-changed");
    const finalEnvironment = scopedDockerEnvironment({
      inheritedEnvironment: s.environment,
      endpoint: finalSelection.endpoint,
    });
    try {
      const finalImpact = inspectEngineImpact(
        s,
        finalSelection.endpoint,
        finalEnvironment,
      );
      if (JSON.stringify(finalImpact) !== JSON.stringify(again.plan.impact))
        return finish("refused", "review-changed");
    } catch {
      return finish("refused", "review-changed");
    }
    if (
      text(
        s,
        ["--host", finalSelection.endpoint, "info", "--format", "{{.ID}}"],
        finalEnvironment,
      ) !== again.plan.engine!.daemonId
    )
      return finish("refused", "review-changed");
    if (options.signal?.aborted)
      return finish("cancelled", "cancelled-before-dispatch");
    if (s.deadline - s.now() < 20000)
      return finish("refused", "shutdown-unconfirmed");
    dispatched = true;
    const timer = new AbortController(),
      abort = () => timer.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => timer.abort(),
      Math.max(1, Math.min(60000, s.deadline - s.now() - 12000)),
    );
    let result: { status: number | null };
    try {
      result = options.dependencies?.stop
        ? await options.dependencies.stop(again.proof.environment, timer.signal)
        : await runOwnedProcess({
            command: "colima",
            args: ["stop"],
            cwd: s.cwd,
            env: again.proof.environment,
            signal: timer.signal,
            stdin: "ignore",
            maxOutputBytes: 65536,
            cancellationGraceMs: 1000,
          });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
    // Once dispatched, cancellation cannot undo shutdown. Observe safely with a fresh non-cancelled probe session.
    const verification = session(
      { ...options, signal: undefined },
      Math.max(1, Math.min(10000, s.deadline - s.now() - 2000)),
    );
    const until = Math.min(verification.deadline, verification.now() + 8000);
    do {
      try {
        confirmed = await confirmColimaStopped(
          verification.backend,
          again.proof,
        );
      } catch {
        confirmed = { profileStopped: false, vmProcessAbsent: false };
      }
      if (confirmed.profileStopped && confirmed.vmProcessAbsent)
        return finish(
          result.status === 0 ? "stopped" : "failed",
          result.status === 0
            ? "shutdown-confirmed"
            : "shutdown-command-failed",
        );
      if (verification.now() >= until) break;
      await delay(100);
    } while (verification.now() < until);
    return finish(
      options.signal?.aborted
        ? "unknown"
        : result.status === 0
          ? "unknown"
          : "failed",
      options.signal?.aborted
        ? "cancelled-after-dispatch"
        : result.status === 0
          ? "shutdown-unconfirmed"
          : "shutdown-command-failed",
    );
  } catch {
    return finish(
      options.signal?.aborted
        ? dispatched
          ? "unknown"
          : "cancelled"
        : dispatched
          ? "unknown"
          : "refused",
      options.signal?.aborted
        ? dispatched
          ? "cancelled-after-dispatch"
          : "cancelled-before-dispatch"
        : dispatched
          ? "shutdown-unconfirmed"
          : "coordination-unavailable",
    );
  } finally {
    try {
      await lease?.release();
    } catch {
      if (reportState.value) {
        reportState.value.status = "unknown";
        reportState.value.reason = "coordination-unavailable";
      } else throw Error("Engine coordination release could not be verified.");
    }
  }
}
