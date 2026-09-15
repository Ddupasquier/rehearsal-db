/**
 * Purpose: Prove the public Rehearsal CLI against a synthetic independent Supabase
 * project, including one valid and one deliberately invalid candidate migration.
 * Run: `npm run rehearsal:fixture:prove`. Uses only disposable local Docker state.
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createCleanProcessEnvironment } from "../../lib/rehearsal/process_environment.mjs";
import {
  readLocalSupabaseEnvironment,
  runLocalCommand,
} from "../../lib/environment/local_supabase.mjs";
import { removeBaselineArtifactRoot } from "../../lib/rehearsal/baseline_artifact.mjs";
import {
  buildRehearsalPlan,
  inspectRehearsalMigrations,
} from "../../lib/rehearsal/plan.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureSource = join(repositoryRoot, "tests/fixtures/rehearsal-project");
const projectId = "rehearsal-fixture";

const findContainer = ({ cwd }) => {
  const output = runLocalCommand(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.supabase.cli.project=${projectId}`,
      "--format",
      "{{.Names}}",
    ],
    { capture: true, cwd },
  );
  const names = output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("supabase_db_"));
  if (names.length !== 1) {
    throw new Error(
      `Expected one fixture database container; found ${names.length}.`,
    );
  }
  return names[0];
};

const runPsql = ({ cwd, sql }) =>
  runLocalCommand(
    "docker",
    [
      "exec",
      "--interactive",
      findContainer({ cwd }),
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
    { capture: true, cwd, input: sql },
  );

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

const runtimeExists = (runtimeWorkdir) =>
  stat(runtimeWorkdir)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });

const main = async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "rehearsal-fixture-proof-"),
  );
  const cwd = join(temporaryRoot, "project");
  const packageOutput = join(temporaryRoot, "packed");
  const runtimeWorkdir = join(cwd, ".rehearsal/runtime");
  const validFilename = "20260101000100_add_widget_description.sql";
  const invalidFilename = "20260101000200_invalid_candidate.sql";
  const timings = {};
  const commandsProven = [];
  let packageInstalled = false;
  try {
    await cp(fixtureSource, cwd, { recursive: true });
    await mkdir(packageOutput, { recursive: true });
    const packResult = JSON.parse(
      runLocalCommand(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          packageOutput,
        ],
        { capture: true, cwd: repositoryRoot },
      ),
    )[0];
    const tarball = join(packageOutput, packResult.filename);
    runLocalCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        tarball,
      ],
      { capture: true, cwd },
    );
    packageInstalled = true;
    const publicImports = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { validateSanitizationCoverage } from "@rehearsal-db/core";',
          'import { createAndActivateBaseline } from "@rehearsal-db/core/baseline";',
          'import { createMigrationReplayReceipt } from "@rehearsal-db/core/migrations";',
          "if (![validateSanitizationCoverage, createAndActivateBaseline, createMigrationReplayReceipt].every((value) => typeof value === 'function')) process.exit(1);",
        ].join("\n"),
      ],
      {
        cwd,
        encoding: "utf8",
        env: createCleanProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (publicImports.status !== 0) {
      throw new Error(
        `The installed package public exports failed: ${publicImports.stderr || publicImports.stdout}`,
      );
    }
    executeCliOrThrow({ cwd, args: ["init", "--json"], label: "init" });
    commandsProven.push("init");
    let startedAt = performance.now();
    const baselineCreate = executeCliOrThrow({
      cwd,
      args: [
        "baseline",
        "create",
        "--records=rehearsal/sanitized-data.ndjson",
        "--ledger=rehearsal/migration-ledger.json",
        "--assets=rehearsal/assets.json",
        "--json",
      ],
      label: "baseline create",
    });
    const baselineResult = JSON.parse(baselineCreate.stdout);
    if (
      baselineResult.data?.rowCount !== 1 ||
      baselineResult.data?.tableCount !== 1 ||
      baselineResult.data?.migrationCount !== 1
    ) {
      throw new Error(
        `The baseline-create result did not report its exact counts: ${baselineCreate.stdout}`,
      );
    }
    commandsProven.push("baseline create");
    const validPlan = await buildRehearsalPlan({ projectRoot: cwd });
    timings.baselineAndPlanMs = Math.round(performance.now() - startedAt);

    for (const [label, args] of [
      ["doctor", ["doctor", "--json"]],
      ["explain", ["explain", "--json"]],
      ["run --dry-run", ["run", "--dry-run", "--json"]],
      ["candidates", ["candidates", "--json"]],
      ["inspect baseline", ["inspect", "baseline", "--json"]],
      ["inspect migrations", ["inspect", "migrations", "--json"]],
      ["status", ["status", "--json"]],
    ]) {
      executeCliOrThrow({ cwd, args, label });
      commandsProven.push(label);
    }

    startedAt = performance.now();
    const validRun = executeCliOrThrow({
      cwd,
      label: "run",
      args: [
        "run",
        `--confirm-candidates=${validPlan.migrations.candidateSha256}`,
        "--json",
        "--debug",
      ],
    });
    commandsProven.push("run");
    const validProof = runPsql({
      cwd,
      sql: `select count(*) = 1
and exists (
	select 1 from information_schema.columns
	where table_schema = 'public'
		and table_name = 'widgets'
		and column_name = 'description'
)
from public.widgets;`,
    }).trim();
    if (validProof !== "t") {
      throw new Error(
        `The valid fixture migration did not preserve data and add its column; proof returned ${JSON.stringify(validProof)}.`,
      );
    }
    const fixtureEnvironment = readLocalSupabaseEnvironment({
      cwd,
      workdir: runtimeWorkdir,
    });
    const assetResponse = await fetch(
      `${fixtureEnvironment.apiUrl}/storage/v1/object/fixture-assets/proof/exact-byte.txt`,
      {
        headers: {
          apikey: fixtureEnvironment.serviceRoleKey,
          authorization: `Bearer ${fixtureEnvironment.serviceRoleKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (
      !assetResponse.ok ||
      (await assetResponse.text()) !== "independent Rehearsal Storage proof\n"
    ) {
      throw new Error(
        "The installed package did not restore the fixture Storage byte exactly.",
      );
    }
    const appliedInspection = await inspectRehearsalMigrations({
      projectRoot: cwd,
    });
    if (
      appliedInspection.migrations.at(-1)?.status !==
      "applied_to_current_runtime"
    ) {
      throw new Error(
        "Migration inspection did not recognize the verified runtime receipt.",
      );
    }
    executeCliOrThrow({ cwd, args: ["verify", "--json"], label: "verify" });
    commandsProven.push("verify");
    executeCliOrThrow({
      cwd,
      args: [
        "migrate",
        `--confirm-candidates=${validPlan.migrations.candidateSha256}`,
        "--json",
      ],
      label: "migrate",
    });
    commandsProven.push("migrate");
    timings.validCliRunAndProofMs = Math.round(performance.now() - startedAt);

    startedAt = performance.now();
    executeCliOrThrow({ cwd, args: ["reset", "--json"], label: "reset" });
    commandsProven.push("reset");
    executeCliOrThrow({ cwd, args: ["stop", "--json"], label: "stop" });
    commandsProven.push("stop");
    executeCliOrThrow({ cwd, args: ["start", "--json"], label: "start" });
    commandsProven.push("start");
    executeCliOrThrow({
      cwd,
      args: ["stop", "--json"],
      label: "second stop",
    });
    executeCliOrThrow({
      cwd,
      args: ["discard", "--json"],
      label: "discard",
    });
    commandsProven.push("discard");
    timings.resetAndStopMs = Math.round(performance.now() - startedAt);

    await cp(
      join(cwd, "broken", invalidFilename),
      join(cwd, "supabase/migrations", invalidFilename),
    );
    const invalidPlan = await buildRehearsalPlan({ projectRoot: cwd });
    startedAt = performance.now();
    const invalidRun = executeCli({
      cwd,
      args: [
        "run",
        `--confirm-candidates=${invalidPlan.migrations.candidateSha256}`,
        "--json",
      ],
    });
    if (invalidRun.status === 0) {
      throw new Error(
        "The deliberately invalid fixture migration unexpectedly passed.",
      );
    }
    const invalidFailure = JSON.parse(invalidRun.stdout);
    if (invalidFailure.error?.category !== "migration_candidate_failure") {
      throw new Error(
        `The invalid fixture failed with the wrong category: ${invalidRun.stdout || invalidRun.stderr}`,
      );
    }
    if (await runtimeExists(runtimeWorkdir)) {
      throw new Error("The failed fixture runtime was not discarded.");
    }
    timings.invalidCandidateRefusalMs = Math.round(
      performance.now() - startedAt,
    );

    console.log(
      JSON.stringify(
        {
          status: "passed",
          fixture: "rehearsal-project",
          installedPackage: `${packResult.name}@${packResult.version}`,
          validCandidate: validFilename,
          invalidCandidate: invalidFilename,
          commandsProven,
          timings,
        },
        null,
        2,
      ),
    );
  } finally {
    if (packageInstalled) {
      executeCli({ cwd, args: ["discard"] });
    }
    await removeBaselineArtifactRoot({
      artifactRoot: join(cwd, ".rehearsal"),
    }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

await main();
