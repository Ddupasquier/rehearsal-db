/**
 * Purpose: Complete and safely apply a generated REVIEW REQUIRED policy draft.
 * The caller owns the interactive presentation; this module owns validation and
 * concurrent-change refusal.
 */

import { readFile, writeFile } from "node:fs/promises";
import { validateRuntimeSanitizationPolicy } from "./sanitization_policy.mjs";

export const SAFE_COLUMN_PRESET = Object.freeze({
  action: "REPLACE WITH SYNTHETIC",
  generated: "NEVER",
  identity: "NO",
  foreignKey: null,
});

export const createSafeTablePreset = (columns) =>
  Object.fromEntries(
    columns.map((column) => [
      typeof column === "string" ? column : column.name,
      { ...SAFE_COLUMN_PRESET },
    ]),
  );

export const suggestPolicyExceptionColumns = (columns) =>
  columns
    .map((column) => (typeof column === "string" ? column : column.name))
    .filter(
      (column) =>
        column === "id" ||
        column.endsWith("_id") ||
        ["created_at", "updated_at", "deleted_at"].includes(column),
    );

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

export const completePolicyDraft = async ({
  draft,
  reviewColumn,
  reviewTable,
}) => {
  if (draft?.draft !== true || !Array.isArray(draft.tables)) {
    throw new Error("A generated REVIEW REQUIRED policy draft is required.");
  }
  const tables = [];
  for (const table of draft.tables) {
    const columnNames = (table.columns ?? []).map((column) => column.name);
    const tableDecisions = reviewTable
      ? await reviewTable({ table: table.name, columns: columnNames })
      : {};
    const columns = [];
    for (const column of table.columns ?? []) {
      const reviewed =
        tableDecisions?.[column.name] ??
        (await reviewColumn?.({
          table: table.name,
          column: column.name,
        }));
      if (!reviewed) {
        throw new Error(
          `Policy review did not classify ${table.name}.${column.name}.`,
        );
      }
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
