/**
 * Prove the packed public CLI against an independent plain PostgreSQL project.
 * The proof uses only disposable local Docker resources.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { removeBaselineArtifactRoot } from "../../../dist/src/baseline/artifact.mjs";
import { findAvailableRehearsalPorts } from "../../../dist/src/project/setup.mjs";
import {
  openApplicationSession,
  openApplicationTerminalSession,
} from "../scenarios/application_session.mjs";
import {
  installCandidateArtifact,
  prepareCandidateArtifact,
} from "../scenarios/artifact.mjs";
import {
  executeInstalledCli,
  runScenarioCommand,
} from "../scenarios/process.mjs";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureSource = join(repositoryRoot, "tests/fixtures/postgresql-project");

const run = runScenarioCommand;
const executeCli = executeInstalledCli;

const executeCliOrThrow = ({ cwd, args, label }) => {
  const result = executeCli({ cwd, args });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.stdout || result.stderr || `exit ${result.status}`}`,
    );
  }
  return result;
};

const main = async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "rehearsal-postgresql-proof-"),
  );
  const cwd = join(temporaryRoot, "project");
  const packageOutput = join(temporaryRoot, "packed");
  let installed = false;
  try {
    await cp(fixtureSource, cwd, { recursive: true });
    await mkdir(packageOutput, { recursive: true });
    const ports = await findAvailableRehearsalPorts();
    const projectId = `rehearsal-postgresql-${process.pid}`;
    const configPath = join(cwd, "rehearsal.config.mjs");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8"))
        .replaceAll("rehearsal-postgresql-fixture", projectId)
        .replace("databasePort: 59422", `databasePort: ${ports.database}`)
        .replace(
          `  application: {
    startCommand: "npm run dev",
    proofCommand: "npm run proof",
  },`,
          `  application: {
    startCommand: "node app.mjs ${ports.api}",
    proofCommand: "npm run proof",
    readiness: {
      url: "http://localhost:${ports.api}",
      expectedStatus: 200,
      timeoutSeconds: 10,
    },
  },`,
        )
        .replaceAll("5275", String(ports.api)),
    );

    const artifact = await prepareCandidateArtifact({
      repositoryRoot,
      outputDirectory: packageOutput,
    });
    installCandidateArtifact(cwd, artifact);
    installed = true;

    const fixtureConfig = await readFile(configPath);
    await rm(configPath);
    const setupPreview = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "PostgreSQL setup preview",
        args: ["setup", "--target=postgresql", "--json"],
      }).stdout,
    );
    if (
      setupPreview.data?.mode !== "preview" ||
      setupPreview.data?.target !== "postgresql"
    ) {
      throw new Error("PostgreSQL setup preview selected the wrong target.");
    }
    await stat(configPath)
      .then(() => {
        throw new Error("PostgreSQL setup preview unexpectedly wrote config.");
      })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    const setupWrite = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "PostgreSQL setup write",
        args: ["setup", "--target=postgresql", "--write", "--json"],
      }).stdout,
    );
    if (
      setupWrite.data?.mode !== "written" ||
      setupWrite.data?.target !== "postgresql" ||
      !(await readFile(configPath, "utf8")).includes('target: "postgresql"')
    ) {
      throw new Error("PostgreSQL setup did not create its previewed config.");
    }
    await writeFile(configPath, fixtureConfig);

    const baseline = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "baseline create",
        args: [
          "baseline",
          "create",
          "--records=rehearsal/sanitized-data.ndjson",
          "--ledger=rehearsal/migration-ledger.json",
          "--json",
        ],
      }).stdout,
    );
    if (
      baseline.data?.rowCount !== 2 ||
      baseline.data?.tableCount !== 2 ||
      baseline.data?.migrationCount !== 1
    ) {
      throw new Error("The PostgreSQL baseline reported unexpected counts.");
    }
    const doctor = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "doctor",
        args: ["doctor", "--json"],
      }).stdout,
    );
    if (doctor.data?.state !== "READY") {
      throw new Error(
        `The PostgreSQL fixture is not ready: ${doctor.data?.state}`,
      );
    }
    const plan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "explain",
        args: ["explain", "--json"],
      }).stdout,
    ).data;
    if (plan.environment?.target !== "postgresql") {
      throw new Error("The plan did not select PostgreSQL.");
    }
    const runResult = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "run",
        args: [
          "run",
          `--confirm-candidates=${plan.migrations.candidateSha256}`,
          "--json",
          "--debug",
        ],
      }).stdout,
    ).data;
    if (
      runResult.lifecycle?.mode !== "stop-after-run" ||
      runResult.lifecycle?.runtimeState !== "stopped" ||
      runResult.lifecycle?.dataState !== "preserved"
    ) {
      throw new Error(
        "The packed run command did not apply bounded persistence.",
      );
    }
    const environment = await readFile(
      join(cwd, ".rehearsal/runtime.env"),
      "utf8",
    );
    if (
      !environment.includes("DATABASE_URL=postgresql://postgres:") ||
      !environment.includes(
        `@127.0.0.1:${ports.database}/postgres?sslmode=disable`,
      ) ||
      !/^PGPASSWORD=[a-f0-9]{48}$/mu.test(environment)
    ) {
      throw new Error(
        "The PostgreSQL runtime environment is missing or unsafe.",
      );
    }
    const applicationUrl = `http://localhost:${ports.api}`;
    const firstOpenOutput = await openApplicationSession({
      cwd,
      url: applicationUrl,
      whileReady: async () => {
        const activity = JSON.parse(
          executeCliOrThrow({
            cwd,
            args: ["activity", "--json"],
            label: "busy operation activity",
          }).stdout,
        ).data;
        if (
          activity.state !== "busy" ||
          activity.operation?.kind !== "open" ||
          !activity.operation?.startedAt ||
          !activity.operation?.rehearsalVersion ||
          "pid" in activity.operation
        ) {
          throw new Error("Activity omitted its safe structured busy state.");
        }
        const container = run(
          "docker",
          [
            "ps",
            "--filter",
            `label=com.rehearsal-db.project=${projectId}`,
            "--format",
            "{{.Names}}",
          ],
          { cwd },
        ).trim();
        run(
          "docker",
          [
            "exec",
            container,
            "psql",
            "--username",
            "postgres",
            "--dbname",
            "postgres",
            "--command",
            "update public.widgets set name = 'Persisted sandbox edit' where id = 1;",
          ],
          { cwd },
        );
      },
    });
    if (
      !firstOpenOutput.includes(
        "Lifecycle stop-on-application-exit stopped the database runtime",
      )
    ) {
      throw new Error(
        "The packed open command omitted its bounded lifecycle receipt.",
      );
    }
    const runningAfterFirstOpen = run(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.rehearsal-db.project=${projectId}`,
        "--format",
        "{{.Names}}",
      ],
      { cwd },
    ).trim();
    if (runningAfterFirstOpen) {
      throw new Error(
        "The PostgreSQL target remained running after bounded open.",
      );
    }
    const idleActivity = JSON.parse(
      executeCliOrThrow({
        cwd,
        args: ["activity", "--json"],
        label: "idle operation activity",
      }).stdout,
    ).data;
    if (idleActivity.state !== "idle" || idleActivity.operation !== null) {
      throw new Error(
        "Activity did not return to idle after application exit.",
      );
    }
    const terminalOpenOutput = await openApplicationTerminalSession({
      cwd,
      url: applicationUrl,
    });
    if (
      !terminalOpenOutput.includes(
        "Lifecycle stop-on-application-exit stopped the database runtime",
      )
    ) {
      throw new Error("Terminal open omitted its bounded lifecycle receipt.");
    }
    executeCliOrThrow({
      cwd,
      label: "resume after bounded open",
      args: ["start", "--json"],
    });
    const container = run(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.rehearsal-db.project=${projectId}`,
        "--format",
        "{{.Names}}",
      ],
      { cwd },
    ).trim();
    const preservedName = run(
      "docker",
      [
        "exec",
        container,
        "psql",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        "select name from public.widgets where id = 1;",
      ],
      { cwd },
    ).trim();
    if (preservedName !== "Persisted sandbox edit") {
      throw new Error(
        "Persistent application restart discarded a runtime edit.",
      );
    }
    for (const [label, args] of [
      ["verify", ["verify", "--json"]],
      ["reset", ["reset", "--json"]],
      ["stop", ["stop", "--json"]],
      ["start", ["start", "--json"]],
    ]) {
      executeCliOrThrow({ cwd, label, args });
    }
    const slowMigrationPath = join(
      cwd,
      "database/migrations/20260101000200_slow_candidate.sql",
    );
    await writeFile(slowMigrationPath, "select pg_sleep(30);\n");
    const cancellationPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "cancellation plan",
        args: ["explain", "--json"],
      }).stdout,
    ).data;
    const cancellationChild = spawn(
      join(cwd, "node_modules/.bin/rehearsal"),
      [
        "migrate",
        `--confirm-candidates=${cancellationPlan.migrations.candidateSha256}`,
        "--json",
      ],
      {
        cwd,
        env: createCleanProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let cancellationStdout = "";
    let cancellationStderr = "";
    cancellationChild.stdout.on("data", (chunk) => {
      cancellationStdout += chunk;
    });
    cancellationChild.stderr.on("data", (chunk) => {
      cancellationStderr += chunk;
    });
    const cancellationExit = new Promise((resolve) =>
      cancellationChild.once("exit", (status, signal) =>
        resolve({ status, signal }),
      ),
    );
    let migrationObserved = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (cancellationChild.exitCode !== null) break;
      const activity = JSON.parse(
        executeCliOrThrow({
          cwd,
          args: ["activity", "--json"],
          label: "cancellable migration activity",
        }).stdout,
      ).data;
      if (activity.state === "busy" && activity.operation?.kind === "migrate") {
        const active = run(
          "docker",
          [
            "exec",
            container,
            "psql",
            "--quiet",
            "--no-align",
            "--tuples-only",
            "--username",
            "postgres",
            "--dbname",
            "postgres",
            "--command",
            "select exists(select 1 from pg_stat_activity where pid <> pg_backend_pid() and state = 'active' and query = 'select pg_sleep(30);');",
          ],
          { cwd },
        ).trim();
        if (active === "t") {
          migrationObserved = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!migrationObserved) {
      cancellationChild.kill("SIGTERM");
      await cancellationExit;
      throw new Error(
        `The cancellable migration did not reach its controlled wait: ${cancellationStdout || cancellationStderr}`,
      );
    }
    const cancellationRequestedAt = performance.now();
    cancellationChild.kill("SIGINT");
    cancellationChild.kill("SIGINT");
    const cancelled = await cancellationExit;
    const cancellationLatencyMs = performance.now() - cancellationRequestedAt;
    if (cancelled.status !== 130 || cancellationLatencyMs > 10_000) {
      throw new Error(
        `The cancellable migration exited ${cancelled.status ?? cancelled.signal} after ${Math.round(cancellationLatencyMs)}ms: ${cancellationStdout || cancellationStderr}`,
      );
    }
    const cancellationFailure = JSON.parse(cancellationStdout).error;
    if (
      cancellationFailure?.category !== "operation_cancelled" ||
      cancellationFailure?.code !== "OPERATION_CANCELLED" ||
      cancellationFailure?.context?.signal !== "SIGINT"
    ) {
      throw new Error(
        `The migration returned an invalid cancellation envelope: ${cancellationStdout}`,
      );
    }
    const afterCancellation = JSON.parse(
      executeCliOrThrow({
        cwd,
        args: ["activity", "--json"],
        label: "post-cancellation activity",
      }).stdout,
    ).data;
    if (afterCancellation.state !== "idle") {
      throw new Error(
        "The cancelled migration did not release its operation lock.",
      );
    }
    const cancelledContainers = run(
      "docker",
      [
        "ps",
        "--all",
        "--filter",
        `label=com.rehearsal-db.project=${projectId}`,
        "--format",
        "{{.Names}}",
      ],
      { cwd },
    ).trim();
    if (cancelledContainers) {
      throw new Error(
        `The cancelled migration left an unverified runtime behind: ${cancelledContainers}`,
      );
    }
    await rm(slowMigrationPath);
    const cleanupPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "cleanup",
        args: ["cleanup", "--include-runtime", "--json"],
      }).stdout,
    ).data.plan;
    executeCliOrThrow({
      cwd,
      label: "cleanup apply",
      args: [
        "cleanup",
        "--include-runtime",
        "--write",
        `--confirm-cleanup=${cleanupPlan.digest}`,
        "--json",
      ],
    });
    executeCliOrThrow({ cwd, label: "discard", args: ["discard", "--json"] });

    await cp(
      join(cwd, "broken/20260101000200_invalid_candidate.sql"),
      join(cwd, "database/migrations/20260101000200_invalid_candidate.sql"),
    );
    const invalidPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "invalid explain",
        args: ["explain", "--json"],
      }).stdout,
    ).data;
    const invalid = executeCli({
      cwd,
      args: [
        "run",
        `--confirm-candidates=${invalidPlan.migrations.candidateSha256}`,
        "--json",
      ],
    });
    if (invalid.status === 0) {
      throw new Error("The invalid PostgreSQL migration unexpectedly passed.");
    }
    if (
      JSON.parse(invalid.stdout).error?.category !==
      "migration_candidate_failure"
    ) {
      throw new Error(
        `The invalid PostgreSQL migration used the wrong failure category: ${invalid.stdout || invalid.stderr}`,
      );
    }
    const remainingContainers = run(
      "docker",
      [
        "ps",
        "--all",
        "--filter",
        `label=com.rehearsal-db.project=${projectId}`,
        "--format",
        "{{.Names}}",
      ],
      { cwd },
    ).trim();
    const remainingVolumes = run(
      "docker",
      [
        "volume",
        "ls",
        "--filter",
        `label=com.rehearsal-db.project=${projectId}`,
        "--format",
        "{{.Name}}",
      ],
      { cwd },
    ).trim();
    if (remainingContainers || remainingVolumes) {
      throw new Error(
        "The failed PostgreSQL runtime left disposable Docker resources behind.",
      );
    }

    console.log(
      JSON.stringify(
        {
          status: "passed",
          fixture: "postgresql-project",
          installedPackage: `${artifact.name}@${artifact.version}`,
          artifactSha256: artifact.sha256,
          artifactSource: artifact.source,
          target: "postgresql",
          validCandidate: "20260101000100_add_widget_description.sql",
          invalidCandidate: "20260101000200_invalid_candidate.sql",
        },
        null,
        2,
      ),
    );
  } finally {
    if (installed) executeCli({ cwd, args: ["discard"] });
    await removeBaselineArtifactRoot({
      artifactRoot: join(cwd, ".rehearsal"),
    }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

await main();
