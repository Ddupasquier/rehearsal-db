import { performance } from "node:perf_hooks";
import { inspectKnexWorkerEngine } from "./knex_worker_engine.mjs";
/** Copy exact reviewed inputs/SDK; execute only in the strictly inspected worker. */
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readKnexMigrationInventory,
  type KnexMigrationEntry,
} from "../runtime/knex_history.mjs";
import { inspectKnexToolchain } from "../runtime/knex_toolchain.mjs";
import { KNEX_WORKER_POLICY_SHA256 } from "../runtime/knex_isolation_contract.mjs";
import {
  parseNativeMigrationBinding,
  type NativeMigrationBinding,
} from "../runtime/native_migration_contract.mjs";
import type { KnexMigrationTool } from "../project/configuration_migration_tool.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import {
  KNEX_WORKER_PROGRAMS,
  assertKnexWorkerPrograms,
} from "./knex_worker_programs.mjs";
import { runKnexWorker } from "./knex_worker_process.mjs";
import {
  withKnexRestrictedRole,
  currentKnexSqlSignal,
  currentKnexSqlRemainingMs,
} from "./knex_restricted_role.mjs";
const fail = () =>
  new Error(
    "Reviewed Knex source, toolchain, baseline, target or isolation binding changed; native code was refused or success could not be established.",
  );
export const deployKnexMigrations = async ({
  projectRoot,
  tool,
  directory,
  runtimeWorkdir,
  projectId,
  entries,
  binding,
  databaseUrl,
  runSql,
  assertOwnedTarget,
  assertExpectedBaseline,
}: {
  projectRoot: string;
  tool: KnexMigrationTool;
  directory: string;
  runtimeWorkdir: string;
  projectId: string;
  entries: readonly KnexMigrationEntry[];
  binding: NativeMigrationBinding;
  databaseUrl: string;
  runSql: (sql: string) => string;
  assertOwnedTarget: () => string;
  assertExpectedBaseline: () => Promise<void>;
}) => {
  throwIfOperationCancelled();
  const bound = parseNativeMigrationBinding(binding);
  if (
    bound.kind !== "knex" ||
    bound.isolationPolicySha256 !== KNEX_WORKER_POLICY_SHA256
  )
    throw fail();
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw fail();
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.password ||
    !/^\/[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(url.pathname) ||
    !/^\d{4,5}$/u.test(url.port)
  )
    throw fail();
  inspectKnexWorkerEngine({ cwd: projectRoot, projectId, runtimeWorkdir });
  const workspace = await mkdtemp(join(runtimeWorkdir, ".knex-worker-")),
    executionDeadline = performance.now() + 120000,
    deadline = new AbortController(),
    timer = setTimeout(() => deadline.abort(), 120000);
  timer.unref();
  const parent = getOperationCancellationSignal(),
    signal = AbortSignal.any([
      deadline.signal,
      ...(parent ? [parent] : []),
      ...(currentKnexSqlSignal() ? [currentKnexSqlSignal()!] : []),
    ]);
  let preserve = false;
  const contents = new Map<string, Buffer>();
  try {
    const roots = ["inputs", "sdk", "runner"].map((x) => join(workspace, x));
    for (const root of roots) await mkdir(root, { mode: 0o755 });
    const assertSource = async (root: string) => {
      const observed = await readKnexMigrationInventory(
        pathToFileURL(`${root}/`),
      );
      if (
        observed.bundleSha256 !== bound.bundleSha256 ||
        JSON.stringify(observed.entries) !== JSON.stringify(entries)
      )
        throw fail();
      return observed;
    };
    const write = async (
      root: string,
      path: string,
      bytes: Buffer | string,
    ) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o444 });
    };
    const source = await readKnexMigrationInventory(
      pathToFileURL(`${directory}/`),
      {
        onBytes: (name, bytes) => {
          contents.set(name, Buffer.from(bytes));
        },
      },
    );
    if (
      source.bundleSha256 !== bound.bundleSha256 ||
      JSON.stringify(source.entries) !== JSON.stringify(entries)
    )
      throw fail();
    for (const [name, bytes] of contents) await write(roots[0]!, name, bytes);
    contents.clear();
    const toolchain = await inspectKnexToolchain({
      projectRoot,
      tool,
      onBytes: async (path, bytes) => {
        const local = relative(projectRoot, path);
        if (!local || local === ".." || local.startsWith(`..${sep}`))
          throw fail();
        await write(roots[1]!, local, bytes);
      },
    });
    if (toolchain.sha256 !== bound.toolchainSha256) throw fail();
    for (const [name, text] of KNEX_WORKER_PROGRAMS)
      await write(roots[2]!, name, text);
    const copyTool = await inspectKnexToolchain({
      projectRoot: roots[1]!,
      tool,
    });
    if (copyTool.sha256 !== bound.toolchainSha256) throw fail();
    await assertSource(directory);
    await assertSource(roots[0]!);
    await assertKnexWorkerPrograms(workspace);
    await assertExpectedBaseline();
    const target = assertOwnedTarget();
    if (signal.aborted) throw fail();
    inspectKnexWorkerEngine({ cwd: projectRoot, projectId, runtimeWorkdir });
    const workerReceipt = await withKnexRestrictedRole({
      projectId,
      runtimeWorkdir,
      database: url.pathname.slice(1),
      runSql,
      assertOwnedTarget,
      work: async (credentials) => {
        if (assertOwnedTarget() !== target) throw fail();
        currentKnexSqlRemainingMs();
        if (performance.now() >= executionDeadline) throw fail();
        try {
          return await runKnexWorker({
            projectRoot,
            workspace,
            projectId,
            knexDirectory: `/sdk/${tool.packageDirectory.split(sep).join("/")}`,
            credentials,
            port: Number(url.port),
            signal,
            assertOwnedTarget,
            assertBackendGone: async (pid) => {
              if (
                assertOwnedTarget() !== target ||
                !Number.isSafeInteger(pid) ||
                pid <= 0 ||
                pid > 2147483647 ||
                runSql(
                  `select pg_catalog.count(*)::text from pg_catalog.pg_stat_activity where pid=${pid} and usename='${credentials.user}';`,
                ).trim() !== "0"
              )
                throw fail();
            },
          });
        } catch (error) {
          if (error instanceof AggregateError) preserve = true;
          throw error;
        }
      },
    });
    await assertSource(directory);
    await assertSource(roots[0]!);
    await assertKnexWorkerPrograms(workspace);
    await assertExpectedBaseline();
    if (
      assertOwnedTarget() !== target ||
      (await inspectKnexToolchain({ projectRoot, tool })).sha256 !==
        bound.toolchainSha256 ||
      (await inspectKnexToolchain({ projectRoot: roots[1]!, tool })).sha256 !==
        bound.toolchainSha256 ||
      signal.aborted ||
      performance.now() >= executionDeadline
    )
      throw fail();
    console.log(
      `Knex isolated worker completion: ${JSON.stringify({ ...workerReceipt, inputBundleSha256: bound.bundleSha256, toolchainSha256: bound.toolchainSha256, isolationPolicySha256: bound.isolationPolicySha256, backendSessionCleanup: "confirmed" })}`,
    );
  } catch (error) {
    if (error instanceof AggregateError) preserve = true;
    if (!preserve) throwIfOperationCancelled();
    if (
      !preserve &&
      (deadline.signal.aborted || performance.now() >= executionDeadline)
    )
      throw new Error(
        "Native migration execution exceeded its 120-second bound; SQL and provider output are withheld.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    contents.clear();
    if (!preserve) await rm(workspace, { recursive: true });
  }
};
