/** Docker lifecycle adapter and private recovery receipts for retained PostgreSQL containers. */
import {
  normalizeRuntimeMarkerProtocol,
  protectPostgresqlRuntimeMarker,
} from "../../runtime/lifecycle/runtime_marker_protocol.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertDockerResourceLabels } from "../docker_resource_ownership.mjs";
import {
  assertPostgresqlRetainedReceipt as assertReceipt,
  assertPostgresqlRetainedBindings as assertRetainedBindings,
  POSTGRESQL_RESUME_DIGEST_PATTERN as digest,
  postgresqlResumeRefusal as refused,
  resumeRetainedPostgresqlContainer,
  type PostgresqlRetainedContainerReceipt,
  type PostgresqlResumeMarker,
  type PostgresqlResumeSnapshot,
} from "./postgresql_resume_protocol.mjs";
export {
  retainedPostgresqlCreateArguments,
  resumeRetainedPostgresqlContainer,
} from "./postgresql_resume_protocol.mjs";
export type {
  PostgresqlRetainedContainerReceipt,
  PostgresqlResumeAdapter,
  PostgresqlResumeMarker,
  PostgresqlResumeSnapshot,
} from "./postgresql_resume_protocol.mjs";

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertLocalDockerContext,
  runtimeDockerContext,
  isLocalDockerEndpoint,
  scopedDockerEnvironment,
} from "../../runtime/engines/local_docker_context.mjs";
import {
  planContainerRetirementAsync,
  retireContainersAsync,
  type ContainerRetirementBinding,
  type AsyncContainerRetirementRunner,
} from "../../runtime/resources/container_retirement.mjs";
import {
  runPostgresqlCommand,
  withPostgresqlDeadline,
} from "./postgresql_process.mjs";
import { getOperationCancellationSignal } from "../../shared/cancellation.mjs";
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
      signal?: NodeJS.Signals | null;
    };
    localContext: () => { context: string; endpoint: string; identity: string };
    diagnostic: (message: string) => void;
  };
}) => {
  const name = projectId + "-postgresql",
    volumeName = name + "-data",
    receiptPath = join(runtimeWorkdir, "container-retirement.json");
  const raw = async (
    args: readonly string[],
    environment?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (dependencies) {
      const result = await dependencies.run(args, environment);
      if (result.error || result.signal || result.status === null)
        throw refused();
      return result;
    }
    return runPostgresqlCommand("docker", args, {
      cwd,
      environment: environment ?? scopedDockerEnvironment(),
      allowFailure: true,
      ...(signal ? { signal } : {}),
    });
  };
  const retirementRunner: AsyncContainerRetirementRunner = async (
    _command,
    args,
    environment,
  ) => {
    if (_command !== "docker") throw refused();
    const result = await raw(args, environment);
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
                ? result.error
                : new Error("Injected Docker probe failed."),
          }
        : {}),
    };
  };
  const probePin = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
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
    const info = await raw(
      ["--host", local.endpoint, "info", "--format", "{{.ID}}"],
      undefined,
      signal,
    );
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
  const pin = async (signal?: AbortSignal) => {
    const value = await probePin(signal);
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
  const query = async (
    binding: ContainerRetirementBinding,
    args: readonly string[],
    signal?: AbortSignal,
  ) => {
    const current = await pin(signal);
    if (JSON.stringify(current.binding) !== JSON.stringify(binding))
      throw refused();
    const result = await raw(
      ["--host", binding.endpoint, ...args],
      undefined,
      signal,
    );
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
  const existingIds = async (
    binding: ContainerRetirementBinding,
    signal?: AbortSignal,
  ) => {
    const output = await query(
      binding,
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "name=^/" + name + "$",
        "--format",
        "{{.ID}}",
      ],
      signal,
    );
    const ids = output ? output.split("\n") : [];
    if (ids.length > 1 || ids.some((id) => !digest.test(id))) throw refused();
    return ids;
  };
  const observe = async (
    binding: ContainerRetirementBinding,
    identity: string,
    retainedImageId: string,
    signal?: AbortSignal,
  ): Promise<PostgresqlResumeSnapshot> => {
    const volumeJson = JSON.parse(
      await query(
        binding,
        [
          "volume",
          "inspect",
          "--format",
          '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"labels":{{json .Labels}}}',
          volumeName,
        ],
        signal,
      ),
    );
    const imageId = await query(
      binding,
      ["image", "inspect", "--format", "{{.Id}}", retainedImageId],
      signal,
    );
    const ids = await existingIds(binding, signal);
    let container: PostgresqlResumeSnapshot["container"] = { state: "absent" };
    if (ids.length) {
      const parsed = JSON.parse(
        await query(
          binding,
          [
            "container",
            "inspect",
            "--format",
            '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"mounts":{{json .Mounts}}}',
            ids[0]!,
          ],
          signal,
        ),
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
    await query(binding, ["info", "--format", "{{.ID}}"], signal);
    signal.throwIfAborted();
    if (dependencies) {
      const began = Date.now(),
        result = await raw(
          ["--host", binding.endpoint, ...args],
          undefined,
          signal,
        );
      signal.throwIfAborted();
      if (
        result.status !== 0 ||
        result.error ||
        Date.now() - began > timeoutMilliseconds
      )
        throw refused();
      return;
    }
    const result = await runPostgresqlCommand(
      "docker",
      ["--host", binding.endpoint, ...args],
      {
        cwd,
        environment: scopedDockerEnvironment(),
        signal,
        purpose: args[0] === "run" ? "startup" : "cleanup",
        timeoutMilliseconds: Math.min(
          timeoutMilliseconds,
          args[0] === "run" ? 120000 : 45000,
        ),
      },
    );
    if (result.status !== 0) throw refused();
  };
  return {
    retireStopped: async () => {
      const available = await probePin();
      if (!available) return noAction("engine-unavailable");
      const { binding, identity } = available,
        ids = await existingIds(binding);
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
          await observe(binding, identity, stored.receipt.imageId),
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
        await query(binding, [
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
      const plan = await planContainerRetirementAsync({
        binding,
        runner: retirementRunner,
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
        await observe(binding, identity, snapshot.image),
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
      const result = await retireContainersAsync({
        plan,
        consent: { kind: "trusted-completion-hook" },
        runner: retirementRunner,
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
      const { binding, identity } = await pin();
      const existing = await existingIds(binding);
      if (existing.length) {
        assertDockerResourceLabels({
          labels: JSON.parse(
            await query(binding, [
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
          inspect: async ({ signal, timeoutMilliseconds }) =>
            withPostgresqlDeadline(
              "metadata",
              (activeSignal) =>
                observe(
                  binding,
                  identity,
                  stored.receipt.imageId,
                  activeSignal,
                ),
              { signal, timeoutMilliseconds },
            ),
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
