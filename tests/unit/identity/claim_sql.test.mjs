import { describe, expect, it } from "vitest";
import {
  planJsonReferenceTransfer,
  planPathReferenceCount,
  planPathReferenceTransfer,
  planRelationalReferenceTransfer,
  planRequiredReferenceCheck,
  planSignupDefaultInspection,
  planSignupDefaultRemoval,
  quoteIdentityIdentifier,
} from "../../../dist/src/identity/claim_sql.mjs";

const relational = {
  schema: "public",
  table: "profiles",
  column: "owner_id",
  required: true,
  strategy: "transfer",
};

describe("identity claim SQL planning", () => {
  it("quotes only validated identifiers", () => {
    expect(quoteIdentityIdentifier("owner_id")).toBe('"owner_id"');
    expect(() =>
      quoteIdentityIdentifier('owner_id"; drop table users;'),
    ).toThrow("not safe");
  });

  it("plans relational reads, updates, and required checks without values", () => {
    const inspection = planSignupDefaultInspection({
      table: { schema: "public", table: "profiles" },
      identityColumn: "id",
      ignoredColumns: [],
      values: { role: { kind: "exact", value: "user" } },
    });
    expect(inspection).toContain('from "public"."profiles" candidate');
    expect(inspection).toContain("in ($1::uuid, $2::uuid)");
    expect(
      planSignupDefaultRemoval({
        table: { schema: "public", table: "profiles" },
        identityColumn: "id",
        ignoredColumns: [],
        values: { role: { kind: "exact", value: "user" } },
      }),
    ).toContain('where "id" = $1::uuid');
    expect(planRelationalReferenceTransfer(relational)).toContain(
      'set "owner_id" = $1::uuid',
    );
    expect(planRequiredReferenceCheck(relational)).toContain("limit 1");
  });

  it("plans JSON and path rewrites by declared representation", () => {
    expect(
      planJsonReferenceTransfer({ ...relational, path: ["owner", "id"] }),
    ).toContain("jsonb_set");
    expect(
      planPathReferenceCount({ ...relational, valueType: "text" }),
    ).toContain('"owner_id" like $1::text');
    expect(
      planPathReferenceCount({ ...relational, valueType: "jsonb" }),
    ).toContain('"owner_id"::text like');
    expect(
      planPathReferenceTransfer({ ...relational, valueType: "text" }),
    ).toContain("substring");
    expect(
      planPathReferenceTransfer({ ...relational, valueType: "jsonb" }),
    ).toContain("replace");
  });
});
