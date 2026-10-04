import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyIdentityClaim,
  createIdentityClaimPlan,
  validateIdentityPolicy,
} from "../../../src/identity/claim.mjs";

const email = "owner@example.com";
const policy = {
  identityVersion: 1,
  identities: [
    {
      name: "approved-owner",
      provider: "google",
      emailEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_EMAIL",
      approvedEmailSha256: createHash("sha256").update(email).digest("hex"),
      placeholderUserId: "11111111-1111-4111-8111-111111111111",
      references: [
        { schema: "public", table: "profiles", column: "id" },
        { schema: "public", table: "widgets", column: "owner_id" },
      ],
      jsonReferences: [
        {
          schema: "public",
          table: "events",
          column: "payload",
          path: ["actor_id"],
        },
      ],
      assets: [{ bucket: "avatars", prefix: "approved-owner/" }],
      claims: { role: "owner" },
    },
  ],
};

describe("local identity claim", () => {
  it("binds an exact redacted plan and applies it transactionally", async () => {
    expect(() =>
      validateIdentityPolicy(validateIdentityPolicy(policy)),
    ).not.toThrow();
    const plan = createIdentityClaimPlan({
      policy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    expect(JSON.stringify(plan)).not.toContain(email);
    expect(JSON.stringify(plan.review)).not.toContain(email);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.review.claimsSha256).toMatch(/^[a-f0-9]{64}$/u);
    const queries = [];
    const client = {
      async connect() {},
      async end() {},
      async query(sql, parameters = []) {
        queries.push({ sql, parameters });
        if (sql.includes("from rehearsal_internal.identity_claims")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.users u")) {
          return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
        }
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("count(*)::integer as count")) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes("select name, owner_id")) {
          return {
            rows: [
              {
                name: "approved-owner/avatar.webp",
                owner_id: policy.identities[0].placeholderUserId,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const result = await applyIdentityClaim({
      plan,
      confirmation: plan.digest,
      connectionString: "postgresql://local:local@127.0.0.1:55432/postgres",
      clientFactory: async () => client,
    });
    expect(result.claimed).toBe(true);
    expect(
      queries.some(({ sql }) => sql.includes("update storage.objects")),
    ).toBe(true);
    expect(queries.at(-1).sql).toContain("commit");
  });

  it("matches a reviewed GitHub subject without serializing or querying the raw subject", async () => {
    const subject = "github-account-847291";
    const subjectPolicy = structuredClone(policy);
    const identity = subjectPolicy.identities[0];
    delete identity.provider;
    delete identity.emailEnvironmentVariable;
    delete identity.approvedEmailSha256;
    identity.matcher = {
      type: "provider-subject",
      provider: "github",
      subjectEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_SUBJECT",
      approvedSubjectSha256: createHash("sha256").update(subject).digest("hex"),
    };
    identity.assets = [];
    const plan = createIdentityClaimPlan({
      policy: subjectPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_SUBJECT: subject },
    });
    expect(plan.review.matcher).toEqual(identity.matcher);
    expect(JSON.stringify(plan)).not.toContain(subject);
    const queries = [];
    const client = {
      async connect() {},
      async end() {},
      async query(sql, parameters = []) {
        queries.push({ sql, parameters });
        if (sql.includes("i.provider_id::text")) {
          return {
            rows: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                provider: "github",
                provider_id: subject,
                subject,
              },
            ],
          };
        }
        if (sql.includes("from rehearsal_internal.identity_claims")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.identities where user_id")) {
          return { rows: [] };
        }
        if (sql.includes("count(*)::integer as count")) {
          return { rows: [{ count: 1 }] };
        }
        return { rows: [] };
      },
    };
    const result = await applyIdentityClaim({
      plan,
      confirmation: plan.digest,
      connectionString: "postgresql://local:local@127.0.0.1:55432/postgres",
      clientFactory: async () => client,
    });
    expect(result).toMatchObject({ claimed: true, provider: "github" });
    expect(
      queries.every(({ parameters }) => !parameters.includes(subject)),
    ).toBe(true);
  });

  it("supports reviewed email provider allowlists and rejects unsupported matcher declarations", () => {
    const allowlistPolicy = structuredClone(policy);
    const identity = allowlistPolicy.identities[0];
    identity.matcher = {
      type: "verified-email",
      providers: ["google", "github"],
      emailEnvironmentVariable: identity.emailEnvironmentVariable,
      approvedEmailSha256: identity.approvedEmailSha256,
    };
    delete identity.provider;
    delete identity.emailEnvironmentVariable;
    delete identity.approvedEmailSha256;
    const plan = createIdentityClaimPlan({
      policy: allowlistPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    expect(plan.review.matcher.providers).toEqual(["google", "github"]);

    const unsupportedProvider = structuredClone(allowlistPolicy);
    unsupportedProvider.identities[0].matcher.providers = ["custom-saml"];
    expect(() => validateIdentityPolicy(unsupportedProvider)).toThrow(
      "provider",
    );
    const unsupportedMatcher = structuredClone(allowlistPolicy);
    unsupportedMatcher.identities[0].matcher = { type: "verified-phone" };
    expect(() => validateIdentityPolicy(unsupportedMatcher)).toThrow(
      "type is unsupported",
    );
    const mixedSyntax = structuredClone(allowlistPolicy);
    mixedSyntax.identities[0].provider = "google";
    expect(() => validateIdentityPolicy(mixedSyntax)).toThrow(
      "cannot combine matcher",
    );
  });

  it("refuses zero, duplicate, and conflicting provider-subject matches", async () => {
    const subject = "github-account-847291";
    const subjectPolicy = structuredClone(policy);
    const identity = subjectPolicy.identities[0];
    delete identity.provider;
    delete identity.emailEnvironmentVariable;
    delete identity.approvedEmailSha256;
    identity.matcher = {
      type: "provider-subject",
      provider: "github",
      subjectEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_SUBJECT",
      approvedSubjectSha256: createHash("sha256").update(subject).digest("hex"),
    };
    const plan = createIdentityClaimPlan({
      policy: subjectPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_SUBJECT: subject },
    });
    const applyWithRows = (rows) =>
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => ({
          async connect() {},
          async end() {},
          async query(sql) {
            return sql.includes("i.provider_id::text")
              ? { rows }
              : { rows: [] };
          },
        }),
      });
    await expect(applyWithRows([])).rejects.toThrow("No verified");
    await expect(
      applyWithRows([
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "github",
          provider_id: subject,
          subject,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          provider: "github",
          provider_id: subject,
          subject,
        },
      ]),
    ).rejects.toThrow("More than one");
    await expect(
      applyWithRows([
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "github",
          provider_id: subject,
          subject: "different-subject",
        },
      ]),
    ).rejects.toThrow("conflicting stable subjects");
    await expect(
      applyWithRows([
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "google",
          provider_id: subject,
          subject,
        },
      ]),
    ).rejects.toThrow("provider is invalid");
  });

  it("replaces only a complete signup default and remaps roles and Storage paths", async () => {
    const expandedPolicy = structuredClone(policy);
    const identity = expandedPolicy.identities[0];
    identity.references[0].required = true;
    identity.references.push({
      schema: "public",
      table: "app_role_assignments",
      column: "user_id",
      required: true,
    });
    identity.signupDefaults = [
      {
        table: { schema: "public", table: "profiles" },
        identityColumn: "id",
        ignoredColumns: ["created_at", "updated_at"],
        values: {
          display_name: { kind: "pattern", pattern: "^User[0-9]{14}$" },
          avatar_path: null,
        },
      },
    ];
    identity.pathReferences = [
      {
        schema: "public",
        table: "profiles",
        column: "avatar_path",
        valueType: "text",
      },
      {
        schema: "public",
        table: "events",
        column: "payload",
        valueType: "jsonb",
      },
    ];
    identity.assets = [
      {
        bucket: "avatars",
        prefix: `${identity.placeholderUserId}/`,
        rewritePath: true,
      },
    ];
    identity.tokenHook = {
      function: { schema: "public", name: "custom_access_token_hook" },
      expectedClaims: { app_role: "developer" },
    };
    const normalizedTwice = validateIdentityPolicy(
      validateIdentityPolicy(expandedPolicy),
    );
    expect(
      normalizedTwice.identities[0].signupDefaults[0].values.avatar_path,
    ).toEqual({ kind: "exact", value: null });
    const plan = createIdentityClaimPlan({
      policy: expandedPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    const localUserId = "22222222-2222-4222-8222-222222222222";
    const queries = [];
    const storageOperations = [];
    const client = {
      async connect() {},
      async end() {},
      async query(sql, parameters = []) {
        queries.push({ sql, parameters });
        if (sql.includes("from rehearsal_internal.identity_claims")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.users u")) {
          return { rows: [{ id: localUserId }] };
        }
        if (sql.includes("from auth.identities where user_id")) {
          return { rows: [] };
        }
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from pg_constraint constraint_record")) {
          return {
            rows: [{ schema: "public", table: "profiles", column: "id" }],
          };
        }
        if (sql.includes("count(*)::integer as count")) {
          return { rows: [{ count: parameters[0] === localUserId ? 1 : 0 }] };
        }
        if (sql.includes("to_jsonb(candidate)")) {
          return {
            rows: [
              {
                identity: localUserId,
                row: {
                  id: localUserId,
                  display_name: "User12345678901234",
                  avatar_path: null,
                  created_at: "2026-10-02T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                },
              },
              {
                identity: identity.placeholderUserId,
                row: {
                  id: identity.placeholderUserId,
                  display_name: "Copied owner",
                  avatar_path: `${identity.placeholderUserId}/avatar.webp`,
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              },
            ],
          };
        }
        if (
          sql.includes("select name, owner_id") &&
          sql.includes("from storage.objects")
        ) {
          return {
            rows: [
              {
                name: `${identity.placeholderUserId}/avatar.webp`,
                owner_id: null,
              },
            ],
          };
        }
        if (
          sql.includes("select name") &&
          sql.includes("from storage.objects")
        ) {
          return { rows: [] };
        }
        if (sql.includes('"custom_access_token_hook"')) {
          return { rows: [{ event: { claims: { app_role: "developer" } } }] };
        }
        if (sql.trimStart().startsWith("select 1")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [] };
      },
    };
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => client,
        storageTransfer: {
          async copyAndVerify(copy) {
            storageOperations.push({ operation: "copy", ...copy });
          },
          async remove({ bucket, paths }) {
            storageOperations.push({ operation: "remove", bucket, paths });
          },
        },
      }),
    ).resolves.toMatchObject({ claimed: true, storageObjectsTransferred: 1 });
    expect(
      queries.some(({ sql }) =>
        sql.includes('delete from "public"."profiles"'),
      ),
    ).toBe(true);
    expect(
      queries.some(({ sql }) => sql.includes("update storage.objects")),
    ).toBe(true);
    expect(storageOperations).toEqual([
      {
        operation: "copy",
        bucket: "avatars",
        source: `${identity.placeholderUserId}/avatar.webp`,
        destination: `${localUserId}/avatar.webp`,
      },
      {
        operation: "remove",
        bucket: "avatars",
        paths: [`${identity.placeholderUserId}/avatar.webp`],
      },
    ]);
    expect(queries.filter(({ sql }) => sql.includes("substring(")).length).toBe(
      1,
    );
    expect(
      queries.some(({ sql }) => sql.includes('"custom_access_token_hook"')),
    ).toBe(true);
  });

  it("refuses to rewrite copied Storage paths when no physical objects exist", async () => {
    const missingAssetPolicy = structuredClone(policy);
    const identity = missingAssetPolicy.identities[0];
    identity.pathReferences = [
      {
        schema: "public",
        table: "profiles",
        column: "avatar_path",
        valueType: "text",
      },
    ];
    identity.assets = [
      {
        bucket: "avatars",
        prefix: `${identity.placeholderUserId}/`,
        rewritePath: true,
      },
    ];
    const plan = createIdentityClaimPlan({
      policy: missingAssetPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    const queries = [];
    const client = {
      async connect() {},
      async end() {},
      async query(sql) {
        queries.push(sql);
        if (sql.includes("from auth.users u")) {
          return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
        }
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.identities where user_id")) {
          return { rows: [] };
        }
        if (sql.includes("from pg_constraint constraint_record")) {
          return { rows: [] };
        }
        if (sql.includes("count(*)::integer as count")) {
          return { rows: [{ count: sql.includes("avatar_path") ? 1 : 0 }] };
        }
        if (sql.includes("select name, owner_id")) return { rows: [] };
        return { rows: [] };
      },
    };
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => client,
      }),
    ).rejects.toThrow("no matching objects");
    expect(queries.at(-1)).toBe("rollback");
    expect(queries.some((sql) => sql.includes("substring("))).toBe(false);
  });

  it("rolls back instead of replacing an edited signup row", async () => {
    const conflictPolicy = structuredClone(policy);
    conflictPolicy.identities[0].signupDefaults = [
      {
        table: { schema: "public", table: "profiles" },
        identityColumn: "id",
        ignoredColumns: ["created_at"],
        values: { display_name: null },
      },
    ];
    const plan = createIdentityClaimPlan({
      policy: conflictPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    const queries = [];
    const localUserId = "22222222-2222-4222-8222-222222222222";
    const client = {
      async connect() {},
      async end() {},
      async query(sql, parameters = []) {
        queries.push({ sql, parameters });
        if (sql.includes("from rehearsal_internal.identity_claims")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.users u"))
          return { rows: [{ id: localUserId }] };
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from pg_constraint constraint_record")) {
          return {
            rows: [{ schema: "public", table: "profiles", column: "id" }],
          };
        }
        if (sql.includes("count(*)::integer as count")) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes("to_jsonb(candidate)")) {
          return {
            rows: [
              {
                identity: localUserId,
                row: {
                  id: localUserId,
                  display_name: "Independently edited",
                  created_at: "2026-10-02T00:00:00Z",
                },
              },
              {
                identity: policy.identities[0].placeholderUserId,
                row: {
                  id: policy.identities[0].placeholderUserId,
                  display_name: "Copied owner",
                  created_at: "2026-01-01T00:00:00Z",
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => client,
      }),
    ).rejects.toThrow("edited");
    expect(queries.at(-1).sql).toBe("rollback");
    expect(
      queries.some(({ sql }) => sql.trimStart().startsWith("delete from")),
    ).toBe(false);
  });

  it("removes staged Storage copies when the database claim rolls back", async () => {
    const rollbackPolicy = structuredClone(policy);
    const identity = rollbackPolicy.identities[0];
    identity.assets = [
      {
        bucket: "avatars",
        prefix: `${identity.placeholderUserId}/`,
        rewritePath: true,
      },
    ];
    identity.pathReferences = [
      {
        schema: "public",
        table: "profiles",
        column: "avatar_path",
        valueType: "text",
      },
    ];
    const plan = createIdentityClaimPlan({
      policy: rollbackPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    const localUserId = "22222222-2222-4222-8222-222222222222";
    const queries = [];
    const storageOperations = [];
    const client = {
      async connect() {},
      async end() {},
      async query(sql, parameters = []) {
        queries.push({ sql, parameters });
        if (sql.includes("from rehearsal_internal.identity_claims")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.users u"))
          return { rows: [{ id: localUserId }] };
        if (sql.includes("from auth.users where id"))
          return { rows: [{ present: true }] };
        if (sql.includes("from auth.identities where user_id"))
          return { rows: [] };
        if (sql.includes("from pg_constraint constraint_record"))
          return { rows: [] };
        if (sql.includes("count(*)::integer as count"))
          return { rows: [{ count: 1 }] };
        if (
          sql.includes("select name, owner_id") &&
          sql.includes("from storage.objects")
        ) {
          return {
            rows: [
              {
                name: `${identity.placeholderUserId}/avatar.webp`,
                owner_id: null,
              },
            ],
          };
        }
        if (
          sql.includes("select name") &&
          sql.includes("from storage.objects")
        ) {
          return { rows: [] };
        }
        if (sql.includes("substring(") && sql.includes("avatar_path")) {
          throw new Error("synthetic database refusal");
        }
        return { rows: [] };
      },
    };
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => client,
        storageTransfer: {
          async copyAndVerify(copy) {
            storageOperations.push({ operation: "copy", ...copy });
          },
          async remove({ bucket, paths }) {
            storageOperations.push({ operation: "remove", bucket, paths });
          },
        },
      }),
    ).rejects.toThrow("synthetic database refusal");
    expect(queries.some(({ sql }) => sql === "rollback")).toBe(true);
    expect(storageOperations.at(-1)).toEqual({
      operation: "remove",
      bucket: "avatars",
      paths: [`${localUserId}/avatar.webp`],
    });
  });

  it("preserves immutable audit authors while transferring the active account", async () => {
    const auditPolicy = structuredClone(policy);
    auditPolicy.identities[0].references[0].required = true;
    auditPolicy.identities[0].references.push({
      schema: "public",
      table: "food_compatibility_feedback",
      column: "reviewed_by",
      required: true,
      strategy: "preserve-audit",
    });
    const plan = createIdentityClaimPlan({
      policy: auditPolicy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    expect(plan.review.references.at(-1).strategy).toBe("preserve-audit");
    const localUserId = "22222222-2222-4222-8222-222222222222";
    const placeholder = auditPolicy.identities[0].placeholderUserId;
    let profileTransferred = false;
    const queries = [];
    const client = {
      async connect() {},
      async end() {},
      async query(sql, parameters = []) {
        queries.push({ sql, parameters });
        if (sql.includes("from rehearsal_internal.identity_claims")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.users u")) {
          return { rows: [{ id: localUserId }] };
        }
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("from auth.identities where user_id")) {
          return { rows: [] };
        }
        if (sql.includes("from pg_constraint constraint_record")) {
          return {
            rows: [
              { schema: "public", table: "profiles", column: "id" },
              {
                schema: "public",
                table: "food_compatibility_feedback",
                column: "reviewed_by",
              },
            ],
          };
        }
        if (sql.includes("count(*)::integer as count")) {
          const isAudit = sql.includes('"food_compatibility_feedback"');
          if (isAudit)
            return { rows: [{ count: parameters[0] === placeholder ? 1 : 0 }] };
          return {
            rows: [
              {
                count:
                  parameters[0] === placeholder
                    ? profileTransferred
                      ? 0
                      : 1
                    : profileTransferred
                      ? 1
                      : 0,
              },
            ],
          };
        }
        if (
          sql.includes('update "public"."profiles"') &&
          sql.includes('set "id"')
        ) {
          profileTransferred = true;
        }
        if (sql.trimStart().startsWith("select 1")) {
          return { rows: [{ present: true }] };
        }
        return { rows: [] };
      },
    };
    const first = await applyIdentityClaim({
      plan,
      confirmation: plan.digest,
      connectionString: "postgresql://local:local@localhost:55432/postgres",
      clientFactory: async () => client,
    });
    expect(first).toMatchObject({
      claimed: true,
      idempotent: false,
      placeholderRetainedForAudit: true,
    });
    expect(
      queries.some(({ sql }) =>
        sql.includes('update "public"."food_compatibility_feedback"'),
      ),
    ).toBe(false);
    expect(
      queries.some(({ sql }) => sql.includes("delete from auth.users")),
    ).toBe(false);

    const second = await applyIdentityClaim({
      plan,
      confirmation: plan.digest,
      connectionString: "postgresql://local:local@localhost:55432/postgres",
      clientFactory: async () => client,
    });
    expect(second).toMatchObject({
      claimed: true,
      idempotent: true,
      placeholderRetainedForAudit: true,
    });
  });

  it("rejects wrong people, hosted targets, ambiguity, and arbitrary behavior", async () => {
    expect(() =>
      createIdentityClaimPlan({
        policy,
        name: "approved-owner",
        environment: { REHEARSAL_APPROVED_OWNER_EMAIL: "other@example.com" },
      }),
    ).toThrow("reviewed receipt");
    expect(() =>
      validateIdentityPolicy({ ...policy, callback: "custom.js" }),
    ).toThrow("unknown");
    const plan = createIdentityClaimPlan({
      policy,
      name: "approved-owner",
      environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
    });
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString:
          "postgresql://admin:secret@hosted.example.com/postgres",
      }),
    ).rejects.toThrow("only the local");
    const ambiguous = {
      async connect() {},
      async end() {},
      async query(sql) {
        return sql.includes("from auth.users u")
          ? {
              rows: [
                { id: policy.identities[0].placeholderUserId },
                { id: "22222222-2222-4222-8222-222222222222" },
              ],
            }
          : { rows: [] };
      },
    };
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => ambiguous,
      }),
    ).rejects.toThrow("More than one");

    const conflicting = {
      async connect() {},
      async end() {},
      async query(sql) {
        if (sql.includes("from auth.users u")) {
          return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
        }
        if (sql.includes("from auth.users where id")) {
          return { rows: [{ present: true }] };
        }
        if (sql.includes("count(*)::integer as count")) {
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes("from auth.identities where user_id")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [] };
      },
    };
    await expect(
      applyIdentityClaim({
        plan,
        confirmation: plan.digest,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        clientFactory: async () => conflicting,
      }),
    ).rejects.toThrow("conflicting local identity");
  });
});
