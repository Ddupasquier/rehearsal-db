/** Explicit completed-disposable ownership; never age-based or forced cleanup.
 * Cooperative local-owner contract, not isolation from a malicious local user. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  isLocalDockerEndpoint,
  scopedDockerEnvironment,
  DOCKER_CONTEXT_TLS_FORMAT,
} from "../engines/local_docker_context.mjs";
export type ContainerRetirementRunner = (
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
) => SpawnSyncReturns<string>;
export interface ContainerRetirementBinding {
  context: string;
  endpoint: string;
  daemonId: string;
}
export interface ContainerRetirementClaim {
  fullId: string;
  expectedLabels: Readonly<Record<string, string>>;
  completedDisposable: true;
}
export interface ContainerRetirementSnapshot {
  fullId: string;
  labels: Readonly<Record<string, string>>;
  labelsSha256: string;
  state: "created" | "exited";
  startedAt: string;
  finishedAt: string;
  restartCount: number;
  image: string;
  mounts: readonly {
    type: string;
    name: string | null;
    destination: string;
    writable: boolean;
  }[];
}
export interface ContainerRetirementVolume {
  name: string;
  createdAt: string;
  driver: string;
}
export interface ContainerRetirementPlan {
  volumes: readonly ContainerRetirementVolume[];
  schemaVersion: 1;
  binding: ContainerRetirementBinding;
  claims: readonly ContainerRetirementClaim[];
  snapshots: readonly ContainerRetirementSnapshot[];
  consentDigest: string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(): never {
  throw new Error(
    "Disposable container retirement refused: ownership, stopped state or pinned engine evidence could not be verified; unrelated resources were preserved.",
  );
}
const fullId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const safeText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && !/[\0\r\n]/u.test(value);
/** Preserve exact Docker RFC3339 nanoseconds, including the unstarted year-0001 sentinel. */
const validContainerTimestamp = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length > 30 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  );
};
const run: ContainerRetirementRunner = (command, args, environment) =>
  spawnSync(command, args, {
    encoding: "utf8",
    env: environment ?? scopedDockerEnvironment(),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
const inspectFormat =
  '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"state":{{json .State.Status}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"restartCount":{{json .RestartCount}},"image":{{json .Image}},"mounts":{{json .Mounts}}}';
const validate = (
  binding: ContainerRetirementBinding,
  claims: readonly ContainerRetirementClaim[],
) => {
  if (
    !binding ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(binding.context) ||
    !isLocalDockerEndpoint(binding.endpoint) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(binding.daemonId) ||
    !Array.isArray(claims) ||
    claims.length < 1 ||
    claims.length > 32 ||
    new Set(claims.map((c) => c?.fullId)).size !== claims.length
  )
    refuse();
  for (const claim of claims) {
    if (
      !claim ||
      !fullId(claim.fullId) ||
      claim.completedDisposable !== true ||
      !claim.expectedLabels ||
      typeof claim.expectedLabels !== "object" ||
      Array.isArray(claim.expectedLabels)
    )
      refuse();
    const labels = Object.entries(claim.expectedLabels);
    if (
      !labels.length ||
      labels.length > 64 ||
      labels.some(([k, v]) => !safeText(k) || !k || !safeText(v) || !v)
    )
      refuse();
  }
};
const session = (
  binding: ContainerRetirementBinding,
  runner: ContainerRetirementRunner,
) => {
  const deadline = Date.now() + 60_000;
  const inheritedEnvironment = { ...process.env };
  if (
    (inheritedEnvironment.DOCKER_CONTEXT &&
      inheritedEnvironment.DOCKER_CONTEXT !== binding.context) ||
    (!inheritedEnvironment.DOCKER_CONTEXT &&
      inheritedEnvironment.DOCKER_HOST &&
      inheritedEnvironment.DOCKER_HOST !== binding.endpoint) ||
    binding.endpoint.startsWith("https:")
  )
    refuse();
  const metadataEnvironment = scopedDockerEnvironment({ inheritedEnvironment });
  const environment = scopedDockerEnvironment({
    inheritedEnvironment,
    endpoint: binding.endpoint,
  });
  const raw = (args: readonly string[]) => {
    if (Date.now() > deadline) refuse();
    const result = runner(
      "docker",
      args,
      args[0] === "context" ? metadataEnvironment : environment,
    );
    if (
      result.status !== 0 ||
      result.error ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > 1024 * 1024
    )
      refuse();
    return result.stdout;
  };
  const identity = () => {
    let endpoint: unknown;
    try {
      endpoint = JSON.parse(
        raw([
          "context",
          "inspect",
          "--format",
          "{{json .Endpoints.docker.Host}}",
          binding.context,
        ]),
      );
    } catch {
      return refuse();
    }
    if (
      endpoint !== binding.endpoint ||
      raw([
        "context",
        "inspect",
        "--format",
        DOCKER_CONTEXT_TLS_FORMAT,
        binding.context,
      ]).trim() !== "false" ||
      raw([
        "--host",
        binding.endpoint,
        "info",
        "--format",
        "{{.ID}}",
      ]).trim() !== binding.daemonId
    )
      refuse();
  };
  return (args: readonly string[]) => {
    identity();
    const value = raw(["--host", binding.endpoint, ...args]);
    identity();
    return value;
  };
};
const inspect = (
  query: ReturnType<typeof session>,
  claim: ContainerRetirementClaim,
): ContainerRetirementSnapshot => {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(
      query(["container", "inspect", "--format", inspectFormat, claim.fullId]),
    );
  } catch {
    return refuse();
  }
  if (
    !value ||
    value.id !== claim.fullId ||
    !["created", "exited"].includes(value.state as string) ||
    value.running !== false ||
    value.paused !== false ||
    value.restarting !== false ||
    !validContainerTimestamp(value.startedAt) ||
    !validContainerTimestamp(value.finishedAt) ||
    !Number.isSafeInteger(value.restartCount) ||
    (value.restartCount as number) < 0 ||
    !safeText(value.image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.image) ||
    !value.labels ||
    typeof value.labels !== "object" ||
    Array.isArray(value.labels) ||
    !Array.isArray(value.mounts) ||
    value.mounts.length > 128
  )
    refuse();
  const labels = Object.entries(value.labels as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  if (
    labels.length > 64 ||
    labels.some(([k, v]) => !safeText(k) || !safeText(v))
  )
    refuse();
  for (const [key, expected] of Object.entries(claim.expectedLabels))
    if ((value.labels as Record<string, unknown>)[key] !== expected) refuse();
  const knownOwners = [
    "com.rehearsal-db.project",
    "com.supabase.cli.project",
    "com.docker.compose.project",
  ];
  for (const key of knownOwners)
    if (
      (value.labels as Record<string, unknown>)[key] !== undefined &&
      !Object.hasOwn(claim.expectedLabels, key)
    )
      refuse();
  const projectOwners = knownOwners
    .slice(0, 2)
    .map((key) => (value.labels as Record<string, unknown>)[key])
    .filter((v) => v !== undefined);
  if (new Set(projectOwners).size > 1) refuse();
  const mounts = value.mounts
    .map((raw: unknown) => {
      if (!raw || typeof raw !== "object") return refuse();
      const m = raw as Record<string, unknown>;
      if (
        !["volume", "bind", "tmpfs"].includes(m.Type as string) ||
        !safeText(m.Destination) ||
        typeof m.RW !== "boolean" ||
        (m.Type === "volume" &&
          (typeof m.Name !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u.test(m.Name)))
      )
        return refuse();
      return {
        type: m.Type as string,
        name: m.Type === "volume" ? (m.Name as string) : null,
        destination: m.Destination,
        writable: m.RW,
      };
    })
    .sort((left, right) => {
      // Docker's inspect projection may enumerate its mount map in a different
      // order. Bind the exact mount facts, independently of that presentation order.
      const a = JSON.stringify(left),
        b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return {
    fullId: claim.fullId,
    labels: { ...claim.expectedLabels },
    labelsSha256: hash(labels),
    state: value.state as "created" | "exited",
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    restartCount: value.restartCount as number,
    image: value.image,
    mounts,
  };
};
const inspectVolume = (
  query: ReturnType<typeof session>,
  name: string,
): ContainerRetirementVolume => {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(
      query([
        "volume",
        "inspect",
        "--format",
        '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}}}',
        name,
      ]),
    );
  } catch {
    return refuse();
  }
  if (
    !value ||
    value.name !== name ||
    !safeText(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !safeText(value.driver) ||
    !value.driver
  )
    refuse();
  return { name, createdAt: value.createdAt, driver: value.driver };
};
export const planContainerRetirement = ({
  binding,
  claims,
  runner = run,
}: {
  binding: ContainerRetirementBinding;
  claims: readonly ContainerRetirementClaim[];
  runner?: ContainerRetirementRunner;
}): ContainerRetirementPlan => {
  validate(binding, claims);
  const query = session(binding, runner),
    snapshots = claims.map((claim) => inspect(query, claim));
  const names = [
    ...new Set(
      snapshots.flatMap((s) =>
        s.mounts.flatMap((m) => (m.name ? [m.name] : [])),
      ),
    ),
  ];
  if (names.length > 128) refuse();
  const volumes = names.map((name) => inspectVolume(query, name));
  const body = {
    volumes,
    schemaVersion: 1 as const,
    binding: { ...binding },
    claims: claims.map((c) => ({
      ...c,
      expectedLabels: { ...c.expectedLabels },
    })),
    snapshots,
  };
  return { ...body, consentDigest: hash(body) };
};
export const retireContainers = ({
  plan,
  consent,
  runner = run,
}: {
  plan: ContainerRetirementPlan;
  consent:
    { kind: "manual"; digest: string } | { kind: "trusted-completion-hook" };
  runner?: ContainerRetirementRunner;
}) => {
  validate(plan.binding, plan.claims);
  const { consentDigest, ...body } = plan;
  if (
    plan.schemaVersion !== 1 ||
    hash(body) !== consentDigest ||
    (consent.kind !== "trusted-completion-hook" &&
      (consent.kind !== "manual" || consent.digest !== consentDigest)) ||
    plan.snapshots.length !== plan.claims.length
  )
    refuse();
  const query = session(plan.binding, runner);
  const outcomes: {
    fullId: string;
    status: "removed" | "refused" | "failed";
    containerRemoved: boolean | null;
    volumesPreserved: boolean | null;
  }[] = [];
  for (let index = 0; index < plan.claims.length; index++) {
    const claim = plan.claims[index]!;
    let removed: boolean | null = false,
      attempted = false;
    try {
      const current = inspect(query, claim);
      if (hash(current) !== hash(plan.snapshots[index])) refuse();
      const volumes = [
        ...new Set(current.mounts.flatMap((m) => (m.name ? [m.name] : []))),
      ];
      for (const name of volumes)
        if (
          hash(inspectVolume(query, name)) !==
          hash(plan.volumes.find((v) => v.name === name))
        )
          refuse();
      attempted = true;
      removed = null;
      query(["container", "rm", claim.fullId]);
      const remaining = query([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `id=${claim.fullId}`,
        "--format",
        "{{.ID}}",
      ]);
      if (remaining.trim() !== "") refuse();
      removed = true;
      for (const name of volumes)
        if (
          hash(inspectVolume(query, name)) !==
          hash(plan.volumes.find((v) => v.name === name))
        )
          refuse();
      outcomes.push({
        fullId: claim.fullId,
        status: "removed",
        containerRemoved: true,
        volumesPreserved: true,
      });
    } catch {
      let preserved: boolean | null = null;
      if (attempted) {
        // A failed command may still have removed the container. Report only
        // independently verified absence; an unavailable engine stays unknown.
        try {
          const remaining = query([
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            `id=${claim.fullId}`,
            "--format",
            "{{.ID}}",
          ]);
          removed =
            remaining.trim() === ""
              ? true
              : remaining.trim() === claim.fullId
                ? false
                : null;
          const names = plan.snapshots[index]!.mounts.flatMap((m) =>
            m.name ? [m.name] : [],
          );
          preserved = names.every(
            (name) =>
              hash(inspectVolume(query, name)) ===
              hash(plan.volumes.find((v) => v.name === name)),
          );
        } catch {
          /* engine/volume proof unknown; never claim success */
        }
      }
      outcomes.push({
        fullId: claim.fullId,
        status: attempted ? "failed" : "refused",
        containerRemoved: removed,
        volumesPreserved: preserved,
      });
      // Stop the batch when any proof is lost; never compound partial cleanup.
      for (const remaining of plan.claims.slice(index + 1))
        outcomes.push({
          fullId: remaining.fullId,
          status: "refused",
          containerRemoved: false,
          volumesPreserved: false,
        });
      break;
    }
  }
  return {
    schemaVersion: 1 as const,
    status: outcomes.every((o) => o.status === "removed")
      ? "completed"
      : outcomes.some((o) => o.containerRemoved)
        ? "partial"
        : outcomes.some((o) => o.status === "failed")
          ? "failed"
          : "refused",
    outcomes,
  };
};
