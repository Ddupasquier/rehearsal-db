import { createHash } from "node:crypto";
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
              identity: "YES",
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
    ).toThrow("explicitly pseudonymized identity");
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
