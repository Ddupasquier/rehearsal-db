import { describe, expect, it } from "vitest";
import {
  nativeMigrationImpactComparison,
  nativeMigrationImpactIndexes,
  nativeMigrationImpactStatistics,
} from "../../../dist/src/runtime/migration_impact_catalog.mjs";
import { lexMigrationSql } from "../../../dist/src/runtime/migration_sql_lexer.mjs";

const compact = (text) => text.replace(/\s+/gu, " ").trim();

describe("fixed native migration-impact catalog predicate compilation", () => {
  it.each(["r", "p"])(
    "binds all index metadata to the closed relation alias %s",
    (alias) => {
      const sql = compact(nativeMigrationImpactIndexes(alias));
      expect(sql).toContain(`mi_index.indrelid = ${alias}.oid`);
      expect(sql).toContain(`mi_attribute.attrelid = ${alias}.oid`);
      expect(sql.startsWith("(not exists (")).toBe(true);
      expect(sql.endsWith("))")).toBe(true);
      expect(sql).toContain(") is not true");
      expect(sql).toContain(
        "mi_index.indexprs is null and mi_index.indpred is null",
      );
      // Invalid indexes are opened before PostgreSQL's planner checks their flag.
      expect(sql).not.toContain("indisvalid");
      expect(sql).not.toContain("indisready");
    },
  );

  it("allows only native btree/hash AMs and their native function handlers", () => {
    const sql = compact(nativeMigrationImpactIndexes("r"));
    expect(sql).toContain("mi_am.oid = 403 and mi_am.amname = 'btree'");
    expect(sql).toContain("mi_am.oid = 405 and mi_am.amname = 'hash'");
    expect(sql).toContain("mi_am.amtype = 'i'");
    expect(sql).toContain(
      "mi_proc.oid = mi_am.amhandler and mi_proc.oid < 16384",
    );
    expect(sql).toContain(
      "mi_proc.prokind = 'f' and mi_proc.prolang in (12, 13)",
    );
    expect(sql).toContain(
      "mi_proc.pronamespace = (select oid from pg_catalog.pg_namespace where nspname = 'pg_catalog')",
    );
    expect(sql).toContain(
      "mi_index_relation.relkind = 'i' and not mi_index_relation.relispartition",
    );
  });

  it("checks every indexed key/include column and refuses indirect user-type support", () => {
    const sql = compact(nativeMigrationImpactIndexes("r"));
    expect(sql).toContain(
      "pg_catalog.array_length(mi_index.indkey::pg_catalog.int2[], 1) = mi_index.indnatts",
    );
    expect(sql).toContain(
      "pg_catalog.unnest(mi_index.indkey::pg_catalog.int2[])",
    );
    expect(sql).toContain(
      "mi_attribute.attnum = mi_key.attribute_number and mi_attribute.attnum > 0",
    );
    expect(sql).toContain(
      "not mi_attribute.attisdropped and mi_attribute.attgenerated in ('', 's')",
    );
    expect(sql).toContain("mi_type.oid < 16384 and mi_type.typnamespace =");
    expect(sql).toContain("mi_type.typbasetype = 0 and mi_type.typname in");
    expect(sql).toContain("mi_input.oid < 16384 and mi_input.typnamespace =");
    expect(sql).toContain("mi_input.typbasetype = 0 and mi_input.typname in");
    for (const unsupported of [
      "'anyarray'",
      "'anyenum'",
      "'record'",
      "'jsonb'",
      "'int4range'",
    ])
      expect(sql).not.toContain(unsupported);
  });

  it("requires full key/opclass/collation metadata rather than an empty-vector pass", () => {
    const sql = compact(nativeMigrationImpactIndexes("r"));
    expect(sql).toContain("mi_index.indnkeyatts > 0");
    expect(sql).toContain(
      "pg_catalog.array_length(mi_index.indclass::pg_catalog.oid[], 1) = mi_index.indnkeyatts",
    );
    expect(sql).toContain(
      "pg_catalog.array_length(mi_index.indcollation::pg_catalog.oid[], 1) = mi_index.indnkeyatts",
    );
    expect(sql).toContain(
      "pg_catalog.unnest(mi_index.indclass::pg_catalog.oid[])",
    );
    expect(sql).toContain(
      "pg_catalog.unnest(mi_index.indcollation::pg_catalog.oid[])",
    );
    expect(sql).toContain(
      "mi_collation.oid = mi_key.collation_oid and mi_collation.oid < 16384",
    );
    expect(sql).toContain("mi_collation.collnamespace =");
    expect(sql).toContain("mi_collation.collisdeterministic");
  });

  it.each([
    ["indexes", () => nativeMigrationImpactIndexes("r")],
    ["comparison", () => nativeMigrationImpactComparison("t")],
  ])(
    "rejects classes, families, operators or support procedures extended by user objects: %s",
    (_label, getSql) => {
      const sql = compact(getSql());
      expect(sql).toContain("mi_class.oid < 16384 and mi_class.opcnamespace =");
      expect(sql).toContain("mi_class.opcmethod = mi_am.oid");
      expect(sql).toContain(
        "mi_family.oid = mi_class.opcfamily and mi_family.oid < 16384",
      );
      expect(sql).toContain("mi_family.opfnamespace =");
      expect(sql).toContain("mi_family.opfmethod = mi_am.oid");
      expect(sql).toContain(
        "where mi_member.amopfamily = mi_family.oid and not (",
      );
      expect(sql).toContain(
        "mi_member.oid < 16384 and mi_member.amopmethod = mi_am.oid",
      );
      expect(sql).toContain(
        "mi_operator.oid = mi_member.amopopr and mi_operator.oid < 16384",
      );
      expect(sql).toContain("mi_operator.oprnamespace =");
      expect(sql).toContain(
        "mi_proc.oid = mi_operator.oprcode and mi_proc.oid < 16384",
      );
      expect(sql).toContain("mi_operator.oprrest = 0 or exists (");
      expect(sql).toContain(
        "mi_proc.oid = mi_operator.oprrest and mi_proc.oid < 16384",
      );
      expect(sql).toContain("mi_operator.oprjoin = 0 or exists (");
      expect(sql).toContain(
        "mi_proc.oid = mi_operator.oprjoin and mi_proc.oid < 16384",
      );
      expect(sql).toContain(
        "where mi_support.amprocfamily = mi_family.oid and not (",
      );
      expect(sql).toContain("mi_support.oid < 16384");
      expect(sql).toContain(
        "mi_proc.oid = mi_support.amproc and mi_proc.oid < 16384",
      );
    },
  );

  it.each(["r", "p"])(
    "rejects expression statistics regardless of whether statistics data exist: %s",
    (alias) => {
      expect(compact(nativeMigrationImpactStatistics(alias))).toBe(
        `(not exists (select 1 from pg_catalog.pg_statistic_ext mi_statistics where mi_statistics.stxrelid = ${alias}.oid and mi_statistics.stxexprs is not null))`,
      );
    },
  );

  it("requires exactly one native default class for each exact comparison input type", () => {
    const sql = compact(nativeMigrationImpactComparison("t"));
    for (const method of [403, 405]) {
      expect(sql).toContain(
        `mi_default.opcintype = t.oid and mi_default.opcmethod = ${method} and mi_default.opcdefault) = 1`,
      );
      expect(sql).toContain(`mi_am.oid = ${method}`);
    }
    expect(
      sql.match(/mi_class\.opcintype = t\.oid and mi_class\.opcdefault/gu),
    ).toHaveLength(2);
    expect(sql).not.toContain("pg_cast");
    expect(sql).not.toContain("IsBinaryCoercible");
    expect(sql).not.toContain("'varchar'");
    expect(sql).not.toContain("'bpchar'");
  });

  it.each([
    ["indexes/r", () => nativeMigrationImpactIndexes("r")],
    ["indexes/p", () => nativeMigrationImpactIndexes("p")],
    ["statistics/r", () => nativeMigrationImpactStatistics("r")],
    ["statistics/p", () => nativeMigrationImpactStatistics("p")],
    ["comparison/t", () => nativeMigrationImpactComparison("t")],
  ])(
    "produces deterministic bounded balanced SQL tokens, not runtime proof: %s",
    (_label, getSql) => {
      const sql = getSql();
      expect(getSql()).toBe(sql);
      expect(Buffer.byteLength(sql)).toBeLessThan(16384);
      expect(sql).not.toMatch(/;|--|\/\*/u);
      expect(lexMigrationSql(sql).unknownReasons).toEqual([]);
      expect(lexMigrationSql(sql).ambiguousQuotes).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    "",
    "t",
    "r.oid",
    "R",
    "r; DROP TABLE private.secret",
    1,
    {},
    ["r"],
  ])("refuses an invalid relation alias without echoing it: %s", (alias) => {
    for (const getSql of [
      nativeMigrationImpactIndexes,
      nativeMigrationImpactStatistics,
    ]) {
      expect(() => getSql(alias)).toThrow(
        "The fixed migration-impact catalog alias is unsupported.",
      );
      try {
        getSql(alias);
      } catch (error) {
        expect(error.message).not.toContain("private.secret");
      }
    }
  });

  it.each([
    undefined,
    null,
    "",
    "r",
    "p",
    "T",
    "t.oid",
    "t; SELECT secret",
    1,
    {},
    ["t"],
  ])(
    "refuses any comparison alias except the fixed type alias: %s",
    (alias) => {
      expect(() => nativeMigrationImpactComparison(alias)).toThrow(
        "The fixed migration-impact catalog alias is unsupported.",
      );
    },
  );
});
