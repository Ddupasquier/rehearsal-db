import {
  normalizeRuntimeMarkerProtocol,
  protectPostgresqlRuntimeMarker,
} from "../runtime/runtime_marker_protocol.mjs";
import { isDeepStrictEqual } from "node:util";
import { captureRuntimeStartupOwnership } from "../runtime/runtime_startup_ownership.mjs";
/** Reconstruct a deliberately retired PostgreSQL container without resetting its retained data. */
import { assertDockerResourceLabels } from "./docker_resource_ownership.mjs";
export interface PostgresqlRetainedContainerReceipt {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly containerName: string;
  readonly volumeName: string;
  readonly volumeCreatedAt: string;
  readonly volumeDriver: string;
  readonly image: string;
  readonly imageId: string;
  readonly engineIdentity: string;
  readonly generationId: string;
  readonly dataSha256: string;
}
export interface PostgresqlResumeMarker {
  readonly target: "postgresql";
  readonly generationId: string;
  readonly dataSha256: string;
  readonly image: string;
  readonly databasePassword: string;
}
export interface PostgresqlResumeSnapshot {
  readonly engineIdentity: string;
  readonly image:
    | {
        readonly state: "present";
        readonly id: string;
        readonly reference: string;
      }
    | { readonly state: "absent" | "unknown" };
  readonly volume:
    | {
        readonly state: "present";
        readonly name: string;
        readonly createdAt: string;
        readonly driver: string;
        readonly labels: unknown;
      }
    | { readonly state: "absent" | "unknown" };
  /** Absence must come from a successful complete exact-name listing, never inspect failure. */
  readonly container:
    | { readonly state: "absent" }
    | { readonly state: "unknown" }
    | {
        readonly state: "present";
        readonly id: string;
        readonly name: string;
        readonly imageId: string;
        readonly labels: unknown;
        readonly running: boolean;
        readonly mounts: readonly {
          readonly type: string;
          readonly name: string;
          readonly destination: string;
          readonly writable: boolean;
        }[];
      };
}
export interface PostgresqlResumeAdapter {
  /** Each callback must use the pinned engine and honor both signal and timeoutMilliseconds. */
  inspect(options: {
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
  }): Promise<PostgresqlResumeSnapshot>;
  create(
    args: readonly string[],
    options: {
      readonly signal: AbortSignal;
      readonly timeoutMilliseconds: number;
    },
  ): Promise<void>;
  waitUntilReady(options: {
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
  }): Promise<void>;
}
const refused = () =>
  new Error(
    "Retained PostgreSQL container cannot be resumed safely. Preserve its volume, runtime marker and retirement receipt; no baseline reset or data deletion was attempted.",
  );
