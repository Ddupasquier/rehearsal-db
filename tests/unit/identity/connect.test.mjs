import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIdentityClaimPlan } from "../../../dist/src/identity/claim.mjs";
import {
  inspectIdentityConnection,
  waitForIdentityConnection,
} from "../../../dist/src/identity/connect.mjs";
import { IdentityLookupError } from "../../../dist/src/identity/claim_identity_lookup.mjs";

const email = "owner@example.com";
const plan = createIdentityClaimPlan({
  policy: {
    identityVersion: 1,
    identities: [
      {
        name: "approved-owner",
        matcher: {
          type: "verified-email",
          providers: ["google"],
          emailEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_EMAIL",
          approvedEmailSha256: createHash("sha256").update(email).digest("hex"),
        },
        placeholderUserId: "11111111-1111-4111-8111-111111111111",
        references: [
          {
            schema: "public",
            table: "profiles",
            column: "id",
            required: true,
            strategy: "transfer",
          },
          {
            schema: "public",
            table: "reviews",
            column: "reviewer_id",
            required: false,
            strategy: "preserve-audit",
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
        signupDefaults: [],
        pathReferences: [],
        assets: [{ bucket: "avatars", prefix: "approved-owner/" }],
        claims: { role: "owner" },
      },
    ],
  },
  name: "approved-owner",
  environment: { REHEARSAL_APPROVED_OWNER_EMAIL: email },
});

const preview = {
  name: "approved-owner",
  provider: "google",
  planDigest: plan.digest,
  relationalGroups: 1,
  preservedAuditGroups: 1,
  nestedJsonGroups: 1,
  signupDefaults: 0,
  storagePathGroups: 0,
  assetScopes: 1,
  claimKeys: 1,
  tokenHookConfigured: false,
  associated: false,
};

describe("guided identity connection", () => {
  it("discovers one verified identity without locking or exposing its identifier", async () => {
    const queries = [];
    const end = vi.fn(async () => undefined);
    const result = await inspectIdentityConnection({
      plan,
      connectionString: "postgresql://local:local@127.0.0.1:55432/postgres",
      clientFactory: async () => ({
        async connect() {},
        end,
        async query(sql) {
          queries.push(sql);
          if (sql.includes("from auth.users u")) {
            return {
              rows: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  provider: "google",
                },
              ],
            };
          }
          if (sql.includes("to_regclass"))
            return { rows: [{ relation: null }] };
          return { rows: [] };
        },
      }),
    });

    expect(result).toEqual(preview);
    expect(JSON.stringify(result)).not.toContain(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(queries.join("\n")).not.toContain("for update");
    expect(end).toHaveBeenCalledOnce();
  });

  it("recognizes an existing exact association receipt", async () => {
    const result = await inspectIdentityConnection({
      plan,
      connectionString: "postgresql://local:local@localhost:55432/postgres",
      clientFactory: async () => ({
        async query(sql) {
          if (sql.includes("from auth.users u")) {
            return {
              rows: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  provider: "google",
                },
              ],
            };
          }
          if (sql.includes("to_regclass")) {
            return {
              rows: [{ relation: "rehearsal_internal.identity_claims" }],
            };
          }
          if (sql.includes("from rehearsal_internal.identity_claims")) {
            return { rows: [{ present: true }] };
          }
          return { rows: [] };
        },
      }),
    });

    expect(result.associated).toBe(true);
  });

  it("waits through a missing identity but fails closed on ambiguity", async () => {
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(
        new IdentityLookupError("none", "No verified identity yet."),
      )
      .mockRejectedValueOnce(
        new IdentityLookupError("none", "No verified identity yet."),
      )
      .mockResolvedValue(preview);
    await expect(
      waitForIdentityConnection({
        plan,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        inspect,
        pollIntervalMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toEqual(preview);
    expect(inspect).toHaveBeenCalledTimes(3);

    const ambiguous = vi.fn(async () => {
      throw new IdentityLookupError(
        "ambiguous",
        "More than one verified identity matches.",
      );
    });
    await expect(
      waitForIdentityConnection({
        plan,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        inspect: ambiguous,
        pollIntervalMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("More than one");
    expect(ambiguous).toHaveBeenCalledOnce();
  });

  it("cancels a pending match without continuing to poll", async () => {
    const controller = new AbortController();
    const inspect = vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      throw new IdentityLookupError("none", "No verified identity yet.");
    });
    await expect(
      waitForIdentityConnection({
        plan,
        connectionString: "postgresql://local:local@localhost:55432/postgres",
        inspect,
        signal: controller.signal,
        pollIntervalMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("cancelled");
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("refuses a non-local database before creating a client", async () => {
    const clientFactory = vi.fn();
    await expect(
      inspectIdentityConnection({
        plan,
        connectionString: "postgresql://example.com:5432/postgres",
        clientFactory,
      }),
    ).rejects.toThrow("local Rehearsal database");
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
