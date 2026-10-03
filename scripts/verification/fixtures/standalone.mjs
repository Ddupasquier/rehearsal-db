/** Prove the packed source-to-local workflow without consumer Rehearsal scripts. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeBaselineArtifactRoot } from "../../../src/baseline/artifact.mjs";
import { createCleanProcessEnvironment } from "../../../src/shared/process_environment.mjs";
import { findAvailableRehearsalPorts } from "../../../src/project/setup.mjs";
import { sourceTargetFingerprint } from "../../../src/source/access.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureSource = join(repositoryRoot, "tests/fixtures/postgresql-project");

const run = (command, args, { cwd, input, environment = {} } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment({ overrides: environment }),
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

const waitForSource = ({ name, cwd }) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        name,
        "pg_isready",
        "--host",
        "127.0.0.1",
        "--username",
        "postgres",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("Disposable source PostgreSQL did not become ready.");
};

const main = async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "rehearsal-standalone-proof-"),
  );
  const cwd = join(temporaryRoot, "project");
  const packageOutput = join(temporaryRoot, "packed");
  const sourceName = `rehearsal-source-${process.pid}`;
  const sourceLabel = `com.rehearsal-db.fixture=${sourceName}`;
  let projectId;
  try {
    await cp(fixtureSource, cwd, { recursive: true });
    await mkdir(packageOutput, { recursive: true });
    const baselineMigrationPath = join(
      cwd,
      "database/migrations/20260101000000_create_widgets.sql",
    );
    const baselineMigration = `${(await readFile(baselineMigrationPath, "utf8")).trim()}
alter table public.widgets add column owner_id uuid;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table auth.identities (
  user_id uuid not null,
  provider text not null,
  identity_data jsonb not null
);
create schema storage;
create table storage.objects (
  owner_id text,
  bucket_id text not null,
  name text not null
);
create table public.profiles (
  id uuid primary key,
  display_name text not null,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.app_role_assignments (
  user_id uuid primary key,
  role text not null
);
create table public.events (id bigint primary key, payload jsonb not null);
create function public.custom_access_token_hook(event jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_set(
    event,
    '{claims,app_role}',
    to_jsonb(coalesce(
      (select role from public.app_role_assignments where user_id = (event->>'user_id')::uuid),
      'user'
    )),
    true
  )
$$;
`;
    await writeFile(baselineMigrationPath, baselineMigration);
    const ports = await findAvailableRehearsalPorts();
    const sourcePort = ports.smtp;
    const applicationPort = ports.api;
    projectId = `rehearsal-standalone-${process.pid}`;
    const sourcePassword = "synthetic-source-password";
    const sourceAdminUrl = `postgresql://postgres:${sourcePassword}@127.0.0.1:${sourcePort}/postgres`;
    const sourceEnvironment = {
      REHEARSAL_SOURCE_ADMIN_URL: sourceAdminUrl,
    };

    run(
      "docker",
      [
        "run",
        "--detach",
        "--pull=never",
        "--name",
        sourceName,
        "--label",
        sourceLabel,
        "--publish",
        `127.0.0.1:${sourcePort}:5432`,
        "--env",
        `POSTGRES_PASSWORD=${sourcePassword}`,
        "postgres:17-alpine",
      ],
      { cwd },
    );
    waitForSource({ name: sourceName, cwd });
    run(
      "docker",
      [
        "exec",
        "--interactive",
        sourceName,
        "psql",
        "--host",
        "127.0.0.1",
        "--username",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      {
        cwd,
        input: `create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text primary key,
  name text not null,
  statements text[] not null
);
${baselineMigration}
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260101000000', 'create_widgets', array[$rehearsal$${baselineMigration}$rehearsal$]);
insert into public.widgets (id, name, created_at, owner_id)
overriding system value values (41, 'private-source-canary', '2026-01-01T00:00:00Z', '11111111-1111-4111-8111-111111111111');
`,
      },
    );

    const configPath = join(cwd, "rehearsal.config.mjs");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8"))
        .replaceAll("rehearsal-postgresql-fixture", projectId)
        .replace("databasePort: 59422", `databasePort: ${ports.database}`)
        .replace(
          "  application: {",
          `  preparation: {
    sourcePolicy: "rehearsal/source-access-policy.json",
    privacyKey: ".rehearsal/secrets/privacy.key",
    batchRows: 1,
    maximumRows: 10,
    maximumBytes: 1048576,
    diskHeadroomBytes: 1048576,
  },
  cleanup: { retainBaselineGenerations: 1 },
  runtimePolicy: "rehearsal/runtime-policy.json",
  identityPolicy: "rehearsal/identity-policy.json",
  application: {`,
        )
        .replace(
          `  application: {
    startCommand: "npm run dev",
    proofCommand: "npm run proof",
  },`,
          `  application: {
    startCommand: "node app-server.mjs",
    proofCommand: "npm run proof",
    environmentVariables: { DATABASE_URL: "primary:DATABASE_URL" },
    readiness: {
      url: "http://127.0.0.1:${applicationPort}/health",
      expectedStatus: 204,
      timeoutSeconds: 10,
    },
    httpProofs: [
      {
        name: "known route",
        kind: "positive",
        url: "http://127.0.0.1:${applicationPort}/known",
        expectedStatus: 200,
        json: { path: ["items"], minimumItems: 1 },
      },
      {
        name: "missing route",
        kind: "negative",
        url: "http://127.0.0.1:${applicationPort}/missing",
        expectedStatus: 404,
        json: { path: ["error"], equals: "not found" },
      },
    ],
  },`,
        ),
    );
    await writeFile(
      join(cwd, "app-server.mjs"),
      `import { createServer } from "node:http";

const database = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(database.hostname)) {
  throw new Error("The fixture application received a non-local database.");
}
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.statusCode = 204;
    response.end();
  } else if (request.url === "/known") {
    response.end(JSON.stringify({ items: [{ localDatabase: true }] }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  }
});
server.listen(${applicationPort}, "127.0.0.1");
process.on("SIGTERM", () => server.close());
`,
    );
    await writeFile(
      join(cwd, "proof.mjs"),
      (await readFile(join(cwd, "proof.mjs"), "utf8")).replace(
        "select count(*) = 1 and exists",
        "select count(*) = 2 and exists (select 1 from public.widgets where id = 99 and name = 'Local fixture row') and exists",
      ),
    );
    await writeFile(
      join(cwd, "rehearsal/source-access-policy.json"),
      `${JSON.stringify(
        {
          accessVersion: 1,
          targetFingerprint: sourceTargetFingerprint(sourceAdminUrl),
          administratorEnvironmentVariable: "REHEARSAL_SOURCE_ADMIN_URL",
          reader: {
            role: `rehearsal_reader_${process.pid}`,
            ownerRole: `rehearsal_owner_${process.pid}`,
            credentialFile: ".rehearsal/secrets/source-reader.env",
            validForMinutes: 30,
          },
          exportSchema: `rehearsal_export_${process.pid}`,
          migrationLedger: {
            schema: "supabase_migrations",
            table: "schema_migrations",
            versionColumn: "version",
            nameColumn: "name",
            statementsColumn: "statements",
          },
          relations: [
            {
              source: { schema: "public", table: "widgets" },
              view: "widgets",
              targetTable: "widgets",
              columns: ["id", "name", "created_at", "owner_id"],
              orderBy: ["id"],
              rowScope: { kind: "approved-public" },
            },
          ],
          assets: [],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(cwd, "rehearsal/sanitization-policy.json"),
      `${JSON.stringify(
        {
          policyVersion: 2,
          migrationCutoff: "20260101000000",
          tables: [
            {
              name: "widgets",
              sourceRows: "STREAM AND SANITIZE",
              columns: [
                {
                  name: "id",
                  action: "KEEP",
                  generated: "NEVER",
                  identity: "YES",
                  foreignKey: null,
                },
                {
                  name: "name",
                  action: "REPLACE",
                  recipe: { kind: "constant", value: "Standalone safe widget" },
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
                {
                  name: "created_at",
                  action: "DERIVE",
                  recipe: { kind: "date-shift", days: 7 },
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
                {
                  name: "owner_id",
                  action: "KEEP",
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(cwd, "rehearsal/runtime-policy.json"),
      `${JSON.stringify(
        {
          policyVersion: 1,
          prerequisites: { schemas: [], extensions: [] },
          triggers: [],
          localRows: [
            {
              table: { schema: "public", name: "widgets" },
              keyColumns: ["id"],
              values: {
                id: 99,
                name: "Local fixture row",
                created_at: "2026-01-02T00:00:00Z",
              },
            },
            {
              table: {
                schema: "public",
                name: "app_role_assignments",
              },
              keyColumns: ["user_id"],
              values: {
                user_id: "11111111-1111-4111-8111-111111111111",
                role: "owner",
              },
              identityAssociation: {
                identity: "approved-owner",
                column: "user_id",
              },
            },
          ],
          expectations: [
            {
              table: { schema: "public", name: "widgets" },
              rowLevelSecurity: false,
              columns: [
                { name: "id", generated: false, identity: true },
                { name: "name", generated: false, identity: false },
                { name: "created_at", generated: false, identity: false },
                { name: "owner_id", generated: false, identity: false },
              ],
              foreignKeys: [],
              policies: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const approvedEmail = "owner@example.com";
    await writeFile(
      join(cwd, "rehearsal/identity-policy.json"),
      `${JSON.stringify(
        {
          identityVersion: 1,
          identities: [
            {
              name: "approved-owner",
              provider: "google",
              emailEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_EMAIL",
              approvedEmailSha256: createHash("sha256")
                .update(approvedEmail)
                .digest("hex"),
              placeholderUserId: "11111111-1111-4111-8111-111111111111",
              references: [
                {
                  schema: "public",
                  table: "profiles",
                  column: "id",
                  required: true,
                },
                { schema: "public", table: "widgets", column: "owner_id" },
                {
                  schema: "public",
                  table: "app_role_assignments",
                  column: "user_id",
                  required: true,
                },
              ],
              jsonReferences: [
                {
                  schema: "public",
                  table: "events",
                  column: "payload",
                  path: ["actor_id"],
                },
              ],
              signupDefaults: [
                {
                  table: { schema: "public", table: "profiles" },
                  identityColumn: "id",
                  ignoredColumns: ["created_at", "updated_at"],
                  values: {
                    display_name: {
                      kind: "pattern",
                      pattern: "^New account$",
                    },
                    avatar_path: null,
                  },
                },
              ],
              pathReferences: [],
              assets: [
                {
                  bucket: "avatars",
                  prefix: "11111111-1111-4111-8111-111111111111/",
                  rewritePath: false,
                },
              ],
              claims: { rehearsal_owner: true },
              tokenHook: {
                function: {
                  schema: "public",
                  name: "custom_access_token_hook",
                },
                expectedClaims: { app_role: "owner" },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
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

    executeCliOrThrow({
      cwd,
      label: "privacy key",
      args: ["privacy", "key", "--write", "--json"],
      environment: sourceEnvironment,
    });
    const accessPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "source plan",
        args: ["source", "plan", "--json"],
        environment: sourceEnvironment,
      }).stdout,
    ).data;
    const wrongAccess = executeCli({
      cwd,
      args: [
        "source",
        "apply",
        `--confirm-source-access=${"0".repeat(64)}`,
        "--json",
      ],
      environment: sourceEnvironment,
    });
    if (wrongAccess.status === 0) {
      throw new Error(
        "A wrong source-access digest unexpectedly changed the source.",
      );
    }
    executeCliOrThrow({
      cwd,
      label: "source apply",
      args: [
        "source",
        "apply",
        `--confirm-source-access=${accessPlan.digest}`,
        "--json",
      ],
      environment: sourceEnvironment,
    });
    const refreshed = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "baseline refresh",
        args: ["baseline", "refresh", "--json"],
      }).stdout,
    ).data;
    if (refreshed.manifest?.rowCount !== 1) {
      throw new Error("Standalone refresh did not stream the expected row.");
    }
    const dataFile = await readFile(
      join(
        cwd,
        ".rehearsal/generations",
        refreshed.generationId,
        "sanitized-data.ndjson",
      ),
      "utf8",
    );
    if (
      !dataFile.includes("Standalone safe widget") ||
      dataFile.includes("private-source-canary")
    ) {
      throw new Error("Standalone privacy transformation did not fail closed.");
    }
    const replacementPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "refresh preview",
        args: ["refresh", "--json"],
      }).stdout,
    ).data.plan;
    const wrongRefresh = executeCli({
      cwd,
      args: ["refresh", `--confirm-refresh=${"0".repeat(64)}`, "--json"],
    });
    if (wrongRefresh.status === 0) {
      throw new Error(
        "A wrong refresh digest unexpectedly changed the local copy.",
      );
    }
    const replacement = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "refresh and replace",
        args: [
          "refresh",
          `--confirm-refresh=${replacementPlan.digest}`,
          "--json",
        ],
      }).stdout,
    ).data;
    if (
      replacement.refreshed.generationId === refreshed.generationId ||
      replacement.cleanup.state !== "complete" ||
      !replacement.cleanup.removed.includes(refreshed.generationId)
    ) {
      throw new Error("Refresh did not replace and retire the prior baseline.");
    }
    const remainingGenerations = await readdir(
      join(cwd, ".rehearsal/generations"),
    );
    if (remainingGenerations.length !== 1) {
      throw new Error("Refresh did not honor one-generation retention.");
    }

    const retirement = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "source retirement preview",
        args: ["source", "retire", "--json"],
        environment: sourceEnvironment,
      }).stdout,
    ).data.plan;
    const wrongRetirement = executeCli({
      cwd,
      args: [
        "source",
        "retire",
        `--confirm-source-retirement=${"0".repeat(64)}`,
        "--json",
      ],
      environment: sourceEnvironment,
    });
    if (wrongRetirement.status === 0) {
      throw new Error(
        "A wrong source-retirement digest unexpectedly changed the source.",
      );
    }
    executeCliOrThrow({
      cwd,
      label: "source retirement",
      args: [
        "source",
        "retire",
        `--confirm-source-retirement=${retirement.digest}`,
        "--json",
      ],
      environment: sourceEnvironment,
    });

    const doctor = JSON.parse(
      executeCliOrThrow({ cwd, label: "doctor", args: ["doctor", "--json"] })
        .stdout,
    );
    if (doctor.data?.state !== "READY")
      throw new Error("Refreshed project is not READY.");
    const plan = JSON.parse(
      executeCliOrThrow({ cwd, label: "explain", args: ["explain", "--json"] })
        .stdout,
    ).data;
    const runResult = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "rehearsal run",
        args: [
          "run",
          `--confirm-candidates=${plan.migrations.candidateSha256}`,
          "--json",
        ],
      }).stdout,
    ).data;
    if (
      runResult.applicationReadiness?.status !== 204 ||
      runResult.httpProofResults?.length !== 2
    ) {
      throw new Error("Installed-package application proofs were incomplete.");
    }
    let applicationStillRunning = false;
    try {
      await fetch(`http://127.0.0.1:${applicationPort}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      applicationStillRunning = true;
    } catch {
      // The CLI owns the application process and must stop it after proofs.
    }
    if (applicationStillRunning) {
      throw new Error("Rehearsal left the fixture application running.");
    }
    const runtimeContainer = run(
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
        "--interactive",
        runtimeContainer,
        "psql",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      {
        cwd,
        input: `insert into auth.users (id, email, email_confirmed_at)
values ('22222222-2222-4222-8222-222222222222', '${approvedEmail}', now());
insert into auth.identities (user_id, provider, identity_data)
values ('22222222-2222-4222-8222-222222222222', 'google', '{"email":"${approvedEmail}","email_verified":true}');
insert into public.profiles (id, display_name, avatar_path)
values
  ('11111111-1111-4111-8111-111111111111', 'Synthetic owner', '11111111-1111-4111-8111-111111111111/avatar.webp'),
  ('22222222-2222-4222-8222-222222222222', 'New account', null);
insert into public.events (id, payload)
values (1, '{"actor_id":"11111111-1111-4111-8111-111111111111","avatar_path":"11111111-1111-4111-8111-111111111111/avatar.webp"}');
insert into storage.objects (owner_id, bucket_id, name)
values ('11111111-1111-4111-8111-111111111111', 'avatars', '11111111-1111-4111-8111-111111111111/avatar.webp');
`,
      },
    );
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
    const wrongIdentity = executeCli({
      cwd,
      args: [
        "identity",
        "claim",
        "--identity=approved-owner",
        `--confirm-identity=${"0".repeat(64)}`,
        "--json",
      ],
      environment: identityEnvironment,
    });
    if (wrongIdentity.status === 0) {
      throw new Error(
        "A wrong identity digest unexpectedly changed the runtime.",
      );
    }
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
    });
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
    );
    if (repeatedIdentity.data?.result?.idempotent !== true) {
      throw new Error("A repeated identity claim was not safely idempotent.");
    }
    const identityProof = run(
      "docker",
      [
        "exec",
        runtimeContainer,
        "psql",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        `select
          (select owner_id = '22222222-2222-4222-8222-222222222222' from public.widgets where id = 41)
          and exists(select 1 from public.profiles where id = '22222222-2222-4222-8222-222222222222' and display_name = 'Synthetic owner' and avatar_path = '11111111-1111-4111-8111-111111111111/avatar.webp')
          and (select payload->>'actor_id' = '22222222-2222-4222-8222-222222222222' from public.events where id = 1)
          and (select payload->>'avatar_path' = '11111111-1111-4111-8111-111111111111/avatar.webp' from public.events where id = 1)
          and exists(select 1 from public.app_role_assignments where user_id = '22222222-2222-4222-8222-222222222222' and role = 'owner')
          and exists(select 1 from storage.objects where owner_id = '22222222-2222-4222-8222-222222222222' and name = '11111111-1111-4111-8111-111111111111/avatar.webp')
          and (select raw_app_meta_data @> '{"rehearsal_owner":true}' from auth.users where id = '22222222-2222-4222-8222-222222222222');`,
      ],
      { cwd },
    ).trim();
    if (identityProof !== "t") {
      throw new Error("Installed-package identity association was incomplete.");
    }
    executeCliOrThrow({
      cwd,
      label: "post-association verification",
      args: ["verify", "--json"],
    });
    executeCliOrThrow({ cwd, label: "discard", args: ["discard", "--json"] });

    console.log(
      JSON.stringify(
        {
          status: "passed",
          fixture: "standalone-source-to-local-postgresql",
          installedPackage: `${packed.name}@${packed.version}`,
          sourceAccessRetired: true,
          refreshAndReplaceVerified: true,
          rawCanaryExcluded: true,
          runtimePolicyVerified: true,
          applicationLifecycleVerified: true,
          httpProofs: 2,
          identityAssociationVerified: true,
          candidateApplied: "20260101000100_add_widget_description.sql",
        },
        null,
        2,
      ),
    );
  } finally {
    if (projectId) {
      executeCli({ cwd, args: ["discard"] });
    }
    try {
      run("docker", ["rm", "--force", sourceName], { cwd });
    } catch {
      // The disposable source may already have been removed.
    }
    await removeBaselineArtifactRoot({
      artifactRoot: join(cwd, ".rehearsal"),
    }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

await main();
