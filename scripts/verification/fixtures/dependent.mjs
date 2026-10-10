/**
 * Prove one primary and one dependent PostgreSQL runtime from the packed public
 * package. Rehearsal owns Docker lifecycle; fixture scripts own publication and
 * positive/negative business assertions.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAvailableRehearsalPorts } from "../../../dist/src/project/setup.mjs";
import { removeBaselineArtifactRoot } from "../../../dist/src/baseline/artifact.mjs";
import {
  installCandidateArtifact,
  prepareCandidateArtifact,
} from "../scenarios/artifact.mjs";
import {
  executeInstalledCli,
  runScenarioCommand,
} from "../scenarios/process.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureSource = join(repositoryRoot, "tests/fixtures/postgresql-project");

const run = runScenarioCommand;
const executeCli = executeInstalledCli;

const executeCliOrThrow = ({ cwd, args, label }) => {
  const result = executeCli({ cwd, args });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.stdout || result.stderr || result.error?.message}`,
    );
  }
  return JSON.parse(result.stdout).data;
};

const fixtureCommandSource = `
import { spawnSync } from "node:child_process";
import primary from "./rehearsal.config.mjs";
import publication from "./rehearsal.publication.config.mjs";

const containerFor = (projectId) => {
  const result = spawnSync("docker", ["ps", "--filter", \`label=com.rehearsal-db.project=\${projectId}\`, "--format", "{{.Names}}"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr || \`Missing runtime \${projectId}.\`);
  return result.stdout.trim();
};
const query = (container, sql) => spawnSync("docker", ["exec", container, "psql", "--quiet", "--no-align", "--tuples-only", "--set", "ON_ERROR_STOP=1", "--username", "postgres", "--dbname", "postgres", "--command", sql], { encoding: "utf8" });
const primaryContainer = containerFor(primary.runtime.projectId);
const publicationContainer = containerFor(publication.runtime.projectId);

if (process.argv[2] === "prepare") {
  if (!process.env.REHEARSAL_PRIMARY_ENV_FILE || !process.env.REHEARSAL_DEPENDENT_PUBLICATION_ENV_FILE) throw new Error("Rehearsal did not expose the local environment-file paths.");
  const source = query(primaryContainer, "select name from public.widgets where id = 1;");
  if (source.status !== 0 || !source.stdout.trim()) throw new Error(source.stderr || "The synthetic source positive is missing.");
  const value = source.stdout.trim().replaceAll("'", "''");
  const inserted = query(publicationContainer, \`insert into public.widgets (id, name, created_at) values (1, '\${value}', '2026-01-01T00:00:00Z') on conflict (id) do update set name = excluded.name;\`);
  if (inserted.status !== 0) throw new Error(inserted.stderr || "Publication preparation failed.");
  console.log("Synthetic publication prepared.");
} else {
  const proof = query(publicationContainer, "select exists(select 1 from public.widgets where id = 1 and name = 'Synthetic Widget') and exists(select 1 from public.widgets where id = 2) and not exists(select 1 from public.widgets where id = 999) and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'widgets' and column_name = 'description');");
  if (proof.status !== 0 || proof.stdout.trim() !== "t") throw new Error(proof.stderr || "Publication positive/negative proof failed.");
  console.log("Publication positive and negative controls passed.");
}
`;

const main = async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "rehearsal-dependent-proof-"),
  );
  const cwd = join(temporaryRoot, "project");
  const packageOutput = join(temporaryRoot, "packed");
  let installed = false;
  let primaryProjectId;
  let publicationProjectId;
  try {
    await cp(fixtureSource, cwd, { recursive: true });
    await mkdir(packageOutput, { recursive: true });
    const ports = await findAvailableRehearsalPorts();
    primaryProjectId = `rehearsal-stack-primary-${process.pid}`;
    publicationProjectId = `rehearsal-stack-publication-${process.pid}`;
    const originalConfig = await readFile(
      join(cwd, "rehearsal.config.mjs"),
      "utf8",
    );
    const primaryConfig = originalConfig
      .replaceAll("rehearsal-postgresql-fixture", primaryProjectId)
      .replace("databasePort: 59422", `databasePort: ${ports.database}`)
      .replace(
        "  application: {",
        `  dependentTargets: [\n    {\n      name: "publication",\n      configPath: "rehearsal.publication.config.mjs",\n      prepareCommand: "node dependent-fixture.mjs prepare",\n    },\n  ],\n  application: {`,
      );
    const publicationConfig = originalConfig
      .replaceAll("rehearsal-postgresql-fixture", publicationProjectId)
      .replace(
        'migrationDirectory: "database/migrations"',
        'migrationDirectory: "publication/database/migrations"',
      )
      .replace(
        'runtimeWorkdir: ".rehearsal/runtime"',
        'runtimeWorkdir: "publication/.rehearsal/runtime"',
      )
      .replace(
        'artifactDirectory: ".rehearsal"',
        'artifactDirectory: "publication/.rehearsal"',
      )
      .replace(
        'sanitizationPolicy: "rehearsal/sanitization-policy.json"',
        'sanitizationPolicy: "publication/rehearsal/sanitization-policy.json"',
      )
      .replace(
        'proofCommand: "npm run proof"',
        'proofCommand: "node dependent-fixture.mjs prove",\n    environmentFile: "publication/.rehearsal/runtime.env"',
      )
      .replace("databasePort: 59422", `databasePort: ${ports.pooler}`);
    await Promise.all([
      writeFile(join(cwd, "rehearsal.config.mjs"), primaryConfig),
      writeFile(
        join(cwd, "rehearsal.publication.config.mjs"),
        publicationConfig,
      ),
      writeFile(join(cwd, "dependent-fixture.mjs"), fixtureCommandSource),
      mkdir(join(cwd, "publication/database"), { recursive: true }),
      mkdir(join(cwd, "publication/rehearsal"), { recursive: true }),
    ]);
    await Promise.all([
      cp(
        join(cwd, "database/migrations"),
        join(cwd, "publication/database/migrations"),
        { recursive: true },
      ),
      cp(
        join(cwd, "rehearsal/migration-ledger.json"),
        join(cwd, "publication/rehearsal/migration-ledger.json"),
      ),
      cp(
        join(cwd, "rehearsal/sanitization-policy.json"),
        join(cwd, "publication/rehearsal/sanitization-policy.json"),
      ),
      writeFile(
        join(cwd, "publication/rehearsal/sanitized-data.ndjson"),
        '{"table":"widgets","row":{"id":2,"name":"Control Widget","created_at":"2026-01-01T00:00:00Z"}}\n',
      ),
    ]);

    const artifact = await prepareCandidateArtifact({
      repositoryRoot,
      outputDirectory: packageOutput,
    });
    installCandidateArtifact(cwd, artifact);
    installed = true;

    for (const [label, configPath, base] of [
      ["primary", "rehearsal.config.mjs", "rehearsal"],
      [
        "publication",
        "rehearsal.publication.config.mjs",
        "publication/rehearsal",
      ],
    ]) {
      executeCliOrThrow({
        cwd,
        label: `${label} baseline`,
        args: [
          "baseline",
          "create",
          `--config=${configPath}`,
          `--records=${base}/sanitized-data.ndjson`,
          `--ledger=${base}/migration-ledger.json`,
          "--json",
        ],
      });
    }
    const doctor = executeCliOrThrow({
      cwd,
      label: "stack doctor",
      args: ["doctor", "--json"],
    });
    if (
      doctor.state !== "READY" ||
      !doctor.checks.some((check) => check.id.startsWith("publication:"))
    ) {
      throw new Error("The dependent runtime was not included in readiness.");
    }
    const plan = executeCliOrThrow({
      cwd,
      label: "stack explain",
      args: ["explain", "--json"],
    });
    if (plan.targets?.length !== 2 || !plan.migrations?.candidateSha256) {
      throw new Error(
        "The execution plan did not include both runtime targets.",
      );
    }
    const wrongConfirmation = executeCli({
      cwd,
      args: [
        "run",
        `--confirm-candidates=${plan.targets[0].plan.migrations.candidateSha256}`,
        "--json",
      ],
    });
    if (
      wrongConfirmation.status === 0 ||
      JSON.parse(wrongConfirmation.stdout).error?.category !==
        "migration_candidate_failure"
    ) {
      throw new Error(
        "The stack accepted a single-target digest instead of the combined approval.",
      );
    }
    const rehearsal = executeCliOrThrow({
      cwd,
      label: "stack run",
      args: [
        "run",
        `--confirm-candidates=${plan.migrations.candidateSha256}`,
        "--json",
      ],
    });
    if (
      rehearsal.runtime?.targets?.length !== 2 ||
      rehearsal.dependentProofs?.length !== 1 ||
      rehearsal.preparations?.length !== 1
    ) {
      throw new Error(
        "The run did not prepare and prove the complete runtime stack.",
      );
    }
    const status = executeCliOrThrow({
      cwd,
      label: "stack status",
      args: ["status", "--json"],
    });
    if (status.targets?.length !== 2)
      throw new Error("Status omitted a runtime target.");
    if (
      status.targets.some(
        (target) =>
          target.runtimeStatus?.schemaVersion !== 1 ||
          target.runtimeStatus?.state !== "running" ||
          target.runtimeStatus?.runtimeTarget !== "postgresql" ||
          target.runtimeStatus?.endpoint?.kind !== "postgresql" ||
          target.runtimeStatus?.endpoint?.host !== "127.0.0.1" ||
          "password" in target.runtimeStatus.endpoint,
      )
    ) {
      throw new Error("Status omitted a safe structured running state.");
    }
    executeCliOrThrow({ cwd, label: "stack reset", args: ["reset", "--json"] });
    const stopped = executeCliOrThrow({
      cwd,
      label: "stack stop",
      args: ["stop", "--json"],
    });
    if (
      stopped.targets?.map((target) => target.target).join(",") !==
      "publication,primary"
    ) {
      throw new Error("The stack did not stop dependent runtimes first.");
    }
    const stoppedStatus = executeCliOrThrow({
      cwd,
      label: "stopped stack status",
      args: ["status", "--json"],
    });
    if (
      stoppedStatus.targets?.some(
        (target) =>
          target.runtimeStatus?.state !== "stopped" ||
          target.runtimeStatus?.reason !== "runtime_not_running" ||
          target.runtimeStatus?.endpoint !== null,
      )
    ) {
      throw new Error("Status did not report every stopped runtime safely.");
    }
    executeCliOrThrow({ cwd, label: "stack start", args: ["start", "--json"] });
    const cleanup = executeCliOrThrow({
      cwd,
      label: "stack cleanup preview",
      args: ["cleanup", "--include-runtime", "--json"],
    });
    if (cleanup.plan?.targets?.length !== 2)
      throw new Error("Cleanup preview omitted a runtime target.");
    executeCliOrThrow({
      cwd,
      label: "stack cleanup apply",
      args: [
        "cleanup",
        "--include-runtime",
        "--write",
        `--confirm-cleanup=${cleanup.plan.digest}`,
        "--json",
      ],
    });
    for (const projectId of [primaryProjectId, publicationProjectId]) {
      const remainingContainers = run(
        "docker",
        [
          "ps",
          "--all",
          "--filter",
          `label=com.rehearsal-db.project=${projectId}`,
          "--quiet",
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
          "--quiet",
        ],
        { cwd },
      ).trim();
      if (remainingContainers || remainingVolumes) {
        throw new Error(`Cleanup left runtime resources for ${projectId}.`);
      }
    }
    console.log(
      JSON.stringify(
        {
          status: "passed",
          fixture: "dependent-postgresql-project",
          installedPackage: `${artifact.name}@${artifact.version}`,
          artifactSha256: artifact.sha256,
          artifactSource: artifact.source,
          targets: 2,
          positiveAndNegativeProofs: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (installed) executeCli({ cwd, args: ["discard"] });
    await Promise.all(
      [join(cwd, ".rehearsal"), join(cwd, "publication/.rehearsal")].map(
        (artifactRoot) =>
          removeBaselineArtifactRoot({ artifactRoot }).catch(() => undefined),
      ),
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

await main();
