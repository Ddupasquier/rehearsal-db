import { withOperationCancellationShield } from "../shared/cancellation.mjs";
import { assertKnexWorkerPrograms } from "./knex_worker_programs.mjs";
import { inspectKnexWorkerEngine } from "./knex_worker_engine.mjs";
import { assertKnexWorkerIsolation } from "./knex_worker_resources.mjs";
/** One strictly inspected disposable worker. No host SDK execution or engine fallback. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KNEX_WORKER_POLICY } from "../runtime/knex_isolation_contract.mjs";
import {
  decodeKnexFrames,
  encodeKnexFrame,
  KNEX_WORKER_LIMITS,
} from "../runtime/knex_worker_protocol.mjs";
import { createKnexPgBroker } from "../runtime/knex_pg_broker.mjs";
import { bindOwnedProcessCancellation } from "../shared/owned_process.mjs";
const failure = () =>
  new Error(
    "Isolated Knex worker execution or cleanup could not be verified; private output is withheld and the data volume is retained.",
  );
export const runKnexWorker = async ({
  projectRoot,
  workspace,
  projectId,
  knexDirectory,
  credentials,
  port,
  signal,
  assertOwnedTarget,
  assertBackendGone,
}: {
  projectRoot: string;
  workspace: string;
  projectId: string;
  knexDirectory: string;
  credentials: { user: string; password: string; database: string };
  port: number;
  signal: AbortSignal;
  assertOwnedTarget: () => string;
  assertBackendGone: (pid: number) => Promise<void>;
}) => {
  const interruption = new AbortController();
  signal = AbortSignal.any([signal, interruption.signal]);
  if (signal.aborted) throw failure();
  if (
    !workspace.startsWith("/") ||
    /[,:\r\n\0]/u.test(workspace) ||
    !knexDirectory.startsWith("/sdk/") ||
    /\.\./u.test(knexDirectory)
  )
    throw failure();
  const { selection, env, daemon, imageId, docker, revalidate } =
    inspectKnexWorkerEngine({ cwd: projectRoot, projectId });
  const token = randomUUID(),
    labels = {
      "com.rehearsal-db.project": projectId,
      "com.rehearsal-db.worker": "knex",
      "com.rehearsal-db.worker-token": token,
    };
  const mounts = [
    { source: join(workspace, "inputs"), destination: "/inputs" },
    { source: join(workspace, "sdk"), destination: "/sdk" },
    { source: join(workspace, "runner"), destination: "/runner" },
  ];
  let id: string | null = null,
    creationDispatched = false,
    cleaned = false,
    original: unknown;
  const assertWorker = () => {
    revalidate();
    const rows = JSON.parse(docker(["container", "inspect", id!]));
    if (!Array.isArray(rows) || rows.length !== 1) throw failure();
    const r = rows[0];
    return assertKnexWorkerIsolation(r, {
      fullId: id!,
      imageId,
      labels,
      mounts,
    });
  };
  try {
    revalidate();
    await writeFile(
      join(workspace, "worker-intent.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "knex-worker-intent",
        name: `rehearsal-knex-${token}`,
        labels,
        context: selection.context,
        endpoint: selection.endpoint,
        daemonId: daemon,
        imageId,
        dataDeletionRequested: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    creationDispatched = true;
    const created = docker([
      "create",
      "--pull=never",
      "--interactive",
      "--name",
      `rehearsal-knex-${token}`,
      "--network=none",
      "--read-only",
      "--user=65532:65532",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--ipc=private",
      "--cgroupns=private",
      "--pids-limit=32",
      "--memory=268435456",
      "--memory-swap=268435456",
      "--cpus=1",
      "--log-driver=none",
      "--restart=no",
      "--no-healthcheck",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      ...mounts.flatMap((m) => [
        "--mount",
        `type=bind,src=${m.source},dst=${m.destination},readonly,bind-propagation=rprivate`,
      ]),
      "--workdir=/inputs",
      "--entrypoint=/usr/local/bin/node",
      KNEX_WORKER_POLICY.image,
      "/runner/bootstrap.mjs",
    ]);
    if (!/^[a-f0-9]{64}$/u.test(created))
      throw new AggregateError(
        [],
        "Knex worker creation outcome is unconfirmed; private intent was retained.",
      );
    id = created;
    await writeFile(
      join(workspace, "worker-recovery.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "knex-worker",
        fullId: id,
        labels,
        context: selection.context,
        endpoint: selection.endpoint,
        daemonId: daemon,
        dataDeletionRequested: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    assertWorker();
    if (signal.aborted) throw failure();
    assertOwnedTarget();
    await assertKnexWorkerPrograms(workspace);
    const child = spawn(
      "docker",
      ["--host", selection.endpoint, "start", "--attach", "--interactive", id],
      {
        cwd: projectRoot,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const detach = bindOwnedProcessCancellation({
      child,
      signal,
      cancellationGraceMs: 1000,
    });
    const write = async (bytes: Buffer) => {
      if (child.stdin.destroyed || signal.aborted) throw failure();
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(bytes, (error) =>
          error ? reject(failure()) : resolve(),
        ),
      );
    };
    const broker = createKnexPgBroker({
      port,
      user: credentials.user,
      database: credentials.database,
      assertOwnedTarget,
      signal,
      send: (kind, bytes) => write(encodeKnexFrame(kind, bytes)),
    });
    let logBytes = 0,
      result: number | null = null,
      protocolFailure: unknown;
    const processing = (async () => {
      for await (const { kind, bytes } of decodeKnexFrames(
        child.stdout,
        "ODCLX",
      )) {
        if (kind === "L") {
          if ((logBytes += bytes.length) > KNEX_WORKER_LIMITS.maximumLogBytes)
            throw failure();
          continue;
        }
        if (kind === "X") {
          if (
            result !== null ||
            bytes.length !== 1 ||
            ![0, 1].includes(bytes[0]!)
          )
            throw failure();
          result = bytes[0]!;
          continue;
        }
        await broker.accept(kind, bytes);
      }
    })().catch(() => {
      protocolFailure = failure();
      interruption.abort();
    });
    let stderr = 0;
    child.stderr.on("data", (bytes: Buffer) => {
      if ((stderr += bytes.length) > 1024 * 1024) {
        protocolFailure = failure();
        interruption.abort();
      }
    });
    let spawnFailure = false;
    child.once("error", () => {
      spawnFailure = true;
      interruption.abort();
    });
    const exit = new Promise<{
      ok: true;
      value: [number | null, NodeJS.Signals | null];
    }>((resolve) =>
      child.once("close", (code, signal) =>
        resolve({ ok: true, value: [code, signal] }),
      ),
    );
    let reaped = false;
    let onInterrupted: () => void = () => {};
    const interrupted = new Promise<{ ok: false }>((resolve) => {
      onInterrupted = () => resolve({ ok: false });
      signal.addEventListener("abort", onInterrupted, { once: true });
      if (signal.aborted) onInterrupted();
    });
    void exit.then(() => {
      reaped = true;
    });
    child.stdin.on("error", () => interruption.abort());
    try {
      const init = Buffer.from(
        JSON.stringify({ ...credentials, knexDirectory }),
      );
      // J is trusted initialization only; it is never accepted from the worker.
      const frame = Buffer.alloc(init.length + 5);
      frame[0] = 74;
      frame.writeUInt32BE(init.length, 1);
      init.copy(frame, 5);
      await write(frame);
      init.fill(0);
      frame.fill(0);
      const ended = await Promise.race([exit, interrupted]);
      if (!ended.ok) throw failure();
      const [code, terminated] = ended.value;
      await processing;
      broker.assertHealthy();
      if (
        spawnFailure ||
        code !== 0 ||
        terminated ||
        result !== 0 ||
        protocolFailure ||
        signal.aborted
      )
        throw failure();
    } finally {
      signal.removeEventListener("abort", onInterrupted);
      interruption.abort();
      const done = await Promise.race([
        exit.then(() => true),
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 2000);
          t.unref();
        }),
      ]);
      detach();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await processing;
      let backendClean = true;
      try {
        await withOperationCancellationShield(() =>
          broker.close(assertBackendGone),
        );
      } catch {
        backendClean = false;
      }
      if (!done || !backendClean)
        throw new AggregateError(
          [],
          "Owned Knex attachment or backend cleanup is unconfirmed; worker recovery evidence is retained.",
        );
    }
  } catch (error) {
    original = failure();
    if (error instanceof AggregateError || (creationDispatched && !id))
      throw new AggregateError(
        [original],
        "Isolated Knex cleanup is unconfirmed; private worker evidence is retained.",
      );
    throw original;
  } finally {
    if (id) {
      const fullId = id;
      try {
        await withOperationCancellationShield(async () => {
          const r = assertWorker();
          if (r.State?.Running) {
            try {
              docker(["stop", "--time", "1", fullId]);
            } catch {
              const retry = assertWorker();
              if (retry.State?.Running)
                docker(["kill", "--signal=KILL", fullId]);
            }
          }
          const stopped = assertWorker();
          if (
            stopped.State?.Running ||
            !["created", "exited"].includes(stopped.State?.Status)
          )
            throw failure();
          docker(["rm", fullId]);
          const ids = docker([
            "ps",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}}",
          ])
            .split(/\s+/u)
            .filter(Boolean);
          if (
            ids.length > 10000 ||
            ids.some((x) => !/^[a-f0-9]{64}$/u.test(x)) ||
            ids.includes(fullId)
          )
            throw failure();
          cleaned = true;
        });
      } catch {
        throw new AggregateError(
          original ? [original] : [],
          "Isolated Knex worker cleanup is unconfirmed; the private worker receipt and owned data are retained.",
        );
      }
    }
    if (!id && !creationDispatched) cleaned = true;
  }
  return {
    schemaVersion: 1 as const,
    status: "completed" as const,
    fullId: id!,
    imageId,
    workerRemoved: cleaned,
    network: "none" as const,
    dataDeletionRequested: false as const,
  };
};
