/**
 * Purpose: Complete and safely apply a generated REVIEW REQUIRED policy draft.
 * The caller owns the interactive presentation; this module owns validation and
 * concurrent-change refusal.
 */

import { readFile, writeFile } from "node:fs/promises";
import { validateRuntimeSanitizationPolicy } from "./sanitization_policy.mjs";

export const readReviewablePolicyDraft = async (path) => {
  const source = await readFile(path, "utf8");
  const draft = JSON.parse(source);
  if (draft?.draft !== true || !Array.isArray(draft.tables)) {
    throw new Error(
      "Interactive review requires a generated sanitization policy with draft: true.",
    );
  }
  return { source, draft };
};

export const completePolicyDraft = async ({ draft, reviewColumn }) => {
  if (draft?.draft !== true || !Array.isArray(draft.tables)) {
    throw new Error("A generated REVIEW REQUIRED policy draft is required.");
  }
  const tables = [];
  for (const table of draft.tables) {
    const columns = [];
    for (const column of table.columns ?? []) {
      const reviewed = await reviewColumn({
        table: table.name,
        column: column.name,
      });
      columns.push({ name: column.name, ...reviewed });
    }
    tables.push({ ...table, columns });
  }
  const reviewed = { ...draft, tables };
  delete reviewed.draft;
  return validateRuntimeSanitizationPolicy(reviewed);
};

export const applyReviewedPolicy = async ({ path, originalSource, policy }) => {
  validateRuntimeSanitizationPolicy(policy);
  if ((await readFile(path, "utf8")) !== originalSource) {
    throw new Error(
      "The sanitization policy changed during review; no reviewed policy was written.",
    );
  }
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, {
    mode: 0o600,
  });
};
