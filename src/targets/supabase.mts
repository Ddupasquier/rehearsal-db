/**
 * Purpose: Restore and manage the disposable local Rehearsal Supabase runtime from
 * the active verified sanitized baseline.
 * Run: `npm run db:rehearsal:reset`, `npm run db:rehearsal:start`,
 * `npm run db:rehearsal:status`, or `npm run db:rehearsal:stop`.
 * Reset deletes only the dedicated local Rehearsal runtime and its Docker volumes.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { verifyActiveBaseline } from "../baseline/artifact.mjs";
import type { BaselineManifest } from "../baseline/artifact.mjs";
import {
  createCleanProcessEnvironment,
  assertLoopbackUrl,
} from "../shared/process_environment.mjs";
import {
  localCommandSucceeds,
  readLocalSupabaseEnvironment,
  removeLocalSupabaseProjectResources,
  runLocalCommand,
  startLocalSupabase,
  stopLocalSupabase,
} from "./supabase_environment.mjs";
import {
  buildRestoreSqlPrefix,
  buildRestoreSqlSuffix,
  encodeBaselineRecordForCopy,
  summarizeRestoreError,
} from "../runtime/restore.mjs";
import {
  buildMigrationLedgerInventory,
  compareSourceToReplay,
  createMigrationReplayReceipt,
  readMigrationFileInventory,
} from "../runtime/migration_history.mjs";
import type { MigrationFileEntry } from "../runtime/migration_history.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { readRehearsalServiceEnvironment } from "../runtime/service_environment.mjs";
import { applySupabaseAuthenticationProviders } from "../identity/provider_configuration.mjs";
import type { LocalSupabaseEnvironment } from "./supabase_environment.mjs";
import {
  captureLocalPublicSchema,
  compareProductionSchemaDumps,
} from "../baseline/schema_snapshot.mjs";
import { formatCount } from "../shared/human_output.mjs";
import { parseRuntimeInvocation } from "./target.mjs";
import {
  buildRuntimeFinalizationSql,
  buildRuntimePostSchemaSql,
  buildRuntimePrerequisiteSql,
  buildRuntimeVerificationSql,
  validateRuntimePolicy,
} from "../runtime/policy.mjs";
import {
  assertCandidateConfirmation,
  readActiveRuntimeInput,
  readCandidateMigrationPlan,
  readMatchingRuntimeMarker,
  runRuntimeLifecycle,
  withOwnedRuntimeRollback,
  writeCandidateMigrationReceipt,
  writeRuntimeMarker,
} from "../runtime/lifecycle_engine.mjs";
import type { ActiveRuntimeInput } from "../runtime/lifecycle_engine.mjs";
import { emitRuntimeStatusSnapshot } from "../runtime/status.mjs";
import { inspectSupabaseRuntimeStatus } from "./supabase_status.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
import {
  bindOwnedProcessCancellation,
  signalOwnedProcessGroup,
} from "../shared/owned_process.mjs";
import { runOwnedSupabaseMigration } from "./supabase_process.mjs";

const repositoryRoot = process.cwd();
const invocation = parseRuntimeInvocation();
const loadedConfiguration = await loadRehearsalConfig({
  projectRoot: repositoryRoot,
  ...(invocation.configPath === undefined
    ? {}
    : { configPath: invocation.configPath }),
});
const { config, paths: configuredPaths } = loadedConfiguration;
if (!config.supabase) {
  throw new Error("The Supabase runtime requires config.supabase.");
}
if (!configuredPaths.rehearsalConfig) {
  throw new Error("The Supabase runtime requires a Rehearsal config template.");
}
const supabaseConfig = config.supabase;
const artifactRoot = configuredPaths.artifactDirectory;
const runtimeWorkdir = configuredPaths.runtimeWorkdir;
const runtimeSupabaseDirectory = join(runtimeWorkdir, "supabase");
const runtimeMarkerPath = join(runtimeWorkdir, "baseline.json");
const runtimeCandidateReceiptPath = join(
  runtimeWorkdir,
  "candidate-receipt.json",
);
const environmentPath = configuredPaths.applicationEnvironment;
const configTemplatePath = configuredPaths.rehearsalConfig;
const manifestPath = configuredPaths.sanitizationPolicy;
const applicationMigrations = new URL(
  "./",
  pathToFileURL(`${configuredPaths.migrationDirectory}/`),
);
const projectId = config.runtime.projectId;
const runtimeAdapter = configuredPaths.runtimeAdapter
  ? ((await import(
      pathToFileURL(configuredPaths.runtimeAdapter).href
    )) as RuntimeAdapter)
  : null;
const runtimePolicy = configuredPaths.runtimePolicy
  ? validateRuntimePolicy(
      JSON.parse(await readFile(configuredPaths.runtimePolicy, "utf8")),
    )
  : null;
const environmentKeyPattern = /^[A-Z][A-Z0-9_]*$/u;
const action = invocation.action;

interface ProjectRuntimeResult {
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly message: string;
}

interface RuntimeAdapter {
  prepareSchema?(input: { runSql: typeof runDatabaseSql }): { message: string };
  configureRuntime?(input: {
    baseline: BaselineManifest;
    environment: LocalSupabaseEnvironment;
    runSql: typeof runDatabaseSql;
  }): ProjectRuntimeResult;
  verifyRuntime?(input: {
    baseline: BaselineManifest;
    environment: LocalSupabaseEnvironment;
    runSql: typeof runDatabaseSql;
  }): { message: string };
}

const readBaselineDataSha256 = (baseline: BaselineManifest): string => {
  const receipt = baseline.files["sanitized-data.ndjson"];
  if (!receipt) {
    throw new Error(
      "The active baseline is missing its sanitized data receipt.",
    );
  }
  return receipt.sha256;
};

const readServiceEnvironment = () =>
  readRehearsalServiceEnvironment({
    path: configuredPaths.serviceEnvironment,
    keys: supabaseConfig.serviceEnvironmentVariables,
    blockedKeys: config.safety.blockedEnvironmentVariables,
  });

const assertRuntimePath = () => {
  const resolvedRoot = resolve(artifactRoot);
  const resolvedRuntime = resolve(runtimeWorkdir);
  if (resolvedRuntime !== join(resolvedRoot, "runtime")) {
    throw new Error("Refusing an unsafe Rehearsal runtime path.");
  }
};

const pathExists = async (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch((error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    });

const hasProjectRuntimeResources = () => {
  const containers = runLocalCommand(
    "docker",
    [
      "ps",
      "--all",
      "--filter",
      `label=com.supabase.cli.project=${projectId}`,
      "--format",
      "{{.ID}}",
    ],
    { capture: true, cwd: repositoryRoot },
  ).trim();
  const volumes = runLocalCommand(
    "docker",
    ["volume", "ls", "--format", "{{.Name}}"],
    { capture: true, cwd: repositoryRoot },
  )
    .split("\n")
    .some((name) => name.trim().endsWith(`_${projectId}`));
  return Boolean(containers) || volumes;
};

const removeRuntime = async () => {
  assertRuntimePath();
  const hasRuntimeConfig = await pathExists(
    join(runtimeSupabaseDirectory, "config.toml"),
  );
  if (hasRuntimeConfig || hasProjectRuntimeResources()) {
    try {
      const serviceEnvironment = await readServiceEnvironment().catch(
        () => ({}),
      );
      runLocalCommand(
        "supabase",
        hasRuntimeConfig
          ? ["stop", "--no-backup", "--workdir", runtimeWorkdir]
          : ["stop", "--no-backup", "--project-id", projectId],
        { cwd: repositoryRoot, environment: serviceEnvironment },
      );
    } catch {
      removeLocalSupabaseProjectResources({
        cwd: repositoryRoot,
        projectId,
      });
    }
  }
  await rm(runtimeWorkdir, { recursive: true, force: true });
  await rm(environmentPath, { force: true });
};

const findDatabaseContainer = () => {
  const output = runLocalCommand(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.supabase.cli.project=${projectId}`,
      "--format",
      "{{.Names}}",
    ],
    { capture: true, cwd: repositoryRoot },
  );
  const names = output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("supabase_db_"));
  if (names.length !== 1) {
    throw new Error(
      `Expected one local Rehearsal database container; found ${names.length}.`,
    );
  }
  return names[0]!;
};

const writeChunk = async (
  stream: Writable,
  chunk: string,
  completion: Promise<number | null>,
): Promise<void> => {
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("The Rehearsal restore connection closed early.");
  }
  if (!stream.write(chunk)) {
    await Promise.race([once(stream, "drain"), completion]);
    if (stream.destroyed || stream.writableEnded) {
      throw new Error("The Rehearsal restore connection closed early.");
    }
  }
};

const restoreBaselineRows = async ({
  baseline,
  paths,
  manifest,
}: ActiveRuntimeInput): Promise<void> => {
  const child = spawn(
    "docker",
    [
      "exec",
      "--interactive",
      findDatabaseContainer(),
      "psql",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
    ],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: createCleanProcessEnvironment(),
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const completion = new Promise<number | null>((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
  });
  const cancellationSignal = getOperationCancellationSignal();
  const unbindCancellation = bindOwnedProcessCancellation({
    child,
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
  });
  child.stdin.on("error", () => undefined);
  try {
    await writeChunk(child.stdin, buildRestoreSqlPrefix(), completion);
    const lines = createInterface({
      input: createReadStream(paths.dataPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line) {
        await writeChunk(
          child.stdin,
          `${encodeBaselineRecordForCopy(line)}\n`,
          completion,
        );
      }
    }
    await writeChunk(
      child.stdin,
      buildRestoreSqlSuffix({
        manifest,
        tableCounts: baseline.tableCounts,
      }),
      completion,
    );
    child.stdin.end();
    const exitCode = await completion;
    if (exitCode !== 0) {
      throw new Error(
        `The local Rehearsal restore failed. ${summarizeRestoreError(stderr)}`,
      );
    }
  } catch (error) {
    if (child.exitCode === null) signalOwnedProcessGroup(child, "SIGTERM");
    await completion.catch(() => undefined);
    throw new Error(
      `The local Rehearsal restore failed. ${summarizeRestoreError(stderr)}`,
      { cause: error },
    );
  } finally {
    unbindCancellation();
  }
};

const restoreBaselineAssets = async ({
  baseline,
  paths,
  environment,
}: Pick<ActiveRuntimeInput, "baseline" | "paths"> & {
  environment: LocalSupabaseEnvironment;
}): Promise<void> => {
  const assets = Object.entries(baseline.storageAssets ?? {});
  if (assets.length === 0) return;
  assertLoopbackUrl("Rehearsal Supabase API", environment.apiUrl);
  for (const [relativePath, receipt] of assets) {
    const content = await readFile(
      join(paths.generationDirectory, relativePath),
    );
    const objectUrl = new URL(
      `/storage/v1/object/${encodeURIComponent(receipt.bucket)}/${receipt.objectPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      environment.apiUrl,
    );
    const response = await fetch(objectUrl, {
      method: "POST",
      headers: {
        apikey: environment.serviceRoleKey,
        authorization: `Bearer ${environment.serviceRoleKey}`,
        "content-type": receipt.contentType,
        "x-upsert": "true",
      },
      body: content,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `The local Rehearsal Storage restore failed for ${receipt.bucket} with status ${response.status}.`,
      );
    }
  }
};

const prepareRuntimeWorkdir = async ({
  baseline,
  paths,
}: Pick<ActiveRuntimeInput, "baseline" | "paths">): Promise<void> => {
  assertRuntimePath();
  await mkdir(join(runtimeSupabaseDirectory, "migrations"), {
    recursive: true,
    mode: 0o700,
  });
  const configTemplate = await readFile(configTemplatePath, "utf8");
  await writeFile(
    join(runtimeSupabaseDirectory, "config.toml"),
    applySupabaseAuthenticationProviders({
      source: configTemplate,
      authentication: supabaseConfig.authentication,
      apiPort:
        config.runtime.ports.api ??
        (() => {
          throw new Error("The Supabase runtime requires runtime.ports.api.");
        })(),
    }),
    { mode: 0o600 },
  );
  for (const filename of Object.keys(baseline.migrations).sort()) {
    await cp(
      join(paths.migrationsDirectory, filename),
      join(runtimeSupabaseDirectory, "migrations", filename),
    );
  }
  await writeFile(
    runtimeMarkerPath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        generationId: baseline.generationId,
        dataSha256: readBaselineDataSha256(baseline),
      },
      null,
      "\t",
    )}\n`,
    { mode: 0o600 },
  );
};

const writeRuntimeEnvironment = async ({
  environment,
  baseline,
  projectRuntime,
}: {
  environment: LocalSupabaseEnvironment;
  baseline: BaselineManifest;
  projectRuntime: ProjectRuntimeResult;
}): Promise<void> => {
  assertLoopbackUrl("Rehearsal Supabase API", environment.apiUrl);
  const variables = {
    REHEARSAL_RUNTIME_ENVIRONMENT: "rehearsal",
    REHEARSAL_BASELINE_ID: baseline.generationId,
    DATABASE_URL: environment.databaseUrl,
    PGHOST: environment.databaseHost,
    PGPORT: environment.databasePort,
    PGDATABASE: environment.databaseName,
    PGUSER: environment.databaseUser,
    PGPASSWORD: environment.databasePassword,
    SUPABASE_URL: environment.apiUrl,
    SUPABASE_PUBLISHABLE_KEY: environment.publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: environment.serviceRoleKey,
    ...projectRuntime.environmentVariables,
  };
  await writeFile(
    environmentPath,
    [
      "# Generated local Rehearsal runtime credentials. Do not commit.",
      ...Object.entries(variables).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
};

function runDatabaseSql(sql: string): string {
  const databaseArguments = [
    "exec",
    "--interactive",
    findDatabaseContainer(),
    "psql",
    "--quiet",
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
  ];
  return runLocalCommand("docker", databaseArguments, {
    capture: true,
    cwd: repositoryRoot,
    input: sql,
  });
}

const restoreProductionSchema = async ({
  baseline,
  paths,
}: Pick<ActiveRuntimeInput, "baseline" | "paths">): Promise<string | null> => {
  const receipt = baseline.files?.["production-schema.sql"];
  if (baseline.formatVersion === 1 && receipt === undefined) {
    if (runtimePolicy) {
      runDatabaseSql(buildRuntimePrerequisiteSql(runtimePolicy));
      runDatabaseSql(buildRuntimePostSchemaSql(runtimePolicy));
    }
    return null;
  }
  if (
    baseline.formatVersion !== 2 ||
    !/^[a-f0-9]{64}$/u.test(receipt?.sha256 ?? "") ||
    typeof receipt?.bytes !== "number" ||
    !Number.isSafeInteger(receipt.bytes)
  ) {
    throw new Error(
      "The active baseline predates exact production-schema restoration; refresh it first.",
    );
  }
  const schemaSql = await readFile(paths.schemaPath, "utf8");
  runDatabaseSql(`drop schema if exists public cascade;
create schema public authorization pg_database_owner;
grant usage on schema public to public;`);
  if (runtimePolicy) {
    runDatabaseSql(buildRuntimePrerequisiteSql(runtimePolicy));
  }
  if (runtimeAdapter?.prepareSchema) {
    const preparation = runtimeAdapter.prepareSchema({
      runSql: runDatabaseSql,
    });
    if (!preparation || typeof preparation.message !== "string") {
      throw new Error(
        "The project runtime adapter returned an invalid schema preparation result.",
      );
    }
  }
  runDatabaseSql(schemaSql);
  if (runtimePolicy) {
    runDatabaseSql(buildRuntimePostSchemaSql(runtimePolicy));
  }
  const restoredSchema = await captureLocalPublicSchema({
    repositoryRoot,
    artifactRoot,
    workdir: runtimeWorkdir,
  });
  return compareProductionSchemaDumps({
    expected: schemaSql,
    actual: restoredSchema,
  });
};

const configureProjectRuntime = ({
  environment,
  baseline,
}: {
  environment: LocalSupabaseEnvironment;
  baseline: BaselineManifest;
}): ProjectRuntimeResult => {
  assertLoopbackUrl("Rehearsal Supabase API", environment.apiUrl);
  if (!runtimeAdapter?.configureRuntime) {
    return {
      message: "Project-neutral local runtime is configured.",
      environmentVariables: {},
    };
  }
  const projectRuntime = runtimeAdapter.configureRuntime({
    baseline,
    environment,
    runSql: runDatabaseSql,
  });
  if (
    !projectRuntime ||
    typeof projectRuntime.message !== "string" ||
    !projectRuntime.environmentVariables ||
    typeof projectRuntime.environmentVariables !== "object" ||
    Array.isArray(projectRuntime.environmentVariables)
  ) {
    throw new Error("The project runtime adapter returned an invalid result.");
  }
  for (const [key, value] of Object.entries(
    projectRuntime.environmentVariables,
  )) {
    if (
      !environmentKeyPattern.test(key) ||
      typeof value !== "string" ||
      /[\n\r\0]/u.test(value)
    ) {
      throw new Error(
        "The project runtime adapter returned an unsafe environment variable.",
      );
    }
  }
  return projectRuntime;
};

const readActive = () => readActiveRuntimeInput({ artifactRoot, manifestPath });

const resetRuntime = async () => {
  const active = await readActive();
  const serviceEnvironment = await readServiceEnvironment();
  await removeRuntime();
  return withOwnedRuntimeRollback({
    operation: async function resetRuntimeOperation() {
      await prepareRuntimeWorkdir(active);
      const environment = startLocalSupabase({
        cwd: repositoryRoot,
        workdir: runtimeWorkdir,
        exclude: ["edge-runtime", "logflare", "vector", "realtime"],
        environment: serviceEnvironment,
        autoStartColima: config.containerRuntime.autoStartColima,
        projectId: config.runtime.projectId,
      });
      const structuralSchemaSha256 = await restoreProductionSchema(active);
      await restoreBaselineRows(active);
      await restoreBaselineAssets({
        baseline: active.baseline,
        paths: active.paths,
        environment,
      });
      if (runtimePolicy && runtimePolicy.localRows.length > 0) {
        runDatabaseSql(buildRuntimeFinalizationSql(runtimePolicy));
        console.log("Applied reviewed local-only recipes.");
      }
      const projectRuntime = configureProjectRuntime({
        environment,
        baseline: active.baseline,
      });
      await writeRuntimeEnvironment({
        environment,
        baseline: active.baseline,
        projectRuntime,
      });
      await writeRuntimeMarker({
        path: runtimeMarkerPath,
        marker: {
          formatVersion: active.baseline.formatVersion,
          generationId: active.baseline.generationId,
          dataSha256: readBaselineDataSha256(active.baseline),
          schemaSha256:
            active.baseline.files?.["production-schema.sql"]?.sha256 ?? null,
          structuralSchemaSha256,
        },
      });
      console.log(
        `Restored Rehearsal baseline ${active.baseline.generationId}: ${formatCount(active.baseline.rowCount, "row")} across ${formatCount(Object.keys(active.baseline.tableCounts).length, "table")}.`,
      );
      console.log(projectRuntime.message);
      return environment;
    },
    rollback: removeRuntime,
  });
};

const startRuntime = async () => {
  const { baseline } = await readActive();
  if (!(await pathExists(runtimeMarkerPath))) return resetRuntime();
  const serviceEnvironment = await readServiceEnvironment();
  await readMatchingRuntimeMarker({
    path: runtimeMarkerPath,
    expected: {
      generationId: baseline.generationId,
      dataSha256: readBaselineDataSha256(baseline),
      schemaSha256: baseline.files?.["production-schema.sql"]?.sha256 ?? null,
    },
    mismatchMessage:
      "The local Rehearsal runtime does not match the active baseline; run db:rehearsal:reset.",
  });
  const environment = startLocalSupabase({
    cwd: repositoryRoot,
    workdir: runtimeWorkdir,
    exclude: ["edge-runtime", "logflare", "vector", "realtime"],
    environment: serviceEnvironment,
    autoStartColima: config.containerRuntime.autoStartColima,
    projectId: config.runtime.projectId,
  });
  const projectRuntime = configureProjectRuntime({ environment, baseline });
  await writeRuntimeEnvironment({
    environment,
    baseline,
    projectRuntime,
  });
  return environment;
};

const readCandidateReceipt = (baseline: BaselineManifest) =>
  readCandidateMigrationPlan({
    baseline,
    migrationDirectory: applicationMigrations,
  });

const readRuntimeMigrationLedger = () => {
  const output = runLocalCommand(
    "docker",
    [
      "exec",
      "--interactive",
      findDatabaseContainer(),
      "psql",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
    ],
    {
      capture: true,
      cwd: repositoryRoot,
      input: `select coalesce(json_agg(json_build_object(
	'version', version,
	'name', name,
	'statements', statements
) order by version), '[]'::json)::text
from supabase_migrations.schema_migrations;`,
    },
  );
  return buildMigrationLedgerInventory(
    JSON.parse(output.trim()) as unknown,
    "Rehearsal runtime migration ledger",
  );
};

const verifyRuntimeMigrationHistory = async ({
  baseline,
  currentFiles,
}: {
  baseline: BaselineManifest;
  currentFiles: readonly MigrationFileEntry[];
}) => {
  const ledger = readRuntimeMigrationLedger();
  const appliedFiles = currentFiles.slice(0, ledger.length);
  const replayReceipt = createMigrationReplayReceipt({
    files: appliedFiles,
    ledger,
  });
  if (!baseline.sourceMigrationHistory) {
    throw new Error("The active baseline is missing source migration history.");
  }
  return compareSourceToReplay({
    sourceLedger: baseline.sourceMigrationHistory,
    replayReceipt,
    ...(baseline.files["production-schema.sql"]?.sha256 === undefined
      ? {}
      : {
          snapshotSchemaSha256: baseline.files["production-schema.sql"].sha256,
        }),
  });
};

const verifyRuntime = async () => {
  const { baseline } = await readActive();
  const environment = await startRuntime();
  const candidateReceipt = await readCandidateReceipt(baseline);
  const migrationComparison = await verifyRuntimeMigrationHistory({
    baseline,
    currentFiles: candidateReceipt.currentFiles,
  });
  let projectVerification;
  if (runtimePolicy) runDatabaseSql(buildRuntimeVerificationSql(runtimePolicy));
  if (runtimeAdapter?.verifyRuntime) {
    projectVerification = runtimeAdapter.verifyRuntime({
      baseline,
      environment,
      runSql: runDatabaseSql,
    });
    if (
      !projectVerification ||
      typeof projectVerification.message !== "string"
    ) {
      throw new Error(
        "The project runtime adapter returned an invalid verification result.",
      );
    }
  }
  console.log(
    `Verified Rehearsal runtime ${baseline.generationId}: immutable baseline and migration history are valid with ${formatCount(migrationComparison.candidates.length, "applied candidate migration")}. Runtime rows may differ from the baseline until the next reset.`,
  );
  if (projectVerification) console.log(projectVerification.message);
  return { baseline, candidateReceipt, migrationComparison };
};

const migrateRuntime = async () => {
  const { baseline } = await readActive();
  await startRuntime();
  const receipt = await readCandidateReceipt(baseline);
  if (receipt.candidates.length === 0) {
    await writeCandidateMigrationReceipt({
      path: runtimeCandidateReceiptPath,
      target: "supabase",
      baseline,
      plan: receipt,
    });
    console.log(
      `No candidate migrations follow baseline ${baseline.migrationCutoff}.`,
    );
    return receipt;
  }
  console.log(
    `${receipt.candidates.length === 1 ? "Candidate migration" : "Candidate migrations"} (${receipt.candidateSha256}): ${receipt.candidates.map((candidate) => candidate.filename).join(", ")}`,
  );
  assertCandidateConfirmation({
    plan: receipt,
    confirmation: invocation.confirmation,
  });
  return withOwnedRuntimeRollback({
    operation: async function migrateRuntimeOperation() {
      const serviceEnvironment = await readServiceEnvironment();
      for (const candidate of receipt.candidates) {
        await cp(
          join(configuredPaths.migrationDirectory, candidate.filename),
          join(runtimeSupabaseDirectory, "migrations", candidate.filename),
        );
      }
      await runOwnedSupabaseMigration({
        environment: serviceEnvironment,
        repositoryRoot,
        runtimeWorkdir,
      });
      const comparison = await verifyRuntimeMigrationHistory({
        baseline,
        currentFiles: receipt.currentFiles,
      });
      if (
        comparison.candidates
          .map((candidate) => candidate.filename)
          .join("\0") !==
        receipt.candidates.map((candidate) => candidate.filename).join("\0")
      ) {
        throw new Error(
          "Applied Rehearsal migration history does not match the confirmed candidate suffix.",
        );
      }
      await writeCandidateMigrationReceipt({
        path: runtimeCandidateReceiptPath,
        target: "supabase",
        baseline,
        plan: receipt,
      });
      console.log(
        `Applied ${formatCount(receipt.candidates.length, "confirmed candidate migration")} to the disposable Rehearsal runtime.`,
      );
      return receipt;
    },
    rollback: removeRuntime,
  });
};

await runRuntimeLifecycle({
  action,
  operations: {
    reset: resetRuntime,
    start: async () => {
      const environment = await startRuntime();
      console.log(`Local Rehearsal Supabase: ${environment.apiUrl}`);
    },
    status: async () => {
      const baseline = await verifyActiveBaseline({ artifactRoot });
      const receipt = await readCandidateReceipt(baseline);
      emitRuntimeStatusSnapshot({
        structured: invocation.structuredResult,
        status: await inspectSupabaseRuntimeStatus({
          cwd: repositoryRoot,
          runtimeWorkdir,
          projectId,
          loadServiceEnvironment: readServiceEnvironment,
          baselineGenerationId: baseline.generationId,
          candidateSha256: receipt.candidateSha256,
          candidates: receipt.candidates.map((candidate) => candidate.filename),
        }),
      });
    },
    candidates: async () => {
      const baseline = await verifyActiveBaseline({ artifactRoot });
      const receipt = await readCandidateReceipt(baseline);
      console.log(
        `Candidate migrations (${receipt.candidateSha256}): ${receipt.candidates.map((candidate) => candidate.filename).join(", ") || "none"}`,
      );
    },
    migrate: migrateRuntime,
    verify: verifyRuntime,
    stop: async () => {
      stopLocalSupabase({
        cwd: repositoryRoot,
        workdir: runtimeWorkdir,
        environment: await readServiceEnvironment(),
      });
    },
    discard: removeRuntime,
  },
});
