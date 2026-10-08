/** Prove the public privacy engine from two unrelated packed-package consumers. */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCandidateArtifact,
  prepareCandidateArtifact,
} from "../scenarios/artifact.mjs";

const repositoryRoot = process.cwd();
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "rehearsal-privacy-fixture-"),
);
const packedRoot = join(temporaryRoot, "packed");

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    env: { ...process.env, ...options.environment },
  });

const column = (name, action, recipe, extra = {}) => ({
  name,
  action,
  ...(recipe ? { recipe } : {}),
  generated: "NEVER",
  identity: "NO",
  foreignKey: null,
  ...extra,
});

const consumerProgram = ({ policy, environment, assertions }) => `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPrivacyEngine, validateExecutablePrivacyPolicy } from "@rehearsal-db/core/privacy";
const policy = ${JSON.stringify(policy)};
validateExecutablePrivacyPolicy(policy);
const environment = ${JSON.stringify(environment)};
const create = (overrides = {}, key = Buffer.alloc(32, 7)) => createPrivacyEngine({
  policy,
  key,
  environment: { ...environment, ...overrides },
});
${assertions}
console.log(JSON.stringify({ status: "passed" }));
`;

try {
  await mkdir(packedRoot, { recursive: true });
  const artifact = await prepareCandidateArtifact({
    repositoryRoot,
    outputDirectory: packedRoot,
  });
  const owner = "11111111-1111-4111-8111-111111111111";
  const ownerSha256 =
    "bd7662a5eeb41614e720d477abfcb2272e19a8a70a93b7e3bc8560d44ad326e9";
  const sharedBindings = {
    "approved-owner": {
      environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
      approvedValueSha256: ownerSha256,
    },
  };

  const consumers = [
    {
      name: "profile-consumer",
      policy: {
        policyVersion: 2,
        migrationCutoff: "20260101000000",
        bindings: sharedBindings,
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
            name: "profiles",
            sourceRows: "STREAM AND SANITIZE",
            ownerBinding: {
              binding: "approved-owner",
              columns: ["user_id", "delegate_user_id"],
              match: "any",
              nullBehavior: "otherwise",
            },
            columns: [
              column(
                "user_id",
                "PSEUDONYMIZE",
                {
                  format: "uuid",
                  namespace: "account-id",
                },
                { identity: "NO" },
              ),
              column("delegate_user_id", "PSEUDONYMIZE", {
                format: "uuid",
                namespace: "account-id",
              }),
              column("avatar_path", "DERIVE", {
                kind: "path-map",
                mapping: "owner-storage",
              }),
              column("display_name", "DERIVE", {
                kind: "approved-owner",
                approved: {
                  action: "DERIVE",
                  recipe: {
                    kind: "binding-substitute",
                    binding: "approved-owner",
                    format: "uuid",
                    namespace: "account-id",
                    maximumBytes: 256,
                  },
                },
                otherwise: {
                  action: "REPLACE",
                  recipe: { kind: "constant", value: "Synthetic account" },
                },
              }),
              column("view_mode", "DERIVE", {
                kind: "approved-owner",
                approved: {
                  action: "DERIVE",
                  recipe: {
                    kind: "enum",
                    values: ["contain", "custom"],
                  },
                },
                otherwise: {
                  action: "DERIVE",
                  recipe: {
                    kind: "enum",
                    values: ["contain", "cover"],
                  },
                },
              }),
              column("source_code", "DERIVE", {
                kind: "approved-owner",
                approved: {
                  action: "DERIVE",
                  recipe: {
                    kind: "validated-string",
                    format: "portable-code",
                    maximumBytes: 64,
                    allowNull: true,
                  },
                },
                otherwise: {
                  action: "DERIVE",
                  recipe: {
                    kind: "validated-string",
                    format: "portable-code",
                    maximumBytes: 64,
                    allowNull: true,
                  },
                },
              }),
              column("payload", "DERIVE", {
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
                      note: {
                        action: "REPLACE",
                        required: false,
                        recipe: { kind: "constant", value: "Synthetic note" },
                      },
                    },
                  },
                },
              }),
            ],
          },
        ],
      },
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
      assertions: `
const engine = create();
const sanitize = (user_id, delegate_user_id, avatar_path, display_name, payload, view_mode = "contain", source_code = "PROCNT") => engine.sanitize({ table: "profiles", row: { user_id, delegate_user_id, avatar_path, display_name, view_mode, source_code, payload } });
const approved = sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Approved name", [{ actor_id: ${JSON.stringify(owner)}, note: "secret-canary" }, { actor_id: ${JSON.stringify(owner)} }]);
const delegated = sanitize("22222222-2222-4222-8222-222222222222", ${JSON.stringify(owner)}, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Delegated owner", []);
const other = sanitize("22222222-2222-4222-8222-222222222222", null, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Other private name", []);
const unowned = sanitize(null, null, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Unowned private name", []);
const repeated = sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Approved name", [{ actor_id: ${JSON.stringify(owner)} }]);
const embedded = sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatars/main.png`)}, ${JSON.stringify(`Recipe for ${owner}`)}, []);
const rotated = create({}, Buffer.alloc(32, 8)).sanitize({ table: "profiles", row: { user_id: ${JSON.stringify(owner)}, delegate_user_id: null, avatar_path: ${JSON.stringify(`${owner}/avatars/main.png`)}, display_name: "Approved name", view_mode: "contain", source_code: "PROCNT", payload: [] } });
assert.equal(approved.row.display_name, "Approved name");
assert.equal(embedded.row.display_name, "Recipe for " + embedded.row.user_id);
assert.equal(JSON.stringify(embedded).includes(${JSON.stringify(owner)}), false);
assert.equal(delegated.row.display_name, "Delegated owner");
assert.equal(other.row.display_name, "Synthetic account");
assert.equal(unowned.row.display_name, "Synthetic account");
assert.equal(sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [], "custom").row.view_mode, "custom");
assert.equal(sanitize("22222222-2222-4222-8222-222222222222", null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [], "cover").row.view_mode, "cover");
assert.throws(() => sanitize("22222222-2222-4222-8222-222222222222", null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [], "custom"), /outside its reviewed scalar domain/);
assert.equal(sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [], "contain", "energy-kcal_100g").row.source_code, "energy-kcal_100g");
assert.equal(sanitize("22222222-2222-4222-8222-222222222222", null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [], "contain", null).row.source_code, null);
assert.throws(() => sanitize("22222222-2222-4222-8222-222222222222", null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [], "contain", "aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc"), /not a valid reviewed portable code/);
assert.equal(approved.row.avatar_path, approved.row.user_id + "/avatars/main.png");
assert.equal(engine.remapPath({ mapping: "owner-storage", value: ${JSON.stringify(`${owner}/avatars/main.png`)} }), approved.row.avatar_path);
assert.equal(approved.row.payload[0].actor_id, approved.row.user_id);
assert.equal(repeated.row.user_id, approved.row.user_id);
assert.notEqual(other.row.user_id, approved.row.user_id);
assert.notEqual(rotated.row.user_id, approved.row.user_id);
assert.equal(JSON.stringify(approved).includes("secret-canary"), false);
assert.throws(() => sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [{ actor_id: ${JSON.stringify(owner)}, unknown: true }]), /unclassified JSON key/);
assert.throws(() => sanitize(${JSON.stringify(owner)}, null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [{}]), /missing required JSON keys/);
assert.throws(() => sanitize({}, null, ${JSON.stringify(`${owner}/avatar.png`)}, "A", []), /invalid owner binding value/);
for (const malformed of [NaN, Infinity, -Infinity]) {
  assert.throws(() => sanitize(malformed, ${JSON.stringify(owner)}, ${JSON.stringify(`${owner}/avatar.png`)}, "A", []), /invalid owner binding value/);
  assert.throws(() => sanitize(${JSON.stringify(owner)}, malformed, ${JSON.stringify(`${owner}/avatar.png`)}, "A", []), /invalid owner binding value/);
}
const jsonInfinity = JSON.parse('{"owner":1e400}').owner;
assert.equal(jsonInfinity, Infinity);
assert.throws(() => sanitize(${JSON.stringify(owner)}, jsonInfinity, ${JSON.stringify(`${owner}/avatar.png`)}, "A", []), /invalid owner binding value/);
assert.throws(() => engine.remapPath({ mapping: "owner-storage", value: "wrong-owner/avatar.png" }), /exact reviewed identity/);
assert.throws(() => create({ REHEARSAL_APPROVED_OWNER_ID: "wrong" }), /review receipt/);
const invalidOwner = "fixture-non-uuid";
const invalidPolicy = structuredClone(policy);
invalidPolicy.bindings["approved-owner"].approvedValueSha256 = createHash("sha256").update(invalidOwner).digest("hex");
const invalidEngine = createPrivacyEngine({ policy: invalidPolicy, key: Buffer.alloc(32, 7), environment: { REHEARSAL_APPROVED_OWNER_ID: invalidOwner } });
const invalidRecord = (display_name) => ({ table: "profiles", row: { user_id: invalidOwner, delegate_user_id: null, avatar_path: invalidOwner + "/avatars/main.png", display_name, view_mode: "contain", source_code: "PROCNT", payload: [] } });
assert.throws(() => invalidEngine.sanitize(invalidRecord("Ordinary text")), /invalid reviewed UUID binding/);
assert.throws(() => invalidEngine.sanitize(invalidRecord(null)), /invalid reviewed UUID binding/);
`,
    },
    {
      name: "audit-consumer",
      policy: {
        policyVersion: 2,
        migrationCutoff: "20260101000000",
        tables: [
          {
            schema: "audit",
            name: "entries",
            sourceRows: "STREAM AND SANITIZE",
            columns: [
              column("id", "KEEP"),
              column("fdc_id", "PSEUDONYMIZE", {
                format: "integer",
                namespace: "external:fdc_id",
              }),
              column("barcode", "PSEUDONYMIZE", {
                format: "gtin",
                namespace: "audit-barcode",
                length: 14,
              }),
              column("source_fingerprint", "PSEUDONYMIZE", {
                format: "hex",
                namespace: "audit-source-fingerprint",
                length: 32,
              }),
              column("evidence_reference", "PSEUDONYMIZE", {
                format: "url",
                namespace: "audit-evidence-url",
                origin: "https://127.0.0.1:58432",
                maxLength: 500,
              }),
              column("evidence_urls", "DERIVE", {
                kind: "json-array",
                maximumItems: 3,
                maximumBytes: 2_048,
                items: {
                  action: "PSEUDONYMIZE",
                  recipe: {
                    format: "url",
                    namespace: "audit-evidence-url",
                    origin: "https://127.0.0.1:58432",
                    maxLength: 500,
                  },
                },
              }),
              column("evidence_fingerprint", "DERIVE", {
                kind: "digest",
                format: "hex",
                namespace: "audit-evidence",
                length: 64,
                inputs: ["id", "barcode"],
              }),
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
                  selectedFoodId: {
                    action: "PSEUDONYMIZE",
                    required: false,
                    recipe: {
                      format: "integer",
                      namespace: "external:fdc_id",
                    },
                  },
                },
              }),
              column("checked_at", "DERIVE", {
                kind: "date-shift",
                days: 30,
                group: "audit-window",
              }),
              column("expires_at", "DERIVE", {
                kind: "date-shift",
                days: 30,
                group: "audit-window",
              }),
              column("events", "DERIVE", {
                kind: "json-array",
                maximumItems: 3,
                maximumDepth: 5,
                maximumBytes: 256,
                allowNull: true,
                items: {
                  action: "DERIVE",
                  recipe: {
                    kind: "json-object",
                    fields: {
                      subject: {
                        action: "PSEUDONYMIZE",
                        recipe: {
                          format: "text",
                          namespace: "audit-subject",
                          maxLength: 32,
                        },
                      },
                      detail: {
                        action: "REPLACE",
                        required: false,
                        recipe: { kind: "constant", value: "redacted" },
                      },
                    },
                  },
                },
              }),
              column("before_value", "DERIVE", {
                kind: "json-union",
                allowNull: true,
                maximumItems: 3,
                maximumDepth: 4,
                maximumBytes: 512,
                variants: {
                  string: { action: "KEEP" },
                  number: { action: "KEEP" },
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
                          recipe: {
                            kind: "constant",
                            value: "Synthetic note",
                          },
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
                      keys: {
                        format: "positive-integer",
                        action: "KEEP",
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
                  foodServingGrams: {
                    action: "DERIVE",
                    required: false,
                    recipe: {
                      kind: "json-dictionary",
                      maximumItems: 4,
                      maximumDepth: 3,
                      maximumBytes: 256,
                      keys: {
                        format: "integer",
                        action: "PSEUDONYMIZE",
                        minimum: -9_007_199_254_740_991,
                        maximum: 9_007_199_254_740_991,
                        recipe: {
                          format: "integer",
                          namespace: "external:fdc_id",
                        },
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
                  foodServingQuantities: {
                    action: "DERIVE",
                    required: false,
                    recipe: {
                      kind: "json-dictionary",
                      maximumItems: 4,
                      maximumDepth: 3,
                      maximumBytes: 256,
                      keys: {
                        format: "integer",
                        action: "PSEUDONYMIZE",
                        minimum: -9_007_199_254_740_991,
                        maximum: 9_007_199_254_740_991,
                        recipe: {
                          format: "integer",
                          namespace: "external:fdc_id",
                        },
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
                            fitMode: {
                              action: "DERIVE",
                              recipe: {
                                kind: "enum",
                                values: ["contain", "cover", "custom"],
                                allowNull: true,
                              },
                            },
                            fitModes: {
                              action: "DERIVE",
                              recipe: {
                                kind: "json-array",
                                maximumItems: 3,
                                maximumDepth: 2,
                                maximumBytes: 128,
                                items: {
                                  action: "DERIVE",
                                  recipe: {
                                    kind: "enum",
                                    values: ["contain", "cover", "custom"],
                                  },
                                },
                              },
                            },
                            fitModesBySlot: {
                              action: "DERIVE",
                              recipe: {
                                kind: "json-dictionary",
                                maximumItems: 3,
                                maximumDepth: 2,
                                maximumBytes: 128,
                                keys: {
                                  format: "identifier",
                                  action: "KEEP",
                                },
                                values: {
                                  action: "DERIVE",
                                  recipe: {
                                    kind: "enum",
                                    values: ["contain", "cover", "custom"],
                                  },
                                },
                              },
                            },
                            sourceNutrientCode: {
                              action: "DERIVE",
                              recipe: {
                                kind: "validated-string",
                                format: "portable-code",
                                maximumBytes: 64,
                                allowNull: true,
                              },
                            },
                            sourceNutrientKeys: {
                              action: "DERIVE",
                              recipe: {
                                kind: "json-array",
                                maximumItems: 3,
                                maximumDepth: 2,
                                maximumBytes: 256,
                                items: {
                                  action: "DERIVE",
                                  recipe: {
                                    kind: "validated-string",
                                    format: "portable-code",
                                    maximumBytes: 64,
                                  },
                                },
                              },
                            },
                            codesByProvider: {
                              action: "DERIVE",
                              recipe: {
                                kind: "json-dictionary",
                                maximumItems: 3,
                                maximumDepth: 2,
                                maximumBytes: 256,
                                keys: {
                                  format: "identifier",
                                  action: "KEEP",
                                },
                                values: {
                                  action: "DERIVE",
                                  recipe: {
                                    kind: "validated-string",
                                    format: "portable-code",
                                    maximumBytes: 64,
                                  },
                                },
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
            ],
          },
        ],
      },
      environment: {},
      assertions: `
