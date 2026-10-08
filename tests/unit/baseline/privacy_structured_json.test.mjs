import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPrivacyEngine,
  validateExecutablePrivacyPolicy,
} from "../../../src/baseline/privacy_engine.mjs";

const column = (name, action, recipe) => ({
  name,
  action,
  ...(recipe === undefined ? {} : { recipe }),
  generated: "NEVER",
  identity: "NO",
  foreignKey: null,
});

describe("privacy ownership conditions", () => {
  it("treats reviewed null owners as non-owners and matches any reviewed column", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const policy = {
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
          name: "moderation_actions",
          sourceRows: "STREAM AND SANITIZE",
          ownerBinding: {
            binding: "approved-owner",
            columns: ["target_user_id", "actor_user_id"],
            match: "any",
            nullBehavior: "otherwise",
          },
          columns: [
            column("target_user_id", "PSEUDONYMIZE", {
              format: "uuid",
              namespace: "account-id",
            }),
            column("actor_user_id", "PSEUDONYMIZE", {
              format: "uuid",
              namespace: "account-id",
            }),
            column("reviewed_at", "DERIVE", {
              kind: "approved-owner",
              approved: { action: "KEEP" },
              otherwise: {
                action: "DERIVE",
                recipe: {
                  kind: "date-shift",
                  days: 30,
                  group: "moderation-history",
                },
              },
            }),
          ],
        },
      ],
    };
    const create = (candidate = policy) =>
      createPrivacyEngine({
        policy: candidate,
        key: Buffer.alloc(32, 7),
        environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
      });
    const engine = create();
    const reviewedAt = "2026-01-01T00:00:00.000Z";
    const sanitize = (target_user_id, actor_user_id) =>
      engine.sanitize({
        table: "moderation_actions",
        row: { target_user_id, actor_user_id, reviewed_at: reviewedAt },
      }).row;

    expect(
      sanitize(owner, "22222222-2222-4222-8222-222222222222").reviewed_at,
    ).toBe(reviewedAt);
    expect(
      sanitize("22222222-2222-4222-8222-222222222222", owner).reviewed_at,
    ).toBe(reviewedAt);
    expect(sanitize(null, owner).reviewed_at).toBe(reviewedAt);
    expect(sanitize(null, null).reviewed_at).not.toBe(reviewedAt);
    expect(
      sanitize(
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ).reviewed_at,
    ).not.toBe(reviewedAt);
    expect(() => sanitize({}, null)).toThrow("invalid owner binding value");

    for (const malformed of [NaN, Infinity, -Infinity]) {
      expect(() => sanitize(malformed, owner)).toThrow(
        "invalid owner binding value",
      );
      expect(() => sanitize(owner, malformed)).toThrow(
        "invalid owner binding value",
      );
    }
    const jsonInfinity = JSON.parse('{"owner":1e400}').owner;
    expect(jsonInfinity).toBe(Infinity);
    expect(() => sanitize(owner, jsonInfinity)).toThrow(
      "invalid owner binding value",
    );

    const singleOwnerPolicy = structuredClone(policy);
    singleOwnerPolicy.tables[0].ownerBinding = {
      binding: "approved-owner",
      column: "target_user_id",
      nullBehavior: "otherwise",
    };
    const singleOwnerEngine = create(singleOwnerPolicy);
    for (const malformed of [NaN, Infinity, -Infinity]) {
      expect(() =>
        singleOwnerEngine.sanitize({
          table: "moderation_actions",
          row: {
            target_user_id: malformed,
            actor_user_id: owner,
            reviewed_at: reviewedAt,
          },
        }),
      ).toThrow("invalid owner binding value");
    }

    const withoutNullReview = structuredClone(policy);
    delete withoutNullReview.tables[0].ownerBinding.nullBehavior;
    expect(() =>
      create(withoutNullReview).sanitize({
        table: "moderation_actions",
        row: {
          target_user_id: null,
          actor_user_id: null,
          reviewed_at: reviewedAt,
        },
      }),
    ).toThrow("invalid owner binding value");

    const withoutMatch = structuredClone(policy);
    delete withoutMatch.tables[0].ownerBinding.match;
    expect(() => validateExecutablePrivacyPolicy(withoutMatch)).toThrow(
      "match must be any",
    );

    const ambiguousColumns = structuredClone(policy);
    ambiguousColumns.tables[0].ownerBinding.column = "target_user_id";
    expect(() => validateExecutablePrivacyPolicy(ambiguousColumns)).toThrow(
      "exactly one of column or columns",
    );

    const duplicateColumns = structuredClone(policy);
    duplicateColumns.tables[0].ownerBinding.columns = [
      "target_user_id",
      "target_user_id",
    ];
    expect(() => validateExecutablePrivacyPolicy(duplicateColumns)).toThrow(
      "must not contain duplicates",
    );

    const unknownColumn = structuredClone(policy);
    unknownColumn.tables[0].ownerBinding.columns = ["missing_owner"];
    expect(() => validateExecutablePrivacyPolicy(unknownColumn)).toThrow(
      "unknown column",
    );

    const retainedOwner = structuredClone(policy);
    retainedOwner.tables[0].columns[0].action = "KEEP";
    delete retainedOwner.tables[0].columns[0].recipe;
    expect(() => validateExecutablePrivacyPolicy(retainedOwner)).toThrow(
      "must be explicitly pseudonymized",
    );

    const unsafeNullBehavior = structuredClone(policy);
    unsafeNullBehavior.tables[0].ownerBinding.nullBehavior = "approved";
    expect(() => validateExecutablePrivacyPolicy(unsafeNullBehavior)).toThrow(
      "must be otherwise",
    );
  });
});

