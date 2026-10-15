import { describe, expect, it } from "vitest";
import {
  buildAuthenticationReview,
  buildBaselineScopeReview,
  publicAuthenticationBooleans,
} from "../../../dist/src/runtime/project_review.mjs";

const scope = () =>
  buildBaselineScopeReview({
    provider: "supabase",
    sourcePreparationConfigured: true,
    identityPolicyConfigured: true,
    baseline: {
      tableCounts: { widgets: 5, "app.widgets": 7 },
      sanitizationPolicySha256: "a".repeat(64),
      storageAssets: {
        hidden: {
          bucket: "avatars",
          objectPath: "private-user/token.jpg",
          bytes: 20,
          sha256: "b".repeat(64),
        },
      },
    },
    policy: {
      policyVersion: 2,
      tables: [
        {
          name: "widgets",
          schema: "public",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              action: "KEEP",
              identity: "YES",
              foreignKey: {
                schema: "private",
                table: "excluded",
                column: "id",
              },
              recipe: { value: "secret-recipe-value" },
            },
          ],
        },
        {
          name: "widgets",
          schema: "app",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            { action: "PSEUDONYMIZE", identity: "NO", foreignKey: null },
          ],
        },
        {
          name: "excluded",
          schema: "private",
          sourceRows: "EXCLUDE",
          columns: [{ action: "EXCLUDE", identity: "NO", foreignKey: null }],
        },
      ],
    },
  });
describe("value-free project review", () => {
  it("keeps schemas distinct, explains excluded references, aggregates Storage without paths/recipes", () => {
    const review = scope();
    expect(
      review.tables.map(({ schema, rowCount }) => [schema, rowCount]),
    ).toEqual([
      ["public", 5],
      ["app", 7],
      ["private", 0],
    ]);
    expect(review.relationships.excludedReferenceCount).toBe(1);
    expect(review.storage).toEqual({
      assetCount: 1,
      bytes: 20,
      buckets: [{ name: "avatars", assetCount: 1, bytes: 20 }],
    });
    expect(JSON.stringify(review)).not.toMatch(
      /private-user|secret-recipe-value|token.jpg/u,
    );
    expect(review.decisions.sourcePermission).toBe("configured-not-contacted");
    expect(review.privacy.sourceContacted).toBe(false);
  });
  it("shows declarative, disabled, email, multiple and unsupported providers without secrets", () => {
    const review = buildAuthenticationReview({
      provider: "supabase",
      configuredProviders: ["google"],
      declarativeProviders: ["google"],
      callback: "http://127.0.0.1:58321/auth/v1/callback",
      identityPolicyConfigured: true,
      template:
        '[auth.email]\nenabled = true\n[auth.external.github]\nenabled = false\nsecret = "private-provider-secret"\n[auth.external.custom]\nenabled = true\n[auth.mfa.totp]\nenroll_enabled = true\nverify_enabled = true\n',
    });
    expect(
      review.providers.map(({ name, enabled, supported }) => [
        name,
        enabled,
        supported,
      ]),
    ).toEqual([
      ["custom", true, false],
      ["email", true, true],
      ["github", false, true],
      ["google", true, true],
    ]);
    expect(review.mfa.totpVerification).toBe(true);
    expect(review.mfa.enforcement).toBe("application-owned-not-verified");
    expect(JSON.stringify(review)).not.toContain("private-provider-secret");
    expect(review.verification).toBe("configuration-only");
  });
  it("refuses to infer missing or duplicate declarations and skips multiline string content", () => {
    const source =
      'description = """\n[auth.external.google]\nenabled = true\n"""\n[auth.email]\nenabled = true\nenabled = false\n[auth.external.github]\nenabled = true\n[auth.external.github]\nenabled = false\n';
    const booleans = publicAuthenticationBooleans(source);
    expect(booleans.has("auth.external.google.enabled")).toBe(false);
    expect(booleans.get("auth.email.enabled")).toBeNull();
    expect(booleans.get("auth.external.github.enabled")).toBeNull();
    expect(publicAuthenticationBooleans(null).size).toBe(0);
    expect(publicAuthenticationBooleans("x".repeat(512 * 1024 + 1)).size).toBe(
      0,
    );
  });
  it("does not invent native providers for PostgreSQL", () => {
    const review = buildAuthenticationReview({
      provider: "postgresql",
      configuredProviders: [],
      declarativeProviders: [],
      callback: null,
      template: null,
      identityPolicyConfigured: false,
    });
    expect(review.providers).toEqual([]);
    expect(review.callback).toBeNull();
    expect(review.identityAssociation).toBe("not-configured");
  });
});