const identifier = /^[a-z_][a-z0-9_]*$/u;
const digest = /^[a-f0-9]{64}$/u;
const assertReceipt = (
  receipt: PostgresqlRetainedContainerReceipt,
  marker: PostgresqlResumeMarker,
) => {
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    !/^[-a-z0-9]{2,63}$/u.test(receipt.projectId) ||
    receipt.containerName !== receipt.projectId + "-postgresql" ||
    receipt.volumeName !== receipt.containerName + "-data" ||
    !/^postgres:\d+(?:\.\d+)?-alpine$/u.test(receipt.image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.imageId) ||
    !digest.test(receipt.engineIdentity) ||
    typeof receipt.volumeDriver !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(receipt.volumeDriver) ||
    !receipt.volumeCreatedAt ||
    !Number.isFinite(Date.parse(receipt.volumeCreatedAt)) ||
    !receipt.generationId ||
    !digest.test(receipt.dataSha256) ||
    !marker ||
    marker.target !== "postgresql" ||
    marker.generationId !== receipt.generationId ||
    marker.dataSha256 !== receipt.dataSha256 ||
    marker.image !== receipt.image ||
    typeof marker.databasePassword !== "string" ||
    marker.databasePassword.length < 32 ||
    marker.databasePassword.length > 256 ||
    /[\r\n\0]/u.test(marker.databasePassword)
  )
    throw refused();
};
const assertRetainedBindings = (
  snapshot: PostgresqlResumeSnapshot,
  receipt: PostgresqlRetainedContainerReceipt,
) => {
  if (
    snapshot.engineIdentity !== receipt.engineIdentity ||
    snapshot.image.state !== "present" ||
    snapshot.image.id !== receipt.imageId ||
    snapshot.image.reference !== receipt.image ||
    snapshot.volume.state !== "present" ||
    snapshot.volume.name !== receipt.volumeName ||
    snapshot.volume.createdAt !== receipt.volumeCreatedAt ||
    snapshot.volume.driver !== receipt.volumeDriver
  )
    throw refused();
  try {
    assertDockerResourceLabels({
      labels: snapshot.volume.labels,
      expectedLabel: "com.rehearsal-db.project",
      projectId: receipt.projectId,
    });
  } catch {
    throw refused();
  }
};
const assertCreatedContainer = (
  snapshot: PostgresqlResumeSnapshot,
  receipt: PostgresqlRetainedContainerReceipt,
) => {
  assertRetainedBindings(snapshot, receipt);
  if (
    snapshot.container.state !== "present" ||
    !digest.test(snapshot.container.id) ||
    snapshot.container.name !== receipt.containerName ||
    snapshot.container.imageId !== receipt.imageId ||
    !snapshot.container.running ||
    snapshot.container.mounts.length !== 1
  )
    throw refused();
  try {
    assertDockerResourceLabels({
      labels: snapshot.container.labels,
      expectedLabel: "com.rehearsal-db.project",
      projectId: receipt.projectId,
    });
  } catch {
    throw refused();
  }
  const mount = snapshot.container.mounts[0]!;
  if (
    mount.type !== "volume" ||
    mount.name !== receipt.volumeName ||
    mount.destination !== "/var/lib/postgresql/data" ||
    !mount.writable
  )
    throw refused();
  return snapshot.container;
};
export const retainedPostgresqlCreateArguments = ({
  receipt,
  password,
  port,
  user,
  database,
}: {
  readonly receipt: PostgresqlRetainedContainerReceipt;
  readonly password: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}): readonly string[] => {
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !identifier.test(user) ||
    !identifier.test(database) ||
    typeof password !== "string" ||
    password.length < 32 ||
    password.length > 256 ||
    /[\r\n\0]/u.test(password)
  )
    throw refused();
  return Object.freeze([
    "run",
    "--detach",
    "--pull=never",
    "--name",
    receipt.containerName,
    "--label",
    "com.rehearsal-db.project=" + receipt.projectId,
    "--publish",
    `127.0.0.1:${port}:5432`,
    "--env",
    "POSTGRES_PASSWORD=" + password,
    "--env",
    "POSTGRES_DB=" + database,
    "--env",
    "POSTGRES_USER=" + user,
    "--volume",
    receipt.volumeName + ":/var/lib/postgresql/data",
    receipt.imageId,
  ]);
};
/** Caller holds the existing lifecycle/operation lease and has verified the private marker/receipt files. */
export const resumeRetainedPostgresqlContainer = async ({
  receipt,
  marker,
  port,
  user,
  database,
  adapter,
  signal: providedSignal,
}: {
  readonly receipt: PostgresqlRetainedContainerReceipt;
  readonly marker: PostgresqlResumeMarker;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly adapter: PostgresqlResumeAdapter;
  readonly signal?: AbortSignal;
}) => {
  assertReceipt(receipt, marker);
  const controller = new AbortController();
  const parentAbort = () => controller.abort();
  providedSignal?.addEventListener("abort", parentAbort, { once: true });
  if (providedSignal?.aborted) controller.abort();
  const signal = controller.signal;
  const deadline = setTimeout(() => controller.abort(), 180000);
  deadline.unref();
  try {
    signal.throwIfAborted();
    const args = retainedPostgresqlCreateArguments({
      receipt,
      password: marker.databasePassword,
      port,
      user,
      database,
    });
    const first = await adapter.inspect({ signal, timeoutMilliseconds: 10000 });
    signal.throwIfAborted();
    assertRetainedBindings(first, receipt);
    if (first.container.state !== "absent") throw refused();
    // Recheck after review immediately before the sole creation; foreign replacements never become reset requests.
    const current = await adapter.inspect({
      signal,
      timeoutMilliseconds: 10000,
    });
    signal.throwIfAborted();
    assertRetainedBindings(current, receipt);
    if (current.container.state !== "absent") throw refused();
    // Resume creates a new shell too: capture before mutation so the shared
    // startup controller can stop this exact shell after readiness failure or cancellation.
    captureRuntimeStartupOwnership();
    await adapter.create(args, { signal, timeoutMilliseconds: 120000 });
    signal.throwIfAborted();
    const created = await adapter.inspect({
      signal,
      timeoutMilliseconds: 10000,
    });
    signal.throwIfAborted();
    const createdContainer = assertCreatedContainer(created, receipt);
    await adapter.waitUntilReady({ signal, timeoutMilliseconds: 60000 });
    signal.throwIfAborted();
    const ready = await adapter.inspect({ signal, timeoutMilliseconds: 10000 });
    signal.throwIfAborted();
    const readyContainer = assertCreatedContainer(ready, receipt);
    if (
      readyContainer.id !== createdContainer.id ||
      JSON.stringify(readyContainer.mounts) !==
        JSON.stringify(createdContainer.mounts)
    )
      throw refused();
    return Object.freeze({
      state: "resumed" as const,
      containerId: createdContainer.id,
      volumeName: receipt.volumeName,
      volumeCreatedAt: receipt.volumeCreatedAt,
      imageId: receipt.imageId,
      generationId: receipt.generationId,
      dataSha256: receipt.dataSha256,
      dataPreserved: true as const,
    });
  } catch {
    throw refused();
  } finally {
    clearTimeout(deadline);
    providedSignal?.removeEventListener("abort", parentAbort);
  }
};
// Driver adapter: private crash-recoverable receipt and real bounded engine probes live here.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertLocalDockerContext,
  runtimeDockerContext,
  isLocalDockerEndpoint,
  scopedDockerEnvironment,
} from "../runtime/local_docker_context.mjs";
import {
  planContainerRetirement,
  retireContainers,
  type ContainerRetirementBinding,
  type ContainerRetirementRunner,
} from "../runtime/container_retirement.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
const bytesHash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const createPostgresqlContainerLifecycle = ({
  cwd,
  runtimeWorkdir,
  markerPath,
  projectId,
  image,
  port,
  user,
  database,
  dependencies,
}: {
  cwd: string;
  runtimeWorkdir: string;
  markerPath: string;
  projectId: string;
  image: string;
  port: number;
  user: string;
  database: string;
  dependencies?: {
    run: (
      args: readonly string[],
      environment?: NodeJS.ProcessEnv,
    ) => {
      status: number | null;
      stdout: string;
      error?: unknown;
    };
    localContext: () => { context: string; endpoint: string; identity: string };
    diagnostic: (message: string) => void;
  };
}) => {
  const name = projectId + "-postgresql",
    volumeName = name + "-data",
    receiptPath = join(runtimeWorkdir, "container-retirement.json");
  const raw = (args: readonly string[], environment?: NodeJS.ProcessEnv) =>
    dependencies?.run(args, environment) ??
    spawnSync("docker", args, {
      cwd,
      encoding: "utf8",
      env: environment ?? scopedDockerEnvironment(),
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const retirementRunner: ContainerRetirementRunner | undefined = dependencies
    ? (_command, args, environment) => {
        if (_command !== "docker") throw refused();
        const result = raw(args, environment);
        return {
          pid: 0,
          output: [null, result.stdout, ""],
          stdout: result.stdout,
          stderr: "",
          status: result.status,
          signal: null,
          ...(result.error
            ? {
                error:
                  result.error instanceof Error
                    ? (result.error as NodeJS.ErrnoException)
                    : new Error("Injected Docker probe failed."),
              }
            : {}),
        };
      }
    : undefined;
  const probePin = () => {
    const local =
      dependencies?.localContext() ??
      (() => {
        const context = runtimeDockerContext();
        if (!context) throw refused();
        return assertLocalDockerContext({ cwd, context });
      })();
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(local.context) ||
      !isLocalDockerEndpoint(local.endpoint) ||
      !digest.test(local.identity)
    )
      throw refused();
    const info = raw(["--host", local.endpoint, "info", "--format", "{{.ID}}"]);
    if (info.status !== 0 || info.error) return null;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(info.stdout.trim()))
      throw refused();
    return {
      binding: {
        context: local.context,
        endpoint: local.endpoint,
        daemonId: info.stdout.trim(),
      },
      identity: local.identity,
    };
  };
  const pin = () => {
    const value = probePin();
    if (!value) throw refused();
    return value;
  };
  const noAction = (reason: "engine-unavailable" | "container-absent") => {
    (dependencies?.diagnostic ?? console.log)(
      reason === "engine-unavailable"
        ? "PostgreSQL stop: local engine unavailable; no container action performed and retained volumes were not inspected."
        : "PostgreSQL stop: exact project container is absent; no container action performed and retained volumes were not inspected.",
    );
    return Object.freeze({
      state: "no-action" as const,
      reason,
      volumesPreserved: null,
    });
  };
  const query = (
    binding: ContainerRetirementBinding,
    args: readonly string[],
  ) => {
    const current = pin();
    if (JSON.stringify(current.binding) !== JSON.stringify(binding))
      throw refused();
    const result = raw(["--host", binding.endpoint, ...args]);
    if (result.status !== 0 || result.error) throw refused();
    return result.stdout.trim();
  };
  const assertPrivateParent = async () => {
    if ((await realpath(runtimeWorkdir)) !== resolve(runtimeWorkdir))
      throw refused();
    const parent = await lstat(runtimeWorkdir);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.mode & 0o077 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      throw refused();
    return { dev: parent.dev, ino: parent.ino };
  };
  const privateBytes = async (path: string) => {
    const began = Date.now(),
      parentBefore = await assertPrivateParent();
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.mode & 0o077 ||
        before.size < 2 ||
        before.size > 65536 ||
        (process.getuid && before.uid !== process.getuid())
      )
        throw refused();
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        if (Date.now() - began > 3000) throw refused();
        const read = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat(),
        linked = await lstat(path),
        parentAfter = await assertPrivateParent();
      if (
        Date.now() - began > 3000 ||
        offset !== before.size ||
        after.size !== before.size ||
        (["dev", "ino", "mtimeMs", "ctimeMs", "mode", "uid"] as const).some(
          (key) => after[key] !== before[key],
        ) ||
        linked.isSymbolicLink() ||
        linked.dev !== before.dev ||
        linked.ino !== before.ino ||
        JSON.stringify(parentBefore) !== JSON.stringify(parentAfter)
      )
        throw refused();
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  };
  const writeReceipt = async (value: unknown) => {
    await assertPrivateParent();
    const tmp = join(runtimeWorkdir, ".retirement-" + randomUUID() + ".json");
    await writeFile(tmp, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, receiptPath);
  };
  const backupPath = join(runtimeWorkdir, "baseline.pre-retirement.json");
  const protectMarker = async (
    markerBytes: Buffer,
    prepared: Record<string, unknown>,
  ) => {
    const rawMarker = JSON.parse(markerBytes.toString()),
      protectedValue = protectPostgresqlRuntimeMarker(rawMarker);
    const protectedBytes =
      rawMarker.target === "postgresql-retired"
        ? markerBytes
        : Buffer.from(JSON.stringify(protectedValue, null, "\t") + "\n");
    if (rawMarker.target === "postgresql-retired") {
      const original = await privateBytes(backupPath);
      if (
        !isDeepStrictEqual(
          protectPostgresqlRuntimeMarker(JSON.parse(original.toString())),
          protectedValue,
        )
      )
        throw refused();
    } else {
      try {
        const handle = await open(
          backupPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(markerBytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await privateBytes(backupPath)).equals(markerBytes))
          throw refused();
      }
    }
    const protectedPrepared = {
      ...prepared,
      state: "prepared",
      markerSha256: bytesHash(protectedBytes),
      priorMarkerSha256: bytesHash(markerBytes),
      markerProtectionProtocol: 1,
    };
    await writeReceipt(protectedPrepared);
    if (!(await privateBytes(markerPath)).equals(markerBytes)) throw refused();
    if (!protectedBytes.equals(markerBytes)) {
      const tmp = join(
        runtimeWorkdir,
        ".protected-marker-" + randomUUID() + ".json",
      );
      const handle = await open(
        tmp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(protectedBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertPrivateParent();
      await rename(tmp, markerPath);
    }
    if (!(await privateBytes(markerPath)).equals(protectedBytes))
      throw refused();
    return protectedPrepared;
  };
  const verifyStored = (
    stored: Record<string, any>,
    binding: ContainerRetirementBinding,
    identity: string,
    markerBytes: Buffer,
  ) => {
    if (
      stored.schemaVersion !== 1 ||
      !["prepared", "completed"].includes(stored.state) ||
      stored.projectId !== projectId ||
      JSON.stringify(stored.binding) !== JSON.stringify(binding) ||
      stored.receipt?.engineIdentity !== identity ||
      !(
        stored.markerSha256 === bytesHash(markerBytes) ||
        (stored.state === "prepared" &&
          stored.markerProtectionProtocol === 1 &&
          stored.priorMarkerSha256 === bytesHash(markerBytes))
      )
    )
      throw refused();
    const marker = normalizeRuntimeMarkerProtocol(
      JSON.parse(markerBytes.toString()),
    ) as unknown as PostgresqlResumeMarker;
    assertReceipt(stored.receipt, marker);
    return marker;
  };
  const existingIds = (binding: ContainerRetirementBinding) => {
    const output = query(binding, [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      "name=^/" + name + "$",
      "--format",
      "{{.ID}}",
    ]);
    const ids = output ? output.split("\n") : [];
    if (ids.length > 1 || ids.some((id) => !digest.test(id))) throw refused();
    return ids;
  };
  const observe = (
    binding: ContainerRetirementBinding,
    identity: string,
    retainedImageId: string,
  ): PostgresqlResumeSnapshot => {
    const volumeJson = JSON.parse(
      query(binding, [
        "volume",
        "inspect",
        "--format",
        '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"labels":{{json .Labels}}}',
        volumeName,
      ]),
    );
    const imageId = query(binding, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      retainedImageId,
    ]);
    const ids = existingIds(binding);
    let container: PostgresqlResumeSnapshot["container"] = { state: "absent" };
    if (ids.length) {
      const parsed = JSON.parse(
        query(binding, [
          "container",
          "inspect",
          "--format",
          '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"mounts":{{json .Mounts}}}',
          ids[0]!,
        ]),
      );
      container = {
        state: "present",
        id: parsed.id,
        name: parsed.name.replace(/^\//u, ""),
        imageId: parsed.imageId,
        labels: parsed.labels,
        running: parsed.running,
        mounts: parsed.mounts.map(
          (m: {
            Type: string;
            Name?: string;
            Destination: string;
            RW: boolean;
          }) => ({
            type: m.Type,
            name: m.Name ?? "",
            destination: m.Destination,
            writable: m.RW,
          }),
        ),
      };
    }
    return {
      engineIdentity: identity,
      image: { state: "present", id: imageId, reference: image },
      volume: { state: "present", ...volumeJson },
      container,
    };
  };
  const bounded = async (
    binding: ContainerRetirementBinding,
    args: readonly string[],
    signal: AbortSignal,
    timeoutMilliseconds: number,
  ) => {
    query(binding, ["info", "--format", "{{.ID}}"]);
    signal.throwIfAborted();
    if (dependencies) {
      const began = Date.now(),
        result = raw(["--host", binding.endpoint, ...args]);
      signal.throwIfAborted();
      if (
        result.status !== 0 ||
        result.error ||
        Date.now() - began > timeoutMilliseconds
      )
        throw refused();
      return;
    }
    const timeout = new AbortController(),
      abort = () => timeout.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) timeout.abort();
    const timer = setTimeout(() => timeout.abort(), timeoutMilliseconds);
    timer.unref();
    try {
      const result = await runOwnedProcess({
        command: "docker",
        args: ["--host", binding.endpoint, ...args],
        cwd,
        env: scopedDockerEnvironment(),
        signal: timeout.signal,
        stdin: "ignore",
        maxOutputBytes: 1024 * 1024,
        cancellationGraceMs: 1000,
      });
      if (result.status !== 0) throw refused();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
  return {
    retireStopped: async () => {
      const available = probePin();
      if (!available) return noAction("engine-unavailable");
      const { binding, identity } = available,
        ids = existingIds(binding);
      if (!ids.length) {
        try {
          await lstat(receiptPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return noAction("container-absent");
          throw error;
        }
        const stored = JSON.parse((await privateBytes(receiptPath)).toString()),
          markerBytes = await privateBytes(markerPath);
        verifyStored(stored, binding, identity, markerBytes);
        assertRetainedBindings(
          observe(binding, identity, stored.receipt.imageId),
          stored.receipt,
        );
        const protectedPrepared = await protectMarker(markerBytes, stored);
        await writeReceipt({ ...protectedPrepared, state: "completed" });
        return Object.freeze({
          state: "protected-retained-runtime",
          containerRemoved: false,
          volumesPreserved: true,
        });
      }
      const markerBytes = await privateBytes(markerPath);
      const marker = normalizeRuntimeMarkerProtocol(
        JSON.parse(markerBytes.toString()),
      ) as unknown as PostgresqlResumeMarker;
      if (
        !marker ||
        marker.target !== "postgresql" ||
        marker.image !== image ||
        typeof marker.generationId !== "string" ||
        !marker.generationId ||
        !digest.test(marker.dataSha256) ||
        typeof marker.databasePassword !== "string" ||
        marker.databasePassword.length < 32 ||
        marker.databasePassword.length > 256 ||
        /[\r\n\0]/u.test(marker.databasePassword)
      )
        throw refused();
      const labels = JSON.parse(
        query(binding, [
          "container",
          "inspect",
          "--format",
          "{{json .Config.Labels}}",
          ids[0]!,
        ]),
      );
      assertDockerResourceLabels({
        labels,
        expectedLabel: "com.rehearsal-db.project",
        projectId,
      });
      const signal =
        getOperationCancellationSignal() ?? new AbortController().signal;
      await bounded(binding, ["stop", "--time", "10", ids[0]!], signal, 45000);
      const plan = planContainerRetirement({
        binding,
        ...(retirementRunner ? { runner: retirementRunner } : {}),
        claims: [
          {
            fullId: ids[0]!,
            expectedLabels: { "com.rehearsal-db.project": projectId },
            completedDisposable: true,
          },
        ],
      });
      const preserved = plan.volumes.find((v) => v.name === volumeName),
        snapshot = plan.snapshots[0];
      if (
        !preserved ||
        plan.volumes.length !== 1 ||
        !snapshot ||
        snapshot.mounts.length !== 1 ||
        snapshot.mounts[0]?.name !== volumeName ||
        snapshot.mounts[0]?.destination !== "/var/lib/postgresql/data"
      )
        throw refused();
      const receipt: PostgresqlRetainedContainerReceipt = {
        schemaVersion: 1,
        projectId,
        containerName: name,
        volumeName,
        volumeCreatedAt: preserved.createdAt,
        volumeDriver: preserved.driver,
        image,
        imageId: snapshot.image,
        engineIdentity: identity,
        generationId: marker.generationId,
        dataSha256: marker.dataSha256,
      };
      assertReceipt(receipt, marker);
      assertRetainedBindings(
        observe(binding, identity, snapshot.image),
        receipt,
      );
      const prepared = {
        schemaVersion: 1,
        state: "prepared",
        projectId,
        markerSha256: bytesHash(markerBytes),
        binding,
        receipt,
        plan,
      };
      const protectedPrepared = await protectMarker(markerBytes, prepared);
      const result = retireContainers({
        plan,
        consent: { kind: "trusted-completion-hook" },
        ...(retirementRunner ? { runner: retirementRunner } : {}),
      });
      if (
        result.status !== "completed" ||
        result.outcomes.some(
          (o) => o.containerRemoved !== true || o.volumesPreserved !== true,
        )
      )
        throw refused();
      await writeReceipt({ ...protectedPrepared, state: "completed" });
    },
    resumeIfMissing: async (marker: Readonly<Record<string, unknown>>) => {
      const { binding, identity } = pin();
      const existing = existingIds(binding);
      if (existing.length) {
        assertDockerResourceLabels({
          labels: JSON.parse(
            query(binding, [
              "container",
              "inspect",
              "--format",
              "{{json .Config.Labels}}",
              existing[0]!,
            ]),
          ),
          expectedLabel: "com.rehearsal-db.project",
          projectId,
        });
        return;
      }
      const stored = JSON.parse((await privateBytes(receiptPath)).toString());
      const markerBytes = await privateBytes(markerPath);
      verifyStored(stored, binding, identity, markerBytes);
      if (stored.markerSha256 !== bytesHash(markerBytes)) throw refused();
      await resumeRetainedPostgresqlContainer({
        receipt: stored.receipt,
        marker: marker as unknown as PostgresqlResumeMarker,
        port,
        user,
        database,
        adapter: {
          inspect: async ({ signal }) => {
            signal.throwIfAborted();
            return observe(binding, identity, stored.receipt.imageId);
          },
          create: async (args, { signal, timeoutMilliseconds }) =>
            bounded(binding, args, signal, timeoutMilliseconds),
          waitUntilReady: async ({ signal, timeoutMilliseconds }) => {
            const until = Date.now() + timeoutMilliseconds;
            let consecutive = 0;
            while (Date.now() < until) {
              signal.throwIfAborted();
              try {
                await bounded(
                  binding,
                  [
                    "exec",
                    name,
                    "pg_isready",
                    "--username",
                    user,
                    "--dbname",
                    database,
                  ],
                  signal,
                  Math.min(5000, Math.max(1, until - Date.now())),
                );
                consecutive++;
              } catch {
                signal.throwIfAborted();
                consecutive = 0;
              }
              if (consecutive === 2) return;
              await new Promise<void>((done) => setTimeout(done, 500));
            }
            throw refused();
          },
        },
        ...(getOperationCancellationSignal()
          ? { signal: getOperationCancellationSignal()! }
          : {}),
      });
    },
  };
};