const engine = create();
const sanitize = (events, checked_at = "2026-01-01T12:00:00.000Z", expires_at = "2026-01-01T13:00:00.000Z", before_value = null, mix_state = { servingGrams: {} }, evidence_fingerprint = "private-derived-value", food = { gtinUpc: "12345678901231", comparisonGtin: "12345678901231" }, evidence_reference = "https://secret-canary.example/private?token=private", evidence_urls = [evidence_reference, "https://second-secret.example/evidence"], fdc_id = 203) => engine.sanitize({ schema: "audit", table: "entries", row: { id: 1, fdc_id, barcode: "12345678901231", source_fingerprint: "private-source-fingerprint", evidence_reference, evidence_urls, evidence_fingerprint, food, checked_at, expires_at, events, before_value, mix_state } });
const first = sanitize([{ subject: "self", detail: "secret-canary" }, { subject: "self" }]);
const checkDigit = (payload) => String((10 - ([...payload].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0) % 10)) % 10);
assert.equal(first.row.events[0].subject, first.row.events[1].subject);
assert.equal(first.row.events[0].detail, "redacted");
assert.match(first.row.barcode, /^\\d{14}$/u);
assert.equal(first.row.barcode.at(-1), checkDigit(first.row.barcode.slice(0, -1)));
assert.match(first.row.source_fingerprint, /^[a-f0-9]{32}$/u);
const evidenceUrl = new URL(first.row.evidence_reference);
assert.equal(evidenceUrl.protocol, "https:");
assert.equal(evidenceUrl.hostname, "127.0.0.1");
assert.equal(evidenceUrl.port, "58432");
assert.equal(evidenceUrl.pathname.startsWith("/rehearsal/"), true);
assert.match(evidenceUrl.pathname.split("/").at(-1), /^[a-f0-9]{32}$/u);
const satisfiesEvidenceConstraint = (value) => value.length <= 500 && new URL(value).protocol === "https:" && ![...value].some((character) => character.trim() === "");
assert.equal(satisfiesEvidenceConstraint(first.row.evidence_reference), true);
assert.equal(first.row.evidence_urls[0], first.row.evidence_reference);
assert.notEqual(first.row.evidence_urls[1], first.row.evidence_urls[0]);
assert.equal(first.row.evidence_urls.every(satisfiesEvidenceConstraint), true);
assert.equal(JSON.stringify(first).includes("secret-canary"), false);
assert.equal(JSON.stringify(first).includes("private"), false);
for (const unsafeOrigin of ["https://127.0.0.1:58432/private/..", "https://127.0.0.1:58432/private/%2e%2e"]) {
  const unsafePolicy = structuredClone(policy);
  unsafePolicy.tables[0].columns.find((column) => column.name === "evidence_reference").recipe.origin = unsafeOrigin;
  assert.throws(() => validateExecutablePrivacyPolicy(unsafePolicy), /safe HTTPS loopback origin/);
}
assert.match(first.row.evidence_fingerprint, /^[a-f0-9]{64}$/u);
assert.equal(sanitize([], undefined, undefined, undefined, undefined, "different-private-value").row.evidence_fingerprint, sanitize([]).row.evidence_fingerprint);
const nested12 = sanitize([], undefined, undefined, undefined, undefined, undefined, { gtinUpc: "123456789012", comparisonGtin: "123456789012" }).row.food;
const nested14 = sanitize([]).row.food;
assert.equal(nested12.gtinUpc.length, 12);
assert.equal(nested14.gtinUpc.length, 14);
assert.equal(nested12.gtinUpc.at(-1), checkDigit(nested12.gtinUpc.slice(0, -1)));
assert.equal(nested14.gtinUpc.at(-1), checkDigit(nested14.gtinUpc.slice(0, -1)));
assert.equal(nested12.comparisonGtin, nested12.gtinUpc);
assert.equal(nested14.comparisonGtin, nested14.gtinUpc);
assert.throws(() => sanitize([], undefined, undefined, undefined, undefined, undefined, { gtinUpc: "1234567890128", comparisonGtin: "1234567890128" }), /allowed length/);
for (const source of [203, -1700000000123, 0]) {
  const identity = sanitize(
    [],
    undefined,
    undefined,
    null,
    { servingGrams: {}, foodServingGrams: { [String(source)]: 100 }, foodServingQuantities: { [String(source)]: 2 } },
    undefined,
    { gtinUpc: "12345678901231", comparisonGtin: "12345678901231", selectedFoodId: source },
    undefined,
    undefined,
    source,
  ).row;
  const destination = String(identity.fdc_id);
  assert.equal(identity.food.selectedFoodId, identity.fdc_id);
  assert.equal(Object.hasOwn(identity.mix_state.foodServingGrams, destination), true);
  assert.equal(Object.hasOwn(identity.mix_state.foodServingQuantities, destination), true);
}
assert.equal(Date.parse(first.row.expires_at) - Date.parse(first.row.checked_at), 60 * 60 * 1000);
for (let index = 0; index < 100; index += 1) {
  const start = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  const end = new Date(Date.UTC(2026, 0, 1, 0, index + 1)).toISOString();
  const shifted = sanitize([], start, end).row;
  assert.ok(Date.parse(shifted.checked_at) < Date.parse(shifted.expires_at));
}
assert.equal(JSON.stringify(first).includes("secret-canary"), false);
assert.equal(sanitize(null).row.events, null);
assert.throws(() => sanitize([{ subject: "a" }, { subject: "b" }, { subject: "c" }, { subject: "d" }]), /maximumItems/);
assert.throws(() => sanitize([{ subject: "x".repeat(300) }]), /maximumBytes/);
assert.throws(() => sanitize([{ subject: { one: { two: { three: { four: "deep" } } } } }]), /maximumDepth/);
assert.equal(sanitize([], undefined, undefined, "safe scalar").row.before_value, "safe scalar");
assert.equal(sanitize([], undefined, undefined, 42).row.before_value, 42);
assert.deepEqual(sanitize([], undefined, undefined, ["safe", 2]).row.before_value, ["safe", 2]);
assert.deepEqual(sanitize([], undefined, undefined, { status: "changed", note: "secret-canary" }).row.before_value, { status: "changed", note: "Synthetic note" });
assert.deepEqual(sanitize([], undefined, undefined, null, { servingGrams: { 101: 30, 202: 55 } }).row.mix_state, { servingGrams: { 101: 30, 202: 55 } });
assert.deepEqual(sanitize([], undefined, undefined, null, { servingGrams: {}, signedServings: { "-1791288000000001": 30, 0: 0, 101: 55 } }).row.mix_state.signedServings, { "-1791288000000001": 30, 0: 0, 101: 55 });
const savedRecipeInput = { createdAt: 1767225600000, updatedAt: 1767229200000, fitMode: "cover", fitModes: ["contain", "custom"], fitModesBySlot: { primary: "contain", thumbnail: "cover" }, sourceNutrientCode: "PROCNT", sourceNutrientKeys: ["203", "energy-kcal_100g"], codesByProvider: { usda: "PROCNT", off: "energy-kcal_100g" }, servings: { "-1791288000000001": 45, 101: 60 } };
const savedRecipe = sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [savedRecipeInput] }).row.mix_state.savedRecipes[0];
assert.equal(typeof savedRecipe.createdAt, "number");
assert.notEqual(savedRecipe.createdAt, savedRecipeInput.createdAt);
assert.equal(savedRecipe.updatedAt - savedRecipe.createdAt, 60 * 60 * 1000);
assert.deepEqual(savedRecipe.servings, savedRecipeInput.servings);
assert.equal(savedRecipe.fitMode, "cover");
assert.deepEqual(savedRecipe.fitModes, ["contain", "custom"]);
assert.deepEqual(savedRecipe.fitModesBySlot, { primary: "contain", thumbnail: "cover" });
assert.equal(savedRecipe.sourceNutrientCode, "PROCNT");
assert.deepEqual(savedRecipe.sourceNutrientKeys, ["203", "energy-kcal_100g"]);
assert.deepEqual(savedRecipe.codesByProvider, { usda: "PROCNT", off: "energy-kcal_100g" });
assert.deepEqual(savedRecipe, sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [savedRecipeInput] }).row.mix_state.savedRecipes[0]);
for (const invalidKey of ["SECRET_CANARY", "+1", "-0", "01", "1.5", "1e3", "9007199254740992", "-9007199254740992"]) {
  assert.throws(() => sanitize([], undefined, undefined, null, { servingGrams: {}, signedServings: { [invalidKey]: 1 } }), /invalid integer key|outside the reviewed range/);
  assert.throws(() => sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [{ ...savedRecipeInput, servings: { [invalidKey]: 1 } }] }), /invalid integer key|outside the reviewed range/);
}
for (const invalidDate of ["1767225600000", 1767225600000.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [{ ...savedRecipeInput, createdAt: invalidDate }] }), /safe epoch-millisecond integer|valid date/);
}
assert.equal(sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [{ ...savedRecipeInput, createdAt: null }] }).row.mix_state.savedRecipes[0].createdAt, null);
const scalarCanary = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature";
for (const invalidRecipe of [
  { ...savedRecipeInput, fitMode: scalarCanary },
  { ...savedRecipeInput, fitModes: [scalarCanary] },
  { ...savedRecipeInput, fitModesBySlot: { primary: scalarCanary } },
]) {
  let message = "";
  try { sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [invalidRecipe] }); } catch (error) { message = error.message; }
  assert.match(message, /outside its reviewed scalar domain/);
  assert.equal(message.includes(scalarCanary), false);
}
const codeCanary = "aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc";
for (const invalidRecipe of [
  { ...savedRecipeInput, sourceNutrientCode: codeCanary },
  { ...savedRecipeInput, sourceNutrientKeys: [codeCanary] },
  { ...savedRecipeInput, codesByProvider: { usda: codeCanary } },
]) {
  let message = "";
  try { sanitize([], undefined, undefined, null, { servingGrams: {}, savedRecipes: [invalidRecipe] }); } catch (error) { message = error.message; }
  assert.match(message, /not a valid reviewed portable code/);
  assert.equal(message.includes(codeCanary), false);
}
assert.throws(() => sanitize([], undefined, undefined, { status: "changed", unknown: "secret" }), /unclassified JSON key/);
assert.throws(() => sanitize([], undefined, undefined, null, { servingGrams: { 0: 30 } }), /invalid positive-integer key/);
assert.throws(() => sanitize([], undefined, undefined, null, { servingGrams: { 101: 1, 202: 2, 303: 3, 404: 4 } }), /maximumItems/);
`,
    },
  ];

  for (const consumer of consumers) {
    const root = join(temporaryRoot, consumer.name);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: consumer.name, private: true, type: "module" })}\n`,
    );
    installCandidateArtifact(root, artifact);
    await writeFile(join(root, "verify.mjs"), consumerProgram(consumer));
    const result = JSON.parse(
      run(process.execPath, ["verify.mjs"], { cwd: root, capture: true }),
    );
    if (result.status !== "passed") throw new Error(`${consumer.name} failed.`);
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        installedPackage: `${artifact.name}@${artifact.version}`,
        artifactSha256: artifact.sha256,
        artifactSource: artifact.source,
        consumers: consumers.map(({ name }) => name),
        approvedOwnerConditional: true,
        retainedTextBindingSubstitution: true,
        nullableAndAnyOwnerMatching: true,
        finiteOwnerValidation: true,
        boundedStructuredJson: true,
        boundedJsonTypeUnions: true,
        boundedJsonDictionaries: true,
        boundedSignedIntegerDictionaryKeys: true,
        numericIdentityDictionaryCorrespondence: true,
        identityAwareStoragePaths: true,
        groupedDateOrdering: true,
        epochMillisecondDateRepresentation: true,
        reviewedScalarDomains: true,
        validatedOpenStructuralCodes: true,
        constraintPreservingPseudonyms: true,
        mixedLengthNestedGtins: true,
        keyedHttpsUrls: true,
        sanitizedInputDigests: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
