/** Execute only a reviewed pinned Prisma deploy in a private owned-target workspace. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPrismaMigrationInventory } from "../runtime/prisma_history.mjs";
import type { MigrationFileEntry } from "../runtime/migration_history.mjs";
import { inspectPrismaToolchain } from "../runtime/prisma_toolchain.mjs";
import {
  sameNativeMigrationBinding,
  type NativeMigrationBinding,
} from "../runtime/native_migration_contract.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";

export const deployPrismaMigrations = async ({
  projectRoot,
  packageDirectory,
  directory,
  runtimeWorkdir,
  entries,
  binding,
  databaseUrl,
  assertOwnedTarget,
}: {
  projectRoot: string;
  packageDirectory: string;
  directory: string;
  runtimeWorkdir: string;
  entries: readonly MigrationFileEntry[];
  binding: NativeMigrationBinding;
  databaseUrl: string;
  assertOwnedTarget: () => string;
}): Promise<void> => {
  throwIfOperationCancelled();
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor! >= 12) || major === 24 || major === 26))
    throw new Error(
      "The qualified Prisma 7.10.1 workflow requires Node 22.12 or newer in the 22 series, Node 24, or Node 26; no runtime was installed.",
    );
  const url = new URL(databaseUrl);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.password ||
    !url.port ||
    url.pathname === "/"
  )
    throw new Error(
      "Prisma execution requires the proven owned loopback PostgreSQL target.",
    );
  url.searchParams.set("schema", "public");
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("socket_timeout", "120");
  url.searchParams.set(
    "options",
    "-c statement_timeout=120000 -c lock_timeout=10000",
  );
  const content = new Map<string, Buffer>();
  const source = await readPrismaMigrationInventory(
    pathToFileURL(`${directory}/`),
    {
      onBytes: (name, bytes) => {
        content.set(name, bytes);
      },
    },
  );
  const toolchain = await inspectPrismaToolchain({
    projectRoot,
    packageDirectory,
  });
  if (
    !sameNativeMigrationBinding(
      { ...source.binding, toolchainSha256: toolchain.sha256 },
      binding,
    ) ||
    JSON.stringify(source.entries) !== JSON.stringify(entries)
  )
    throw new Error(
      "Native migration inputs or installed toolchain changed after review; no Prisma command was started.",
    );
  const target = assertOwnedTarget();
  if (!/^[a-f0-9]{64}$/u.test(target))
    throw new Error("Owned native migration target identity is invalid.");
  const workspace = await mkdtemp(join(runtimeWorkdir, ".prisma-deploy-"));
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("Native migration execution timed out.")),
    120000,
  );
  timer.unref();
  let failure: unknown;
  try {
    const migrations = join(workspace, "migrations");
    await mkdir(migrations, { mode: 0o700 });
    for (const [name, bytes] of content) {
      await mkdir(dirname(join(migrations, name)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(migrations, name), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    await writeFile(
      join(workspace, "schema.prisma"),
      'datasource db {\n  provider = "postgresql"\n}\n',
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(workspace, "prisma.config.ts"),
      'export default { schema: "./schema.prisma", migrations: { path: "./migrations" }, datasource: { url: process.env.REHEARSAL_NATIVE_DATABASE_URL } };\n',
      { flag: "wx", mode: 0o600 },
    );
    const cache = join(workspace, "cache");
    await mkdir(cache, { mode: 0o700 });
    const parent = getOperationCancellationSignal();
    if (
      (await inspectPrismaToolchain({ projectRoot, packageDirectory }))
        .sha256 !== binding.toolchainSha256
    )
      throw new Error(
        "Installed Prisma toolchain changed before dispatch; no Prisma command was started.",
      );
    if (assertOwnedTarget() !== target)
      throw new Error("Owned native migration target changed before dispatch.");
    throwIfOperationCancelled();
    if (deadline.signal.aborted)
      throw new Error(
        "Native migration preparation exceeded its deadline; no Prisma command was started.",
      );
    const result = await runOwnedProcess({
      command: process.execPath,
      args: [
        toolchain.cliPath,
        "migrate",
        "deploy",
        "--config",
        join(workspace, "prisma.config.ts"),
      ],
      cwd: workspace,
      stdin: "ignore",
      maxOutputBytes: 1024 * 1024,
      cancellationGraceMs: 1000,
      signal: parent
        ? AbortSignal.any([parent, deadline.signal])
        : deadline.signal,
      env: createCleanProcessEnvironment({
        overrides: {
          REHEARSAL_NATIVE_DATABASE_URL: url.href,
          PRISMA_SCHEMA_ENGINE_BINARY: toolchain.enginePath,
          CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
          PRISMA_SKIP_POSTINSTALL_GENERATE: "1",
          XDG_CACHE_HOME: cache,
          JITI_CACHE_DIR: cache,
          TMPDIR: workspace,
          TMP: workspace,
          TEMP: workspace,
        },
      }),
    });
    throwIfOperationCancelled();
    if (deadline.signal.aborted)
      throw new Error(
        "Native migration execution exceeded its 120-second bound; SQL and provider output are withheld.",
      );
    if (result.status !== 0 || result.error)
      throw new Error(
        `Prisma Migrate failed (exit ${Number.isInteger(result.status) ? result.status : "unknown"}); SQL, credentials and provider output are withheld.`,
      );
    if (
      assertOwnedTarget() !== target ||
      (await inspectPrismaToolchain({ projectRoot, packageDirectory }))
        .sha256 !== binding.toolchainSha256
    )
      throw new Error(
        "Native execution identity changed; success cannot be established.",
      );
    const after = await readPrismaMigrationInventory(
      pathToFileURL(`${directory}/`),
    );
    if (
      JSON.stringify(after.entries) !== JSON.stringify(entries) ||
      after.binding.lockSha256 !== binding.lockSha256
    )
      throw new Error(
        "Native migration input changed during execution; success cannot be established.",
      );
    // The private execution copy must also remain byte-identical after the tool exits.
    const executed = await readPrismaMigrationInventory(
      pathToFileURL(`${migrations}/`),
    );
    if (JSON.stringify(executed) !== JSON.stringify(source))
      throw new Error(
        "Native execution copy changed; success cannot be established.",
      );
    throwIfOperationCancelled();
    if (deadline.signal.aborted)
      throw new Error(
        "Native migration verification exceeded its deadline; success cannot be established.",
      );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      await rm(workspace, { recursive: true });
    } catch (cleanup) {
      throw new AggregateError(
        failure ? [failure, cleanup] : [cleanup],
        "Private native migration execution files could not be removed.",
      );
    }
  }
};
