import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceAccessPlan,
  externalViewDefinitionFingerprint,
  sourceTargetFingerprint,
} from "../../../src/source/access.mjs";
import {
  applyPostgresqlSourceAccess,
  planPostgresqlSourceAccessRetirement,
  retirePostgresqlSourceAccess,
} from "../../../src/source/postgresql_access.mjs";

const roots = [];
const administratorUrl =
  "postgresql://administrator:admin-secret@127.0.0.1:55432/source_fixture";
const environment = {
  REHEARSAL_SOURCE_ADMIN_URL: administratorUrl,
  REHEARSAL_APPROVED_OWNER_ID: "owner-secret-id",
};
const policy = {
  accessVersion: 1,
  targetFingerprint: sourceTargetFingerprint(administratorUrl),
  administratorEnvironmentVariable: "REHEARSAL_SOURCE_ADMIN_URL",
  reader: {
    role: "rehearsal_fixture_reader",
    ownerRole: "rehearsal_fixture_owner",
    credentialFile: ".rehearsal/secrets/source-reader.env",
    validForMinutes: 15,
  },
  exportSchema: "rehearsal_export_fixture",
  migrationLedger: {
    schema: "supabase_migrations",
    table: "schema_migrations",
    versionColumn: "version",
    nameColumn: "name",
    statementsColumn: "statements",
  },
  relations: [
    {
      source: { schema: "private", table: "profiles" },
      view: "approved_owner_profile",
      targetTable: "profiles",
      columns: ["id", "email"],
      orderBy: ["id"],
      rowScope: {
        kind: "approved-owner",
        column: "id",
        valueEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
      },
    },
  ],
};

const externalUrl =
  "postgresql://provided_reader:reader-secret@127.0.0.1:55432/source_fixture";
const externalEnvironment = {
  REHEARSAL_SOURCE_READER_URL: externalUrl,
};
const externalPolicy = {
  accessVersion: 1,
  targetFingerprint: sourceTargetFingerprint(externalUrl),
  reader: {
    mode: "external",
    role: "provided_reader",
    connectionEnvironmentVariable: "REHEARSAL_SOURCE_READER_URL",
    credentialFile: ".rehearsal/secrets/source-reader.env",
    maximumValidForMinutes: 30,
  },
  exportSchema: "provided_export",
  migrationLedger: policy.migrationLedger,
  relations: [
    {
      source: { schema: "private", table: "profiles" },
      view: "approved_profiles",
      targetTable: "profiles",
      columns: ["id", "email"],
      orderBy: ["id"],
      rowScope: { kind: "approved-public" },
      viewDefinitionSha256: externalViewDefinitionFingerprint(
        "select id, email from private.profiles",
      ),
    },
  ],
};

const provisioningClient = () => {
  const queries = [];
  return {
    queries,
    async connect() {},
    async end() {},
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes("schema_exists")) {
        return {
          rows: [
            { schema_exists: false, reader_exists: false, owner_exists: false },
          ],
        };
      }
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ column_name: "id" }, { column_name: "email" }] };
      }
      if (sql.includes("has_table_privilege")) {
        return {
          rows: [
            {
              can_select: false,
              can_insert: false,
              can_update: false,
              can_delete: false,
            },
          ],
        };
      }
      if (sql.includes("pg_has_role")) {
        return { rows: [{ owner_member: false, privileged: false }] };
      }
      if (sql.includes("pg_proc")) return { rows: [{ exposed: 0 }] };
      return { rows: [] };
    },
  };
};

