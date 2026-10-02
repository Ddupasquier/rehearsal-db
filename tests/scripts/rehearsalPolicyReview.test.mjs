import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAFE_COLUMN_PRESET,
  applyReviewedPolicy,
  completePolicyDraft,
  createSafeTablePreset,
  readReviewablePolicyDraft,
  suggestPolicyExceptionColumns,
} from "../../scripts/lib/rehearsal/policy_review.mjs";

const roots = [];
const draft = {
  policyVersion: 1,
  draft: true,
  migrationCutoff: "20261001000000",
  tables: [
    {
      name: "widgets",
      group: "synthetic",
      sourceRows: "STREAM AND SANITIZE",
      columns: [
        {
          name: "name",
          action: "REVIEW REQUIRED",
          generated: "REVIEW REQUIRED",
          identity: "REVIEW REQUIRED",
          foreignKey: "REVIEW REQUIRED",
        },
      ],
    },
  ],
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("interactive policy review", () => {
  it("creates explicit safe defaults and suggests structural exceptions", () => {
    const columns = ["created_at", "id", "name", "owner_id", "updated_at"];

    expect(createSafeTablePreset(columns)).toEqual(
      Object.fromEntries(
        columns.map((column) => [column, { ...SAFE_COLUMN_PRESET }]),
      ),
    );
    expect(suggestPolicyExceptionColumns(columns)).toEqual([
      "created_at",
      "id",
      "owner_id",
      "updated_at",
    ]);
  });

  it("combines table defaults with exception-only column review", async () => {
    const expanded = structuredClone(draft);
    expanded.tables[0].columns.push(
      {
        name: "id",
        action: "REVIEW REQUIRED",
        generated: "REVIEW REQUIRED",
        identity: "REVIEW REQUIRED",
        foreignKey: "REVIEW REQUIRED",
      },
      {
        name: "owner_id",
        action: "REVIEW REQUIRED",
        generated: "REVIEW REQUIRED",
        identity: "REVIEW REQUIRED",
        foreignKey: "REVIEW REQUIRED",
      },
    );
    const individuallyReviewed = [];
    const policy = await completePolicyDraft({
      draft: expanded,
      reviewTable: async ({ columns }) => {
        const preset = createSafeTablePreset(columns);
        delete preset.id;
        delete preset.owner_id;
        return preset;
      },
      reviewColumn: async ({ column }) => {
        individuallyReviewed.push(column);
        return {
          action: column === "id" ? "KEEP EXACTLY" : "PSEUDONYMIZE",
          generated: "NEVER",
          identity: column === "id" ? "YES" : "NO",
          foreignKey:
            column === "owner_id"
              ? { schema: "public", table: "owners", column: "id" }
              : null,
        };
      },
    });

    expect(individuallyReviewed).toEqual(["id", "owner_id"]);
    expect(policy.tables[0].columns).toEqual([
      { name: "name", ...SAFE_COLUMN_PRESET },
      {
        name: "id",
        action: "KEEP EXACTLY",
        generated: "NEVER",
        identity: "YES",
        foreignKey: null,
      },
      {
        name: "owner_id",
        action: "PSEUDONYMIZE",
        generated: "NEVER",
        identity: "NO",
        foreignKey: { schema: "public", table: "owners", column: "id" },
      },
    ]);
  });

  it("refuses a bulk review that leaves a column unclassified", async () => {
    await expect(
      completePolicyDraft({
        draft,
        reviewTable: async () => ({}),
      }),
    ).rejects.toThrow("did not classify widgets.name");
  });

  it("completes, validates, and applies a draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-policy-review-"));
    roots.push(root);
    const path = join(root, "policy.json");
    await writeFile(path, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
    const { source, draft: loaded } = await readReviewablePolicyDraft(path);
    const policy = await completePolicyDraft({
      draft: loaded,
      reviewColumn: async () => ({
        action: "REPLACE WITH SYNTHETIC",
        generated: "NEVER",
        identity: "NO",
        foreignKey: null,
      }),
    });
    await applyReviewedPolicy({ path, originalSource: source, policy });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(policy);
    expect(policy).not.toHaveProperty("draft");
  });

  it("refuses to replace a draft changed during review", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-policy-review-"));
    roots.push(root);
    const path = join(root, "policy.json");
    await writeFile(path, `${JSON.stringify(draft)}\n`);
    const { source, draft: loaded } = await readReviewablePolicyDraft(path);
    const policy = await completePolicyDraft({
      draft: loaded,
      reviewColumn: async () => ({
        action: "EXCLUDE",
        generated: "NEVER",
        identity: "NO",
        foreignKey: null,
      }),
    });
    await writeFile(path, `${JSON.stringify({ ...draft, note: "changed" })}\n`);

    await expect(
      applyReviewedPolicy({ path, originalSource: source, policy }),
    ).rejects.toThrow("changed during review");
  });
});
