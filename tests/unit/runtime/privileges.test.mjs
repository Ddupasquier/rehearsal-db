import { describe, expect, it } from "vitest";
import {
  buildRuntimeFinalizationSql,
  buildRuntimePreparationSql,
  buildRuntimeVerificationSql,
  validateRuntimePolicy,
} from "../../../dist/src/runtime/policy.mjs";

const declaration = {
  kind: "table",
  schema: "public",
  name: "profiles",
  role: "anon",
  required: ["SELECT"],
  forbidden: ["INSERT", "UPDATE", "DELETE"],
};
const policy = (privileges) => ({ policyVersion: 1, privileges });
const sql = (privileges) => buildRuntimeVerificationSql(policy(privileges));

describe("opt-in effective runtime privileges", () => {
  it("preserves the exact old normalized policy shape and SQL when absent", () => {
    const old = validateRuntimePolicy({ policyVersion: 1 });
    expect(old).toEqual({
      policyVersion: 1,
      prerequisites: { schemas: [], extensions: [] },
      triggers: [],
      localRows: [],
      expectations: [],
    });
    expect(Object.hasOwn(old, "privileges")).toBe(false);
    expect(validateRuntimePolicy(old)).toEqual(old);
    expect(validateRuntimePolicy(policy([])).privileges).toEqual([]);
    expect(sql([])).toBe(buildRuntimeVerificationSql(old));
  });

  it("normalizes and freezes all supported kinds without inventing a grant", () => {
    const entries = [
      { kind: "schema", schema: "public", role: "anon", required: ["USAGE"] },
      declaration,
      {
        kind: "sequence",
        schema: "public",
        name: "profiles_id_seq",
        role: "authenticated",
        forbidden: ["UPDATE"],
      },
      {
        kind: "function",
        schema: "public",
        name: "get_profile",
        role: "authenticated",
        required: ["EXECUTE"],
        argumentTypes: [{ schema: "pg_catalog", name: "uuid" }],
      },
      {
        kind: "function",
        schema: "public",
        name: "list_profiles",
        role: "anon",
        forbidden: ["EXECUTE"],
        argumentTypes: [],
      },
    ];
    const normalized = validateRuntimePolicy(policy(entries));
    expect(normalized.privileges[0].forbidden).toEqual([]);
    expect(normalized.privileges[2].required).toEqual([]);
    expect(Object.isFrozen(normalized.privileges)).toBe(true);
    expect(Object.isFrozen(normalized.privileges[3].argumentTypes[0])).toBe(
      true,
    );
    expect(validateRuntimePolicy(normalized)).toEqual(normalized);
    const verification = sql(entries);
    for (const kind of ["schema", "table", "sequence", "function"])
      expect(verification).toContain(`pg_catalog.has_${kind}_privilege`);
    expect(verification).toContain("from pg_catalog.pg_roles");
    expect(verification).not.toMatch(
      /\b(?:grant|revoke|insert|update|delete|alter|create|drop)\s+(?:on|into|table|schema|role|function)\b/iu,
    );
    expect(buildRuntimePreparationSql(policy(entries))).toBe(
      "begin;\ncommit;\nbegin;\ncommit;\n",
    );
    expect(buildRuntimeFinalizationSql(policy(entries))).toBe(
      "begin;\ncommit;\n",
    );
  });

  it("requires full-table rights but detects column-only forbidden rights", () => {
    const tableSql = sql([
      {
        ...declaration,
        required: ["SELECT", "INSERT", "UPDATE", "REFERENCES"],
        forbidden: ["TRUNCATE"],
      },
    ]);
    expect(tableSql).not.toContain("has_any_column_privilege");
    const columnSql = sql([
      {
        ...declaration,
        required: [],
        forbidden: ["SELECT", "INSERT", "UPDATE", "REFERENCES", "DELETE"],
      },
    ]);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"])
      expect(columnSql).toContain(
        `pg_catalog.has_any_column_privilege(rehearsal_role, rehearsal_object, '${privilege}')`,
      );
    expect(columnSql).not.toContain(
      "has_any_column_privilege(rehearsal_role, rehearsal_object, 'DELETE')",
    );
    expect(columnSql).not.toMatch(
      /\b(?:relacl|attacl|relrowsecurity|pg_policies|set\s+role)\b/iu,
    );
    expect(columnSql).toContain("if rehearsal_allowed is null then");
  });

  it("resolves objects and exact function input types through catalogs, not SQL signatures", () => {
    const functionSql = sql([
      {
        kind: "function",
        schema: "public",
        name: "lookup_profile",
        role: "anon",
        required: ["EXECUTE"],
        argumentTypes: [
          { schema: "pg_catalog", name: "uuid" },
          { schema: "pg_catalog", name: "_text" },
        ],
      },
    ]);
    expect(functionSql).toContain("p.prokind = 'f' and p.pronargs = 2");
    expect(functionSql).toContain("p.proargtypes[0]");
    expect(functionSql).toContain("p.proargtypes[1]");
    expect(functionSql).toContain("t.typname = '_text'");
    expect(functionSql).not.toMatch(
      /regprocedure|regtype|lookup_profile\s*\(/u,
    );
    expect(functionSql).toContain(
      "Rehearsal privilege argument type is missing",
    );
    expect(functionSql).toContain("Rehearsal privilege object is missing");
    expect(
      sql([
        {
          kind: "function",
          schema: "public",
          name: "lookup_profile",
          role: "anon",
          forbidden: ["EXECUTE"],
          argumentTypes: [],
        },
      ]),
    ).toContain("p.pronargs = 0");
    expect(
      sql([
        {
          kind: "sequence",
          schema: "public",
          name: "seq",
          role: "anon",
          required: ["USAGE"],
        },
      ]),
    ).toContain("c.relkind = 'S'");
    expect(sql([declaration])).toContain(
      "c.relkind in ('r', 'p', 'v', 'm', 'f')",
    );
  });

  it("guards MAINTAIN on older PostgreSQL without evaluating an unknown privilege", () => {
    for (const field of ["required", "forbidden"]) {
      const verification = sql([
        { ...declaration, required: [], forbidden: [], [field]: ["MAINTAIN"] },
      ]);
      expect(verification).toMatch(
        /if pg_catalog\.current_setting\('server_version_num'\)::integer < 170000 then\s+rehearsal_allowed := false;\s+else\s+rehearsal_allowed := pg_catalog\.has_table_privilege\(rehearsal_role, rehearsal_object, 'MAINTAIN'\);/u,
      );
      expect(verification).toContain(
        `if rehearsal_allowed is ${field === "required" ? "false" : "true"} then`,
      );
    }
  });

  it("uses fixed failure messages without declared object or role values", () => {
    const verification = sql([
      {
        ...declaration,
        schema: "private_schema",
        name: "private_table",
        role: "private_role",
      },
    ]);
    const messages = [
      ...verification.matchAll(/raise exception '([^']+)'/gu),
    ].map((match) => match[1]);
    expect(messages).toContain("Rehearsal privilege role is missing");
    expect(messages).toContain("Rehearsal privilege object is unavailable");
    expect(messages).toContain("Rehearsal required privilege is missing");
    expect(messages).toContain("Rehearsal forbidden privilege is present");
    expect(messages.join("\n")).not.toMatch(
      /private_schema|private_table|private_role/u,
    );
  });

  it.each([
    null,
    undefined,
    {},
    "SELECT",
    [null],
    [false],
    [new Date()],
    Array(1),
  ])("rejects malformed privilege declarations %j", (value) => {
    expect(() => validateRuntimePolicy(policy(value))).toThrow();
  });

  it.each([
    { kind: "database" },
    { schema: undefined },
    { schema: "public; drop schema public" },
    { name: "profiles()" },
    { name: undefined },
    { name: "" },
    { role: undefined },
    { role: null },
    { role: "" },
    { role: "anon with grant option" },
    { sql: "select 1" },
    { required: null },
    { forbidden: null },
    { required: ["ALL"] },
    { required: ["select"] },
    { required: ["SELECT WITH GRANT OPTION"] },
    { required: ["SELECT", "SELECT"] },
    { required: Array(1) },
    { required: ["SELECT"], forbidden: ["SELECT"] },
    { required: [], forbidden: [] },
    { argumentTypes: [] },
  ])("rejects unsupported fields or privileges %j", (change) => {
    expect(() =>
      validateRuntimePolicy(policy([{ ...declaration, ...change }])),
    ).toThrow();
  });

  it("rejects contradictory declarations for the same exact object and role", () => {
    expect(() =>
      validateRuntimePolicy(
        policy([
          declaration,
          { ...declaration, required: [], forbidden: ["SELECT"] },
        ]),
      ),
    ).toThrow("overlapping");
    expect(() =>
      validateRuntimePolicy(
        policy([
          { ...declaration, role: "other_role" },
          { ...declaration, required: [], forbidden: ["SELECT"] },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    { kind: "schema", name: "unexpected", required: ["USAGE"] },
    { kind: "schema", required: ["SELECT"] },
    { kind: "sequence", required: ["DELETE"] },
    { kind: "function", required: ["SELECT"], argumentTypes: [] },
    { kind: "function", required: ["EXECUTE"], argumentTypes: null },
    { kind: "function", required: ["EXECUTE"] },
    { kind: "function", required: ["EXECUTE"], argumentTypes: ["uuid"] },
    { kind: "function", required: ["EXECUTE"], argumentTypes: Array(1) },
    {
      kind: "function",
      required: ["EXECUTE"],
      argumentTypes: [{ schema: "public", name: "uuid" }],
    },
    {
      kind: "function",
      required: ["EXECUTE"],
      argumentTypes: [{ schema: "pg_catalog", name: "text[]" }],
    },
    {
      kind: "function",
      required: ["EXECUTE"],
      argumentTypes: [{ schema: "pg_catalog", name: "uuid", sql: "select 1" }],
    },
  ])("rejects kind-specific object or signature errors %j", (change) => {
    const base = { schema: "public", role: "anon", forbidden: [] };
    if (change.kind !== "schema") base.name = "profiles";
    expect(() =>
      validateRuntimePolicy(policy([{ ...base, ...change }])),
    ).toThrow();
  });

  it("bounds identifiers, declarations and structured function arguments", () => {
    expect(() =>
      validateRuntimePolicy(policy([{ ...declaration, name: "a".repeat(63) }])),
    ).not.toThrow();
    expect(() =>
      validateRuntimePolicy(policy([{ ...declaration, name: "a".repeat(64) }])),
    ).toThrow();
    expect(() =>
      validateRuntimePolicy(
        policy(Array.from({ length: 1_024 }, () => declaration)),
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimePolicy(
        policy(Array.from({ length: 1_025 }, () => declaration)),
      ),
    ).toThrow("1024");
    const fn = {
      kind: "function",
      schema: "public",
      name: "many_args",
      role: "anon",
      required: ["EXECUTE"],
    };
    expect(() =>
      validateRuntimePolicy(
        policy([
          {
            ...fn,
            argumentTypes: Array.from({ length: 32 }, () => ({
              schema: "pg_catalog",
              name: "text",
            })),
          },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimePolicy(
        policy([
          {
            ...fn,
            argumentTypes: Array.from({ length: 33 }, () => ({
              schema: "pg_catalog",
              name: "text",
            })),
          },
        ]),
      ),
    ).toThrow("32");
  });
});