describe("structured JSON privacy recipes", () => {
  const policy = {
    policyVersion: 2,
    migrationCutoff: "20260101000000",
    tables: [
      {
        name: "audit_items",
        sourceRows: "STREAM AND SANITIZE",
        columns: [
          column("before_value", "DERIVE", {
            kind: "json-union",
            allowNull: true,
            maximumItems: 3,
            maximumDepth: 4,
            maximumBytes: 512,
            variants: {
              string: { action: "KEEP" },
              number: { action: "KEEP" },
              boolean: {
                action: "REPLACE",
                recipe: { kind: "constant", value: false },
              },
              array: {
                action: "DERIVE",
                recipe: {
                  kind: "json-array",
                  maximumItems: 3,
                  maximumDepth: 3,
                  maximumBytes: 256,
                  items: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-union",
                      maximumItems: 1,
                      maximumDepth: 2,
                      maximumBytes: 64,
                      variants: {
                        string: { action: "KEEP" },
                        number: { action: "KEEP" },
                      },
                    },
                  },
                },
              },
              object: {
                action: "DERIVE",
                recipe: {
                  kind: "json-object",
                  fields: {
                    status: {
                      action: "DERIVE",
                      recipe: {
                        kind: "json-union",
                        maximumItems: 1,
                        maximumDepth: 2,
                        maximumBytes: 64,
                        variants: { string: { action: "KEEP" } },
                      },
                    },
                    note: {
                      action: "REPLACE",
                      required: false,
                      recipe: { kind: "constant", value: "Synthetic note" },
                    },
                  },
                },
              },
            },
          }),
          column("mix_state", "DERIVE", {
            kind: "json-object",
            fields: {
              servingGrams: {
                action: "DERIVE",
                recipe: {
                  kind: "json-dictionary",
                  maximumItems: 3,
                  maximumDepth: 3,
                  maximumBytes: 256,
                  keys: { format: "positive-integer", action: "KEEP" },
                  values: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-union",
                      maximumItems: 1,
                      maximumDepth: 2,
                      maximumBytes: 64,
                      variants: { number: { action: "KEEP" } },
                    },
                  },
                },
              },
              signedServings: {
                action: "DERIVE",
                required: false,
                recipe: {
                  kind: "json-dictionary",
                  maximumItems: 4,
                  maximumDepth: 3,
                  maximumBytes: 256,
                  keys: {
                    format: "integer",
                    action: "KEEP",
                    minimum: -9_007_199_254_740_991,
                    maximum: 9_007_199_254_740_991,
                  },
                  values: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-union",
                      maximumItems: 1,
                      maximumDepth: 2,
                      maximumBytes: 64,
                      variants: { number: { action: "KEEP" } },
                    },
                  },
                },
              },
              savedRecipes: {
                action: "DERIVE",
                required: false,
                recipe: {
                  kind: "json-array",
                  maximumItems: 2,
                  maximumDepth: 5,
                  maximumBytes: 512,
                  items: {
                    action: "DERIVE",
                    recipe: {
                      kind: "json-object",
                      fields: {
                        createdAt: {
                          action: "DERIVE",
                          recipe: {
                            kind: "date-shift",
                            days: 30,
                            group: "saved-recipe-window",
                            representation: "epoch-milliseconds",
                          },
                        },
                        updatedAt: {
                          action: "DERIVE",
                          recipe: {
                            kind: "date-shift",
                            days: 30,
                            group: "saved-recipe-window",
                            representation: "epoch-milliseconds",
                          },
                        },
                        servings: {
                          action: "DERIVE",
                          recipe: {
                            kind: "json-dictionary",
                            maximumItems: 4,
                            maximumDepth: 3,
                            maximumBytes: 256,
                            keys: {
                              format: "integer",
                              action: "KEEP",
                              minimum: -9_007_199_254_740_991,
                              maximum: 9_007_199_254_740_991,
                            },
                            values: {
                              action: "DERIVE",
                              recipe: {
                                kind: "json-union",
                                maximumItems: 1,
                                maximumDepth: 2,
                                maximumBytes: 64,
                                variants: { number: { action: "KEEP" } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
          column("identity_map", "DERIVE", {
            kind: "json-dictionary",
            maximumItems: 2,
            maximumDepth: 2,
            maximumBytes: 256,
            keys: {
              format: "uuid",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "account-id" },
            },
            values: {
              action: "REPLACE",
              recipe: { kind: "constant", value: "Synthetic account" },
            },
          }),
        ],
      },
    ],
  };
  const create = (candidate = policy) =>
    createPrivacyEngine({ policy: candidate, key: Buffer.alloc(32, 7) });
  const sanitize = (before_value, mix_state, identity_map = {}) =>
    create().sanitize({
      table: "audit_items",
      row: { before_value, mix_state, identity_map },
    }).row;

  it("shares integer identity mappings with canonical integer dictionary keys", () => {
    const numberValue = {
      action: "DERIVE",
      recipe: {
        kind: "json-union",
        maximumItems: 1,
        maximumDepth: 2,
        maximumBytes: 64,
        variants: { number: { action: "KEEP" } },
      },
    };
    const identityKeys = (namespace = "external:fdc_id") => ({
      format: "integer",
      action: "PSEUDONYMIZE",
      minimum: -9_007_199_254_740_991,
      maximum: 9_007_199_254_740_991,
      recipe: { format: "integer", namespace },
    });
    const identityDictionary = (namespace) => ({
      action: "DERIVE",
      recipe: {
        kind: "json-dictionary",
        maximumItems: 4,
        maximumDepth: 2,
        maximumBytes: 256,
        keys: identityKeys(namespace),
        values: numberValue,
      },
    });
    const correspondencePolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      tables: [
        {
          name: "foods",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            column("fdc_id", "PSEUDONYMIZE", {
              format: "integer",
              namespace: "external:fdc_id",
            }),
            column("food", "DERIVE", {
              kind: "json-object",
              fields: {
                selectedFoodId: {
                  action: "PSEUDONYMIZE",
                  recipe: {
                    format: "integer",
                    namespace: "external:fdc_id",
                  },
                },
              },
            }),
            column("state", "DERIVE", {
              kind: "json-object",
              fields: {
                servingGrams: identityDictionary(),
                servingQuantities: identityDictionary(),
                unrelatedIds: identityDictionary("external:other-id"),
              },
            }),
          ],
        },
      ],
    };
    const sanitizeIdentity = (source, key = Buffer.alloc(32, 7)) =>
      createPrivacyEngine({ policy: correspondencePolicy, key }).sanitize({
        table: "foods",
        row: {
          fdc_id: source,
          food: { selectedFoodId: source },
          state: {
            servingGrams: { [String(source)]: 100 },
            servingQuantities: { [String(source)]: 2 },
            unrelatedIds: { [String(source)]: 1 },
          },
        },
      }).row;

    for (const source of [203, -1_700_000_000_123, 0]) {
      const first = sanitizeIdentity(source);
      const repeated = sanitizeIdentity(source);
      const destination = String(first.fdc_id);
      expect(first).toEqual(repeated);
      expect(first.food.selectedFoodId).toBe(first.fdc_id);
      expect(Object.hasOwn(first.state.servingGrams, destination)).toBe(true);
      expect(Object.hasOwn(first.state.servingQuantities, destination)).toBe(
        true,
      );
      expect(Object.keys(first.state.unrelatedIds)).not.toContain(destination);
      expect(sanitizeIdentity(source, Buffer.alloc(32, 8)).fdc_id).not.toBe(
        first.fdc_id,
      );
    }

    for (const invalidKey of ["+203", "0203", "203.0", "2e3", "-0"]) {
      const invalid = structuredClone(correspondencePolicy);
      const engine = createPrivacyEngine({
        policy: invalid,
        key: Buffer.alloc(32, 7),
      });
      expect(() =>
        engine.sanitize({
          table: "foods",
          row: {
            fdc_id: 203,
            food: { selectedFoodId: 203 },
            state: {
              servingGrams: { [invalidKey]: 100 },
              servingQuantities: { 203: 2 },
              unrelatedIds: { 203: 1 },
            },
          },
        }),
      ).toThrow(/invalid integer key|outside the reviewed range/u);
    }
  });

  it("preserves each reviewed GTIN length inside one nested declaration", () => {
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
    const mixedPolicy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      tables: [
        {
          name: "foods",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            column("food", "DERIVE", {
              kind: "json-object",
              fields: {
                gtinUpc: {
                  action: "PSEUDONYMIZE",
                  recipe: {
                    format: "gtin",
                    namespace: "external:gtin",
                    allowedLengths: [12, 14],
                  },
                },
                comparisonGtin: {
                  action: "PSEUDONYMIZE",
                  recipe: {
                    format: "gtin",
                    namespace: "external:gtin",
                    allowedLengths: [12, 14],
                  },
                },
              },
            }),
          ],
        },
      ],
    };
    const createMixed = (key = Buffer.alloc(32, 7)) =>
      createPrivacyEngine({ policy: mixedPolicy, key });
    const sanitizeGtin = (value, key) =>
      createMixed(key).sanitize({
        table: "foods",
        row: { food: { gtinUpc: value, comparisonGtin: value } },
      }).row.food;
    const gtin12 = gtin("12345678901");
    const gtin14 = gtin("1234567890123");
    const checkDigit = (value) => gtin(value.slice(0, -1)).at(-1);

    for (const source of [gtin12, gtin14]) {
      const first = sanitizeGtin(source);
      const repeated = sanitizeGtin(source);
      expect(first).toEqual(repeated);
      expect(first.gtinUpc).toHaveLength(source.length);
      expect(first.gtinUpc).toMatch(/^\d+$/u);
      expect(first.gtinUpc.at(-1)).toBe(checkDigit(first.gtinUpc));
      expect(first.comparisonGtin).toBe(first.gtinUpc);
      expect(sanitizeGtin(source, Buffer.alloc(32, 8)).gtinUpc).not.toBe(
        first.gtinUpc,
      );
    }
    expect(sanitizeGtin(null)).toEqual({
      gtinUpc: null,
      comparisonGtin: null,
    });
    expect(() => sanitizeGtin(gtin("123456789012"))).toThrow(
      "allowed length (12, 14)",
    );
    expect(() => sanitizeGtin(`${gtin12.slice(0, -1)}0`)).toThrow(
      "valid normalized GTIN",
    );

    const ambiguous = structuredClone(mixedPolicy);
    ambiguous.tables[0].columns[0].recipe.fields.gtinUpc.recipe.length = 12;
    expect(() => validateExecutablePrivacyPolicy(ambiguous)).toThrow(
      "exactly one of length or allowedLengths",
    );
    const duplicate = structuredClone(mixedPolicy);
    duplicate.tables[0].columns[0].recipe.fields.gtinUpc.recipe.allowedLengths =
      [12, 12];
    expect(() => validateExecutablePrivacyPolicy(duplicate)).toThrow(
      "must not contain duplicates",
    );
    const unsupported = structuredClone(mixedPolicy);
    unsupported.tables[0].columns[0].recipe.fields.gtinUpc.recipe.allowedLengths =
      [10, 14];
    expect(() => validateExecutablePrivacyPolicy(unsupported)).toThrow(
      "reviewed GTIN lengths",
    );
  });

  it("accepts each reviewed JSON type and sanitizes classified values", () => {
    expect(
      sanitize("product", { servingGrams: { 101: 30 } }).before_value,
    ).toBe("product");
    expect(sanitize(42, { servingGrams: { 202: 55 } }).before_value).toBe(42);
    expect(sanitize(true, { servingGrams: {} }).before_value).toBe(false);
    expect(sanitize(["a", 2], { servingGrams: {} }).before_value).toEqual([
      "a",
      2,
    ]);
    expect(
      sanitize(
        { status: "changed", note: "secret-canary" },
        { servingGrams: { 101: 30, 202: 55 } },
      ),
    ).toMatchObject({
      before_value: { status: "changed", note: "Synthetic note" },
      mix_state: { servingGrams: { 101: 30, 202: 55 } },
    });
    expect(sanitize(null, { servingGrams: {} }).before_value).toBeNull();
    expect(
      sanitize("x", {
        servingGrams: {},
        signedServings: {
          "-1791288000000001": 30,
          0: 0,
          101: 55,
        },
        savedRecipes: [
          {
            createdAt: 1_767_225_600_000,
            updatedAt: 1_767_229_200_000,
            servings: { "-1791288000000001": 45, 101: 60 },
          },
        ],
      }).mix_state.signedServings,
    ).toEqual({ "-1791288000000001": 30, 0: 0, 101: 55 });
    const savedRecipes = sanitize("x", {
      servingGrams: {},
      savedRecipes: [
        {
          createdAt: 1_767_225_600_000,
          updatedAt: 1_767_229_200_000,
          servings: { "-1791288000000001": 45, 101: 60 },
        },
      ],
    }).mix_state.savedRecipes;
    expect(savedRecipes[0].createdAt).not.toBe(1_767_225_600_000);
    expect(savedRecipes[0].updatedAt - savedRecipes[0].createdAt).toBe(
      60 * 60 * 1_000,
    );
    expect(savedRecipes[0].servings).toEqual({
      "-1791288000000001": 45,
      101: 60,
    });
    expect(savedRecipes).toEqual(
      sanitize("x", {
        servingGrams: {},
        savedRecipes: [
          {
            createdAt: 1_767_225_600_000,
            updatedAt: 1_767_229_200_000,
            servings: { "-1791288000000001": 45, 101: 60 },
          },
        ],
      }).mix_state.savedRecipes,
    );
    expect(
      sanitize("x", {
        servingGrams: {},
        savedRecipes: [
          {
            createdAt: null,
            updatedAt: 1_767_229_200_000,
            servings: {},
          },
        ],
      }).mix_state.savedRecipes[0].createdAt,
    ).toBeNull();

    const sourceIdentity = "11111111-1111-4111-8111-111111111111";
    const identity = sanitize(
      "x",
      { servingGrams: {} },
      {
        [sourceIdentity]: "secret-canary",
      },
    ).identity_map;
    expect(Object.keys(identity)[0]).toMatch(/^[a-f0-9-]{36}$/u);
    expect(Object.keys(identity)[0]).not.toBe(sourceIdentity);
    expect(Object.values(identity)).toEqual(["Synthetic account"]);
    expect(JSON.stringify(identity)).not.toContain("secret-canary");
  });

  it("rejects unreviewed variants, keys, fields, and bounds", () => {
    expect(() =>
      sanitize({ status: "changed", unknown: "secret" }, { servingGrams: {} }),
    ).toThrow("unclassified JSON key");
    expect(() => sanitize([1, 2, 3, 4], { servingGrams: {} })).toThrow(
      "maximumItems",
    );
    expect(() => sanitize("x", { servingGrams: { 0: 1 } })).toThrow(
      "invalid positive-integer key",
    );
    for (const invalidKey of [
      "SECRET_CANARY",
      "+1",
      "-0",
      "01",
      "1.5",
      "1e3",
      "9007199254740992",
      "-9007199254740992",
    ]) {
      expect(() =>
        sanitize("x", {
          servingGrams: {},
          signedServings: { [invalidKey]: 1 },
        }),
      ).toThrow(/invalid integer key|outside the reviewed range/u);
    }
    for (const invalidDate of [
      "1767225600000",
      1_767_225_600_000.5,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        sanitize("x", {
          servingGrams: {},
          savedRecipes: [
            {
              createdAt: invalidDate,
              updatedAt: 1_767_229_200_000,
              servings: {},
            },
          ],
        }),
      ).toThrow(/safe epoch-millisecond integer|valid date/u);
    }
    expect(() =>
      sanitize("x", { servingGrams: { 101: 1, 202: 2, 303: 3, 404: 4 } }),
    ).toThrow("maximumItems");
    expect(() => sanitize("x", { servingGrams: {}, unknown: true })).toThrow(
      "unclassified JSON key",
    );
    expect(() => sanitize("x".repeat(600), { servingGrams: {} })).toThrow(
      "maximumBytes",
    );
    expect(() =>
      sanitize(
        { status: { one: { two: { three: { four: "deep" } } } } },
        { servingGrams: {} },
      ),
    ).toThrow("maximumDepth");
    expect(() =>
      sanitize("x", { servingGrams: { 101: "x".repeat(300) } }),
    ).toThrow("maximumBytes");
    expect(() =>
      sanitize("x", { servingGrams: {} }, { "not-a-uuid": "secret" }),
    ).toThrow("invalid uuid key");
    expect(() => sanitize("x", { servingGrams: {} }, null)).toThrow(
      "JSON dictionary object",
    );

    const unsafeUnion = structuredClone(policy);
    unsafeUnion.tables[0].columns[0].recipe.variants.object = {
      action: "KEEP",
    };
    expect(() => validateExecutablePrivacyPolicy(unsafeUnion)).toThrow(
      "classify container contents",
    );

    const missingVariant = structuredClone(policy);
    delete missingVariant.tables[0].columns[0].recipe.variants.string;
    expect(() =>
      create(missingVariant).sanitize({
        table: "audit_items",
        row: {
          before_value: "unreviewed",
          mix_state: { servingGrams: {} },
          identity_map: {},
        },
      }),
    ).toThrow("unreviewed JSON string variant");

    const retainedDictionaryValue = structuredClone(policy);
    retainedDictionaryValue.tables[0].columns[1].recipe.fields.servingGrams.recipe.values =
      { action: "KEEP" };
    expect(() =>
      validateExecutablePrivacyPolicy(retainedDictionaryValue),
    ).toThrow("must classify value types");

    const unsupportedKeyFormat = structuredClone(policy);
    unsupportedKeyFormat.tables[0].columns[2].recipe.keys.format = "pattern";
    expect(() => validateExecutablePrivacyPolicy(unsupportedKeyFormat)).toThrow(
      "keys.format is unsupported",
    );

    const signedKeys = (candidate) =>
      candidate.tables[0].columns[1].recipe.fields.signedServings.recipe.keys;
    for (const bound of ["minimum", "maximum"]) {
      const missingBound = structuredClone(policy);
      delete signedKeys(missingBound)[bound];
      expect(() => validateExecutablePrivacyPolicy(missingBound)).toThrow(
        `keys.${bound} must be a safe integer`,
      );
    }
    const invertedRange = structuredClone(policy);
    signedKeys(invertedRange).minimum = 2;
    signedKeys(invertedRange).maximum = -2;
    expect(() => validateExecutablePrivacyPolicy(invertedRange)).toThrow(
      "minimum must not exceed maximum",
    );
    const misplacedRange = structuredClone(policy);
    misplacedRange.tables[0].columns[1].recipe.fields.servingGrams.recipe.keys.minimum =
      -1;
    expect(() => validateExecutablePrivacyPolicy(misplacedRange)).toThrow(
      "supported only for integer keys",
    );

    const narrowRange = structuredClone(policy);
    signedKeys(narrowRange).minimum = -10;
    signedKeys(narrowRange).maximum = 10;
    expect(() =>
      create(narrowRange).sanitize({
        table: "audit_items",
        row: {
          before_value: "x",
          mix_state: { servingGrams: {}, signedServings: { "-11": 1 } },
          identity_map: {},
        },
      }),
    ).toThrow("outside the reviewed range -10 through 10");
  });
});
