/** Private non-starting transport for one explicitly selected owned local runtime. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BaselineManifest } from "../baseline/artifact.mjs";
import type { RuntimeTopologyTarget } from "../runtime/topology.mjs";
import { isLocalDockerEndpoint } from "../runtime/local_docker_context.mjs";
import { diagnoseMigrationFailure } from "../runtime/migration_failure.mjs";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";
import type { HeldPathAncestry } from "../shared/held_path_ancestry.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import { assertDockerResourceLabels } from "./docker_resource_ownership.mjs";

export type MigrationImpactRuntimeFailureReason =
  | "runtime_unavailable"
  | "ownership_mismatch"
  | "stale_runtime"
  | "query_failed"
  | "lock_timeout"
  | "statement_timeout"
  | "transaction_timeout"
  | "cancelled";

export class MigrationImpactRuntimeError extends Error {
  constructor(readonly reason: MigrationImpactRuntimeFailureReason) {
    super(
      "The selected local runtime could not complete bounded read-only inspection; private output withheld.",
    );
    this.name = "MigrationImpactRuntimeError";
  }
}
export interface MigrationImpactRuntime {
  readonly identitySha256: string;
  runSql(sql: string | (() => string)): Promise<string>;
  assertCurrent(): Promise<void>;
}
export interface OpenMigrationImpactRuntimeOptions {
  readonly projectRoot: string;
  readonly target: RuntimeTopologyTarget;
  readonly baseline: BaselineManifest;
  readonly signal?: AbortSignal;
  readonly runProcessImplementation?: typeof runOwnedProcess;
}
type Json = Record<string, unknown>;
const INSPECTION_BYTES = 65536;
const SQL_INPUT_BYTES = 262144;
const SQL_OUTPUT_BYTES = 131072;
function fail(reason: MigrationImpactRuntimeFailureReason): never {
  throw new MigrationImpactRuntimeError(reason);
}
const digest = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("runtime_unavailable");
  return value as Json;
};
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
};
const CONTAINER_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}';

/** No lifecycle, adapter, source-reader, URL or credential-file access is permitted here. */
export async function openMigrationImpactRuntime(
  options: OpenMigrationImpactRuntimeOptions,
): Promise<MigrationImpactRuntime> {
  const { target, baseline } = options;
  const signal = options.signal ?? AbortSignal.timeout(30000);
  const run = options.runProcessImplementation ?? runOwnedProcess;
  const cancelled = () => {
    if (signal.aborted) fail("cancelled");
  };
  cancelled();
  const provider = target.config.runtime.target;
  const projectId = target.config.runtime.projectId;
  const postgres = provider === "postgresql" ? target.config.postgresql : null;
  const databasePort = target.config.runtime.ports.database;
  if (
    !["postgresql", "supabase"].includes(provider) ||
    (provider === "postgresql" && !postgres)
  )
    fail("ownership_mismatch");
  const dataSha256 = baseline.files["sanitized-data.ndjson"]?.sha256;
  if (
    !/^[a-f0-9]{64}$/u.test(dataSha256 ?? "") ||
    !/^\d{8}T\d{6}Z-[a-f0-9]{12}$/u.test(baseline.generationId)
  )
    fail("stale_runtime");
  let root: string, receiptDirectory: string;
  try {
    root = await realpath(resolve(options.projectRoot));
    const lexicalRoot = resolve(options.projectRoot),
      configured = resolve(target.paths.runtimeWorkdir);
    receiptDirectory = inside(lexicalRoot, configured)
      ? resolve(root, relative(lexicalRoot, configured))
      : configured;
    if (
      !inside(root, receiptDirectory) ||
      (await realpath(receiptDirectory)) !== receiptDirectory
    )
      fail("ownership_mismatch");
  } catch {
    fail("ownership_mismatch");
  }

  const readReceipt = async () => {
    cancelled();
    let ancestry: HeldPathAncestry | undefined;
    try {
      ancestry = await holdPathAncestry(receiptDirectory);
      await ancestry.assertUnchanged();
      const path = join(ancestry.path, "baseline.json"),
        leaf = await lstat(path, { bigint: true });
      if (
        !leaf.isFile() ||
        leaf.isSymbolicLink() ||
        leaf.size > BigInt(INSPECTION_BYTES) ||
        (leaf.mode & 0o077n) !== 0n ||
        (typeof process.getuid === "function" &&
          leaf.uid !== BigInt(process.getuid()))
      )
        fail("stale_runtime");
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.dev !== leaf.dev ||
          before.ino !== leaf.ino ||
          before.size !== leaf.size ||
          before.mtimeNs !== leaf.mtimeNs ||
          before.ctimeNs !== leaf.ctimeNs
        )
          fail("stale_runtime");
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const next = await handle.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (!next.bytesRead) break;
          length += next.bytesRead;
        }
        const after = await handle.stat({ bigint: true }),
          current = await lstat(path, { bigint: true });
        if (
          BigInt(length) !== before.size ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          [after, current].some(
            (stat) =>
              stat.dev !== before.dev ||
              stat.ino !== before.ino ||
              stat.size !== before.size ||
              stat.mtimeNs !== before.mtimeNs ||
              stat.ctimeNs !== before.ctimeNs,
          )
        )
          fail("stale_runtime");
        await ancestry.assertUnchanged();
        const contents = bytes.subarray(0, length);
        const marker = object(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(contents),
          ),
        );
        if (
          marker.target !== provider ||
          marker.generationId !== baseline.generationId ||
          marker.dataSha256 !== dataSha256 ||
          (postgres
            ? marker.formatVersion !== 1 ||
              marker.image !== postgres.image ||
              typeof marker.databasePassword !== "string" ||
              marker.databasePassword.length < 32
            : marker.formatVersion !== baseline.formatVersion ||
              marker.schemaSha256 !==
                (baseline.files["production-schema.sql"]?.sha256 ?? null))
        )
          fail("stale_runtime");
        return {
          sha256: digest(contents),
          inode: `${before.dev}:${before.ino}:${before.ctimeNs}:${before.mtimeNs}`,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof MigrationImpactRuntimeError) throw error;
      fail("stale_runtime");
    } finally {
      try {
        await ancestry?.close();
      } catch {
        cancelled();
        fail("stale_runtime");
      }
    }
  };
  const initialReceipt = await readReceipt();
  let endpoint: string | undefined;
  const invoke = async (
    args: readonly string[],
    input?: string,
  ): Promise<string> => {
    cancelled();
    const maximum = input === undefined ? INSPECTION_BYTES : SQL_OUTPUT_BYTES;
    try {
      const result = await run({
        command: "docker",
        args,
        cwd: root,
        env: createCleanProcessEnvironment({
          overrides: { DOCKER_HOST: endpoint },
        }),
        signal,
        stdin: "ignore",
        ...(input === undefined ? {} : { input }),
        maxOutputBytes: maximum,
        cancellationGraceMs: 1000,
      });
      cancelled();
      if (
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        !Number.isSafeInteger(result.stdoutByteCount) ||
        !Number.isSafeInteger(result.stderrByteCount) ||
        result.stdoutByteCount < Buffer.byteLength(result.stdout) ||
        result.stderrByteCount < Buffer.byteLength(result.stderr) ||
        result.stdoutByteCount > maximum ||
        result.stderrByteCount > INSPECTION_BYTES ||
        (input === undefined &&
          result.stdoutByteCount + result.stderrByteCount > INSPECTION_BYTES)
      )
        fail(input === undefined ? "runtime_unavailable" : "query_failed");
      if (result.error || result.signal || result.status !== 0) {
        if (input !== undefined) {
          const code = diagnoseMigrationFailure({
            provider: "postgresql",
            stderr: result.stderr,
          }).sqlState;
          if (code === "55P03") fail("lock_timeout");
          if (code === "57014") fail("statement_timeout");
          if (code === "25P04") fail("transaction_timeout");
        }
        fail(input === undefined ? "runtime_unavailable" : "query_failed");
      }
      return result.stdout;
    } catch (error) {
      cancelled();
      if (error instanceof MigrationImpactRuntimeError) throw error;
      fail(input === undefined ? "runtime_unavailable" : "query_failed");
    }
  };
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      fail("runtime_unavailable");
    }
  };
  const context = (await invoke(["context", "show"])).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(context))
    fail("ownership_mismatch");
  const selected = parse(
    await invoke([
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
      context,
    ]),
  );
  if (!isLocalDockerEndpoint(selected)) fail("ownership_mismatch");
  endpoint = selected as string;
  const engineId = async () => {
    const value = parse(await invoke(["info", "--format", "{{json .ID}}"]));
    if (typeof value !== "string" || !/^[a-zA-Z0-9:-]{1,128}$/u.test(value))
      fail("runtime_unavailable");
    return value;
  };
  const engine = await engineId();
  const expectedName = postgres
    ? `${projectId}-postgresql`
    : `supabase_db_${projectId}`;
  const inspect = async (id: string) => {
    const value = object(
      parse(
        await invoke([
          "container",
          "inspect",
          "--format",
          CONTAINER_FORMAT,
          id,
        ]),
      ),
    );
    if (
      typeof value.id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.id) ||
      value.name !== `/${expectedName}` ||
      value.running !== true ||
      typeof value.imageId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.imageId)
    )
      fail("runtime_unavailable");
    try {
      assertDockerResourceLabels({
        labels: value.labels,
        expectedLabel: postgres
          ? "com.rehearsal-db.project"
          : "com.supabase.cli.project",
        projectId,
      });
    } catch {
      fail("ownership_mismatch");
    }
    if (postgres) {
      const ports = object(value.ports),
        mappings = ports["5432/tcp"];
      if (
        value.image !== postgres.image ||
        !Array.isArray(mappings) ||
        mappings.length !== 1
      )
        fail("ownership_mismatch");
      const mapping = object(mappings[0]);
      if (
        mapping.HostIp !== "127.0.0.1" ||
        mapping.HostPort !== String(databasePort)
      )
        fail("ownership_mismatch");
    }
    return { id: value.id, imageId: value.imageId };
  };
  const container = await inspect(expectedName);
  const assertCurrent = async (): Promise<void> => {
    cancelled();
    const currentReceipt = await readReceipt();
    if (
      currentReceipt.sha256 !== initialReceipt.sha256 ||
      currentReceipt.inode !== initialReceipt.inode
    )
      fail("stale_runtime");
    if ((await engineId()) !== engine) fail("stale_runtime");
    const current = await inspect(container.id);
    if (current.id !== container.id || current.imageId !== container.imageId)
      fail("stale_runtime");
    const finalReceipt = await readReceipt();
    if (
      finalReceipt.sha256 !== initialReceipt.sha256 ||
      finalReceipt.inode !== initialReceipt.inode
    )
      fail("stale_runtime");
  };
  await assertCurrent();
  return Object.freeze({
    identitySha256: digest(
      JSON.stringify({
        endpoint,
        engine,
        container,
        receipt: initialReceipt.sha256,
        provider,
        projectId,
        generation: baseline.generationId,
      }),
    ),
    assertCurrent,
    runSql: async (input: string | (() => string)): Promise<string> => {
      // Compile the remaining server deadline only after the final potentially
      // slow Docker/receipt preflight. Never rewrite a caller's SQL text.
      if (typeof input === "function") await assertCurrent();
      const sql = typeof input === "function" ? input() : input;
      if (
        typeof sql !== "string" ||
        Buffer.byteLength(sql) > SQL_INPUT_BYTES ||
        sql.length === 0 ||
        sql.includes("\0")
      )
        fail("query_failed");
      if (typeof input !== "function") await assertCurrent();
      let result = "",
        failure: unknown;
      try {
        // Docker exec inherits container variables unless env -i clears them;
        // force a local socket so PGHOSTADDR/service/options cannot redirect it.
        result = await invoke(
          [
            "exec",
            "--interactive",
            container.id,
            "/usr/bin/env",
            "-i",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PGSSLMODE=disable",
            "PGPASSFILE=/dev/null",
            "psql",
            "--no-psqlrc",
            "--no-password",
            "--host=/var/run/postgresql",
            "--port=5432",
            "--quiet",
            "--no-align",
            "--tuples-only",
            "--set",
            "ON_ERROR_STOP=1",
            "--set",
            "VERBOSITY=sqlstate",
            "--username",
            postgres?.user ?? "postgres",
            "--dbname",
            postgres?.database ?? "postgres",
          ],
          sql,
        );
      } catch (error) {
        failure = error;
      }
      await assertCurrent();
      if (failure) throw failure;
      return result;
    },
  });
}
