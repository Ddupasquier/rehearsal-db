import { runOwnedRestore } from "../runtime/recovery/restore_process.mjs";
import { createPostgresqlResourceManagement } from "./postgresql/postgresql_resources.mjs";
import { describeMigrationCutoff } from "../runtime/migrations/migration_identity.mjs";
import {
  assertActiveBaselineUnchanged,
  assertNativeBaselineManifestUnchanged,
} from "../runtime/lifecycle/baseline_identity.mjs";
import { createPostgresqlMigrationRuntime } from "./postgresql/postgresql_migrations.mjs";
import { requirePrismaTargetBinding } from "./native/prisma_target_binding.mjs";
import { createPostgresqlContainerLifecycle } from "./postgresql/postgresql_container_resume.mjs";
import { restoreCopyChunks } from "../runtime/resources/restore_cache.mjs";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyActiveBaseline } from "../baseline/artifact.mjs";
import type { BaselineManifest } from "../baseline/artifact.mjs";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { formatCount } from "../shared/human_output.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  buildRestoreSqlPrefix,
  buildRestoreSqlSuffix,
} from "../runtime/recovery/restore.mjs";
import {
  assertCandidateConfirmation,
  readActiveRuntimeInput,
  readMatchingRuntimeMarker,
  runRuntimeLifecycle,
  withOwnedRuntimeRollback,
  writeCandidateMigrationReceipt,
  writeRuntimeMarker,
} from "../runtime/lifecycle/lifecycle_engine.mjs";
import type { ActiveRuntimeInput } from "../runtime/lifecycle/lifecycle_engine.mjs";
import { emitRuntimeStatusSnapshot } from "../runtime/lifecycle/status.mjs";
import { inspectPostgresqlRuntimeStatus } from "./postgresql/postgresql_status.mjs";
import { ensureConfiguredContainerRuntime } from "./supabase/supabase_environment.mjs";
import {
  runPostgresqlCommand,
  runPostgresqlAdapterSql,
  postgresqlPsqlArguments,
  withPostgresqlDeadline,
  type PostgresqlCommandPurpose,
} from "./postgresql/postgresql_process.mjs";
import { parseRuntimeInvocation } from "./target.mjs";
import { guardRuntimeManagerAction } from "../runtime/lifecycle/runtime_manager_guards.mjs";
import { runtimeDockerEnvironment } from "../runtime/engines/local_docker_context.mjs";
import { assertPostgresqlStartupResult } from "./port_start_failure.mjs";
import {
  buildRuntimeFinalizationSql,
  buildRuntimePostSchemaSql,
  buildRuntimePrerequisiteSql,
  buildRuntimeVerificationSql,
  validateRuntimePolicy,
} from "../runtime/lifecycle/policy.mjs";
const repositoryRoot = process.cwd();
const invocation = parseRuntimeInvocation();
const loadedConfiguration = await loadRehearsalConfig({
  projectRoot: repositoryRoot,
  ...(invocation.configPath === undefined
    ? {}
    : { configPath: invocation.configPath }),
});
const { config, paths: configuredPaths } = loadedConfiguration;
await guardRuntimeManagerAction(loadedConfiguration, invocation.action);
if (!config.postgresql) {
  throw new Error("The PostgreSQL runtime requires config.postgresql.");
}
const postgresqlConfig = config.postgresql;
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
const image = postgresqlConfig.image;
const database = postgresqlConfig.database;
const databaseUser = postgresqlConfig.user;
const databasePort = config.runtime.ports.database;
if (databasePort === undefined)
  throw new Error(
    "The PostgreSQL runtime requires its configured database port.",
  );
const action = invocation.action;
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

interface RunCommandOptions {
  readonly capture?: boolean;
  readonly input?: string;
  readonly allowFailure?: boolean;
  readonly purpose?: PostgresqlCommandPurpose;
}

