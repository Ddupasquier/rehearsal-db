/**
 * Purpose: Prove the public Rehearsal CLI against a synthetic independent Supabase
 * project, including one valid and one deliberately invalid candidate migration.
 * Run: `npm run rehearsal:fixture:prove`. Uses only disposable local Docker state.
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
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createCleanProcessEnvironment } from "../../../src/shared/process_environment.mjs";
import {
  readLocalSupabaseEnvironment,
  runLocalCommand,
} from "../../../src/targets/supabase_environment.mjs";
import { removeBaselineArtifactRoot } from "../../../src/baseline/artifact.mjs";
import { findAvailableRehearsalPorts } from "../../../src/project/setup.mjs";
import {
  buildRehearsalPlan,
  inspectRehearsalMigrations,
} from "../../../src/runtime/plan.mjs";
import { streamApprovedSupabaseAssets } from "../../../src/source/asset_transfer.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureSource = join(repositoryRoot, "tests/fixtures/rehearsal-project");
let projectId = "rehearsal-fixture";

const prepareFixtureRuntimeIdentity = async ({ cwd }) => {
  const ports = await findAvailableRehearsalPorts();
  projectId = `rehearsal-fixture-${process.pid}`;
  const configPath = join(cwd, "rehearsal.config.mjs");
  const localConfigPath = join(cwd, "supabase/config.toml");
  const replacements = new Map([
    ["rehearsal-fixture", projectId],
    ["59320", String(ports.shadow)],
    ["59321", String(ports.api)],
    ["59322", String(ports.database)],
    ["59323", String(ports.studio)],
    ["59324", String(ports.smtp)],
    ["59329", String(ports.pooler)],
  ]);
  for (const path of [configPath, localConfigPath]) {
    let source = await readFile(path, "utf8");
    for (const [current, replacement] of replacements) {
      source = source.replaceAll(current, replacement);
    }
    await writeFile(path, source);
  }
  const legacyTemplate = await readFile(localConfigPath, "utf8");
  await writeFile(
    localConfigPath,
    `${legacyTemplate.trimEnd()}

[auth.external.google]
enabled = true
client_id = "env(LEGACY_GOOGLE_CLIENT_ID)"
secret = "env(LEGACY_GOOGLE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
skip_nonce_check = true
email_optional = false
`,
  );
  const configSource = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    configSource.replace(
      'runtimeWorkdir: ".rehearsal/runtime",',
      `runtimeWorkdir: ".rehearsal/runtime",
    authentication: {
      enableLocalSignup: true,
      environmentFile: ".env.rehearsal-service.local",
      providers: [{
        name: "google",
        clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
        clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
        skipNonceCheck: true,
        emailOptional: false,
      }],
    },`,
    ),
  );
  await writeFile(
    join(cwd, ".env.rehearsal-service.local"),
    "REHEARSAL_GOOGLE_CLIENT_ID=fixture-client-id\nREHEARSAL_GOOGLE_CLIENT_SECRET=fixture-client-secret\n",
    { mode: 0o600 },
  );
};

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

const executeCli = ({ cwd, args, environment = {} }) =>
  spawnSync(join(cwd, "node_modules/.bin/rehearsal"), args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment({ overrides: environment }),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });

const executeCliOrThrow = ({ cwd, args, label, environment }) => {
  const result = executeCli({ cwd, args, environment });
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

const promoteActiveBaselineWithSchemaSnapshot = ({ cwd }) => {
  const script = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAndActivateBaseline,
  resolveActiveBaselinePaths,
  verifyActiveBaseline,
} from "@rehearsal-db/core/baseline";
import { captureLocalPublicSchema } from "@rehearsal-db/core/schema";

const artifactRoot = join(process.cwd(), ".rehearsal");
const [baseline, paths, schemaSql] = await Promise.all([
  verifyActiveBaseline({ artifactRoot }),
  resolveActiveBaselinePaths({ artifactRoot }),
  captureLocalPublicSchema({
    repositoryRoot: process.cwd(),
    artifactRoot,
    workdir: join(artifactRoot, "runtime"),
  }),
]);
const records = (await readFile(paths.dataPath, "utf8"))
  .split("\\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const migrationFiles = await Promise.all(
  Object.entries(baseline.migrations).map(async ([filename, receipt]) => ({
    version: filename.slice(0, 14),
    name: filename.slice(15, -4),
    filename,
    fileSha256: receipt.sha256,
    content: await readFile(join(paths.migrationsDirectory, filename), "utf8"),
  })),
);
const assets = await Promise.all(
  Object.entries(baseline.storageAssets ?? {}).map(
    async ([relativePath, receipt]) => ({
      bucket: receipt.bucket,
      objectPath: receipt.objectPath,
      contentType: receipt.contentType,
      content: await readFile(join(paths.generationDirectory, relativePath)),
    }),
  ),
);
const {
  formatVersion,
  generationId,
  rowCount,
  tableCounts,
  files,
  storageAssets,
  migrations,
  ...metadata
} = baseline;
await createAndActivateBaseline({
  artifactRoot,
  records,
  metadata,
  expectedTables: Object.keys(tableCounts),
  migrationFiles,
  assets,
  schemaSql,
});
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd,
      encoding: "utf8",
      env: createCleanProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Schema-snapshot promotion failed: ${result.stderr || result.stdout}`,
    );
  }
};

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
    await prepareFixtureRuntimeIdentity({ cwd });
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
    const fixtureConfigPath = join(cwd, "rehearsal.config.mjs");
    const fixtureConfig = await readFile(fixtureConfigPath);
    await rm(fixtureConfigPath);
    const setupPreview = executeCliOrThrow({
      cwd,
      args: ["setup", "--json"],
      label: "setup preview",
    });
    if (
      JSON.parse(setupPreview.stdout).data?.mode !== "preview" ||
      (await runtimeExists(fixtureConfigPath))
    ) {
      throw new Error("Setup preview unexpectedly mutated the fixture.");
    }
    const setupWrite = executeCliOrThrow({
      cwd,
      args: ["setup", "--write", "--json"],
      label: "setup write",
    });
    if (
      JSON.parse(setupWrite.stdout).data?.mode !== "written" ||
      !(await runtimeExists(
        join(cwd, "infrastructure/rehearsal/supabase/config.toml"),
      ))
    ) {
      throw new Error("Setup did not create its previewed local scaffolding.");
    }
    await writeFile(fixtureConfigPath, fixtureConfig);
    await rm(join(cwd, "infrastructure"), { recursive: true, force: true });
    commandsProven.push("setup");
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
    const support = JSON.parse(
      executeCliOrThrow({
        cwd,
        args: ["support", "--json"],
        label: "support",
      }).stdout,
    );
    if (
      support.data?.privacy?.reviewBeforeSharing !== true ||
      !support.data?.privacy?.omits?.includes("credentials") ||
      JSON.stringify(support).includes(cwd)
    ) {
      throw new Error(
        "The installed support report did not preserve its privacy contract.",
      );
    }
    commandsProven.push("support");
    let startedAt = performance.now();
    const policyPath = join(cwd, "rehearsal/sanitization-policy.json");
    const reviewedPolicy = await readFile(policyPath);
    await rm(policyPath);
    const preparationArguments = [
      "baseline",
      "prepare",
      "--records=rehearsal/sanitized-data.ndjson",
      "--ledger=rehearsal/migration-ledger.json",
      "--json",
    ];
    const preparationPreview = executeCliOrThrow({
      cwd,
      args: preparationArguments,
      label: "baseline prepare preview",
    });
    if (preparationPreview.stdout.includes("Synthetic Widget")) {
      throw new Error("Baseline preparation unexpectedly printed a row value.");
    }
    executeCliOrThrow({
      cwd,
      args: [...preparationArguments, "--write"],
      label: "baseline prepare write",
    });
    const draftFailure = executeCli({
      cwd,
      args: [
        "baseline",
        "create",
        "--records=rehearsal/sanitized-data.ndjson",
        "--ledger=rehearsal/migration-ledger.json",
        "--json",
      ],
    });
    if (draftFailure.status === 0 || !draftFailure.stdout.includes("draft")) {
      throw new Error(
        `The unreviewed policy draft was not refused: ${draftFailure.stdout || draftFailure.stderr}`,
      );
    }
    await writeFile(policyPath, reviewedPolicy);
    commandsProven.push("baseline prepare");
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

    const alternateConfigPath = join(cwd, "rehearsal.alternate.config.mjs");
    const alternateArtifactDirectory = "alternate/.rehearsal";
    const alternateConfig = fixtureConfig
      .toString("utf8")
      .replaceAll(projectId, `${projectId}-alternate`)
      .replace(
        'runtimeWorkdir: ".rehearsal/runtime"',
        `runtimeWorkdir: "${alternateArtifactDirectory}/runtime"`,
      )
      .replace(
        'artifactDirectory: ".rehearsal"',
        `artifactDirectory: "${alternateArtifactDirectory}"`,
      )
      .replace(
        'proofCommand: "npm run proof",',
        `proofCommand: "npm run proof",\n    environmentFile: "${alternateArtifactDirectory}/runtime.env",`,
      );
    await writeFile(alternateConfigPath, alternateConfig);
    const alternateStatus = executeCli({
      cwd,
      args: ["status", "--config=rehearsal.alternate.config.mjs", "--json"],
    });
    if (
      alternateStatus.status === 0 ||
      !alternateStatus.stdout.includes(alternateArtifactDirectory)
    ) {
      throw new Error(
        `A lifecycle command did not stay isolated to its explicitly selected config: ${alternateStatus.stdout || alternateStatus.stderr}`,
      );
    }
    commandsProven.push("alternate config isolation");

    executeCliOrThrow({
      cwd,
      args: ["reset", "--json"],
      label: "format-1 prerequisite reset",
    });
    const runtimeAuthConfig = await readFile(
      join(runtimeWorkdir, "supabase/config.toml"),
      "utf8",
    );
    if (
      !runtimeAuthConfig.includes("[auth.external.google]") ||
      !runtimeAuthConfig.includes("enable_signup = true") ||
      !runtimeAuthConfig.includes(
        'client_id = "env(REHEARSAL_GOOGLE_CLIENT_ID)"',
      ) ||
      !runtimeAuthConfig.includes(
        `redirect_uri = "http://127.0.0.1:${
          new URL(
            readLocalSupabaseEnvironment({ cwd, workdir: runtimeWorkdir })
              .apiUrl,
          ).port
        }/auth/v1/callback"`,
      ) ||
      !runtimeAuthConfig.includes("skip_nonce_check = true") ||
      runtimeAuthConfig.includes("fixture-client-secret")
    ) {
      throw new Error(
        "The installed package did not generate the declared local OAuth provider safely.",
      );
    }
    if (
      runtimeAuthConfig.includes("LEGACY_GOOGLE_CLIENT_ID") ||
      runtimeAuthConfig.match(/\[auth\.external\.google\]/gu)?.length !== 1
    ) {
      throw new Error(
        "The installed package did not replace the compatible legacy provider only in the generated runtime.",
      );
    }
    commandsProven.push("declarative local OAuth provider");
    promoteActiveBaselineWithSchemaSnapshot({ cwd });
    executeCliOrThrow({
      cwd,
      args: ["reset", "--json"],
      label: "format-2 prerequisite reset",
    });
    const prerequisiteProof = runPsql({
      cwd,
      sql: `select
        exists (
          select 1
          from pg_extension extension_record
          join pg_namespace namespace_record
            on namespace_record.oid = extension_record.extnamespace
          where extension_record.extname = 'pg_trgm'
            and namespace_record.nspname = 'public'
        )
        and to_regclass('public.widgets_name_trgm_idx') is not null;`,
    }).trim();
    if (prerequisiteProof !== "t") {
      throw new Error(
        "The installed package did not restore extension-dependent schema objects in prerequisite order.",
      );
    }
    commandsProven.push("schema prerequisite ordering");

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
    const generatedRuntimeEnvironment = await readFile(
      join(cwd, ".rehearsal/runtime.env"),
      "utf8",
    );
    if (
      !generatedRuntimeEnvironment.includes(
        `DATABASE_URL=${fixtureEnvironment.databaseUrl}`,
      ) ||
      !generatedRuntimeEnvironment.includes(
        `PGPORT=${fixtureEnvironment.databasePort}`,
      )
    ) {
      throw new Error(
        "The Supabase runtime environment omitted its validated local database connection.",
      );
    }
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
    const approvedEmail = "owner@example.com";
    const serviceHeaders = {
      apikey: fixtureEnvironment.serviceRoleKey,
      authorization: `Bearer ${fixtureEnvironment.serviceRoleKey}`,
    };
    const nestedFixtureAsset = await fetch(
      `${fixtureEnvironment.apiUrl}/storage/v1/object/copy`,
      {
        method: "POST",
        headers: { ...serviceHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          bucketId: "fixture-assets",
          sourceKey: "proof/exact-byte.txt",
          destinationKey: "proof/nested/deeper/exact-byte.txt",
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!nestedFixtureAsset.ok) {
      throw new Error(
        `The nested Storage fixture copy failed with HTTP ${nestedFixtureAsset.status}.`,
      );
    }
    const recursivelyInventoriedAssets = [];
    for await (const asset of streamApprovedSupabaseAssets({
      baseUrl: fixtureEnvironment.apiUrl,
      token: fixtureEnvironment.serviceRoleKey,
      declarations: [{ bucket: "fixture-assets", prefix: "proof/" }],
    })) {
      const chunks = [];
      for await (const chunk of asset.content) chunks.push(chunk);
      recursivelyInventoriedAssets.push({
        path: asset.objectPath,
        content: Buffer.concat(chunks).toString("utf8"),
      });
    }
    if (
      recursivelyInventoriedAssets.length !== 2 ||
      !recursivelyInventoriedAssets.some(
        ({ path }) => path === "proof/exact-byte.txt",
      ) ||
      !recursivelyInventoriedAssets.some(
        ({ path }) => path === "proof/nested/deeper/exact-byte.txt",
      ) ||
      recursivelyInventoriedAssets.some(
        ({ content }) => content !== "independent Rehearsal Storage proof\n",
      )
    ) {
      throw new Error(
        "The real Supabase Storage inventory did not recursively stream both exact fixture objects.",
      );
    }
    commandsProven.push("recursive Supabase Storage inventory");
    const signupResponse = await fetch(
      `${fixtureEnvironment.apiUrl}/auth/v1/admin/users`,
      {
        method: "POST",
        headers: {
          apikey: fixtureEnvironment.serviceRoleKey,
          authorization: `Bearer ${fixtureEnvironment.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: approvedEmail,
          password: "Rehearsal-local-proof-2026!",
          email_confirm: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!signupResponse.ok) {
      throw new Error(
        `The local identity signup failed with HTTP ${signupResponse.status}.`,
      );
    }
    const localUserId = runPsql({
      cwd,
      sql: `select id::text from auth.users where lower(email) = '${approvedEmail}';`,
    }).trim();
    if (!/^[a-f0-9-]{36}$/u.test(localUserId)) {
      throw new Error("The local identity signup did not create one user.");
    }
    const copiedAssetResponse = await fetch(
      `${fixtureEnvironment.apiUrl}/storage/v1/object/copy`,
      {
        method: "POST",
        headers: { ...serviceHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          bucketId: "fixture-assets",
          sourceKey: "proof/exact-byte.txt",
          destinationKey: "11111111-1111-4111-8111-111111111111/avatar.txt",
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!copiedAssetResponse.ok) {
      throw new Error(
        `The identity fixture asset copy failed with HTTP ${copiedAssetResponse.status}.`,
      );
    }
    runPsql({
      cwd,
      sql: `insert into auth.users (
  instance_id, id, aud, role, email, confirmation_token, recovery_token,
  email_change_token_new, email_change, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
  created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated', 'rehearsal-owner@rehearsal.invalid',
  '', '', '', '', '', '', '', '',
  '{"provider":"email","providers":["email"]}', '{"rehearsal":true}',
  false, false, now(), now()
);
insert into public.profiles (id, display_name, avatar_path)
values
  ('11111111-1111-4111-8111-111111111111', 'Synthetic owner', '11111111-1111-4111-8111-111111111111/avatar.txt'),
  ('${localUserId}', 'New account', null);
insert into public.food_compatibility_feedback (decision, reviewed_by)
values ('approved synthetic decision', '11111111-1111-4111-8111-111111111111');`,
    });
    const restoredAssetOwner = runPsql({
      cwd,
      sql: `select owner_id is null
from storage.objects
where bucket_id = 'fixture-assets'
  and name = '11111111-1111-4111-8111-111111111111/avatar.txt';`,
    }).trim();
    if (restoredAssetOwner !== "t") {
      throw new Error(
        "The identity fixture did not preserve the restored NULL Storage owner case.",
      );
    }
    const identityEnvironment = {
      REHEARSAL_APPROVED_OWNER_EMAIL: approvedEmail,
    };
    const identityPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "identity plan",
        args: ["identity", "plan", "--identity=approved-owner", "--json"],
        environment: identityEnvironment,
      }).stdout,
    ).data.plan;
    if (
      JSON.stringify(identityPlan).includes(approvedEmail) ||
      identityPlan.review?.matcher?.type !== "verified-email"
    ) {
      throw new Error(
        "The installed legacy email policy exposed or misclassified its matcher value.",
      );
    }
    const identityClaim = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "identity claim",
        args: [
          "identity",
          "claim",
          "--identity=approved-owner",
          `--confirm-identity=${identityPlan.digest}`,
          "--json",
        ],
        environment: identityEnvironment,
      }).stdout,
    ).data.result;
    if (
      identityClaim.storageObjectsTransferred !== 1 ||
      identityClaim.placeholderRetainedForAudit !== true
    ) {
      throw new Error(
        "The installed identity claim omitted a safe transfer step.",
      );
    }
    const repeatedIdentity = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "repeated identity claim",
        args: [
          "identity",
          "claim",
          "--identity=approved-owner",
          `--confirm-identity=${identityPlan.digest}`,
          "--json",
        ],
        environment: identityEnvironment,
      }).stdout,
    ).data.result;
    if (!repeatedIdentity.idempotent) {
      throw new Error("The installed identity claim was not idempotent.");
    }
    const transferredAsset = await fetch(
      `${fixtureEnvironment.apiUrl}/storage/v1/object/fixture-assets/${localUserId}/avatar.txt`,
      {
        headers: serviceHeaders,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const retiredAsset = await fetch(
      `${fixtureEnvironment.apiUrl}/storage/v1/object/fixture-assets/11111111-1111-4111-8111-111111111111/avatar.txt`,
      {
        headers: serviceHeaders,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (
      !transferredAsset.ok ||
      (await transferredAsset.text()) !==
        "independent Rehearsal Storage proof\n" ||
      retiredAsset.ok
    ) {
      throw new Error(
        "The installed identity claim did not move the physical Storage byte exactly.",
      );
    }
    const identityProof = runPsql({
      cwd,
      sql: `select
  exists (
    select 1 from public.profiles
    where id = '${localUserId}'
      and display_name = 'Synthetic owner'
      and avatar_path = '${localUserId}/avatar.txt'
  )
  and exists (
    select 1 from public.food_compatibility_feedback
    where reviewed_by = '11111111-1111-4111-8111-111111111111'
  )
  and exists (
    select 1 from auth.users
    where id = '11111111-1111-4111-8111-111111111111'
  )
  and exists (
    select 1 from storage.objects
    where bucket_id = 'fixture-assets'
      and name = '${localUserId}/avatar.txt'
      and owner_id = '${localUserId}'
  );`,
    }).trim();
    if (identityProof !== "t") {
      throw new Error(
        "The installed identity claim did not preserve its database invariants.",
      );
    }
    commandsProven.push("identity claim with physical Storage transfer");
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
    const cleanupPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        args: ["cleanup", "--include-runtime", "--json"],
        label: "cleanup preview",
      }).stdout,
    ).data.plan;
    commandsProven.push("cleanup");
    executeCliOrThrow({
      cwd,
      args: [
        "cleanup",
        "--include-runtime",
        "--write",
        `--confirm-cleanup=${cleanupPlan.digest}`,
        "--json",
      ],
      label: "cleanup apply",
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
