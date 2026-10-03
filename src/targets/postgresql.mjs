/**
 * Purpose: Restore and manage a disposable, loopback-only PostgreSQL runtime from
 * the active verified Rehearsal baseline.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  resolveActiveBaselinePaths,
  verifyActiveBaseline,
} from "../baseline/artifact.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { formatCount } from "../shared/human_output.mjs";
import { readMigrationFileInventory } from "../runtime/migration_history.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  buildRestoreSqlPrefix,
  buildRestoreSqlSuffix,
  createCandidateMigrationReceipt,
  encodeBaselineRecordForCopy,
  summarizeRestoreError,
} from "../runtime/restore.mjs";
import { readBoundRuntimeSanitizationPolicy } from "../baseline/sanitization_policy.mjs";
import { ensureLocalContainerRuntime } from "./supabase_environment.mjs";
import { parseRuntimeInvocation } from "./target.mjs";
import {
  buildRuntimeFinalizationSql,
  buildRuntimePostSchemaSql,
  buildRuntimePrerequisiteSql,
  buildRuntimeVerificationSql,
  validateRuntimePolicy,
} from "../runtime/policy.mjs";

const repositoryRoot = process.cwd();
const invocation = parseRuntimeInvocation();
const loadedConfiguration = await loadRehearsalConfig({
  projectRoot: repositoryRoot,
  configPath: invocation.configPath,
});
const { config, paths: configuredPaths } = loadedConfiguration;
const artifactRoot = configuredPaths.artifactDirectory;
const runtimeWorkdir = configuredPaths.runtimeWorkdir;
const runtimeMarkerPath = join(runtimeWorkdir, "baseline.json");
const runtimeCandidateReceiptPath = join(
  runtimeWorkdir,
  "candidate-receipt.json",
);
const environmentPath = configuredPaths.applicationEnvironment;
const manifestPath = configuredPaths.sanitizationPolicy;
const projectId = config.runtime.projectId;
const containerName = `${projectId}-postgresql`;
const volumeName = `${projectId}-postgresql-data`;
const label = `com.rehearsal-db.project=${projectId}`;
const image = config.postgresql.image;
const database = config.postgresql.database;
const databaseUser = config.postgresql.user;
const databasePort = config.runtime.ports.database;
const action = invocation.action;
const applicationMigrations = new URL(
  "./",
  pathToFileURL(`${configuredPaths.migrationDirectory}/`),
);
const runtimeAdapter = configuredPaths.runtimeAdapter
  ? await import(pathToFileURL(configuredPaths.runtimeAdapter).href)
  : null;
const runtimePolicy = configuredPaths.runtimePolicy
  ? validateRuntimePolicy(
      JSON.parse(await readFile(configuredPaths.runtimePolicy, "utf8")),
    )
  : null;
const environmentKeyPattern = /^[A-Z][A-Z0-9_]*$/u;

const runCommand = (
  command,
  args,
  { capture = false, input, allowFailure = false } = {},
) => {
  const piped = capture || input !== undefined || allowFailure;
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (!allowFailure && result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result;
};

const commandSucceeds = (command, args) =>
  runCommand(command, args, { allowFailure: true }).status === 0;

const pathExists = async (path) =>
  stat(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });

const assertRuntimePath = () => {
  if (resolve(runtimeWorkdir) !== join(resolve(artifactRoot), "runtime")) {
    throw new Error("Refusing an unsafe Rehearsal runtime path.");
  }
};

const assertDocker = () => {
  ensureLocalContainerRuntime({
    cwd: repositoryRoot,
    autoStartColima: config.containerRuntime.autoStartColima,
  });
};

const inspectResourceLabel = (kind, name) =>
  runCommand(
    "docker",
    [
      kind,
      "inspect",
      "--format",
      kind === "container"
        ? '{{index .Config.Labels "com.rehearsal-db.project"}}'
        : '{{index .Labels "com.rehearsal-db.project"}}',
      name,
    ],
    { allowFailure: true },
  );

const resourceExists = (kind, name) =>
  runCommand("docker", [kind, "inspect", name], { allowFailure: true })
    .status === 0;

const assertOwnedResource = (kind, name) => {
  if (!resourceExists(kind, name)) return false;
  const inspection = inspectResourceLabel(kind, name);
  if (inspection.status !== 0 || inspection.stdout.trim() !== projectId) {
    throw new Error(
      `Refusing to manage Docker ${kind} ${name} because it is not owned by this Rehearsal project.`,
    );
  }
  return true;
};

const removeRuntime = async () => {
  assertRuntimePath();
  if (commandSucceeds("docker", ["info"])) {
    if (assertOwnedResource("container", containerName)) {
      runCommand("docker", ["container", "rm", "--force", containerName], {
        capture: true,
      });
    }
    if (assertOwnedResource("volume", volumeName)) {
      runCommand("docker", ["volume", "rm", "--force", volumeName], {
        capture: true,
      });
    }
  }
  await rm(runtimeWorkdir, { recursive: true, force: true });
  await rm(environmentPath, { force: true });
};

const waitForDatabase = async () => {
  let consecutiveReadyChecks = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      commandSucceeds("docker", [
        "exec",
        containerName,
        "pg_isready",
        "--username",
        databaseUser,
        "--dbname",
        database,
      ])
    ) {
      consecutiveReadyChecks += 1;
      if (consecutiveReadyChecks === 3) return;
    } else {
      consecutiveReadyChecks = 0;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("The disposable PostgreSQL database did not become ready.");
};

const runPsql = (sql, { capture = true } = {}) =>
  runCommand(
    "docker",
    [
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      databaseUser,
      "--dbname",
      database,
    ],
    { capture, input: sql },
  ).stdout;

const databaseEnvironment = (password) => ({
  databaseUrl: [
    "postgresql://",
    databaseUser,
    ":",
    encodeURIComponent(password),
    "@127.0.0.1:",
    databasePort,
    "/",
    database,
    "?sslmode=disable",
  ].join(""),
  host: "127.0.0.1",
  port: databasePort,
  database,
  user: databaseUser,
  password,
});

const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

const initializeMigrationLedger = () =>
  runPsql(`create schema if not exists rehearsal_internal;
create table if not exists rehearsal_internal.schema_migrations (
  version text primary key,
  name text not null,
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
);`);

const applyMigration = async ({ migration, directory }) => {
  const source = await readFile(join(directory, migration.filename), "utf8");
  runPsql(source, { capture: false });
  runPsql(`insert into rehearsal_internal.schema_migrations
  (version, name, file_sha256)
values (
  ${quoteLiteral(migration.version)},
  ${quoteLiteral(migration.name)},
  ${quoteLiteral(migration.fileSha256)}
);`);
};

const readRuntimeMigrationLedger = () => {
  const output =
    runPsql(`select version || E'\\t' || name || E'\\t' || file_sha256
from rehearsal_internal.schema_migrations
order by version;`);
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [version, name, fileSha256] = line.split("\t");
      return { version, name, fileSha256 };
    });
};

const verifyMigrationLedger = ({ currentFiles, baseline }) => {
  const ledger = readRuntimeMigrationLedger();
  const baselineCount = Object.keys(baseline.migrations).length;
  if (ledger.length < baselineCount || ledger.length > currentFiles.length) {
    throw new Error(
      "The PostgreSQL runtime migration ledger has an unexpected length.",
    );
  }
  for (let index = 0; index < ledger.length; index += 1) {
    const applied = ledger[index];
    const source = currentFiles[index];
    if (
      !source ||
      applied.version !== source.version ||
      applied.name !== source.name ||
      applied.fileSha256 !== source.fileSha256
    ) {
      throw new Error(
        `The PostgreSQL runtime migration ledger differs at ${applied.version ?? "unknown"}.`,
      );
    }
  }
  return { ledger, appliedCandidateCount: ledger.length - baselineCount };
};

const writeChunk = async (stream, chunk, completion) => {
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("The Rehearsal restore connection closed early.");
  }
  if (!stream.write(chunk)) {
    await Promise.race([once(stream, "drain"), completion]);
  }
};

const restoreBaselineRows = async ({ baseline, paths, manifest }) => {
  const child = spawn(
    "docker",
    [
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      databaseUser,
      "--dbname",
      database,
    ],
    {
      cwd: repositoryRoot,
      env: createCleanProcessEnvironment(),
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const completion = new Promise((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
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
        restoreSupabaseAuth: false,
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
    if (child.exitCode === null) child.kill("SIGTERM");
    await completion.catch(() => undefined);
    throw error;
  }
};

const prepareProjectPrerequisites = () => {
  if (runtimePolicy) {
    runPsql(buildRuntimePrerequisiteSql(runtimePolicy));
    console.log("Applied reviewed runtime prerequisites.");
  }
};

const prepareProjectSchema = ({ baseline, environment }) => {
  if (!runtimeAdapter?.prepareSchema) return;
  const preparation = runtimeAdapter.prepareSchema({
    baseline,
    environment,
    runSql: runPsql,
  });
  if (!preparation || typeof preparation.message !== "string") {
    throw new Error(
      "The project runtime adapter returned an invalid schema preparation result.",
    );
  }
  console.log(preparation.message);
};

const finalizeProjectSchema = () => {
  if (!runtimePolicy || runtimePolicy.triggers.length === 0) return;
  runPsql(buildRuntimePostSchemaSql(runtimePolicy));
  console.log("Applied reviewed post-schema triggers.");
};

const finalizeProjectRuntime = () => {
  if (!runtimePolicy || runtimePolicy.localRows.length === 0) return;
  runPsql(buildRuntimeFinalizationSql(runtimePolicy));
  console.log("Applied reviewed local-only recipes.");
};

const configureProjectRuntime = ({ baseline, environment }) => {
  if (!runtimeAdapter?.configureRuntime) {
    return {
      environmentVariables: {},
      message: "Project-neutral PostgreSQL runtime is configured.",
    };
  }
  const result = runtimeAdapter.configureRuntime({
    baseline,
    environment,
    runSql: runPsql,
  });
  if (
    !result ||
    typeof result.message !== "string" ||
    !result.environmentVariables ||
    typeof result.environmentVariables !== "object" ||
    Array.isArray(result.environmentVariables)
  ) {
    throw new Error("The project runtime adapter returned an invalid result.");
  }
  for (const [key, value] of Object.entries(result.environmentVariables)) {
    if (
      !environmentKeyPattern.test(key) ||
      typeof value !== "string" ||
      config.safety.blockedEnvironmentVariables.includes(key)
    ) {
      throw new Error(
        "The project runtime adapter returned an unsafe environment variable.",
      );
    }
  }
  return result;
};

const writeRuntimeEnvironment = async ({
  baseline,
  environment,
  projectRuntime,
}) => {
  const variables = {
    REHEARSAL_RUNTIME_ENVIRONMENT: "rehearsal",
    REHEARSAL_BASELINE_ID: baseline.generationId,
    DATABASE_URL: environment.databaseUrl,
    PGHOST: environment.host,
    PGPORT: String(environment.port),
    PGDATABASE: environment.database,
    PGUSER: environment.user,
    PGPASSWORD: environment.password,
    ...projectRuntime.environmentVariables,
  };
  await writeFile(
    environmentPath,
    [
      "# Generated local Rehearsal runtime values. Do not commit.",
      ...Object.entries(variables).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
};

const readActive = async () => {
  const baseline = await verifyActiveBaseline({ artifactRoot });
  const paths = await resolveActiveBaselinePaths({ artifactRoot });
  const manifest = readBoundRuntimeSanitizationPolicy({
    bytes: await readFile(manifestPath),
    expectedSha256: baseline.sanitizationPolicySha256,
  });
  if (Object.keys(baseline.storageAssets ?? {}).length > 0) {
    throw new Error(
      "The PostgreSQL target cannot restore Supabase Storage assets. Create this baseline without an assets manifest.",
    );
  }
  if (
    manifest.tables.some((table) =>
      table.columns.some((column) => column.foreignKey?.schema === "auth"),
    )
  ) {
    throw new Error(
      "The PostgreSQL target cannot synthesize Supabase Auth rows. Remove auth-schema references or use the Supabase target.",
    );
  }
  return { baseline, paths, manifest };
};

const createContainer = async (password) => {
  assertDocker();
  if (!commandSucceeds("docker", ["image", "inspect", image])) {
    throw new Error(
      `The configured local PostgreSQL image is unavailable: ${image}. Pull it explicitly, review it, then retry.`,
    );
  }
  runCommand("docker", ["volume", "create", "--label", label, volumeName], {
    capture: true,
  });
  runCommand(
    "docker",
    [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      containerName,
      "--label",
      label,
      "--publish",
      `127.0.0.1:${databasePort}:5432`,
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--env",
      `POSTGRES_USER=${databaseUser}`,
      "--volume",
      `${volumeName}:/var/lib/postgresql/data`,
      image,
    ],
    { capture: true },
  );
  await waitForDatabase();
};

const resetRuntime = async () => {
  const active = await readActive();
  await removeRuntime();
  await mkdir(runtimeWorkdir, { recursive: true, mode: 0o700 });
  try {
    const password = randomBytes(24).toString("hex");
    await createContainer(password);
    const environment = databaseEnvironment(password);
    prepareProjectPrerequisites();
    initializeMigrationLedger();
    const baselineMigrations = await readMigrationFileInventory(
      new URL("./", pathToFileURL(`${active.paths.migrationsDirectory}/`)),
    );
    for (const migration of baselineMigrations) {
      await applyMigration({
        migration,
        directory: active.paths.migrationsDirectory,
      });
    }
    prepareProjectSchema({ baseline: active.baseline, environment });
    finalizeProjectSchema();
    await restoreBaselineRows({ ...active });
    finalizeProjectRuntime();
    const projectRuntime = configureProjectRuntime({
      baseline: active.baseline,
      environment,
    });
    await writeRuntimeEnvironment({
      baseline: active.baseline,
      environment,
      projectRuntime,
    });
    await writeFile(
      runtimeMarkerPath,
      `${JSON.stringify(
        {
          formatVersion: 1,
          target: "postgresql",
          generationId: active.baseline.generationId,
          dataSha256: active.baseline.files["sanitized-data.ndjson"].sha256,
          image,
          databasePassword: password,
        },
        null,
        "\t",
      )}\n`,
      { mode: 0o600 },
    );
    console.log(
      `Restored Rehearsal baseline ${active.baseline.generationId}: ${formatCount(active.baseline.rowCount, "row")} across ${formatCount(Object.keys(active.baseline.tableCounts).length, "table")}.`,
    );
    console.log(projectRuntime.message);
    return environment;
  } catch (error) {
    await removeRuntime().catch(() => undefined);
    throw error;
  }
};

const startRuntime = async () => {
  const { baseline } = await readActive();
  if (!(await pathExists(runtimeMarkerPath))) return resetRuntime();
  const marker = JSON.parse(await readFile(runtimeMarkerPath, "utf8"));
  if (
    marker.target !== "postgresql" ||
    marker.generationId !== baseline.generationId ||
    marker.dataSha256 !== baseline.files["sanitized-data.ndjson"].sha256 ||
    marker.image !== image ||
    typeof marker.databasePassword !== "string" ||
    marker.databasePassword.length < 32
  ) {
    throw new Error(
      "The local Rehearsal runtime does not match the active baseline; reset it before continuing.",
    );
  }
  if (!assertOwnedResource("container", containerName)) {
    return resetRuntime();
  }
  if (
    !commandSucceeds("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ])
  ) {
    throw new Error("The disposable PostgreSQL container cannot be inspected.");
  }
  const running = runCommand(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", containerName],
    { capture: true },
  ).stdout.trim();
  if (running !== "true") {
    runCommand("docker", ["start", containerName], { capture: true });
  }
  await waitForDatabase();
  const environment = databaseEnvironment(marker.databasePassword);
  const projectRuntime = configureProjectRuntime({ baseline, environment });
  await writeRuntimeEnvironment({ baseline, environment, projectRuntime });
  return environment;
};

const readCandidateReceipt = async (baseline) => {
  const currentFiles = await readMigrationFileInventory(applicationMigrations);
  return {
    currentFiles,
    ...createCandidateMigrationReceipt({
      baselineManifest: baseline,
      currentFiles,
    }),
  };
};

const verifyRuntime = async () => {
  const { baseline } = await readActive();
  const environment = await startRuntime();
  const receipt = await readCandidateReceipt(baseline);
  const migrationVerification = verifyMigrationLedger({
    currentFiles: receipt.currentFiles,
    baseline,
  });
  let projectVerification;
  if (runtimePolicy) runPsql(buildRuntimeVerificationSql(runtimePolicy));
  if (runtimeAdapter?.verifyRuntime) {
    projectVerification = runtimeAdapter.verifyRuntime({
      baseline,
      environment,
      runSql: runPsql,
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
    `Verified Rehearsal runtime ${baseline.generationId}: immutable baseline and migration history are valid with ${formatCount(migrationVerification.appliedCandidateCount, "applied candidate migration")}. Runtime rows may differ from the baseline until the next reset.`,
  );
  if (projectVerification) console.log(projectVerification.message);
  return { baseline, receipt, migrationVerification };
};

const migrateRuntime = async () => {
  const { baseline } = await readActive();
  await startRuntime();
  const receipt = await readCandidateReceipt(baseline);
  const confirmation = invocation.confirmation;
  if (confirmation !== receipt.candidateSha256) {
    throw new Error(
      "Candidate migration confirmation is missing or does not match the exact SHA-256.",
    );
  }
  try {
    const ledger = readRuntimeMigrationLedger();
    for (const migration of receipt.candidates.slice(
      Math.max(0, ledger.length - Object.keys(baseline.migrations).length),
    )) {
      await applyMigration({
        migration,
        directory: configuredPaths.migrationDirectory,
      });
    }
    const verification = verifyMigrationLedger({
      currentFiles: receipt.currentFiles,
      baseline,
    });
    if (verification.appliedCandidateCount !== receipt.candidates.length) {
      throw new Error(
        "Applied PostgreSQL migration history does not match the confirmed candidate suffix.",
      );
    }
    await writeFile(
      runtimeCandidateReceiptPath,
      `${JSON.stringify(
        {
          formatVersion: 1,
          baselineGenerationId: baseline.generationId,
          candidateSha256: receipt.candidateSha256,
          candidates: receipt.candidates.map((candidate) => ({
            filename: candidate.filename,
            sha256: candidate.fileSha256,
          })),
        },
        null,
        "\t",
      )}\n`,
      { mode: 0o600 },
    );
    console.log(
      receipt.candidates.length
        ? `Applied ${formatCount(receipt.candidates.length, "confirmed candidate migration")} to the disposable PostgreSQL runtime.`
        : `No candidate migrations follow baseline ${baseline.migrationCutoff}.`,
    );
    return receipt;
  } catch (error) {
    await removeRuntime().catch(() => undefined);
    throw error;
  }
};

switch (action) {
  case "reset":
    await resetRuntime();
    break;
  case "start": {
    const environment = await startRuntime();
    console.log(
      `Local Rehearsal PostgreSQL: ${environment.host}:${environment.port}/${environment.database}`,
    );
    break;
  }
  case "status": {
    const baseline = await verifyActiveBaseline({ artifactRoot });
    const receipt = await readCandidateReceipt(baseline);
    const running =
      commandSucceeds("docker", ["info"]) &&
      resourceExists("container", containerName) &&
      runCommand(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", containerName],
        { capture: true },
      ).stdout.trim() === "true";
    console.log(
      `Local Rehearsal PostgreSQL: ${running ? `running on 127.0.0.1:${databasePort}` : "stopped"}`,
    );
    console.log(`Active sanitized baseline: ${baseline.generationId}`);
    console.log(
      `Candidate migrations (${receipt.candidateSha256}): ${receipt.candidates.map((candidate) => candidate.filename).join(", ") || "none"}`,
    );
    break;
  }
  case "candidates": {
    const baseline = await verifyActiveBaseline({ artifactRoot });
    const receipt = await readCandidateReceipt(baseline);
    console.log(
      `Candidate migrations (${receipt.candidateSha256}): ${receipt.candidates.map((candidate) => candidate.filename).join(", ") || "none"}`,
    );
    break;
  }
  case "migrate":
    await migrateRuntime();
    break;
  case "verify":
    await verifyRuntime();
    break;
  case "run":
    await resetRuntime();
    await migrateRuntime();
    await verifyRuntime();
    break;
  case "stop":
    if (
      commandSucceeds("docker", ["info"]) &&
      assertOwnedResource("container", containerName)
    ) {
      runCommand("docker", ["stop", containerName], { capture: true });
    }
    break;
  case "discard":
    await removeRuntime();
    break;
  default:
    throw new Error(`Unknown Rehearsal database action: ${action}`);
}
