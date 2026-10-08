import { describe, expect, it } from "vitest";
import {
  buildRuntimeFinalizationSql,
  buildRuntimePostSchemaSql,
  buildRuntimePreparationSql,
  buildRuntimePrerequisiteSql,
  buildRuntimeVerificationSql,
  validateRuntimePolicy,
} from "../../../dist/src/runtime/policy.mjs";

const policy = {
  policyVersion: 1,
  prerequisites: {
    schemas: ["extensions"],
    extensions: [
      { name: "pgcrypto", schema: "extensions" },
      { name: "uuid-ossp", schema: "extensions" },
    ],
  },
  triggers: [
    {
      name: "profile_after_auth_insert",
      table: { schema: "auth", name: "users" },
      timing: "after",
      events: ["insert"],
      function: { schema: "public", name: "handle_new_user" },
    },
  ],
  localRows: [
    {
      table: { schema: "public", name: "runtime_settings" },
      keyColumns: ["name"],
      values: { name: "scheduler_enabled", value: false },
    },
  ],
  expectations: [
    {
      table: { schema: "public", name: "profiles" },
      rowLevelSecurity: true,
      columns: [
        { name: "id", generated: false, identity: false },
        { name: "search_text", generated: true, identity: false },
      ],
    },
  ],
};

describe("declarative runtime policy", () => {
  it("builds bounded prerequisite, trigger, local-row, and verification SQL", () => {
    const preparation = buildRuntimePreparationSql(policy);
    const prerequisites = buildRuntimePrerequisiteSql(policy);
    const postSchema = buildRuntimePostSchemaSql(policy);
    const finalization = buildRuntimeFinalizationSql(policy);
    const verification = buildRuntimeVerificationSql(policy);
    expect(preparation).toContain('create extension if not exists "pgcrypto"');
    expect(prerequisites).toContain(
      'create extension if not exists "pgcrypto"',
    );
    expect(prerequisites).not.toContain("create trigger");
    expect(postSchema).toContain("create trigger");
    expect(postSchema).not.toContain("create extension");
    expect(preparation).toContain('create trigger "profile_after_auth_insert"');
    expect(preparation).not.toContain("jsonb_populate_record");
    expect(finalization).toContain("jsonb_populate_record");
    expect(finalization).toContain("on conflict");
    expect(verification).toContain("relrowsecurity = true");
    expect(verification).toContain("local-only row is missing");
    expect(verification).toContain("not convalidated");
    expect(preparation).not.toContain("drop ");
  });

  it("rejects arbitrary SQL, unknown extensions, and incomplete local recipes", () => {
    expect(() => validateRuntimePolicy({ ...policy, sql: "select 1" })).toThrow(
      "unknown",
    );
    expect(() =>
      validateRuntimePolicy({
        ...policy,
        prerequisites: {
          schemas: [],
          extensions: [{ name: "untrusted_code", schema: "public" }],
        },
      }),
    ).toThrow("allowlist");
    expect(() =>
      validateRuntimePolicy({
        ...policy,
        localRows: [
          {
            table: { schema: "public", name: "settings" },
            keyColumns: ["missing"],
            values: { name: "safe" },
          },
        ],
      }),
    ).toThrow("must be present in values");
  });

  it("verifies an identity-owned local row before and after association", () => {
    const associated = structuredClone(policy);
    associated.localRows.push({
      table: { schema: "public", name: "app_role_assignments" },
      keyColumns: ["user_id"],
      values: {
        user_id: "11111111-1111-4111-8111-111111111111",
        role: "owner",
      },
      identityAssociation: {
        identity: "approved-owner",
        column: "user_id",
      },
    });
    expect(() =>
      validateRuntimePolicy(validateRuntimePolicy(associated)),
    ).not.toThrow();
    const finalization = buildRuntimeFinalizationSql(associated);
    const verification = buildRuntimeVerificationSql(associated);
    expect(finalization).toContain("rehearsal_internal.identity_claims");
    expect(verification).toContain("claim.local_user_id::text");
    expect(verification).toContain("claim.placeholder_user_id::text");
    expect(verification).toContain("'approved-owner'");

    associated.localRows[1].identityAssociation.column = "role";
    expect(() => validateRuntimePolicy(associated)).toThrow("key column");
  });
});