interface DatabaseEnvironment {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

interface ProjectRuntimeResult {
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly message: string;
}

interface RuntimeAdapter {
  prepareSchema?(input: {
    baseline: BaselineManifest;
    environment: DatabaseEnvironment;
    runSql: typeof runAdapterPsql;
  }): { message: string };
  configureRuntime?(input: {
    baseline: BaselineManifest;
    environment: DatabaseEnvironment;
    runSql: typeof runAdapterPsql;
  }): ProjectRuntimeResult;
  verifyRuntime?(input: {
    baseline: BaselineManifest;
    environment: DatabaseEnvironment;
    runSql: typeof runAdapterPsql;
  }): { message: string };
}

const runCommand = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
) => runPostgresqlCommand(command, args, { cwd: repositoryRoot, ...options });

const commandSucceeds = async (
  command: string,
  args: readonly string[],
): Promise<boolean> =>
  (await runCommand(command, args, { allowFailure: true })).status === 0;
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
const assertRuntimePath = () => {
  if (resolve(runtimeWorkdir) !== join(resolve(artifactRoot), "runtime")) {
    throw new Error("Refusing an unsafe Rehearsal runtime path.");
  }
};
const assertDocker = () => {
  ensureConfiguredContainerRuntime({
    cwd: repositoryRoot,
    artifactDirectory: artifactRoot,
    projectId,
    policy: config.containerRuntime,
  });
};

const { assertOwnedResource, removeResources } =
  createPostgresqlResourceManagement({
    runCommand,
    containerName,
    volumeName,
    projectId,
  });
const removeRuntime = async () => {
  assertRuntimePath();
  await removeResources();
  await rm(runtimeWorkdir, { recursive: true, force: true });
  await rm(environmentPath, { force: true });
};

