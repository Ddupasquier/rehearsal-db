/**
 * Prove the packed public CLI against an independent plain PostgreSQL project.
 * The proof uses only disposable local Docker resources.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  assertDemoObservation,
  demoObservationSql,
} from "../../../tests/fixtures/postgresql-project/demo/contract.mjs";
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

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const immutableBaselineFingerprint = async (cwd) => {
  const root = join(cwd, ".rehearsal");
  const current = await readlink(join(root, "current"));
  if (!/^generations\/\d{8}T\d{6}Z-[a-f0-9]{12}$/u.test(current)) {
    throw new Error(
      "The demo baseline has an unexpected active-generation path.",
    );
  }
  const files = [];
  const visit = async (relative) => {
    for (const entry of await readdir(join(root, current, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(join(root, current, path));
        if (files.length >= 64 || bytes.length > 256 * 1024) {
          throw new Error(
            "The synthetic baseline exceeded its bounded evidence size.",
          );
        }
        files.push([path, sha256(bytes)]);
      } else
        throw new Error("The demo baseline contains an unexpected file type.");
    }
  };
  await visit("");
  return JSON.stringify({
    current,
    files: files.sort(([a], [b]) => a.localeCompare(b)),
  });
};

const ownedDemoContainers = (cwd, projectId) =>
  run(
    "docker",
    [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=com.rehearsal-db.project=${projectId}`,
      "--format",
      "{{.ID}}",
    ],
    { cwd },
  ).trim();

const assertDemoResourcesRemoved = (cwd, projectId) => {
  if (
    ownedDemoContainers(cwd, projectId) ||
    run(
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
    ).trim()
  )
    throw new Error("The data-shaped demo left owned Docker resources behind.");
};

const physicalDemoObservation = (cwd, projectId, expectations) => {
  const container = ownedDemoContainers(cwd, projectId);
  if (!/^[a-f0-9]{64}$/u.test(container)) {
    throw new Error("The data-shaped demo needs one exact owned container.");
  }
  return assertDemoObservation(
    JSON.parse(
      run(
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
          demoObservationSql,
        ],
        { cwd },
      ).trim(),
    ),
    expectations,
  );
};

const runDataSpecificMigrationDemo = async ({
  artifact,
  temporaryRoot,
  originalCwd,
  ports,
  projectId,
}) => {
  const originalBaseline = await immutableBaselineFingerprint(originalCwd);
  const originalInputs = await Promise.all(
    [
      "database/migrations/20260101000000_create_widgets.sql",
      "database/migrations/20260101000100_add_widget_description.sql",
      "rehearsal/migration-ledger.json",
      "rehearsal/sanitized-data.ndjson",
      "rehearsal/sanitization-policy.json",
    ].map(async (path) => [
      path,
      sha256(await readFile(join(fixtureSource, path))),
    ]),
  );
  const unrelatedContainers = run(
    "docker",
    ["ps", "--all", "--no-trunc", "--format", "{{.ID}}|{{.Names}}|{{.State}}"],
    { cwd: originalCwd },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const unrelatedVolumes = run(
    "docker",
    ["volume", "ls", "--format", "{{.Name}}"],
    { cwd: originalCwd },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const invalidBytes = await readFile(
    join(fixtureSource, "demo/require-description.sql"),
  );
  const correctedBytes = await readFile(
    join(fixtureSource, "demo/backfill-and-require-description.sql"),
  );
  const projects = [];
  const observations = [];
  let reviewedDigest;
  let correctedDigest;
  let operationFailure;
  try {
    for (const [name, expectedRows] of [
      ["empty", 0],
      ["populated", 1],
    ]) {
      const cwd = join(temporaryRoot, `data-demo-${name}`);
      const id = `${projectId}-demo-${name}`;
      await cp(fixtureSource, cwd, { recursive: true });
      projects.push({ cwd, projectId: id, installed: false });
      const configPath = join(cwd, "rehearsal.config.mjs");
      const config = (await readFile(configPath, "utf8"))
        .replaceAll("rehearsal-postgresql-fixture", id)
        .replace("databasePort: 59422", `databasePort: ${ports.database}`)
        .replace(
          `  application: {\n    startCommand: "npm run dev",\n    proofCommand: "npm run proof",\n  },`,
          `  lifecycle: { run: "stop-after-run", open: "stop-on-application-exit" },\n  application: {\n    startCommand: "node demo/app.mjs ${ports.api}",\n    proofCommand: "node demo/proof.mjs ${expectedRows} nullable",\n    readiness: { url: "http://localhost:${ports.api}/health", expectedStatus: 200, timeoutSeconds: 10 },\n  },`,
        )
        .replaceAll("5275", String(ports.api));
      await writeFile(configPath, config);
      if (name === "empty")
        await cp(
          join(cwd, "demo/empty-control.ndjson"),
          join(cwd, "rehearsal/sanitized-data.ndjson"),
        );
      installCandidateArtifact(cwd, artifact);
      projects.at(-1).installed = true;
      const cli = (args, label) =>
        JSON.parse(executeCliOrThrow({ cwd, args, label }).stdout).data;
      const baseline = cli(
        [
          "baseline",
          "create",
          "--records=rehearsal/sanitized-data.ndjson",
          "--ledger=rehearsal/migration-ledger.json",
          "--json",
        ],
        `${name} demo baseline`,
      );
      if (baseline.rowCount !== expectedRows + 1)
        throw new Error("The demo baseline has the wrong synthetic row count.");
      const immutable = await immutableBaselineFingerprint(cwd);
      const initial = cli(["explain", "--json"], `${name} nullable plan`);
      const initialRun = cli(
        [
          "run",
          `--confirm-candidates=${initial.migrations.candidateSha256}`,
          "--json",
        ],
        `${name} nullable run`,
      );
      if (
        !initialRun.applicationProof?.output?.includes(
          "Data-shaped PostgreSQL application proof passed.",
        )
      )
        throw new Error("The demo omitted its ordinary application proof.");
      cli(["start", "--json"], `${name} precondition start`);
      physicalDemoObservation(cwd, id, {
        expectedRows,
        descriptionRequired: false,
      });
      const candidatePath = join(
        cwd,
        "database/migrations/20260101000200_require_widget_description.sql",
      );
      await writeFile(candidatePath, invalidBytes);
      await writeFile(
        configPath,
        config.replace(
          `node demo/proof.mjs ${expectedRows} nullable`,
          `node demo/proof.mjs ${expectedRows} required`,
        ),
      );
      const plan = cli(["explain", "--json"], `${name} data-specific plan`);
      const candidate = plan.migrations.candidates.find(
        (entry) =>
          entry.filename === "20260101000200_require_widget_description.sql",
      );
      if (
        candidate?.sha256 !== sha256(invalidBytes) ||
        !/^[a-f0-9]{64}$/u.test(plan.migrations.candidateSha256)
      )
        throw new Error(
          "The data-specific candidate was not reviewed as exact bytes.",
        );
      if (reviewedDigest && reviewedDigest !== plan.migrations.candidateSha256)
        throw new Error(
          "The empty and populated controls did not review the same candidate set.",
        );
      reviewedDigest = plan.migrations.candidateSha256;
      const result = executeCli({
        cwd,
        args: ["migrate", `--confirm-candidates=${reviewedDigest}`, "--json"],
      });
      if (name === "empty") {
        if (result.status !== 0)
          throw new Error(
            "The identical constraint migration did not pass on the empty control.",
          );
        physicalDemoObservation(cwd, id, {
          expectedRows,
          descriptionRequired: true,
        });
        cli(["verify", "--json"], "empty control verify");
        cli(["stop", "--json"], "empty control bounded stop");
      } else {
        if (
          result.status === 0 ||
          JSON.parse(result.stdout).error?.category !==
            "migration_candidate_failure"
        )
          throw new Error(
            "The null-bearing control did not fail with the safe migration category.",
          );
        if (
          /null value in column|contains null values|alter table public\.widgets/iu.test(
            `${result.stdout}\n${result.stderr}`,
          )
        )
          throw new Error(
            "The failed demo exposed raw provider SQL or output.",
          );
        assertDemoResourcesRemoved(cwd, id);
        await writeFile(candidatePath, correctedBytes);
        const corrected = cli(
          ["explain", "--json"],
          "corrected forward candidate plan",
        );
        if (
          corrected.migrations.candidateSha256 === reviewedDigest ||
          corrected.migrations.candidates.find(
            (entry) =>
              entry.filename ===
              "20260101000200_require_widget_description.sql",
          )?.sha256 !== sha256(correctedBytes)
        )
          throw new Error(
            "The correction did not require review of changed candidate bytes.",
          );
        correctedDigest = corrected.migrations.candidateSha256;
        const correctedRun = cli(
          [
            "run",
            `--confirm-candidates=${corrected.migrations.candidateSha256}`,
            "--json",
          ],
          "corrected data-shaped run",
        );
        if (
          !correctedRun.applicationProof?.output?.includes(
            "Data-shaped PostgreSQL application proof passed.",
          )
        )
          throw new Error(
            "The corrected rehearsal did not pass the ordinary HTTP application proof.",
          );
        cli(["start", "--json"], "corrected physical inspection start");
        physicalDemoObservation(cwd, id, {
          expectedRows,
          descriptionRequired: true,
        });
        cli(["verify", "--json"], "corrected runtime verify");
        cli(["stop", "--json"], "corrected bounded stop");
      }
      if ((await immutableBaselineFingerprint(cwd)) !== immutable)
        throw new Error(
          "The data-specific demo changed its immutable baseline.",
        );
      observations.push({
        control: name,
        rows: expectedRows,
        knownNullsBefore: expectedRows,
        outcome: name === "empty" ? "passed" : "migration_candidate_failure",
      });
    }
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const project of projects) {
      if (!project.installed) continue;
      try {
        executeCliOrThrow({
          cwd: project.cwd,
          args: ["discard", "--json"],
          label: "data-specific owned discard",
        });
        assertDemoResourcesRemoved(project.cwd, project.projectId);
        await removeBaselineArtifactRoot({
          artifactRoot: join(project.cwd, ".rehearsal"),
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        operationFailure ? [operationFailure, ...cleanupErrors] : cleanupErrors,
        "The data-specific demo could not confirm cleanup of its owned resources.",
      );
  }
  if ((await immutableBaselineFingerprint(originalCwd)) !== originalBaseline)
    throw new Error(
      "The data-specific demo changed the original scenario baseline.",
    );
  for (const [path, digest] of originalInputs) {
    if (sha256(await readFile(join(fixtureSource, path))) !== digest)
      throw new Error(
        "The data-specific demo changed original fixture inputs or applied history.",
      );
  }
  const afterContainers = new Set(
    run(
      "docker",
      [
        "ps",
        "--all",
        "--no-trunc",
        "--format",
        "{{.ID}}|{{.Names}}|{{.State}}",
      ],
      { cwd: originalCwd },
    )
      .trim()
      .split("\n"),
  );
  const afterVolumes = new Set(
    run("docker", ["volume", "ls", "--format", "{{.Name}}"], {
      cwd: originalCwd,
    })
      .trim()
      .split("\n"),
  );
  if (
    unrelatedContainers.some((entry) => !afterContainers.has(entry)) ||
    unrelatedVolumes.some((entry) => !afterVolumes.has(entry))
  )
    throw new Error(
      "The data-specific demo did not preserve unrelated Docker resources.",
    );
  return {
    candidateFileSha256: sha256(invalidBytes),
    candidateSetSha256: reviewedDigest,
    correctedCandidateSha256: correctedDigest,
    observations,
    immutableBaselinesPreserved: true,
    unrelatedResourcesPreserved: true,
    cleanup: "passed",
  };
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
          `  lifecycle: {
    run: "stop-after-run",
    open: "stop-on-application-exit",
  },
  application: {
    startCommand: "node app.mjs ${ports.api}",
    proofCommand: "npm run proof",
    readiness: {
      url: "http://localhost:${ports.api}/health",
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

    const dataSpecificMigration = await runDataSpecificMigrationDemo({
      artifact,
      temporaryRoot,
      originalCwd: cwd,
      ports,
      projectId,
    });

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
          dataSpecificMigration,
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
