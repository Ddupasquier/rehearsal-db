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

type ColumnReference = string | { name: string };
type ReviewedColumn = Record<string, unknown>;
interface PolicyColumn extends Record<string, unknown> {
  name: string;
}
interface PolicyTable extends Record<string, unknown> {
  name: string;
  columns: PolicyColumn[];
}
interface PolicyDraft extends Record<string, unknown> {
  draft: true;
  tables: PolicyTable[];
}

const isPolicyDraft = (value: unknown): value is PolicyDraft =>
  typeof value === "object" &&
  value !== null &&
  "draft" in value &&
  value.draft === true &&
  "tables" in value &&
  Array.isArray(value.tables);

export const createSafeTablePreset = (columns: readonly ColumnReference[]) =>
  Object.fromEntries(
    columns.map((column) => [
      typeof column === "string" ? column : column.name,
      { ...SAFE_COLUMN_PRESET },
    ]),
  );

export const suggestPolicyExceptionColumns = (
  columns: readonly ColumnReference[],
): string[] =>
  columns
    .map((column) => (typeof column === "string" ? column : column.name))
    .filter(
      (column) =>
        column === "id" ||
        column.endsWith("_id") ||
        ["created_at", "updated_at", "deleted_at"].includes(column),
    );

export const readReviewablePolicyDraft = async (
  path: string,
): Promise<{ source: string; draft: PolicyDraft }> => {
  const source = await readFile(path, "utf8");
  const draft = JSON.parse(source);
  if (!isPolicyDraft(draft)) {
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
}: {
  draft: unknown;
  reviewColumn?: (input: {
    table: string;
    column: string;
  }) => ReviewedColumn | undefined | Promise<ReviewedColumn | undefined>;
  reviewTable?: (input: {
    table: string;
    columns: string[];
  }) =>
    | Record<string, ReviewedColumn>
    | undefined
    | Promise<Record<string, ReviewedColumn> | undefined>;
}): Promise<unknown> => {
  if (!isPolicyDraft(draft)) {
    throw new Error("A generated REVIEW REQUIRED policy draft is required.");
  }
  const tables: PolicyTable[] = [];
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
  const reviewed: Record<string, unknown> = { ...draft, tables };
  delete reviewed.draft;
  return validateRuntimeSanitizationPolicy(reviewed);
};

export const applyReviewedPolicy = async ({
  path,
  originalSource,
  policy,
}: {
  path: string;
  originalSource: string;
  policy: unknown;
}): Promise<void> => {
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
