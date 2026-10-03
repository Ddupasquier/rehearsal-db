import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceAccessPlan,
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
});
