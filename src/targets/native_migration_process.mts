/** Shared bounded native-process boundary; recipes own native inventory/configuration. */
import { constants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, open, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AnyMigrationFileEntry } from "../runtime/migrations/migration_identity.mjs";

import {
  sameNativeMigrationBinding,
  sameNativeMigrationHistory,
  parseNativeMigrationBinding,
  type NativeMigrationBinding,
} from "../runtime/migrations/native_migration_contract.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { runOwnedProcess } from "../shared/owned_process.mjs";

export interface NativeProcessRecipe {
  readonly label: string;
  readonly prefix: string;
  readonly preparedInputs: readonly (readonly [string, string])[];
  read: (
    directory: string,
    onBytes?: (name: string, bytes: Buffer) => void,
  ) => Promise<{
    entries: readonly AnyMigrationFileEntry[];
    binding: NativeMigrationBinding;
  }>;
  inspect: () => Promise<{
    sha256: string;
    cliPath: string;
    enginePath?: string;
  }>;
  args: (cliPath: string, workspace: string) => string[];
  environment: (
    workspace: string,
    cache: string,
    toolchain: { enginePath?: string },
  ) => Record<string, string>;
}
export const deployNativeMigrations = async ({
  recipe,
  directory,
  runtimeWorkdir,
  entries,
  binding,
  databaseUrl,
  assertOwnedTarget,
  assertExpectedBaseline,
}: {
  recipe: NativeProcessRecipe;
  directory: string;
  runtimeWorkdir: string;
  entries: readonly AnyMigrationFileEntry[];
  binding: NativeMigrationBinding;
  databaseUrl: string;
  assertOwnedTarget: () => string;
  assertExpectedBaseline: () => Promise<void>;
}): Promise<void> => {
  throwIfOperationCancelled();
  binding = parseNativeMigrationBinding(binding);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor! >= 12) || major === 24 || major === 26))
    throw new Error(
      "The qualified native migration workflow requires Node 22.12 or newer in the 22 series, Node 24, or Node 26; no runtime was installed.",
    );
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      "Native execution requires the proven owned loopback PostgreSQL target.",
    );
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.password ||
    !url.port ||
    url.pathname === "/"
  )
    throw new Error(
      "Native execution requires the proven owned loopback PostgreSQL target.",
    );
  if (binding.kind === "prisma") url.searchParams.set("schema", "public");
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("socket_timeout", "120");
  url.searchParams.set(
    "options",
    "-c statement_timeout=120000 -c lock_timeout=10000",
  );
  const content = new Map<string, Buffer>();
  const source = await recipe.read(directory, (name, bytes) => {
    content.set(name, bytes);
  });
  if (
    !sameNativeMigrationHistory(source.binding, binding) ||
    JSON.stringify(source.entries) !== JSON.stringify(entries)
  )
    throw new Error(
      "Native migration inputs or installed toolchain changed after review; no native migration command was started.",
    );
  const target = assertOwnedTarget();
  if (!/^[a-f0-9]{64}$/u.test(target))
    throw new Error("Owned native migration target identity is invalid.");
  const workspace = await mkdtemp(join(runtimeWorkdir, recipe.prefix));
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
    const preparedInputs = recipe.preparedInputs;
    for (const [name, text] of preparedInputs)
      await writeFile(join(workspace, name), text, { flag: "wx", mode: 0o600 });
    const cache = join(workspace, "cache");
    await mkdir(cache, { mode: 0o700 });
    const parent = getOperationCancellationSignal();
    const toolchain = await recipe.inspect();
    const freshSource = await recipe.read(directory);
    const executionCopy = await recipe.read(migrations);
    if (
      !sameNativeMigrationHistory(freshSource.binding, binding) ||
      JSON.stringify(freshSource.entries) !== JSON.stringify(entries) ||
      JSON.stringify(executionCopy) !== JSON.stringify(source)
    )
      throw new Error(
        "Native migration source or private execution copy changed before dispatch; no native migration command was started.",
      );
    const assertPreparedInputs = async (
      phase: "before dispatch" | "after execution" = "before dispatch",
    ) => {
      for (const [name, text] of preparedInputs) {
        const expected = Buffer.from(text),
          handle = await open(
            join(workspace, name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size !== expected.length)
            throw new Error(`Private native configuration changed ${phase}.`);
          const bytes = Buffer.alloc(expected.length + 1),
            { bytesRead } = await handle.read(bytes, 0, bytes.length, 0),
            after = await handle.stat(),
            leaf = await lstat(join(workspace, name));
          if (
            !leaf.isFile() ||
            leaf.isSymbolicLink() ||
            leaf.dev !== after.dev ||
            leaf.ino !== after.ino ||
            leaf.size !== after.size ||
            leaf.mtimeMs !== after.mtimeMs ||
            leaf.ctimeMs !== after.ctimeMs ||
            bytesRead !== expected.length ||
            !bytes.subarray(0, bytesRead).equals(expected) ||
            before.ino !== after.ino ||
            before.dev !== after.dev ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error(`Private native configuration changed ${phase}.`);
        } finally {
          await handle.close();
        }
      }
    };
    await assertPreparedInputs();
    if (
      !sameNativeMigrationBinding(
        { ...freshSource.binding, toolchainSha256: toolchain.sha256 },
        binding,
      )
    )
      throw new Error(
        "Installed native toolchain changed before dispatch; no native migration command was started.",
      );
    await assertExpectedBaseline();
    if (assertOwnedTarget() !== target)
      throw new Error("Owned native migration target changed before dispatch.");
    throwIfOperationCancelled();
    if (deadline.signal.aborted)
      throw new Error(
        "Native migration preparation exceeded its deadline; no native migration command was started.",
      );
    const result = await runOwnedProcess({
      command: process.execPath,
      args: recipe.args(toolchain.cliPath, workspace),
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
          ...recipe.environment(workspace, cache, toolchain),
          XDG_CACHE_HOME: cache,
          XDG_CONFIG_HOME: cache,
          XDG_DATA_HOME: cache,
          XDG_STATE_HOME: cache,
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
        `${recipe.label} failed (exit ${Number.isInteger(result.status) ? result.status : "unknown"}); SQL, credentials and provider output are withheld.`,
      );
    if (
      assertOwnedTarget() !== target ||
      (await recipe.inspect()).sha256 !== binding.toolchainSha256
    )
      throw new Error(
        "Native execution identity changed; success cannot be established.",
      );
    const after = await recipe.read(directory);
    if (
      JSON.stringify(after.entries) !== JSON.stringify(entries) ||
      !sameNativeMigrationHistory(after.binding, binding)
    )
      throw new Error(
        "Native migration input changed during execution; success cannot be established.",
      );
    // The private execution copy must also remain byte-identical after the tool exits.
    const executed = await recipe.read(migrations);
    if (JSON.stringify(executed) !== JSON.stringify(source))
      throw new Error(
        "Native execution copy changed; success cannot be established.",
      );
    await assertPreparedInputs("after execution");
    await assertExpectedBaseline();
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
