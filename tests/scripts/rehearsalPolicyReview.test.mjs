import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReviewedPolicy,
  completePolicyDraft,
  readReviewablePolicyDraft,
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
