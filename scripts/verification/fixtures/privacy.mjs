/** Prove the public privacy engine from two unrelated packed-package consumers. */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packedRoot],
      { capture: true },
    ),
  )[0];
  const tarball = join(packedRoot, packed.filename);
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
            ownerBinding: { binding: "approved-owner", column: "user_id" },
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
              column("avatar_path", "DERIVE", {
                kind: "path-map",
                mapping: "owner-storage",
              }),
              column("display_name", "DERIVE", {
                kind: "approved-owner",
                approved: { action: "KEEP" },
                otherwise: {
                  action: "REPLACE",
                  recipe: { kind: "constant", value: "Synthetic account" },
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
const sanitize = (user_id, avatar_path, display_name, payload) => engine.sanitize({ table: "profiles", row: { user_id, avatar_path, display_name, payload } });
const approved = sanitize(${JSON.stringify(owner)}, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Approved name", [{ actor_id: ${JSON.stringify(owner)}, note: "secret-canary" }, { actor_id: ${JSON.stringify(owner)} }]);
const other = sanitize("22222222-2222-4222-8222-222222222222", ${JSON.stringify(`${owner}/avatars/main.png`)}, "Other private name", []);
const repeated = sanitize(${JSON.stringify(owner)}, ${JSON.stringify(`${owner}/avatars/main.png`)}, "Approved name", [{ actor_id: ${JSON.stringify(owner)} }]);
const rotated = create({}, Buffer.alloc(32, 8)).sanitize({ table: "profiles", row: { user_id: ${JSON.stringify(owner)}, avatar_path: ${JSON.stringify(`${owner}/avatars/main.png`)}, display_name: "Approved name", payload: [] } });
assert.equal(approved.row.display_name, "Approved name");
assert.equal(other.row.display_name, "Synthetic account");
assert.equal(approved.row.avatar_path, approved.row.user_id + "/avatars/main.png");
assert.equal(engine.remapPath({ mapping: "owner-storage", value: ${JSON.stringify(`${owner}/avatars/main.png`)} }), approved.row.avatar_path);
assert.equal(approved.row.payload[0].actor_id, approved.row.user_id);
assert.equal(repeated.row.user_id, approved.row.user_id);
assert.notEqual(other.row.user_id, approved.row.user_id);
assert.notEqual(rotated.row.user_id, approved.row.user_id);
assert.equal(JSON.stringify(approved).includes("secret-canary"), false);
assert.throws(() => sanitize(${JSON.stringify(owner)}, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [{ actor_id: ${JSON.stringify(owner)}, unknown: true }]), /unclassified JSON key/);
assert.throws(() => sanitize(${JSON.stringify(owner)}, ${JSON.stringify(`${owner}/avatar.png`)}, "A", [{}]), /missing required JSON keys/);
assert.throws(() => engine.remapPath({ mapping: "owner-storage", value: "wrong-owner/avatar.png" }), /exact reviewed identity/);
assert.throws(() => create({ REHEARSAL_APPROVED_OWNER_ID: "wrong" }), /review receipt/);
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
            ],
          },
        ],
      },
      environment: {},
      assertions: `
const engine = create();
const sanitize = (events, checked_at = "2026-01-01T12:00:00.000Z", expires_at = "2026-01-01T13:00:00.000Z") => engine.sanitize({ schema: "audit", table: "entries", row: { id: 1, checked_at, expires_at, events } });
const first = sanitize([{ subject: "self", detail: "secret-canary" }, { subject: "self" }]);
assert.equal(first.row.events[0].subject, first.row.events[1].subject);
assert.equal(first.row.events[0].detail, "redacted");
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
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        tarball,
      ],
      { cwd: root },
    );
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
        installedPackage: `${packed.name}@${packed.version}`,
        consumers: consumers.map(({ name }) => name),
        approvedOwnerConditional: true,
        boundedStructuredJson: true,
        identityAwareStoragePaths: true,
        groupedDateOrdering: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
