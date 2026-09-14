import { describe, expect, it, vi } from "vitest";
import {
  EXCLUDED_VALUE,
  applySanitizationAction,
  validateSanitizationCoverage,
} from "../../scripts/lib/rehearsal/sanitization_policy.mjs";

const schemaTables = [
  { name: "accounts", columns: ["id", "email", "display_name"] },
  { name: "widgets", columns: ["id", "owner_id"] },
];

const policy = {
  policyVersion: 1,
  tables: [
    {
      name: "accounts",
      columns: [
        { name: "id", action: "PSEUDONYMIZE" },
        { name: "email", action: "REPLACE" },
        { name: "display_name", action: "EXCLUDE" },
      ],
    },
    {
      name: "widgets",
      columns: [
        { name: "id", action: "KEEP" },
        { name: "owner_id", action: "DERIVE" },
      ],
    },
  ],
};

describe("sanitization policy", () => {
  it("normalizes a complete, exact policy", () => {
    const result = validateSanitizationCoverage({ policy, schemaTables });
    expect(result.tableCount).toBe(2);
    expect(result.columnCount).toBe(5);
    expect(result.tables[0].columns[1].action).toBe("REPLACE");
  });

  it("fails closed for missing and unknown schema coverage", () => {
    expect(() =>
      validateSanitizationCoverage({
        policy: {
          ...policy,
          tables: policy.tables.slice(0, 1),
        },
        schemaTables,
      }),
    ).toThrow("does not classify table widgets");

    expect(() =>
      validateSanitizationCoverage({
        policy: {
          ...policy,
          tables: policy.tables.map((table) =>
            table.name === "accounts"
              ? {
                  ...table,
                  columns: table.columns.filter(
                    (column) => column.name !== "email",
                  ),
                }
              : table,
          ),
        },
        schemaTables,
      }),
    ).toThrow("does not classify column accounts.email");

    expect(() =>
      validateSanitizationCoverage({
        policy: {
          ...policy,
          tables: [
            ...policy.tables,
            { name: "ghosts", columns: [{ name: "id", action: "KEEP" }] },
          ],
        },
        schemaTables,
      }),
    ).toThrow("unknown table ghosts");
  });

  it("executes generic operations only through project-owned callbacks", () => {
    const replace = vi.fn(() => "safe@example.invalid");
    const pseudonymize = vi.fn((value) => `pseudo-${value}`);
    const derive = vi.fn((_value, context) => context.fallback);

    expect(applySanitizationAction({ action: "KEEP", value: 7 })).toBe(7);
    expect(applySanitizationAction({ action: "EXCLUDE", value: 7 })).toBe(
      EXCLUDED_VALUE,
    );
    expect(
      applySanitizationAction({ action: "REPLACE", value: "raw", replace }),
    ).toBe("safe@example.invalid");
    expect(
      applySanitizationAction({
        action: "PSEUDONYMIZE",
        value: "abc",
        pseudonymize,
      }),
    ).toBe("pseudo-abc");
    expect(
      applySanitizationAction({
        action: "DERIVE",
        value: null,
        derive,
        context: { fallback: "derived" },
      }),
    ).toBe("derived");
    expect(() =>
      applySanitizationAction({ action: "REPLACE", value: "raw" }),
    ).toThrow("project-owned replacement function");
  });
});