const externalReaderClient = ({
  expiresAt = "2026-10-02T12:20:00.000Z",
  extraReadable = false,
  memberships = 0,
  viewDefinition = "select id, email from private.profiles",
  securityBarrier = true,
  privileged = false,
  writePrivileges = 0,
  securityDefiners = 0,
  viewOwner = "provided_export_owner",
} = {}) => {
  const queries = [];
  return {
    queries,
    async connect() {},
    async end() {},
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes("from pg_roles where rolname = current_user")) {
        return {
          rows: [
            {
              role: "provided_reader",
              rolcanlogin: true,
              rolvaliduntil: expiresAt,
              rolsuper: privileged,
              rolcreaterole: false,
              rolcreatedb: false,
              rolreplication: false,
              rolbypassrls: false,
            },
          ],
        };
      }
      if (sql.includes("from pg_auth_members")) {
        return { rows: [{ count: memberships }] };
      }
      if (sql.includes("has_database_privilege")) {
        return { rows: [{ count: writePrivileges }] };
      }
      if (sql.includes("from pg_namespace")) {
        return { rows: [{ count: writePrivileges }] };
      }
      if (sql.includes("has_table_privilege")) {
        return { rows: [{ count: writePrivileges }] };
      }
      if (sql.includes("has_sequence_privilege")) {
        return { rows: [{ count: writePrivileges }] };
      }
      if (sql.includes("'INSERT'") && sql.includes("has_column_privilege")) {
        return { rows: [{ count: writePrivileges }] };
      }
      if (sql.includes("'SELECT'") && sql.includes("has_column_privilege")) {
        return {
          rows: [
            {
              schema: "provided_export",
              relation: "approved_profiles",
              column: "id",
            },
            {
              schema: "provided_export",
              relation: "approved_profiles",
              column: "email",
            },
            {
              schema: "supabase_migrations",
              relation: "schema_migrations",
              column: "version",
            },
            {
              schema: "supabase_migrations",
              relation: "schema_migrations",
              column: "name",
            },
            {
              schema: "supabase_migrations",
              relation: "schema_migrations",
              column: "statements",
            },
            ...(extraReadable
              ? [{ schema: "private", relation: "secrets", column: "value" }]
              : []),
          ],
        };
      }
      if (sql.includes("pg_get_viewdef")) {
        return {
          rows: [
            {
              definition: viewDefinition,
              reloptions: securityBarrier ? ["security_barrier=true"] : [],
              owner: viewOwner,
            },
          ],
        };
      }
      if (sql.includes("from pg_proc")) {
        return { rows: [{ count: securityDefiners }] };
      }
      return { rows: [] };
    },
  };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("PostgreSQL source access lifecycle", () => {
  it("applies and retires only exact reviewed resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-source-access-"));
    roots.push(root);
    const plan = createSourceAccessPlan({
      policy,
      environment,
      now: new Date("2026-10-02T12:00:00.000Z"),
    });
    const provisioned = provisioningClient();
    const applied = await applyPostgresqlSourceAccess({
      plan,
      confirmation: plan.digest,
      projectRoot: root,
      environment,
      clientFactory: async () => provisioned,
      now: new Date("2026-10-02T12:00:00.000Z"),
    });

    const credential = await readFile(applied.credentialPath, "utf8");
    const receipt = await readFile(applied.receiptPath, "utf8");
    expect(credential).toContain("rehearsal_fixture_reader");
    expect(credential).not.toContain("admin-secret");
    expect(receipt).not.toContain("owner-secret-id");
    expect(JSON.parse(receipt).expiresAt).toBe("2026-10-02T12:15:00.000Z");
    expect(
      provisioned.queries.some(({ sql }) =>
        sql.includes(
          'create view "rehearsal_export_fixture"."approved_owner_profile"',
        ),
      ),
    ).toBe(true);

    const retirement = await planPostgresqlSourceAccessRetirement({
      projectRoot: root,
      targetFingerprint: policy.targetFingerprint,
    });
    const retired = provisioningClient();
    retired.query = async (sql, parameters = []) => {
      retired.queries.push({ sql, parameters });
      if (sql.includes("from pg_class")) {
        return {
          rows: [
            {
              relname: "approved_owner_profile",
              schema_comment: `rehearsal-source-access:${retirement.review.preparationDigest}`,
            },
          ],
        };
      }
      if (sql.includes("schema_exists")) {
        return {
          rows: [
            {
              schema_exists: false,
              reader_exists: false,
              owner_exists: false,
            },
          ],
        };
      }
      return { rows: [] };
    };
    await retirePostgresqlSourceAccess({
      plan: retirement,
      confirmation: retirement.digest,
      administratorEnvironmentVariable: policy.administratorEnvironmentVariable,
      projectRoot: root,
      environment,
      credentialFile: policy.reader.credentialFile,
      clientFactory: async () => retired,
    });
    await expect(
      readFile(applied.credentialPath, "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(retired.queries.some(({ sql }) => sql.includes("drop role"))).toBe(
      true,
    );
    expect(JSON.stringify(retired.queries)).not.toContain("unrelated_role");
    await expect(
      planPostgresqlSourceAccessRetirement({
        projectRoot: root,
        targetFingerprint: policy.targetFingerprint,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to adopt existing source resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-source-access-"));
    roots.push(root);
    const plan = createSourceAccessPlan({ policy, environment });
    const client = provisioningClient();
    client.query = async (sql, parameters = []) => {
      client.queries.push({ sql, parameters });
      if (sql.includes("schema_exists")) {
        return {
          rows: [
            { schema_exists: true, reader_exists: false, owner_exists: false },
          ],
        };
      }
      return { rows: [] };
    };
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment,
        clientFactory: async () => client,
      }),
    ).rejects.toThrow("will not overwrite or adopt");
  });

  it("preserves existing local source-access files on repeated apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-source-access-"));
    roots.push(root);
    const credentialPath = join(root, policy.reader.credentialFile);
    const receiptPath = join(root, ".rehearsal/source-access-receipt.json");
    await mkdir(join(root, ".rehearsal/secrets"), { recursive: true });
    await writeFile(credentialPath, "existing-credential\n");
    await writeFile(receiptPath, "existing-receipt\n");
    const plan = createSourceAccessPlan({ policy, environment });

    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment,
        clientFactory: async () => {
          throw new Error("database must not be reached");
        },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(credentialPath, "utf8")).toBe(
      "existing-credential\n",
    );
    expect(await readFile(receiptPath, "utf8")).toBe("existing-receipt\n");
  });

  it("refuses an owner scope that changed after preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-source-access-"));
    roots.push(root);
    const plan = createSourceAccessPlan({ policy, environment });
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: {
          ...environment,
          REHEARSAL_APPROVED_OWNER_ID: "different-owner",
        },
        clientFactory: async () => provisioningClient(),
      }),
    ).rejects.toThrow("scope changed after");
  });

  it("rolls back interrupted managed provisioning without local credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-source-access-"));
    roots.push(root);
    const plan = createSourceAccessPlan({ policy, environment });
    const client = provisioningClient();
    const baseQuery = client.query.bind(client);
    client.query = async (sql, parameters = []) => {
      if (sql.includes("create view")) {
        client.queries.push({ sql, parameters });
        throw new Error("synthetic interrupted provisioning");
      }
      return baseQuery(sql, parameters);
    };

    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment,
        clientFactory: async () => client,
      }),
    ).rejects.toThrow("synthetic interrupted provisioning");
    await expect(
      readFile(join(root, policy.reader.credentialFile), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, ".rehearsal/source-access-receipt.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.queries.some(({ sql }) => sql === "rollback")).toBe(true);
  });

  it("verifies and locally retires an external reader without source writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-external-reader-"));
    roots.push(root);
    const plan = createSourceAccessPlan({
      policy: externalPolicy,
      environment: externalEnvironment,
    });
    const client = externalReaderClient();
    const applied = await applyPostgresqlSourceAccess({
      plan,
      confirmation: plan.digest,
      projectRoot: root,
      environment: externalEnvironment,
      clientFactory: async () => client,
      now: new Date("2026-10-02T12:00:00.000Z"),
    });

    expect(applied.receipt).toMatchObject({
      accessMode: "external",
      readerRole: "provided_reader",
      expiresAt: "2026-10-02T12:20:00.000Z",
    });
    expect(await readFile(applied.credentialPath, "utf8")).toContain(
      "provided_reader",
    );
    expect(
      client.queries.some(({ sql }) => /create\s+(?:role|view)/iu.test(sql)),
    ).toBe(false);

    const retirement = await planPostgresqlSourceAccessRetirement({
      projectRoot: root,
      targetFingerprint: externalPolicy.targetFingerprint,
    });
    expect(retirement.review.accessMode).toBe("external");
    await retirePostgresqlSourceAccess({
      plan: retirement,
      confirmation: retirement.digest,
      projectRoot: root,
      credentialFile: externalPolicy.reader.credentialFile,
      clientFactory: async () => {
        throw new Error("external retirement must not connect to the source");
      },
    });
    await expect(
      readFile(applied.credentialPath, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses broad or insufficiently short-lived external readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-external-reader-"));
    roots.push(root);
    const plan = createSourceAccessPlan({
      policy: externalPolicy,
      environment: externalEnvironment,
    });
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({ extraReadable: true }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("do not exactly match");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({ expiresAt: "2026-10-02T13:00:00.000Z" }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("expiration within the reviewed limit");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({ expiresAt: "2026-10-02T11:59:00.000Z" }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("expiration within the reviewed limit");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () => externalReaderClient({ memberships: 1 }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("belongs to another database role");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({
            viewDefinition:
              "select id, email from private.profiles where false",
          }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("view definition does not match");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({ securityBarrier: false }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("must enable PostgreSQL security_barrier");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () => externalReaderClient({ writePrivileges: 1 }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("write or sequence privileges");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () => externalReaderClient({ privileged: true }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("privileged role attributes");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({ securityDefiners: 1 }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("security-definer function");
    await expect(
      applyPostgresqlSourceAccess({
        plan,
        confirmation: plan.digest,
        projectRoot: root,
        environment: externalEnvironment,
        clientFactory: async () =>
          externalReaderClient({ viewOwner: "provided_reader" }),
        now: new Date("2026-10-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("must not own an export view");
  });
});
