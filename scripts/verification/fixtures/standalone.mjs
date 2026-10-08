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
  const primaryStateDirectory = "targets/primary/.rehearsal";
  const primaryArtifactRoot = join(cwd, primaryStateDirectory);
  const publicationStateDirectory = "targets/publication/.rehearsal";
  const publicationArtifactRoot = join(cwd, publicationStateDirectory);
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
  provider_id text,
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
create schema audit;
create table audit.entries (
  id bigint primary key,
  message text not null
);
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
    const approvedOwnerId = "11111111-1111-4111-8111-111111111111";
    const sourceAdminUrl = `postgresql://postgres:${sourcePassword}@127.0.0.1:${sourcePort}/postgres`;
    const sourceEnvironment = {
      REHEARSAL_SOURCE_ADMIN_URL: sourceAdminUrl,
      REHEARSAL_APPROVED_OWNER_ID: approvedOwnerId,
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
insert into audit.entries (id, message)
values (7, 'private-audit-canary');
insert into public.profiles (id, display_name, avatar_path, created_at, updated_at)
values (
  '${approvedOwnerId}',
  'private-approved-owner-name',
  '${approvedOwnerId}/avatar.png',
  '2026-01-01T00:00:00Z',
  '2026-01-01T01:00:00Z'
);
`,
      },
    );

    const configPath = join(cwd, "rehearsal.config.mjs");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8"))
        .replaceAll("rehearsal-postgresql-fixture", projectId)
        .replace(
          'runtimeWorkdir: ".rehearsal/runtime"',
          `runtimeWorkdir: "${primaryStateDirectory}/runtime"`,
        )
        .replace(
          'artifactDirectory: ".rehearsal"',
          `artifactDirectory: "${primaryStateDirectory}"`,
        )
        .replace("databasePort: 59422", `databasePort: ${ports.database}`)
        .replace(
          "  application: {",
          `  preparation: {
    sourcePolicy: "rehearsal/source-access-policy.json",
    privacyKey: "${primaryStateDirectory}/secrets/privacy.key",
    batchRows: 257,
    maximumRows: 20000,
    maximumBytes: 33554432,
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
    environmentFile: "${primaryStateDirectory}/runtime.env",
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
        "select count(*) >= 2 and exists (select 1 from public.widgets where id = 99 and name = 'Local fixture row') and exists",
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
            mode: "managed",
            role: `rehearsal_reader_${process.pid}`,
            ownerRole: `rehearsal_owner_${process.pid}`,
            credentialFile: `${primaryStateDirectory}/secrets/source-reader.env`,
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
            {
              source: { schema: "audit", table: "entries" },
              view: "audit_entries",
              targetSchema: "audit",
              targetTable: "entries",
              columns: ["id", "message"],
              orderBy: ["id"],
              rowScope: { kind: "approved-public" },
            },
            {
              source: { schema: "public", table: "profiles" },
              view: "approved_owner_profiles",
              targetTable: "profiles",
              columns: [
                "id",
                "display_name",
                "avatar_path",
                "created_at",
                "updated_at",
              ],
              orderBy: ["id"],
              rowScope: {
                kind: "approved-owner",
                column: "id",
                valueEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
              },
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
          bindings: {
            "approved-owner": {
              environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
              approvedValueSha256: createHash("sha256")
                .update(approvedOwnerId)
                .digest("hex"),
            },
          },
          pathMappings: {
            "owner-storage": {
              binding: "approved-owner",
              format: "uuid",
              namespace: "account-id",
              maximumBytes: 512,
              maximumSegments: 4,
            },
          },
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
            {
              schema: "audit",
              name: "entries",
              sourceRows: "STREAM AND SANITIZE",
              columns: [
                {
                  name: "id",
                  action: "KEEP",
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
                {
                  name: "message",
                  action: "REPLACE",
                  recipe: { kind: "constant", value: "Safe audit event" },
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
              ],
            },
            {
              name: "profiles",
              sourceRows: "STREAM AND SANITIZE",
              ownerBinding: {
                binding: "approved-owner",
                column: "id",
              },
              columns: [
                {
                  name: "id",
                  action: "PSEUDONYMIZE",
                  recipe: { format: "uuid", namespace: "account-id" },
                  generated: "NEVER",
                  identity: "YES",
                  foreignKey: null,
                },
                {
                  name: "display_name",
                  action: "DERIVE",
                  recipe: {
                    kind: "approved-owner",
                    approved: { action: "KEEP" },
                    otherwise: {
                      action: "REPLACE",
                      recipe: {
                        kind: "constant",
                        value: "Synthetic profile",
                      },
                    },
                  },
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
                {
                  name: "avatar_path",
                  action: "DERIVE",
                  recipe: { kind: "path-map", mapping: "owner-storage" },
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
                {
                  name: "created_at",
                  action: "DERIVE",
                  recipe: {
                    kind: "date-shift",
                    days: 7,
                    group: "profile-time",
                  },
                  generated: "NEVER",
                  identity: "NO",
                  foreignKey: null,
                },
                {
                  name: "updated_at",
                  action: "DERIVE",
                  recipe: {
                    kind: "date-shift",
                    days: 7,
                    group: "profile-time",
                  },
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
    const approvedSubject = "github-account-847291";
    await writeFile(
      join(cwd, "rehearsal/identity-policy.json"),
      `${JSON.stringify(
        {
          identityVersion: 1,
          identities: [
            {
              name: "approved-owner",
              matcher: {
                type: "provider-subject",
                provider: "github",
                subjectEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_SUBJECT",
                approvedSubjectSha256: createHash("sha256")
                  .update(approvedSubject)
                  .digest("hex"),
              },
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
    await writeFile(
      join(cwd, "installed-cleanup-proof.mjs"),
      `import assert from "node:assert/strict";
import { mkdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createAndActivateBaseline,
  listIncompleteBaselineBuilds,
  removeBaselineArtifactRoot,
} from "@rehearsal-db/core/baseline";

const proofRoot = join(process.cwd(), "cleanup-proof");
const artifactRoot = join(proofRoot, ".rehearsal");
await mkdir(proofRoot, { recursive: true });
const metadata = {
  migrationCutoff: "20260101000000",
  migrationHistorySha256: "a".repeat(64),
  sanitizationPolicySha256: "b".repeat(64),
};
try {
  await createAndActivateBaseline({
    artifactRoot,
    generationId: "20261004T120000Z-131313131313",
    metadata,
    records: [],
  });
  const before = await readlink(join(artifactRoot, "current"));
  async function* failingAssets() {
    yield {
      bucket: "avatars",
      objectPath: "safe/avatar.png",
      content: Buffer.from("safe asset"),
    };
    throw new Error("Synthetic Storage response was HTTP 503.");
  }
  await assert.rejects(
    createAndActivateBaseline({
      artifactRoot,
      generationId: "20261004T120100Z-141414141414",
      metadata,
      records: [],
      migrationFiles: [{
        filename: "20260101000000_baseline.sql",
        content: "create table public.fixture(id bigint);\\n",
      }],
      assets: failingAssets(),
    }),
    /Storage response was HTTP 503/,
  );
  assert.equal(await readlink(join(artifactRoot, "current")), before);
  assert.deepEqual(await listIncompleteBaselineBuilds({ artifactRoot }), []);
} finally {
  await removeBaselineArtifactRoot({ artifactRoot }).catch(() => undefined);
  await rm(proofRoot, { recursive: true, force: true });
}
`,
    );
    run(process.execPath, ["installed-cleanup-proof.mjs"], { cwd });

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
        environment: sourceEnvironment,
      }).stdout,
    ).data;
    if (refreshed.manifest?.rowCount !== 3) {
      throw new Error(
        "Standalone refresh did not stream both schemas and the approved UUID owner.",
      );
    }
    const dataFile = await readFile(
      join(
        cwd,
        `${primaryStateDirectory}/generations`,
        refreshed.generationId,
        "sanitized-data.ndjson",
      ),
      "utf8",
    );
    if (
      !dataFile.includes("Standalone safe widget") ||
      !dataFile.includes("Safe audit event") ||
      dataFile.includes("private-source-canary") ||
      dataFile.includes("private-audit-canary")
    ) {
      throw new Error("Standalone privacy transformation did not fail closed.");
    }
    const sanitizedProfile = dataFile
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((record) => record.table === "profiles");
    if (
      !sanitizedProfile ||
      sanitizedProfile.row.id === approvedOwnerId ||
      sanitizedProfile.row.avatar_path !==
        `${sanitizedProfile.row.id}/avatar.png` ||
      Date.parse(sanitizedProfile.row.updated_at) -
        Date.parse(sanitizedProfile.row.created_at) !==
        60 * 60 * 1_000
    ) {
      throw new Error(
        "Standalone UUID owner, Storage path, or grouped timestamps were not sanitized coherently.",
      );
    }
    const replacementPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "refresh preview",
        args: ["refresh", "--json"],
        environment: sourceEnvironment,
      }).stdout,
    ).data.plan;
    const wrongRefresh = executeCli({
      cwd,
      args: ["refresh", `--confirm-refresh=${"0".repeat(64)}`, "--json"],
      environment: sourceEnvironment,
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
        environment: sourceEnvironment,
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
      join(primaryArtifactRoot, "generations"),
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
        input: `insert into public.widgets (id, name, created_at, owner_id)
overriding system value
select generated_id,
       'private-source-row-' || generated_id,
       '2026-01-01T00:00:00Z'::timestamptz + (generated_id || ' seconds')::interval,
       '11111111-1111-4111-8111-111111111111'::uuid
from generate_series(1000, 10999) generated_id;
`,
      },
    );

    const externalReader = `provided_reader_${process.pid}`;
    const externalReaderGroup = `provided_reader_group_${process.pid}`;
    const externalOwner = `provided_owner_${process.pid}`;
    const externalSchema = `provided_export_${process.pid}`;
    const externalPassword = "synthetic-external-reader-password";
    const externalExpiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
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
        input: `create role ${externalOwner}
nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role ${externalReader}
login password '${externalPassword}' valid until '${externalExpiresAt}'
inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role ${externalReaderGroup}
nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create schema ${externalSchema} authorization ${externalOwner};
revoke all on schema ${externalSchema} from public;
grant usage on schema public to ${externalOwner};
grant usage on schema audit to ${externalOwner};
grant select (id, name, created_at, owner_id) on public.widgets to ${externalOwner};
grant select (id, message) on audit.entries to ${externalOwner};
grant select (id, display_name, avatar_path, created_at, updated_at) on public.profiles to ${externalOwner};
set role ${externalOwner};
create view ${externalSchema}.widgets with (security_barrier = true) as
select id, name, created_at, owner_id from public.widgets;
create view ${externalSchema}.audit_entries with (security_barrier = true) as
select id, message from audit.entries;
create view ${externalSchema}.approved_owner_profiles with (security_barrier = true) as
select id, display_name, avatar_path, created_at, updated_at
from public.profiles
where id = '${approvedOwnerId}'::uuid;
reset role;
revoke all on ${externalSchema}.widgets from public;
revoke all on ${externalSchema}.audit_entries from public;
revoke all on ${externalSchema}.approved_owner_profiles from public;
grant usage on schema ${externalSchema} to ${externalReaderGroup};
grant select on ${externalSchema}.widgets to ${externalReaderGroup};
grant select on ${externalSchema}.audit_entries to ${externalReaderGroup};
grant select on ${externalSchema}.approved_owner_profiles to ${externalReaderGroup};
grant usage on schema supabase_migrations to ${externalReaderGroup};
grant select (version, name, statements)
on supabase_migrations.schema_migrations to ${externalReaderGroup};
grant ${externalReaderGroup} to ${externalReader}
with inherit true, set false, admin false;
`,
      },
    );
    const canonicalViewDefinition = run(
      "docker",
      [
        "exec",
        sourceName,
        "psql",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        `select pg_get_viewdef('${externalSchema}.widgets'::regclass, false)`,
      ],
      { cwd },
    ).trim();
    const externalViewFingerprint = run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { externalViewDefinitionFingerprint } from "@rehearsal-db/core/source-access";
process.stdout.write(externalViewDefinitionFingerprint(process.env.REHEARSAL_VIEW_DEFINITION));`,
      ],
      {
        cwd,
        environment: {
          REHEARSAL_VIEW_DEFINITION: canonicalViewDefinition,
        },
      },
    );
    const canonicalAuditViewDefinition = run(
      "docker",
      [
        "exec",
        sourceName,
        "psql",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        `select pg_get_viewdef('${externalSchema}.audit_entries'::regclass, false)`,
      ],
      { cwd },
    ).trim();
    const externalAuditViewFingerprint = run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { externalViewDefinitionFingerprint } from "@rehearsal-db/core/source-access";
process.stdout.write(externalViewDefinitionFingerprint(process.env.REHEARSAL_VIEW_DEFINITION));`,
      ],
      {
        cwd,
        environment: {
          REHEARSAL_VIEW_DEFINITION: canonicalAuditViewDefinition,
        },
      },
    );
    const canonicalProfileViewDefinition = run(
      "docker",
      [
        "exec",
        sourceName,
        "psql",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        `select pg_get_viewdef('${externalSchema}.approved_owner_profiles'::regclass, false)`,
      ],
      { cwd },
    ).trim();
    const externalProfileViewFingerprint = run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { externalViewDefinitionFingerprint } from "@rehearsal-db/core/source-access";
process.stdout.write(externalViewDefinitionFingerprint(process.env.REHEARSAL_VIEW_DEFINITION));`,
      ],
      {
        cwd,
        environment: {
          REHEARSAL_VIEW_DEFINITION: canonicalProfileViewDefinition,
        },
      },
    );
    const externalReaderUrl = `postgresql://${externalReader}:${externalPassword}@127.0.0.1:${sourcePort}/postgres`;
    const publicationConfig = "publication.rehearsal.config.mjs";
    await writeFile(
      join(cwd, publicationConfig),
      (await readFile(configPath, "utf8")).replaceAll(
        primaryStateDirectory,
        publicationStateDirectory,
      ),
    );
    await writeFile(
      join(cwd, "rehearsal/source-access-policy.json"),
      `${JSON.stringify(
        {
          accessVersion: 1,
          targetFingerprint: sourceTargetFingerprint(externalReaderUrl),
          reader: {
            mode: "external",
            role: externalReader,
            allowedMemberships: [externalReaderGroup],
            connectionEnvironmentVariable: "REHEARSAL_SOURCE_READER_URL",
            credentialFile: `${publicationStateDirectory}/secrets/source-reader.env`,
            maximumValidForMinutes: 30,
          },
          exportSchema: externalSchema,
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
              viewDefinitionSha256: externalViewFingerprint,
            },
            {
              source: { schema: "audit", table: "entries" },
              view: "audit_entries",
              targetSchema: "audit",
              targetTable: "entries",
              columns: ["id", "message"],
              orderBy: ["id"],
              rowScope: { kind: "approved-public" },
              viewDefinitionSha256: externalAuditViewFingerprint,
            },
            {
              source: { schema: "public", table: "profiles" },
              view: "approved_owner_profiles",
              targetTable: "profiles",
              columns: [
                "id",
                "display_name",
                "avatar_path",
                "created_at",
                "updated_at",
              ],
              orderBy: ["id"],
              rowScope: {
                kind: "approved-owner",
                column: "id",
                valueEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
              },
              viewDefinitionSha256: externalProfileViewFingerprint,
            },
          ],
          assets: [],
        },
        null,
        2,
      )}\n`,
    );
    const externalEnvironment = {
      REHEARSAL_SOURCE_READER_URL: externalReaderUrl,
      REHEARSAL_APPROVED_OWNER_ID: approvedOwnerId,
    };
    executeCliOrThrow({
      cwd,
      label: "publication privacy key",
      args: [
        "privacy",
        "key",
        "--write",
        "--json",
        `--config=${publicationConfig}`,
      ],
      environment: externalEnvironment,
    });
    const externalPolicyPath = join(cwd, "rehearsal/source-access-policy.json");
    const groupedExternalPolicy = JSON.parse(
      await readFile(externalPolicyPath, "utf8"),
    );
    const undeclaredMembershipPolicy = structuredClone(groupedExternalPolicy);
    undeclaredMembershipPolicy.reader.allowedMemberships = [];
    await writeFile(
      externalPolicyPath,
      `${JSON.stringify(undeclaredMembershipPolicy, null, 2)}\n`,
    );
    const undeclaredMembershipPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "undeclared membership source plan",
        args: ["source", "plan", "--json", `--config=${publicationConfig}`],
        environment: externalEnvironment,
      }).stdout,
    ).data;
    const undeclaredMembershipRefusal = executeCli({
      cwd,
      args: [
        "source",
        "apply",
        `--confirm-source-access=${undeclaredMembershipPlan.digest}`,
        "--json",
        `--config=${publicationConfig}`,
      ],
      environment: externalEnvironment,
    });
    const undeclaredMembershipFailure = JSON.parse(
      undeclaredMembershipRefusal.stdout,
    ).error;
    if (
      undeclaredMembershipRefusal.status !== 3 ||
      undeclaredMembershipFailure?.category !== "unsafe_environment" ||
      undeclaredMembershipFailure?.code !== "SOURCE_AUTHORIZATION_REFUSED"
    ) {
      throw new Error(
        "An undeclared external role membership did not produce the expected source-authorization refusal.",
      );
    }
    await writeFile(
      externalPolicyPath,
      `${JSON.stringify(groupedExternalPolicy, null, 2)}\n`,
    );
    const externalPlan = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "external source plan",
        args: ["source", "plan", "--json", `--config=${publicationConfig}`],
        environment: externalEnvironment,
      }).stdout,
    ).data;
    if (externalPlan.review?.reader?.sourceChanges !== false) {
      throw new Error("External source plan claimed source-side changes.");
    }
    executeCliOrThrow({
      cwd,
      label: "external source verification",
      args: [
        "source",
        "apply",
        `--confirm-source-access=${externalPlan.digest}`,
        "--json",
        `--config=${publicationConfig}`,
      ],
      environment: externalEnvironment,
    });
    const externalRefresh = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "external baseline refresh",
        args: [
          "baseline",
          "refresh",
          "--json",
          `--config=${publicationConfig}`,
        ],
        environment: externalEnvironment,
      }).stdout,
    ).data;
    if (externalRefresh.manifest?.rowCount !== 10_003) {
      throw new Error(
        "External reader did not stream the expected 10,003 rows across two schemas and a UUID owner.",
      );
    }
    const externalRetirement = JSON.parse(
      executeCliOrThrow({
        cwd,
        label: "external source retirement preview",
        args: ["source", "retire", "--json", `--config=${publicationConfig}`],
      }).stdout,
    ).data.plan;
    executeCliOrThrow({
      cwd,
      label: "external local source retirement",
      args: [
        "source",
        "retire",
        `--confirm-source-retirement=${externalRetirement.digest}`,
        "--json",
        `--config=${publicationConfig}`,
      ],
    });
    const providerResourcesPreserved = run(
      "docker",
      [
        "exec",
        sourceName,
        "psql",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        `select exists(select 1 from pg_roles where rolname = '${externalReader}')
          and exists(select 1 from pg_roles where rolname = '${externalReaderGroup}')
          and exists(select 1 from pg_roles where rolname = '${externalOwner}')
          and to_regclass('${externalSchema}.widgets') is not null
          and to_regclass('${externalSchema}.audit_entries') is not null
          and to_regclass('${externalSchema}.approved_owner_profiles') is not null`,
      ],
      { cwd },
    ).trim();
    if (providerResourcesPreserved !== "t") {
      throw new Error(
        "External retirement changed provider-owned source objects.",
      );
    }

    // Continue the runtime proof against the second target's independently
    // refreshed baseline. Both target roots remain present until final cleanup.
    await writeFile(configPath, await readFile(join(cwd, publicationConfig)));

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
    const generatedIdentity = Number(
      run(
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
          "insert into public.widgets (name, created_at) values ('sequence-proof', now()) returning id",
        ],
        { cwd },
      ).trim(),
    );
    if (
      !Number.isSafeInteger(generatedIdentity) ||
      generatedIdentity <= 10_999
    ) {
      throw new Error(
        "The genuine numeric identity sequence was not advanced after restore.",
      );
    }
    run(
      "docker",
      [
        "exec",
        runtimeContainer,
        "psql",
        "--quiet",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        `delete from public.widgets where id = ${generatedIdentity}`,
      ],
      { cwd },
    );
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
values ('22222222-2222-4222-8222-222222222222', '${approvedEmail}', null);
insert into auth.identities (user_id, provider, provider_id, identity_data)
values ('22222222-2222-4222-8222-222222222222', 'github', '${approvedSubject}', '{"sub":"${approvedSubject}","email":"${approvedEmail}","email_verified":false}');
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
      REHEARSAL_APPROVED_OWNER_SUBJECT: approvedSubject,
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
      JSON.stringify(identityPlan).includes(approvedSubject) ||
      identityPlan.review?.matcher?.type !== "provider-subject" ||
      identityPlan.review?.matcher?.provider !== "github"
    ) {
      throw new Error(
        "The installed identity plan exposed or misclassified the reviewed provider subject.",
      );
    }
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
    const unverifiedIdentity = executeCli({
      cwd,
      args: [
        "identity",
        "claim",
        "--identity=approved-owner",
        `--confirm-identity=${identityPlan.digest}`,
        "--json",
      ],
      environment: identityEnvironment,
    });
    const unverifiedOutput = `${unverifiedIdentity.stdout}\n${unverifiedIdentity.stderr}`;
    if (
      unverifiedIdentity.status === 0 ||
      !unverifiedOutput.includes("No verified local identity")
    ) {
      throw new Error(
        "An unverified provider subject was not refused before account transfer.",
      );
    }
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
        input: `update auth.users
set email_confirmed_at = now()
where id = '22222222-2222-4222-8222-222222222222';
`,
      },
    );
    const claimedIdentity = JSON.parse(
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
    );
    if (claimedIdentity.data?.result?.provider !== "github") {
      throw new Error(
        "The installed identity claim did not record the matched GitHub provider.",
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
          externalReaderVerified: true,
          externalReaderMembershipVerified: true,
          externalMembershipRefusalVerified: true,
          externalProviderResourcesPreserved: true,
          isolatedSourceStateRootsVerified: 2,
          streamedRows: 10_003,
          unrelatedTargetSchemasVerified: 2,
          legacyApprovedOwnerUuidRestoreVerified: true,
          numericIdentitySequenceVerified: true,
          failedAssetCleanupVerified: true,
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
      artifactRoot: primaryArtifactRoot,
    }).catch(() => undefined);
    await removeBaselineArtifactRoot({
      artifactRoot: publicationArtifactRoot,
    }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

await main();
