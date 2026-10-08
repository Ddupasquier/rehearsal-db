import { createHash, createHmac } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPrivacyEngine,
  createPrivacyKey,
  readPrivacyKey,
  validateExecutablePrivacyPolicy,
} from "../../../src/baseline/privacy_engine.mjs";

const roots = [];

const policy = {
  policyVersion: 2,
  migrationCutoff: "20260101000000",
  tables: [
    {
      name: "accounts",
      sourceRows: "STREAM AND SANITIZE",
      columns: [
        {
          name: "id",
          action: "PSEUDONYMIZE",
          recipe: { format: "uuid", namespace: "account-id" },
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
        {
          name: "email",
          action: "PSEUDONYMIZE",
          recipe: { format: "email", namespace: "account-email" },
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
        {
          name: "metadata",
          action: "DERIVE",
          recipe: {
            kind: "json-object",
            fields: {
              nickname: {
                action: "PSEUDONYMIZE",
                recipe: {
                  format: "text",
                  namespace: "nickname",
                  maxLength: 24,
                },
              },
              token: { action: "EXCLUDE" },
            },
          },
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
        {
          name: "created_at",
          action: "DERIVE",
          recipe: { kind: "date-shift", days: 30 },
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
      ],
    },
  ],
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("executable privacy engine", () => {
  it("preserves only a reviewed owner and sanitizes bounded structured arrays", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const policyWithOwner = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      bindings: {
        "approved-owner": {
          environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
          approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
        },
      },
      tables: [
        {
          name: "profiles",
          sourceRows: "STREAM AND SANITIZE",
          ownerBinding: { binding: "approved-owner", column: "user_id" },
          columns: [
            {
              name: "user_id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "account-id" },
              generated: "NEVER",
              identity: "NO",
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
                  recipe: { kind: "constant", value: "Synthetic account" },
                },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "payload",
              action: "DERIVE",
              recipe: {
                kind: "json-array",
                maximumItems: 2,
                maximumDepth: 4,
                maximumBytes: 512,
                items: {
                  action: "DERIVE",
                  recipe: {
                    kind: "json-object",
                    fields: {
                      actor_id: {
                        action: "PSEUDONYMIZE",
                        recipe: { format: "uuid", namespace: "account-id" },
                      },
                      notes: {
                        action: "REPLACE",
                        required: false,
                        recipe: { kind: "constant", value: "Synthetic note" },
                      },
                    },
                  },
                },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const engine = createPrivacyEngine({
      policy: policyWithOwner,
      key: Buffer.alloc(32, 7),
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
    });
    const make = (userId, displayName, payload) =>
      engine.sanitize({
        table: "profiles",
        row: { user_id: userId, display_name: displayName, payload },
      });
    const approved = make(owner, "Approved owner", [
      { actor_id: owner, notes: "secret-canary" },
      { actor_id: owner },
    ]);
    const other = make(
      "22222222-2222-4222-8222-222222222222",
      "Other private name",
      [],
    );

    expect(approved.row.display_name).toBe("Approved owner");
    expect(other.row.display_name).toBe("Synthetic account");
    expect(approved.row.payload[0]).toEqual({
      actor_id: approved.row.user_id,
      notes: "Synthetic note",
    });
    expect(approved.row.payload[1]).toEqual({ actor_id: approved.row.user_id });
    const rotated = createPrivacyEngine({
      policy: policyWithOwner,
      key: Buffer.alloc(32, 8),
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
    }).sanitize({
      table: "profiles",
      row: {
        user_id: owner,
        display_name: "Approved owner",
        payload: [{ actor_id: owner }],
      },
    });
    expect(rotated.row.user_id).not.toBe(approved.row.user_id);
    expect(JSON.stringify(approved)).not.toContain("secret-canary");
    expect(() =>
      make(owner, "A", [
        { actor_id: owner },
        { actor_id: owner },
        { actor_id: owner },
      ]),
    ).toThrow("maximumItems");
    expect(() =>
      make(owner, "A", [{ actor_id: owner, unknown: true }]),
    ).toThrow("unclassified JSON key");
    expect(() => make(owner, "A", [{}])).toThrow("missing required JSON keys");
    expect(() =>
      make(owner, "A", [{ actor_id: { nested: { too: { deep: owner } } } }]),
    ).toThrow("maximumDepth");
    expect(() => make(owner, "A", [{ actor_id: "x".repeat(600) }])).toThrow(
      "maximumBytes",
    );
    expect(() => make(owner, "A", null)).toThrow("must be a JSON array");
    expect(() =>
      createPrivacyEngine({
        policy: policyWithOwner,
        key: Buffer.alloc(32, 7),
        environment: { REHEARSAL_APPROVED_OWNER_ID: "wrong" },
      }),
    ).toThrow("does not match its review receipt");
    expect(() =>
      validateExecutablePrivacyPolicy({
        ...policyWithOwner,
        tables: [
          {
            ...policyWithOwner.tables[0],
            columns: policyWithOwner.tables[0].columns.map((entry) =>
              entry.name === "user_id"
                ? {
                    ...entry,
                    action: "REPLACE",
                    recipe: { kind: "constant", value: "synthetic-owner" },
                  }
                : entry,
            ),
          },
        ],
      }),
    ).toThrow("must be explicitly pseudonymized");
  });

  it("produces stable, shape-valid pseudonyms and removes excluded nested values", () => {
    const engine = createPrivacyEngine({ policy, key: Buffer.alloc(32, 7) });
    const source = {
      table: "accounts",
      row: {
        id: "source-owner",
        email: "private@example.com",
        metadata: { nickname: "Private Name", token: "secret-canary" },
        created_at: "2026-01-01T00:00:00.000Z",
      },
    };
    const first = engine.sanitize(source);
    const second = engine.sanitize(source);

    expect(first).toEqual(second);
    expect(first.row.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(first.row.email).toMatch(
      /^rehearsal\+[a-f0-9]{24}@example\.invalid$/u,
    );
    expect(first.row.metadata).toEqual({
      nickname: expect.stringMatching(/^rehearsal_[a-f0-9]+$/u),
    });
    expect(JSON.stringify(first)).not.toContain("secret-canary");
    expect(first.row.created_at).not.toBe(source.row.created_at);
  });

  it("preserves hexadecimal and GTIN shapes and derives digests from sanitized inputs", () => {
    const gtin = (payload) => {
      const sum = [...payload]
        .reverse()
        .reduce(
          (total, digit, index) =>
            total + Number(digit) * (index % 2 === 0 ? 3 : 1),
          0,
        );
      return `${payload}${(10 - (sum % 10)) % 10}`;
    };
    const formatPolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      tables: [
        {
          name: "products",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "id",
              action: "PSEUDONYMIZE",
              recipe: {
                format: "text",
                namespace: "product-id",
                maxLength: 32,
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "barcode",
              action: "PSEUDONYMIZE",
              recipe: { format: "gtin", namespace: "barcode", length: 14 },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "optional_barcode",
              action: "PSEUDONYMIZE",
              recipe: { format: "gtin", namespace: "barcode", length: 14 },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "source_fingerprint",
              action: "PSEUDONYMIZE",
              recipe: {
                format: "hex",
                namespace: "source-fingerprint",
                length: 32,
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "derived_fingerprint",
              action: "DERIVE",
              recipe: {
                kind: "digest",
                format: "hex",
                namespace: "product-fingerprint",
                length: 64,
                inputs: ["id", "barcode"],
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const key = Buffer.alloc(32, 7);
    const engine = createPrivacyEngine({ policy: formatPolicy, key });
    const source = {
      table: "products",
      row: {
        id: "private-product-a",
        barcode: gtin("1234567890123"),
        optional_barcode: null,
        source_fingerprint: "private-fingerprint-a",
        derived_fingerprint: "ignored-private-derived-value",
      },
    };
    const first = engine.sanitize(source);
    const second = engine.sanitize(source);

    expect(first).toEqual(second);
    expect(first.row.source_fingerprint).toMatch(/^[a-f0-9]{32}$/u);
    expect(first.row.derived_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.row.barcode).toMatch(/^\d{14}$/u);
    expect(first.row.barcode.at(-1)).toBe(
      gtin(first.row.barcode.slice(0, -1)).at(-1),
    );
    expect(first.row.optional_barcode).toBeNull();
    expect(first.row.derived_fingerprint).toBe(
      createHmac("sha256", key)
        .update("product-fingerprint")
        .update("\0")
        .update(
          JSON.stringify([
            { name: "id", value: first.row.id },
            { name: "barcode", value: first.row.barcode },
          ]),
        )
        .digest("hex"),
    );
    expect(
      engine.sanitize({
        ...source,
        row: {
          ...source.row,
          derived_fingerprint: "a-different-raw-fingerprint",
        },
      }).row.derived_fingerprint,
    ).toBe(first.row.derived_fingerprint);
    expect(
      engine.sanitize({
        ...source,
        row: { ...source.row, id: "private-product-b" },
      }).row.derived_fingerprint,
    ).not.toBe(first.row.derived_fingerprint);
    const differentIdentifiers = engine.sanitize({
      ...source,
      row: {
        ...source.row,
        barcode: gtin("9876543210987"),
        source_fingerprint: "private-fingerprint-b",
      },
    });
    expect(differentIdentifiers.row.barcode).not.toBe(first.row.barcode);
    expect(differentIdentifiers.row.source_fingerprint).not.toBe(
      first.row.source_fingerprint,
    );
    expect(
      createPrivacyEngine({
        policy: formatPolicy,
        key: Buffer.alloc(32, 8),
      }).sanitize(source).row.barcode,
    ).not.toBe(first.row.barcode);
    expect(() =>
      engine.sanitize({
        ...source,
        row: { ...source.row, barcode: "12345678901234" },
      }),
    ).toThrow("valid normalized GTIN-14");

    const unknownInput = structuredClone(formatPolicy);
    unknownInput.tables[0].columns[4].recipe.inputs = ["missing"];
    expect(() => validateExecutablePrivacyPolicy(unknownInput)).toThrow(
      "references unknown column missing",
    );
    const cycle = structuredClone(formatPolicy);
    cycle.tables[0].columns[4].recipe.inputs = ["derived_fingerprint"];
    expect(() => validateExecutablePrivacyPolicy(cycle)).toThrow(
      "cyclic digest dependency",
    );
    const excludedInput = structuredClone(formatPolicy);
    excludedInput.tables[0].columns[0].action = "EXCLUDE";
    delete excludedInput.tables[0].columns[0].recipe;
    expect(() => validateExecutablePrivacyPolicy(excludedInput)).toThrow(
      "is excluded instead of sanitized",
    );
    const invalidHexLength = structuredClone(formatPolicy);
    invalidHexLength.tables[0].columns[3].recipe.length = 40;
    expect(() => validateExecutablePrivacyPolicy(invalidHexLength)).toThrow(
      "length must be 32 or 64 for hex",
    );
    const invalidGtinLength = structuredClone(formatPolicy);
    invalidGtinLength.tables[0].columns[1].recipe.length = 10;
    expect(() => validateExecutablePrivacyPolicy(invalidGtinLength)).toThrow(
      "length must be 8, 12, 13, or 14 for gtin",
    );
  });

  it("creates keyed HTTPS loopback URLs without retaining source URL secrets", () => {
    const urlRecipe = {
      format: "url",
      namespace: "evidence-url",
      origin: "https://127.0.0.1:58432",
      maxLength: 500,
    };
    const urlPolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      tables: [
        {
          name: "evidence",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "evidence_reference",
              action: "PSEUDONYMIZE",
              recipe: urlRecipe,
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "optional_reference",
              action: "PSEUDONYMIZE",
              recipe: urlRecipe,
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "evidence_urls",
              action: "DERIVE",
              recipe: {
                kind: "json-array",
                maximumItems: 4,
                maximumBytes: 2_048,
                items: { action: "PSEUDONYMIZE", recipe: urlRecipe },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "details",
              action: "DERIVE",
              recipe: {
                kind: "json-object",
                maximumBytes: 1_024,
                fields: {
                  source: { action: "PSEUDONYMIZE", recipe: urlRecipe },
                },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const key = Buffer.alloc(32, 7);
    const firstSource =
      "https://secret-canary.example/private/path?token=private-token#fragment";
    const secondSource = "https://other-secret.example/evidence/second";
    const source = {
      table: "evidence",
      row: {
        evidence_reference: firstSource,
        optional_reference: null,
        evidence_urls: [firstSource, secondSource],
        details: { source: firstSource },
      },
    };
    const engine = createPrivacyEngine({ policy: urlPolicy, key });
    const first = engine.sanitize(source);
    const repeated = engine.sanitize(source);
    const rotated = createPrivacyEngine({
      policy: urlPolicy,
      key: Buffer.alloc(32, 8),
    }).sanitize(source);

    expect(first).toEqual(repeated);
    expect(first.row.evidence_reference).toMatch(
      /^https:\/\/127\.0\.0\.1:58432\/rehearsal\/[a-f0-9]{32}$/u,
    );
    expect(first.row.evidence_reference).toHaveLength(
      new URL(first.row.evidence_reference).href.length,
    );
    expect(first.row.evidence_reference.length).toBeLessThanOrEqual(500);
    expect(first.row.optional_reference).toBeNull();
    expect(first.row.evidence_urls[0]).toBe(first.row.evidence_reference);
    expect(first.row.details.source).toBe(first.row.evidence_reference);
    expect(first.row.evidence_urls[1]).not.toBe(first.row.evidence_urls[0]);
    expect(rotated.row.evidence_reference).not.toBe(
      first.row.evidence_reference,
    );
    expect(JSON.stringify(first)).not.toContain("secret-canary");
    expect(JSON.stringify(first)).not.toContain("private-token");
    expect(JSON.stringify(first)).not.toContain("other-secret");

    for (const loopbackOrigin of ["https://localhost", "https://[::1]:58432"]) {
      const loopbackPolicy = structuredClone(urlPolicy);
      for (const column of loopbackPolicy.tables[0].columns) {
        if (column.recipe?.format === "url") {
          column.recipe.origin = loopbackOrigin;
        }
      }
      expect(() =>
        validateExecutablePrivacyPolicy(loopbackPolicy),
      ).not.toThrow();
    }

    for (const unsafeOrigin of [
      "http://127.0.0.1:58432",
      "https://example.com",
      "https://user:password@localhost",
      "https://localhost/path",
      "https://localhost?query=secret",
      "https://127.0.0.1:58432/private/..",
      "https://127.0.0.1:58432/private/%2e%2e",
    ]) {
      const invalid = structuredClone(urlPolicy);
      invalid.tables[0].columns[0].recipe.origin = unsafeOrigin;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        "safe HTTPS loopback origin",
      );
    }
    for (const invalidBound of [null, "500", 0, 50, 2_049]) {
      const invalid = structuredClone(urlPolicy);
      invalid.tables[0].columns[0].recipe.maxLength = invalidBound;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        /maxLength/u,
      );
    }
    for (const invalidSource of [
      "http://private.example/path",
      "not-a-url",
      " https://private.example/path",
      { href: "https://private.example/path" },
    ]) {
      expect(() =>
        engine.sanitize({
          ...source,
          row: { ...source.row, evidence_reference: invalidSource },
        }),
      ).toThrow("valid HTTPS URL");
    }
  });

  it("substitutes reviewed UUID bindings inside bounded retained text", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const substitution = {
      kind: "binding-substitute",
      binding: "approved-owner",
      format: "uuid",
      namespace: "account-id",
      maximumBytes: 128,
    };
    const substitutionPolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      bindings: {
        "approved-owner": {
          environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
          approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
        },
      },
      tables: [
        {
          name: "custom_foods",
          sourceRows: "STREAM AND SANITIZE",
          ownerBinding: { binding: "approved-owner", column: "user_id" },
          columns: [
            {
              name: "user_id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "account-id" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "food",
              action: "DERIVE",
              recipe: {
                kind: "json-object",
                maximumBytes: 512,
                fields: {
                  description: {
                    action: "DERIVE",
                    recipe: {
                      kind: "approved-owner",
                      approved: { action: "DERIVE", recipe: substitution },
                      otherwise: {
                        action: "PSEUDONYMIZE",
                        recipe: {
                          format: "text",
                          namespace: "food-description",
                          maxLength: 64,
                        },
                      },
                    },
                  },
                },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const create = (key = Buffer.alloc(32, 7), approvedOwner = owner) =>
      createPrivacyEngine({
        policy: substitutionPolicy,
        key,
        environment: { REHEARSAL_APPROVED_OWNER_ID: approvedOwner },
      });
    const sanitize = (engine, userId, description) =>
      engine.sanitize({
        table: "custom_foods",
        row: { user_id: userId, food: { description } },
      });
    const engine = create();
    const approved = sanitize(engine, owner, `Recipe for ${owner}`);
    const repeated = sanitize(engine, owner, `${owner} then ${owner}`);
    const ordinary = sanitize(engine, owner, "Permitted owner description");
    const nullable = sanitize(engine, owner, null);
    const other = sanitize(
      engine,
      "22222222-2222-4222-8222-222222222222",
      "other-owner-secret-canary",
    );
    const rotated = sanitize(
      create(Buffer.alloc(32, 8)),
      owner,
      `Recipe for ${owner}`,
    );

    expect(approved.row.food.description).toBe(
      `Recipe for ${approved.row.user_id}`,
    );
    expect(repeated.row.food.description).toBe(
      `${repeated.row.user_id} then ${repeated.row.user_id}`,
    );
    expect(ordinary.row.food.description).toBe("Permitted owner description");
    expect(nullable.row.food.description).toBeNull();
    expect(other.row.food.description).toMatch(/^rehearsal_[a-f0-9]+$/u);
    expect(other.row.food.description).not.toContain("secret-canary");
    expect(rotated.row.food.description).toBe(
      `Recipe for ${rotated.row.user_id}`,
    );
    expect(rotated.row.user_id).not.toBe(approved.row.user_id);
    expect(JSON.stringify(approved)).not.toContain(owner);

    expect(() => sanitize(engine, owner, { text: owner })).toThrow(
      "must be text or null",
    );
    expect(() => sanitize(engine, owner, "x".repeat(129))).toThrow(
      "reviewed byte limit",
    );

    const unknownBinding = structuredClone(substitutionPolicy);
    unknownBinding.tables[0].columns[1].recipe.fields.description.recipe.approved.recipe.binding =
      "missing-owner";
    expect(() => validateExecutablePrivacyPolicy(unknownBinding)).toThrow(
      "unknown privacy binding missing-owner",
    );
    for (const invalidMaximum of [undefined, null, "128", 0, -1, 65_537]) {
      const invalid = structuredClone(substitutionPolicy);
      const recipe =
        invalid.tables[0].columns[1].recipe.fields.description.recipe.approved
          .recipe;
      if (invalidMaximum === undefined) delete recipe.maximumBytes;
      else recipe.maximumBytes = invalidMaximum;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        "maximumBytes",
      );
    }
    const invalidFormat = structuredClone(substitutionPolicy);
    invalidFormat.tables[0].columns[1].recipe.fields.description.recipe.approved.recipe.format =
      "text";
    expect(() => validateExecutablePrivacyPolicy(invalidFormat)).toThrow(
      "format must be uuid",
    );

    const invalidOwner = "reviewed-but-not-a-uuid";
    const invalidOwnerPolicy = structuredClone(substitutionPolicy);
    invalidOwnerPolicy.bindings["approved-owner"].approvedValueSha256 =
      createHash("sha256").update(invalidOwner).digest("hex");
    const invalidOwnerEngine = createPrivacyEngine({
      policy: invalidOwnerPolicy,
      key: Buffer.alloc(32, 7),
      environment: { REHEARSAL_APPROVED_OWNER_ID: invalidOwner },
    });
    expect(() =>
      sanitize(invalidOwnerEngine, invalidOwner, `Recipe for ${invalidOwner}`),
    ).toThrow("invalid reviewed UUID binding");
    expect(() => sanitize(invalidOwnerEngine, invalidOwner, null)).toThrow(
      "invalid reviewed UUID binding",
    );
  });

  it("aligns identity paths and preserves related timestamp ordering", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const equivalentPolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      bindings: {
        "approved-owner": {
          environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
          approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
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
          name: "coverage",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "user_id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "account-id" },
              generated: "NEVER",
              identity: "YES",
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
              name: "checked_at",
              action: "DERIVE",
              recipe: {
                kind: "date-shift",
                days: 30,
                group: "coverage-window",
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "expires_at",
              action: "DERIVE",
              recipe: {
                kind: "date-shift",
                days: 30,
                group: "coverage-window",
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const engine = createPrivacyEngine({
      policy: equivalentPolicy,
      key: Buffer.alloc(32, 7),
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
    });
    for (let index = 0; index < 100; index += 1) {
      const checkedAt = new Date(Date.UTC(2026, 0, 1, 0, index));
      const expiresAt = new Date(checkedAt.valueOf() + 60 * 60 * 1_000);
      const result = engine.sanitize({
        table: "coverage",
        row: {
          user_id: owner,
          avatar_path: `${owner}/avatars/photo.png`,
          checked_at: checkedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        },
      });
      expect(result.row.avatar_path).toBe(
        `${result.row.user_id}/avatars/photo.png`,
      );
      expect(
        new Date(result.row.expires_at).valueOf() -
          new Date(result.row.checked_at).valueOf(),
      ).toBe(60 * 60 * 1_000);
    }
    expect(
      engine.remapPath({
        mapping: "owner-storage",
        value: `${owner}/avatars/photo.png`,
      }),
    ).toMatch(/^[a-f0-9-]{36}\/avatars\/photo\.png$/u);
    expect(() =>
      engine.remapPath({
        mapping: "owner-storage",
        value: "22222222-2222-4222-8222-222222222222/avatar.png",
      }),
    ).toThrow("exact reviewed identity");
    expect(() =>
      engine.remapPath({
        mapping: "owner-storage",
        value: `${owner}/../avatar.png`,
      }),
    ).toThrow("safe bounded Storage path");
  });

  it("preserves explicit epoch-millisecond dates and grouped mixed representations", () => {
    const dateColumn = (name, representation) => ({
      name,
      action: "DERIVE",
      recipe: {
        kind: "date-shift",
        days: 30,
        group: "saved-recipe-window",
        ...(representation === undefined ? {} : { representation }),
      },
      generated: "NEVER",
      identity: "NO",
      foreignKey: null,
    });
    const datePolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      tables: [
        {
          name: "saved_recipes",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            dateColumn("created_at", "epoch-milliseconds"),
            dateColumn("updated_at", "epoch-milliseconds"),
            dateColumn("stored_at"),
          ],
        },
      ],
    };
    const engine = createPrivacyEngine({
      policy: datePolicy,
      key: Buffer.alloc(32, 7),
    });
    const createdAt = Date.UTC(2026, 0, 1);
    const updatedAt = createdAt + 60 * 60 * 1_000;
    const input = {
      created_at: createdAt,
      updated_at: updatedAt,
      stored_at: new Date(createdAt).toISOString(),
    };
    const first = engine.sanitize({ table: "saved_recipes", row: input }).row;
    const repeated = engine.sanitize({
      table: "saved_recipes",
      row: input,
    }).row;

    expect(first).toEqual(repeated);
    expect(typeof first.created_at).toBe("number");
    expect(first.created_at).not.toBe(createdAt);
    expect(first.updated_at - first.created_at).toBe(60 * 60 * 1_000);
    expect(new Date(first.stored_at).valueOf()).toBe(first.created_at);
    expect(
      engine.sanitize({
        table: "saved_recipes",
        row: { created_at: null, updated_at: null, stored_at: null },
      }).row,
    ).toEqual({ created_at: null, updated_at: null, stored_at: null });

    const numericIsoInput = engine.sanitize({
      table: "saved_recipes",
      row: {
        created_at: createdAt,
        updated_at: updatedAt,
        stored_at: createdAt,
      },
    }).row;
    expect(typeof numericIsoInput.stored_at).toBe("string");

    for (const invalid of [
      "1767225600000",
      1_767_225_600_000.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        engine.sanitize({
          table: "saved_recipes",
          row: {
            created_at: invalid,
            updated_at: updatedAt,
            stored_at: input.stored_at,
          },
        }),
      ).toThrow("safe epoch-millisecond integer");
    }
    expect(() =>
      engine.sanitize({
        table: "saved_recipes",
        row: {
          created_at: Number.MAX_SAFE_INTEGER,
          updated_at: updatedAt,
          stored_at: input.stored_at,
        },
      }),
    ).toThrow("not a valid date");
    expect(() =>
      engine.sanitize({
        table: "saved_recipes",
        row: {
          created_at: 8_640_000_000_000_000,
          updated_at: updatedAt,
          stored_at: input.stored_at,
        },
      }),
    ).toThrow("outside the supported date range");

    for (const representation of [null, "epoch-seconds", "", 1]) {
      const invalidPolicy = structuredClone(datePolicy);
      invalidPolicy.tables[0].columns[0].recipe.representation = representation;
      expect(() => validateExecutablePrivacyPolicy(invalidPolicy)).toThrow(
        "representation must be iso-string or epoch-milliseconds",
      );
    }
  });

  it("retains only reviewed scalar domains across structured containers and owner branches", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const scalar = (values = ["contain", "cover", "custom"], allowNull) => ({
      action: "DERIVE",
      recipe: {
        kind: "enum",
        values,
        ...(allowNull === undefined ? {} : { allowNull }),
      },
    });
    const scalarPolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      bindings: {
        owner: {
          environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
          approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
        },
      },
      tables: [
        {
          name: "image_settings",
          sourceRows: "STREAM AND SANITIZE",
          ownerBinding: { binding: "owner", column: "user_id" },
          columns: [
            {
              name: "user_id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "account-id" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "settings",
              action: "DERIVE",
              recipe: {
                kind: "json-object",
                fields: {
                  fitMode: scalar(undefined, true),
                  modes: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-array",
                      maximumItems: 3,
                      maximumDepth: 2,
                      maximumBytes: 128,
                      items: scalar(),
                    },
                  },
                  modesBySlot: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-dictionary",
                      maximumItems: 3,
                      maximumDepth: 2,
                      maximumBytes: 128,
                      keys: { format: "identifier", action: "KEEP" },
                      values: scalar(),
                    },
                  },
                  ownerMode: {
                    action: "DERIVE",
                    recipe: {
                      kind: "approved-owner",
                      approved: scalar(["contain", "custom"]),
                      otherwise: scalar(["contain", "cover"]),
                    },
                  },
                },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const engine = createPrivacyEngine({
      policy: scalarPolicy,
      key: Buffer.alloc(32, 7),
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
    });
    const sanitize = (user_id, settings) =>
      engine.sanitize({ table: "image_settings", row: { user_id, settings } })
        .row.settings;
    const ordinary = {
      fitMode: "cover",
      modes: ["contain", "custom"],
      modesBySlot: { primary: "contain", thumbnail: "cover" },
      ownerMode: "cover",
    };

    expect(sanitize(other, ordinary)).toEqual(ordinary);
    expect(
      sanitize(owner, { ...ordinary, ownerMode: "custom" }).ownerMode,
    ).toBe("custom");
    expect(sanitize(other, { ...ordinary, fitMode: null }).fitMode).toBeNull();
    expect(() => sanitize(other, { ...ordinary, ownerMode: "custom" })).toThrow(
      "outside its reviewed scalar domain",
    );
    expect(() => sanitize(owner, { ...ordinary, ownerMode: "cover" })).toThrow(
      "outside its reviewed scalar domain",
    );

    const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature";
    for (const settings of [
      { ...ordinary, fitMode: secret },
      { ...ordinary, modes: [secret] },
      { ...ordinary, modesBySlot: { primary: secret } },
      { ...ordinary, ownerMode: secret },
    ]) {
      let message = "";
      try {
        sanitize(other, settings);
      } catch (error) {
        message = error.message;
      }
      expect(message).toContain("outside its reviewed scalar domain");
      expect(message).not.toContain(secret);
    }

    const fitModeRecipe = (candidate) =>
      candidate.tables[0].columns[1].recipe.fields.fitMode.recipe;
    for (const values of [
      [],
      Array(1),
      Array.from({ length: 129 }, (_, index) => `mode-${index}`),
      ["contain", "contain"],
      [null],
      [{}],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [-0],
      ["x".repeat(257)],
    ]) {
      const invalid = structuredClone(scalarPolicy);
      fitModeRecipe(invalid).values = values;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow();
    }
    for (const allowNull of [null, "true", 1]) {
      const invalid = structuredClone(scalarPolicy);
      fitModeRecipe(invalid).allowNull = allowNull;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        "allowNull must be true or false",
      );
    }
  });

  it("retains bounded portable codes without admitting credential-shaped text", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const code = (allowNull = false, maximumBytes = 64) => ({
      action: "DERIVE",
      recipe: {
        kind: "validated-string",
        format: "portable-code",
        maximumBytes,
        allowNull,
      },
    });
    const codePolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      bindings: {
        owner: {
          environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
          approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
        },
      },
      tables: [
        {
          name: "nutrient_evidence",
          sourceRows: "STREAM AND SANITIZE",
          ownerBinding: { binding: "owner", column: "user_id" },
          columns: [
            {
              name: "user_id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "account-id" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "source_code",
              ...code(true),
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "payload",
              action: "DERIVE",
              recipe: {
                kind: "json-object",
                fields: {
                  sourceNutrientCode: code(true),
                  sourceNutrientKeys: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-array",
                      maximumItems: 3,
                      maximumDepth: 2,
                      maximumBytes: 256,
                      items: code(),
                    },
                  },
                  codesByProvider: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-dictionary",
                      maximumItems: 3,
                      maximumDepth: 2,
                      maximumBytes: 256,
                      keys: { format: "identifier", action: "KEEP" },
                      values: code(),
                    },
                  },
                  ownerCode: {
                    action: "DERIVE",
                    recipe: {
                      kind: "approved-owner",
                      approved: code(),
                      otherwise: code(),
                    },
                  },
                },
              },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const engine = createPrivacyEngine({
      policy: codePolicy,
      key: Buffer.alloc(32, 7),
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
    });
    const ordinary = {
      sourceNutrientCode: "PROCNT",
      sourceNutrientKeys: ["203", "energy-kcal_100g"],
      codesByProvider: { usda: "PROCNT", off: "energy-kcal_100g" },
      ownerCode: "OWNER_CODE-1",
    };
    const sanitize = (user_id, source_code = "PROCNT", payload = ordinary) =>
      engine.sanitize({
        table: "nutrient_evidence",
        row: { user_id, source_code, payload },
      }).row;

    expect(sanitize(other).source_code).toBe("PROCNT");
    expect(sanitize(owner).payload).toEqual(ordinary);
    expect(
      sanitize(other, null, { ...ordinary, sourceNutrientCode: null }),
    ).toMatchObject({
      source_code: null,
      payload: { sourceNutrientCode: null },
    });

    const credential = `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`;
    const invalidValues = [
      credential,
      "",
      "-PROCNT",
      "_PROCNT",
      "PROCNT.value",
      "two words",
      "provider/code",
      "provider:code",
      "énergie",
      "line\nbreak",
      "x".repeat(65),
      203,
      { code: "PROCNT" },
    ];
    for (const value of invalidValues) {
      for (const run of [
        () => sanitize(other, value),
        () =>
          sanitize(other, "PROCNT", { ...ordinary, sourceNutrientCode: value }),
        () =>
          sanitize(other, "PROCNT", {
            ...ordinary,
            sourceNutrientKeys: [value],
          }),
        () =>
          sanitize(other, "PROCNT", {
            ...ordinary,
            codesByProvider: { usda: value },
          }),
        () => sanitize(other, "PROCNT", { ...ordinary, ownerCode: value }),
      ]) {
        let message = "";
        try {
          run();
        } catch (error) {
          message = error.message;
        }
        expect(message).toMatch(
          /not a valid reviewed portable code|exceeds maximumDepth/u,
        );
        if (typeof value === "string" && value) {
          expect(message).not.toContain(value);
        }
      }
    }

    const sourceRecipe = (candidate) => candidate.tables[0].columns[1].recipe;
    for (const format of [undefined, null, "identifier", "regex"]) {
      const invalid = structuredClone(codePolicy);
      if (format === undefined) delete sourceRecipe(invalid).format;
      else sourceRecipe(invalid).format = format;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        "format must be portable-code",
      );
    }
    for (const maximumBytes of [undefined, null, "64", 0, -1, 1_025]) {
      const invalid = structuredClone(codePolicy);
      if (maximumBytes === undefined) delete sourceRecipe(invalid).maximumBytes;
      else sourceRecipe(invalid).maximumBytes = maximumBytes;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        "maximumBytes",
      );
    }
    for (const allowNull of [null, "true", 1]) {
      const invalid = structuredClone(codePolicy);
      sourceRecipe(invalid).allowNull = allowNull;
      expect(() => validateExecutablePrivacyPolicy(invalid)).toThrow(
        "allowNull must be true or false",
      );
    }
    const arbitraryPattern = structuredClone(codePolicy);
    sourceRecipe(arbitraryPattern).pattern = "^[A-Z]+$";
    expect(() => validateExecutablePrivacyPolicy(arbitraryPattern)).toThrow(
      "pattern is unknown",
    );
  });

  it("fails closed for inconsistent shift groups and path mappings", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const base = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      bindings: {
        owner: {
          environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
          approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
        },
      },
      pathMappings: {
        files: {
          binding: "owner",
          format: "uuid",
          namespace: "account-id",
        },
      },
      tables: [
        {
          name: "events",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "path",
              action: "DERIVE",
              recipe: { kind: "path-map", mapping: "missing" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    expect(() => validateExecutablePrivacyPolicy(base)).toThrow(
      "unknown path mapping missing",
    );
    expect(() =>
      validateExecutablePrivacyPolicy({
        ...base,
        tables: [
          {
            ...base.tables[0],
            columns: [
              {
                ...base.tables[0].columns[0],
                name: "first_at",
                recipe: { kind: "date-shift", days: 3, group: "window" },
              },
              {
                ...base.tables[0].columns[0],
                name: "second_at",
                recipe: { kind: "date-shift", days: 4, group: "window" },
              },
            ],
          },
        ],
      }),
    ).toThrow("must use one days value");
  });

  it("fails closed for unknown tables, columns, JSON keys, and recipes", () => {
    const engine = createPrivacyEngine({ policy, key: Buffer.alloc(32, 9) });
    expect(() => engine.sanitize({ table: "unknown", row: { id: 1 } })).toThrow(
      "does not classify table",
    );
    expect(() =>
      engine.sanitize({
        table: "accounts",
        row: {
          id: "a",
          email: "a@example.com",
          metadata: { nickname: "A", token: "x", surprise: "private" },
          created_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toThrow("unclassified JSON key");
    expect(() =>
      validateExecutablePrivacyPolicy({
        ...policy,
        tables: [
          {
            ...policy.tables[0],
            columns: policy.tables[0].columns.map((column) =>
              column.name === "created_at"
                ? {
                    ...column,
                    recipe: { kind: "javascript", code: "return value" },
                  }
                : column,
            ),
          },
        ],
      }),
    ).toThrow("unknown");
  });

  it("creates an owner-only local key and rejects accidental replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-privacy-"));
    roots.push(root);
    const path = join(root, "secrets/privacy.key");
    const created = await createPrivacyKey(path);
    const key = await readPrivacyKey(path);

    expect(key).toHaveLength(32);
    expect(created.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(createPrivacyKey(path)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await readFile(path, "utf8")).trim()).not.toContain("source");
    await chmod(path, 0o644);
    await expect(readPrivacyKey(path)).rejects.toThrow("owner-only");
  });
});
