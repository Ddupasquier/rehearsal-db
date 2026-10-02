/**
 * Prove the packed public CLI against an independent plain PostgreSQL project.
 * The proof uses only disposable local Docker resources.
 */

import { spawnSync } from "node:child_process";
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
import { removeBaselineArtifactRoot } from "../../lib/rehearsal/baseline_artifact.mjs";
import { createCleanProcessEnvironment } from "../../lib/rehearsal/process_environment.mjs";
import { findAvailableRehearsalPorts } from "../../lib/rehearsal/setup.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureSource = join(repositoryRoot, "tests/fixtures/postgresql-project");

const run = (command, args, { cwd, input } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        result.error?.message ||
        `${command} failed.`,
    );
  }
  return result.stdout;
};

const executeCli = ({ cwd, args }) =>
  spawnSync(join(cwd, "node_modules/.bin/rehearsal"), args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });

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
        .replace("databasePort: 59422", `databasePort: ${ports.database}`),
    );

    const packed = JSON.parse(
      run(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          packageOutput,
        ],
        { cwd: repositoryRoot },
      ),
    )[0];
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        join(packageOutput, packed.filename),
      ],
      { cwd },
    );
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
    if (baseline.data?.rowCount !== 1 || baseline.data?.migrationCount !== 1) {
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
    executeCliOrThrow({
      cwd,
      label: "run",
      args: [
        "run",
        `--confirm-candidates=${plan.migrations.candidateSha256}`,
        "--json",
        "--debug",
      ],
    });
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
    for (const [label, args] of [
      ["verify", ["verify", "--json"]],
      ["reset", ["reset", "--json"]],
      ["stop", ["stop", "--json"]],
      ["start", ["start", "--json"]],
      ["discard", ["discard", "--json"]],
    ]) {
      executeCliOrThrow({ cwd, label, args });
    }

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
          installedPackage: `${packed.name}@${packed.version}`,
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
