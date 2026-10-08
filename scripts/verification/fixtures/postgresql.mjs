/**
 * Prove the packed public CLI against an independent plain PostgreSQL project.
 * The proof uses only disposable local Docker resources.
 */

import { spawn as spawnProcess, spawnSync } from "node:child_process";
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
import { spawn as spawnTerminal } from "@lydell/node-pty";
import { removeBaselineArtifactRoot } from "../../../dist/src/baseline/artifact.mjs";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";
import { findAvailableRehearsalPorts } from "../../../dist/src/project/setup.mjs";

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

const openApplicationSession = async ({ cwd, url, whileReady }) => {
  const child = spawnProcess(
    join(cwd, "node_modules/.bin/rehearsal"),
    ["open", "--plain"],
    {
      cwd,
      env: createCleanProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) =>
    child.once("exit", (status, signal) => resolve({ status, signal })),
  );
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && stdout.includes("SANDBOX READY")) {
        ready = true;
        break;
      }
    } catch {
      // The runtime and application are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill("SIGTERM");
    await exit;
    throw new Error(
      `Persistent application did not become ready: ${stdout || stderr || "no output"}`,
    );
  }
  try {
    await whileReady?.();
  } finally {
    child.kill("SIGINT");
  }
  const ended = await exit;
  if (ended.status !== 0) {
    throw new Error(
      `Persistent application session failed: ${stdout || stderr || `exit ${ended.status ?? ended.signal}`}`,
    );
  }
  if (
    !stdout.includes(`Application: ${url}`) ||
    !stdout.includes("Application stopped after SIGINT.") ||
    !stdout.includes("database and Storage changes were preserved")
  ) {
    throw new Error(`Persistent application receipt is invalid: ${stdout}`);
  }
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    throw new Error(
      "Persistent application child remained reachable after exit.",
    );
  } catch (error) {
    if (
      error?.message ===
      "Persistent application child remained reachable after exit."
    ) {
      throw error;
    }
  }
  return stdout;
};

const openApplicationTerminalSession = async ({ cwd, url }) => {
  const terminal = spawnTerminal(
    "npx",
    ["--no-install", "rehearsal", "open", "--plain"],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 40,
      cwd,
      env: createCleanProcessEnvironment(),
    },
  );
  let output = "";
  terminal.onData((chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve) => terminal.onExit(resolve));
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && output.includes("SANDBOX READY")) {
        ready = true;
        break;
      }
    } catch {
      // The runtime and application are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) {
    terminal.kill();
    await exit;
    throw new Error(
      `Persistent terminal application did not become ready: ${output || "no output"}`,
    );
  }
  terminal.write("\u0003");
  let exitTimeout;
  const ended = await Promise.race([
    exit,
    new Promise((_, reject) => {
      exitTimeout = setTimeout(
        () => reject(new Error(`Terminal Ctrl+C timed out: ${output}`)),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(exitTimeout));
  if (ended.exitCode !== 0) {
    throw new Error(
      `Terminal Ctrl+C exited ${ended.exitCode}: ${output || "no output"}`,
    );
  }
  if (
    !output.includes("Application stopped after SIGINT.") ||
    !output.includes("database and Storage changes were preserved")
  ) {
    throw new Error(`Terminal Ctrl+C receipt is invalid: ${output}`);
  }
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    throw new Error(
      "Persistent terminal application child remained reachable after exit.",
    );
  } catch (error) {
    if (
      error?.message ===
      "Persistent terminal application child remained reachable after exit."
    ) {
      throw error;
    }
  }
  return output;
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
    const applicationUrl = `http://localhost:${ports.api}`;
    await openApplicationSession({
      cwd,
      url: applicationUrl,
      whileReady: async () => {
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
    await openApplicationTerminalSession({ cwd, url: applicationUrl });
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
