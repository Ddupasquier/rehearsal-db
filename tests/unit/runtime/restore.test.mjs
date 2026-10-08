import { describe, expect, it } from "vitest";
import {
  buildRestoreSqlPrefix,
  buildRestoreSqlSuffix,
  createCandidateMigrationReceipt,
  encodeBaselineRecordForCopy,
  summarizeRestoreError,
} from "../../../dist/src/runtime/restore.mjs";

const manifest = {
  tables: [
    {
      name: "profiles",
      sourceRows: "STREAM AND SANITIZE",
      columns: [
        {
          name: "user_id",
          action: "PSEUDONYMIZE",
          generated: "NEVER",
          identity: "NO",
          foreignKey: { schema: "auth", table: "users", column: "id" },
        },
        {
          name: "display_name",
          action: "REPLACE WITH SYNTHETIC",
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
        {
          name: "search_vector",
          action: "DERIVE",
          generated: "ALWAYS",
          identity: "NO",
          foreignKey: null,
        },
      ],
    },
  ],
};

describe("Rehearsal runtime restore", () => {
  it("reports a constraint location without returning rejected row contents", () => {
    const stderr = [
      'ERROR:  new row for relation "safe_table" violates check constraint "safe_reason_check"',
      "DETAIL:  Failing row contains (private-person@example.com, secret value).",
    ].join("\n");
    expect(summarizeRestoreError(stderr)).toBe(
      "Sanitized data violated safe_table.safe_reason_check.",
    );
    expect(summarizeRestoreError(stderr)).not.toContain("private-person");
    expect(summarizeRestoreError("ERROR: invalid input secret-value")).toBe(
      "PostgreSQL rejected the sanitized baseline stream; row details were withheld.",
    );
    expect(
      summarizeRestoreError(
        "ERROR:  23505: duplicate key contains private@example.com",
      ),
    ).toBe(
      "PostgreSQL rejected the sanitized baseline stream with SQLSTATE 23505; row details were withheld.",
    );
    expect(
      summarizeRestoreError(
        'ERROR:  23502: null value in column "required_field" of relation "safe_table" violates not-null constraint\nDETAIL: failing row contains (secret)',
      ),
    ).toBe("Sanitized data omitted required column safe_table.required_field.");
  });

  it("builds an encoded copy stream and a replica-bounded checked restore", () => {
    const encoded = encodeBaselineRecordForCopy(
      '{"table":"profiles","row":{"display_name":"synthetic"}}\n',
    );
    const [schemaName, tableName, encodedRow] = encoded.split("\t");
    expect(schemaName).toBe("public");
    expect(tableName).toBe("profiles");
    expect(Buffer.from(encodedRow, "base64").toString("utf8")).toContain(
      '"display_name"',
    );
    expect(buildRestoreSqlPrefix()).toContain(
      "set local session_replication_role = replica",
    );
    expect(buildRestoreSqlPrefix()).toContain("\\set VERBOSITY verbose");
    expect(buildRestoreSqlPrefix()).toContain("schema_name text not null");
    const suffix = buildRestoreSqlSuffix({
      manifest,
      tableCounts: { profiles: 1 },
    });
    expect(suffix).toContain("insert into auth.users");
    expect(suffix).toContain("instance_id");
    expect(suffix).toContain("confirmation_token");
    expect(suffix).toContain("reauthentication_token");
    expect(suffix).toContain("'authenticated'");
    expect(suffix).toContain("'rehearsal-' || replace(id::text");
    expect(suffix).toContain("'{\"rehearsal\":true}'::jsonb");
    expect(suffix).toContain('truncate table "public"."profiles"');
    expect(suffix).toContain(
      'insert into "public"."profiles" ("user_id", "display_name")',
    );
    expect(suffix).toContain("rehearsal_restore_rows_table_name_idx");
    expect(suffix).toContain("where source.schema_name = 'public'");
    expect(suffix).toContain("and source.table_name = 'profiles'");
    expect(suffix).not.toContain("->'row'");
    expect(suffix).not.toContain('restored."search_vector"');
    expect(suffix).toContain("Rehearsal row-count mismatch for profiles");
    expect(suffix).toContain(
      "Rehearsal foreign-key mismatch for profiles.user_id",
    );
    const postgresqlSuffix = buildRestoreSqlSuffix({
      manifest,
      tableCounts: { profiles: 1 },
      restoreSupabaseAuth: false,
    });
    expect(postgresqlSuffix).not.toContain("insert into auth.users");
    expect(postgresqlSuffix).toContain('insert into "public"."profiles"');
  });

  it("keeps same-named tables in separate PostgreSQL schemas", () => {
    const multiSchema = {
      tables: [
        { ...manifest.tables[0], schema: "public" },
        { ...manifest.tables[0], schema: "blendcalc_api" },
      ],
    };
    const suffix = buildRestoreSqlSuffix({
      manifest: multiSchema,
      tableCounts: { profiles: 1, "blendcalc_api.profiles": 2 },
      restoreSupabaseAuth: false,
    });
    expect(suffix).toContain('insert into "public"."profiles"');
    expect(suffix).toContain('insert into "blendcalc_api"."profiles"');
    expect(suffix).toContain("source.schema_name = 'blendcalc_api'");
    expect(suffix).toContain(
      "Rehearsal row-count mismatch for blendcalc_api.profiles",
    );
    expect(() =>
      buildRestoreSqlSuffix({
        manifest: multiSchema,
        tableCounts: { profiles: 1, unknown: 2 },
      }),
    ).toThrow("table counts do not match");
  });

  it("uses the actual schema to guard UUID and numeric sequence resets", () => {
    const suffix = buildRestoreSqlSuffix({
      manifest: {
        tables: [
          {
            name: "profiles",
            sourceRows: "STREAM AND SANITIZE",
            ownerBinding: {
              binding: "approved-owner",
              column: "user_id",
            },
            columns: [
              {
                name: "user_id",
                action: "PSEUDONYMIZE",
                generated: "NEVER",
                identity: "YES",
                foreignKey: null,
              },
            ],
          },
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
            ],
          },
        ],
      },
      tableCounts: { profiles: 1, widgets: 1 },
      restoreSupabaseAuth: false,
    });

    expect(suffix).toContain(
      "pg_get_serial_sequence('public.profiles', 'user_id')",
    );
    expect(suffix).toContain("pg_get_serial_sequence('public.widgets', 'id')");
    expect(suffix).toContain("if sequence_name is not null then");
    expect(suffix).toContain(
      `execute 'select max("id")::bigint, exists(select 1 from "public"."widgets") from "public"."widgets"'`,
    );
    expect(suffix).toContain(
      `execute 'select max("user_id")::bigint, exists(select 1 from "public"."profiles") from "public"."profiles"'`,
    );
  });

  it("accepts only an exact immutable baseline prefix", () => {
    const baselineManifest = {
      migrations: {
        "20260912000000_baseline.sql": { sha256: "a".repeat(64) },
      },
    };
    const result = createCandidateMigrationReceipt({
      baselineManifest,
      currentFiles: [
        {
          filename: "20260912000000_baseline.sql",
          fileSha256: "a".repeat(64),
        },
        {
          filename: "20260912000100_candidate.sql",
          fileSha256: "b".repeat(64),
        },
      ],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidateSha256).toMatch(/^[a-f0-9]{64}$/u);

    expect(() =>
      createCandidateMigrationReceipt({
        baselineManifest,
        currentFiles: [
          {
            filename: "20260912000000_baseline.sql",
            fileSha256: "c".repeat(64),
          },
        ],
      }),
    ).toThrow("diverges from the active baseline");
  });
});