const waitForDatabase = async () =>
  withPostgresqlDeadline(
    "startup",
    async (signal) => {
      const until = Date.now() + 60_000;
      let consecutiveReadyChecks = 0;
      while (Date.now() < until) {
        const ready = await runPostgresqlCommand(
          "docker",
          [
            "exec",
            containerName,
            "pg_isready",
            "--username",
            databaseUser,
            "--dbname",
            database,
          ],
          {
            cwd: repositoryRoot,
            allowFailure: true,
            signal,
            timeoutMilliseconds: Math.min(
              5_000,
              Math.max(1, until - Date.now()),
            ),
          },
        );
        consecutiveReadyChecks =
          ready.status === 0 ? consecutiveReadyChecks + 1 : 0;
        if (consecutiveReadyChecks === 3) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      throw new Error(
        "The disposable PostgreSQL database did not become ready.",
      );
    },
    { timeoutMilliseconds: 60_000 },
  );

const psqlArguments = postgresqlPsqlArguments({
  containerName,
  database,
  databaseUser,
});
const runPsql = async (sql: string): Promise<string> =>
  (
    await runCommand("docker", psqlArguments, {
      input: sql,
      capture: true,
      purpose: "sql",
    })
  ).stdout;
const runAdapterPsql = (
  sql: string,
  _options: { capture?: boolean } = {},
): string => runPostgresqlAdapterSql(psqlArguments, sql, repositoryRoot);

const databaseEnvironment = (password: string): DatabaseEnvironment => ({
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

const migrationRuntime = createPostgresqlMigrationRuntime({
  loaded: loadedConfiguration,
  runSql: runPsql,
  assertExpectedBaseline: (baseline) =>
    assertNativeBaselineManifestUnchanged({ artifactRoot, expected: baseline }),
  containerName,
  database,
  databaseUser,
  assertOwnedTarget: async () => {
    const ownedContainerId = await assertOwnedResource(
      "container",
      containerName,
    );
    if (!ownedContainerId || !(await assertOwnedResource("volume", volumeName)))
      throw new Error("Native PostgreSQL resources are unconfirmed.");
    try {
      const value = JSON.parse(
        (
          await runCommand(
            "docker",
            [
              "inspect",
              "--format",
              '{"id":{{json .Id}},"running":{{json .State.Running}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}',
              containerName,
            ],
            { capture: true },
          )
        ).stdout,
      );
      const expectedImage = (
        await runCommand(
          "docker",
          ["image", "inspect", "--format", "{{.Id}}", image],
          { capture: true },
        )
      ).stdout.trim();
      if (value.id !== ownedContainerId)
        throw new Error("Owned PostgreSQL container identity changed.");
      return requirePrismaTargetBinding(value, {
        image,
        imageId: expectedImage,
        volume: volumeName,
        port: databasePort,
      });
    } catch {
      throw new Error(
        "Native PostgreSQL execution requires the exact running owned container, image, loopback port and data-volume binding; no fallback was attempted.",
      );
    }
  },
});
const verifyMigrationLedger = migrationRuntime.verifyLedger;

const restoreBaselineRows = async ({
  baseline,
  paths,
  manifest,
}: ActiveRuntimeInput): Promise<void> =>
  runOwnedRestore({
    args: postgresqlPsqlArguments({
      containerName,
      database,
      databaseUser,
      purpose: "restore",
    }),
    cwd: repositoryRoot,
    environment: createCleanProcessEnvironment({
      overrides: runtimeDockerEnvironment(),
    }),
    input: (signal) =>
      (async function* () {
        yield buildRestoreSqlPrefix();
        const copy = await restoreCopyChunks({
          artifactRoot,
          dataPath: paths.dataPath,
          generationId: baseline.generationId,
          sourceSha256: baseline.files["sanitized-data.ndjson"]!.sha256,
          sanitizationPolicySha256: baseline.sanitizationPolicySha256,
          target: "postgresql",
          ...(config.resources.restoreCache
            ? { policy: config.resources.restoreCache }
            : {}),
          signal,
        });
        for await (const chunk of copy.chunks) {
          signal.throwIfAborted();
          yield chunk;
        }
        console.log(`COPY encoding cache: ${copy.state}.`);
        yield buildRestoreSqlSuffix({
          manifest,
          tableCounts: baseline.tableCounts,
          restoreSupabaseAuth: false,
        });
      })(),
  });

const prepareProjectPrerequisites = async () => {
  if (runtimePolicy) {
    await runPsql(buildRuntimePrerequisiteSql(runtimePolicy));
    console.log("Applied reviewed runtime prerequisites.");
  }
};

const prepareProjectSchema = ({
  baseline,
  environment,
}: {
  baseline: BaselineManifest;
  environment: DatabaseEnvironment;
}): void => {
  if (!runtimeAdapter?.prepareSchema) return;
  const preparation = runtimeAdapter.prepareSchema({
    baseline,
    environment,
    runSql: runAdapterPsql,
  });
  if (!preparation || typeof preparation.message !== "string") {
    throw new Error(
      "The project runtime adapter returned an invalid schema preparation result.",
    );
  }
  console.log(preparation.message);
};

const finalizeProjectSchema = async () => {
  if (!runtimePolicy || runtimePolicy.triggers.length === 0) return;
  await runPsql(buildRuntimePostSchemaSql(runtimePolicy));
  console.log("Applied reviewed post-schema triggers.");
};

const finalizeProjectRuntime = async () => {
  if (!runtimePolicy || runtimePolicy.localRows.length === 0) return;
  await runPsql(buildRuntimeFinalizationSql(runtimePolicy));
  console.log("Applied reviewed local-only recipes.");
};

const configureProjectRuntime = ({
  baseline,
  environment,
}: {
  baseline: BaselineManifest;
  environment: DatabaseEnvironment;
}): ProjectRuntimeResult => {
  if (!runtimeAdapter?.configureRuntime) {
    return {
      environmentVariables: {},
      message: "Project-neutral PostgreSQL runtime is configured.",
    };
  }
  const result = runtimeAdapter.configureRuntime({
    baseline,
    environment,
    runSql: runAdapterPsql,
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
}: {
  baseline: BaselineManifest;
  environment: DatabaseEnvironment;
  projectRuntime: ProjectRuntimeResult;
}): Promise<void> => {
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

const readActive = (expectedBaseline?: BaselineManifest) =>
  readActiveRuntimeInput({
    artifactRoot,
    manifestPath,
    validate: async ({ baseline, manifest }) => {
      if (expectedBaseline)
        assertActiveBaselineUnchanged(expectedBaseline, baseline);
      if (
        Boolean(baseline.nativeMigrations) !==
        Boolean(postgresqlConfig.migrationTool)
      )
        throw new Error(
          "Baseline and configured migration tool differ; no runtime change was made.",
        );
      if (postgresqlConfig.migrationTool)
        await migrationRuntime.validateHistory(baseline);
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
    },
  });

const createContainer = async (password: string): Promise<void> => {
  if (!(await commandSucceeds("docker", ["image", "inspect", image]))) {
    throw new Error(
      `The configured local PostgreSQL image is unavailable: ${image}. Pull it explicitly, review it, then retry.`,
    );
  }
  await runCommand(
    "docker",
    ["volume", "create", "--label", label, volumeName],
    {
      capture: true,
    },
  );
  assertPostgresqlStartupResult(
    await runCommand(
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
      { capture: true, allowFailure: true, purpose: "startup" },
    ),
  );
  await waitForDatabase();
};

const retainedContainerLifecycle = createPostgresqlContainerLifecycle({
  cwd: repositoryRoot,
  runtimeWorkdir,
  markerPath: runtimeMarkerPath,
  projectId,
  image,
  port: databasePort,
  user: databaseUser,
  database,
});

const resetRuntime = async (expectedBaseline?: BaselineManifest) => {
  const active = await readActive(expectedBaseline);
  if (postgresqlConfig.migrationTool)
    await migrationRuntime.prepareMutation(active.baseline);
  if (postgresqlConfig.migrationTool)
    await assertNativeBaselineManifestUnchanged({
      artifactRoot,
      expected: active.baseline,
    });
  // Reset may initialize only the explicitly approved runtime, after input validation.
  // Discard/status retain their observation-only, unavailable-engine behavior.
  assertDocker();
  await removeRuntime();
  await mkdir(runtimeWorkdir, { recursive: true, mode: 0o700 });
  return withOwnedRuntimeRollback({
    operation: async function resetRuntimeOperation() {
      const password = randomBytes(24).toString("hex");
      await createContainer(password);
      const environment = databaseEnvironment(password);
      await prepareProjectPrerequisites();
      await migrationRuntime.initialize();
      await migrationRuntime.restore(
        active.baseline,
        active.paths.migrationsDirectory,
        environment.databaseUrl,
      );
      prepareProjectSchema({ baseline: active.baseline, environment });
      await finalizeProjectSchema();
      await restoreBaselineRows({ ...active });
      await finalizeProjectRuntime();
      const projectRuntime = configureProjectRuntime({
        baseline: active.baseline,
        environment,
      });
      await writeRuntimeEnvironment({
        baseline: active.baseline,
        environment,
        projectRuntime,
      });
      await writeRuntimeMarker({
        path: runtimeMarkerPath,
        marker: {
          formatVersion: 1,
          target: "postgresql",
          generationId: active.baseline.generationId,
          dataSha256: active.baseline.files["sanitized-data.ndjson"]!.sha256,
          image,
          databasePassword: password,
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

const startRuntime = async (expectedBaseline?: BaselineManifest) => {
  const { baseline } = await readActive(expectedBaseline);
  if (
    postgresqlConfig.migrationTool &&
    (await pathExists(join(runtimeWorkdir, "native-migration-failure.json")))
  )
    throw new Error(
      "The native migration failed or was interrupted. Its volume and failure receipt are preserved. Review the failure, then explicitly reset the disposable target from its immutable baseline; automatic retry is refused.",
    );
  if (!(await pathExists(runtimeMarkerPath))) return resetRuntime(baseline);
  const mismatchMessage =
    "The local Rehearsal runtime does not match the active baseline; reset it before continuing.";
  const marker = await readMatchingRuntimeMarker({
    path: runtimeMarkerPath,
    expected: {
      target: "postgresql",
      generationId: baseline.generationId,
      dataSha256: baseline.files["sanitized-data.ndjson"]!.sha256,
      image,
    },
    mismatchMessage,
  });
  if (
    typeof marker.databasePassword !== "string" ||
    marker.databasePassword.length < 32
  )
    throw new Error(mismatchMessage);
  await retainedContainerLifecycle.resumeIfMissing(marker);
  if (
    !(await commandSucceeds("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]))
  ) {
    throw new Error("The disposable PostgreSQL container cannot be inspected.");
  }
  const running = (
    await runCommand(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerName],
      { capture: true },
    )
  ).stdout.trim();
  if (running !== "true") {
    assertPostgresqlStartupResult(
      await runCommand("docker", ["start", containerName], {
        capture: true,
        allowFailure: true,
        purpose: "startup",
      }),
    );
  }
  await waitForDatabase();
  const environment = databaseEnvironment(marker.databasePassword);
  const projectRuntime = configureProjectRuntime({ baseline, environment });
  await writeRuntimeEnvironment({ baseline, environment, projectRuntime });
  return environment;
};

const readCandidateReceipt = migrationRuntime.plan;

const verifyRuntime = async () => {
  const { baseline } = await readActive();
  const environment = await startRuntime(baseline);
  const receipt = await readCandidateReceipt(baseline);
  const migrationVerification = await verifyMigrationLedger({
    currentFiles: receipt.currentFiles,
    baseline,
  });
  let projectVerification;
  if (runtimePolicy) await runPsql(buildRuntimeVerificationSql(runtimePolicy));
  if (runtimeAdapter?.verifyRuntime) {
    projectVerification = runtimeAdapter.verifyRuntime({
      baseline,
      environment,
      runSql: runAdapterPsql,
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
  const receipt = await migrationRuntime.prepareMutation(baseline, (receipt) =>
    assertCandidateConfirmation({
      plan: receipt,
      confirmation: invocation.confirmation,
    }),
  );
  const environment = await startRuntime(baseline);
  await verifyMigrationLedger({ currentFiles: receipt.currentFiles, baseline });
  return withOwnedRuntimeRollback({
    operation: async function migrateRuntimeOperation() {
      await migrationRuntime.apply(baseline, receipt, environment.databaseUrl);
      const verification = await verifyMigrationLedger({
        currentFiles: receipt.currentFiles,
        baseline,
      });
      if (verification.appliedCandidateCount !== receipt.candidates.length) {
        throw new Error(
          "Applied PostgreSQL migration history does not match the confirmed candidate suffix.",
        );
      }
      await writeCandidateMigrationReceipt({
        path: runtimeCandidateReceiptPath,
        target: "postgresql",
        baseline,
        plan: receipt,
      });
      console.log(
        receipt.candidates.length
          ? `Applied ${formatCount(receipt.candidates.length, "confirmed candidate migration")} to the disposable PostgreSQL runtime.`
          : `No candidate migrations follow baseline ${describeMigrationCutoff(baseline.migrationCutoff)}.`,
      );
      return receipt;
    },
    rollback: postgresqlConfig.migrationTool
      ? async () => {
          try {
            await writeFile(
              join(runtimeWorkdir, "native-migration-failure.json"),
              `${JSON.stringify({ schemaVersion: 1, state: "failed_or_interrupted", baselineGenerationId: baseline.generationId, candidateSha256: receipt.candidateSha256, migrationTool: receipt.nativeMigrations, recovery: "retained-volume-review-required" })}\n`,
              { mode: 0o600, flag: "wx" },
            );
          } finally {
            await retainedContainerLifecycle.retireStopped();
          }
        }
      : removeRuntime,
  });
};

await runRuntimeLifecycle({
  action,
  protected: config.runtime.protected,
  operations: {
    reset: resetRuntime,
    start: async () => {
      const environment = await startRuntime();
      console.log(
        `Local Rehearsal PostgreSQL: ${environment.host}:${environment.port}/${environment.database}`,
      );
    },
    status: async () => {
      const baseline = await verifyActiveBaseline({ artifactRoot });
      const receipt = await readCandidateReceipt(baseline);
      emitRuntimeStatusSnapshot({
        structured: invocation.structuredResult,
        status: await inspectPostgresqlRuntimeStatus({
          runCommand,
          containerName,
          databaseUser,
          database,
          databasePort,
          projectId,
          runtimeMarkerPath,
          baselineDataSha256: baseline.files["sanitized-data.ndjson"]!.sha256,
          image,
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
    stop: retainedContainerLifecycle.retireStopped,
    discard: removeRuntime,
  },
});
