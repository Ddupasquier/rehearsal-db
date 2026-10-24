import { describe, expect, it } from "vitest";
import { scanMigrationSql } from "../../../dist/src/runtime/migration_sql_scan.mjs";

const rules = (sql) => scanMigrationSql(sql).findings.map(({ rule }) => rule);
const unknown = (sql, reason) => {
  const result = scanMigrationSql(sql);
  expect(result.complete).toBe(false);
  expect(result.unknownReasons).toContain(reason);
  return result;
};

describe("bounded static PostgreSQL migration scan", () => {
  it.each([
    ["DROP TABLE accounts;", ["drop_table"]],
    [
      'drop /* explanation */ table if exists public.accounts, "Other" restrict;',
      ["drop_table"],
    ],
    ["DROP TABLE public.accounts CASCADE;", ["drop_table", "cascade"]],
    ["TRUNCATE accounts;", ["truncate"]],
    [
      "TRUNCATE TABLE ONLY public.accounts *, other RESTART IDENTITY CASCADE",
      ["truncate", "cascade"],
    ],
    ["UPDATE public.accounts SET active = false", ["broad_update"]],
    [
      "UPDATE ONLY public.accounts AS a SET active = false RETURNING *",
      ["broad_update"],
    ],
    ["DELETE FROM public.accounts", ["broad_delete"]],
    [
      "DELETE FROM ONLY public.accounts a USING other WHERE a.id = other.id",
      [],
    ],
    ["UPDATE public.accounts SET active = false WHERE id = 1", []],
    [
      "ALTER TABLE public.accounts DROP COLUMN IF EXISTS obsolete CASCADE",
      ["drop_column", "cascade"],
    ],
    [
      "ALTER TABLE accounts DROP obsolete, DROP COLUMN other",
      ["drop_column", "drop_column"],
    ],
    [
      "ALTER TABLE ONLY public.accounts ALTER COLUMN active SET NOT NULL",
      ["not_null"],
    ],
    ["ALTER TABLE accounts ALTER active SET NOT NULL", ["not_null"]],
  ])("finds modeled local review hints: %s", (sql, expected) => {
    expect(rules(sql)).toEqual(expected);
    expect(scanMigrationSql(sql)).toMatchObject({
      complete: true,
      unknownReasons: [],
    });
  });

  it.each([
    [
      "ALTER TABLE accounts ADD CONSTRAINT positive CHECK (total > 0)",
      ["new_constraint"],
    ],
    ["ALTER TABLE accounts ADD UNIQUE (email)", ["new_constraint"]],
    ["ALTER TABLE accounts ADD PRIMARY KEY (id)", ["new_constraint"]],
    [
      "ALTER TABLE accounts ADD FOREIGN KEY (owner) REFERENCES owners(id) ON DELETE CASCADE",
      ["new_constraint", "cascade"],
    ],
    ["ALTER TABLE accounts ADD COLUMN name text NOT NULL", ["not_null"]],
    [
      "ALTER TABLE accounts ADD COLUMN name text NOT NULL UNIQUE",
      ["new_constraint", "not_null"],
    ],
    ["ALTER TABLE accounts ADD name text DEFAULT 'NOT NULL CASCADE CHECK'", []],
    [
      "ALTER TABLE accounts ADD present boolean DEFAULT (other IS NOT NULL)",
      [],
    ],
    ["ALTER TABLE accounts ADD present boolean DEFAULT other IS NOT NULL", []],
    ['ALTER TABLE accounts ADD "NOT NULL CHECK CASCADE" text', []],
  ])(
    "reports constraint hints without claiming to parse column definitions: %s",
    (sql, expected) => {
      expect(rules(sql)).toEqual(expected);
      unknown(sql, "unsupported_sql");
    },
  );

  it("does not reinterpret omitted defaults as a full PostgreSQL syntax parser", () => {
    for (const sql of [
      "CREATE TABLE accounts (id integer)",
      "CREATE INDEX account_id ON accounts(id)",
      "INSERT INTO accounts VALUES (1)",
      "SELECT 1",
      "SET ROLE postgres",
      "BEGIN; COMMIT;",
      "VACUUM accounts",
      "gibberish SQL;",
      "ALTER TABLE accounts SET LOGGED",
    ]) {
      expect(unknown(sql, "unsupported_sql").findings).toEqual([]);
    }
  });

  it.each([
    "-- DROP TABLE secret;\n/* UPDATE accounts SET a = 1; /* DELETE FROM x; */ TRUNCATE x; */",
    "SELECT 'DROP TABLE hidden; UPDATE accounts SET x=1; DELETE FROM x';",
    "SELECT 'it''s not DELETE FROM x;';",
    String.raw`SELECT E'it\'s not DROP TABLE hidden;';`,
    "SELECT $$DROP TABLE hidden; UPDATE hidden SET a=1;$$;",
    "SELECT $fn$DELETE FROM hidden; TRUNCATE hidden;$fn$;",
    "SELECT $Étiquette$DELETE FROM hidden;$Étiquette$;",
    'SELECT "DROP TABLE hidden; UPDATE hidden SET a=1";',
    'SELECT "escaped""DELETE FROM hidden";',
  ])("ignores keywords inside opaque lexical content: %s", (sql) => {
    expect(rules(sql)).toEqual([]);
  });

  it("does not confuse quoted identifiers with keywords or dollar delimiters", () => {
    expect(rules('UPDATE "WHERE" SET "DROP TABLE" = 1')).toEqual([
      "broad_update",
    ]);
    expect(rules('DELETE FROM "TRUNCATE" WHERE "UPDATE" = 1')).toEqual([]);
    expect(rules("UPDATE dollar$tag$ SET value = 1")).toEqual(["broad_update"]);
    expect(rules("UPDATE t SET value = $1 WHERE id = $2")).toEqual([]);
  });

  it("keeps semicolons and misleading WHERE tokens inside literals/comments opaque", () => {
    const sql =
      "UPDATE accounts SET note = 'WHERE id = 1;'; /* WHERE x */ DELETE FROM accounts RETURNING $$WHERE id=1;$$;";
    expect(rules(sql)).toEqual(["broad_update", "broad_delete"]);
  });

  it("requires WHERE at the mutation's own depth", () => {
    expect(
      rules("UPDATE accounts SET x = (SELECT id FROM other WHERE id = 1)"),
    ).toEqual(["broad_update"]);
    expect(
      rules(
        "DELETE FROM accounts USING (SELECT id FROM other WHERE id = 1) AS o",
      ),
    ).toEqual(["broad_delete"]);
    expect(
      rules("DELETE FROM accounts RETURNING (SELECT id FROM other WHERE id=1)"),
    ).toEqual(["broad_delete"]);
    expect(
      rules("UPDATE accounts SET x = (SELECT id FROM other) WHERE id = 1"),
    ).toEqual([]);
  });

  it("walks CTE bodies and the main mutation independently", () => {
    const result = scanMigrationSql(`WITH old AS (
      DELETE FROM accounts WHERE id = 1 RETURNING *
    ), changed AS NOT MATERIALIZED (
      UPDATE other SET note = 'WHERE' RETURNING *
    ) UPDATE accounts SET x = (SELECT id FROM other WHERE id=1);`);
    expect(result.findings).toEqual([
      { rule: "broad_update", severity: "danger", line: 4, column: 7 },
      { rule: "broad_update", severity: "danger", line: 5, column: 7 },
    ]);
    expect(result.complete).toBe(true);
  });

  it("handles recursive/column-list/nested CTEs without borrowing an inner WHERE", () => {
    const sql = `WITH RECURSIVE data(id) AS (SELECT 1 WHERE true), changed AS (
      WITH removed AS (DELETE FROM accounts RETURNING *)
      UPDATE other SET x = 1 WHERE id = 1 RETURNING *
    ) DELETE FROM target;`;
    expect(rules(sql)).toEqual(["broad_delete", "broad_delete"]);
    unknown(sql, "unsupported_sql");
  });

  it.each([
    "DO $$BEGIN DELETE FROM hidden; END$$;",
    "CREATE FUNCTION f() RETURNS void AS $body$BEGIN TRUNCATE hidden; END$body$ LANGUAGE plpgsql;",
    "CREATE OR REPLACE PROCEDURE f() LANGUAGE SQL BEGIN ATOMIC DELETE FROM hidden; UPDATE hidden SET a=1; END;",
    "CREATE FUNCTION f() RETURNS integer LANGUAGE SQL BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 0 END; DELETE FROM hidden; END;",
    "EXECUTE prepared_statement;",
    "PREPARE pending AS DELETE FROM accounts;",
    "CALL f();",
  ])(
    "does not emit body/dynamic-SQL findings but keeps coverage unknown: %s",
    (sql) => {
      expect(unknown(sql, "unsupported_sql").findings).toEqual([]);
    },
  );

  it("resumes after opaque routine bodies and reports only following statements", () => {
    expect(
      rules(
        "CREATE FUNCTION f() RETURNS void LANGUAGE SQL BEGIN ATOMIC DELETE FROM hidden; END; DROP TABLE visible;",
      ),
    ).toEqual(["drop_table"]);
    expect(
      rules("DO $$BEGIN DELETE FROM hidden; END$$; TRUNCATE visible;"),
    ).toEqual(["truncate"]);
  });

  it("does not mistake defaults, cascades or existing constraints for column removal", () => {
    for (const sql of [
      "ALTER TABLE t ALTER c DROP DEFAULT",
      "ALTER TABLE t ALTER c DROP NOT NULL",
      "ALTER TABLE t DROP CONSTRAINT known",
      "ALTER TABLE t RENAME COLUMN old TO new",
      "ALTER TABLE t ADD cascade text",
      "ALTER TABLE t ADD value cascade",
      "DROP VIEW cascade",
      "DROP VIEW public.cascade",
      "DROP MATERIALIZED VIEW cascade",
      "ALTER TABLE t ADD present boolean DEFAULT CASE WHEN other IS NOT NULL THEN true ELSE false END",
    ])
      expect(rules(sql)).toEqual([]);
    expect(rules("ALTER TABLE t DROP CONSTRAINT known CASCADE")).toEqual([
      "cascade",
    ]);
    expect(rules("DROP VIEW example CASCADE")).toEqual(["cascade"]);
    expect(
      rules(
        "CREATE TABLE t (owner integer REFERENCES parent(id) ON DELETE CASCADE)",
      ),
    ).toEqual(["cascade"]);
  });

  it.each([
    "'unfinished",
    '"unfinished',
    '""',
    "$$unfinished",
    "$body$unfinished",
    "/* unfinished",
    "/* nested /* unfinished */",
    "*/",
    "UPDATE t SET x = (1;",
    "UPDATE t SET x = [1)",
    "DROP TABLE;",
    "TRUNCATE;",
    "DROP TABLE t,;",
    "UPDATE t SET;",
    "UPDATE t SET x=;",
    "UPDATE t SET x= WHERE id=1;",
    "UPDATE t SET x=1,;",
    "UPDATE t SET x=1 WHERE;",
    "DELETE;",
    "DELETE FROM;",
    "DELETE FROM t WHERE RETURNING *",
    "ALTER TABLE t;",
    "ALTER TABLE t DROP;",
    "WITH gone AS (DELETE FROM t)",
    "CREATE FUNCTION f() RETURNS void LANGUAGE SQL BEGIN ATOMIC DELETE FROM t;",
    "UPDATE t SET x = \0;",
  ])("returns fixed unknown evidence for malformed input: %s", (sql) => {
    unknown(sql, "malformed_sql");
  });

  it.each([
    "WITH x SELECT 1",
    "WITH x AS NOT (SELECT 1) DELETE FROM t",
    "WITH x AS (SELECT 1) SEARCH DEPTH FIRST BY id SET ordercol SELECT * FROM x",
    "\\i 'private-file.sql'",
    "SELECT `private`;",
    String.raw`SELECT 'runtime\dependent';`,
  ])("keeps unsupported syntax/runtime-dependent lexing unknown: %s", (sql) => {
    unknown(sql, "unsupported_sql");
  });

  it("uses one-based UTF-16 editor columns, with CRLF and CR line endings", () => {
    const sql =
      '-- 😀\r\n/* 😀 */ DROP TABLE "é";\r  TRUNCATE "é";\nUPDATE "é" SET x=1';
    expect(scanMigrationSql(sql).findings).toEqual([
      { rule: "drop_table", severity: "danger", line: 2, column: 10 },
      { rule: "truncate", severity: "danger", line: 3, column: 3 },
      { rule: "broad_update", severity: "danger", line: 4, column: 1 },
    ]);
    expect(
      scanMigrationSql('UPDATE "😀" SET x=1; DROP TABLE "é";').findings[1]
        .column,
    ).toBe(22);
  });

  it("does not invent unfiltered-mutation findings from truncated or ambiguous lexing", () => {
    const overLimit =
      "UPDATE accounts SET value=1 FROM " +
      "other,".repeat(11_000) +
      "other WHERE id=1";
    expect(unknown(overLimit, "input_limit").findings).toEqual([]);
    expect(
      unknown("UPDATE accounts SET value='unfinished", "malformed_sql")
        .findings,
    ).toEqual([]);
    const ambiguous = String.raw`SELECT 'escaped\'; DROP TABLE hidden; -- not necessarily a statement`;
    expect(unknown(ambiguous, "unsupported_sql").findings).toEqual([]);
  });

  it("returns only closed rules, severity and positions, never source text", () => {
    const result = scanMigrationSql(
      "ALTER TABLE PRIVATE_IDENTIFIER ADD PRIVATE_COLUMN text NOT NULL; UPDATE PRIVATE_IDENTIFIER SET note='PRIVATE_ROW';",
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    for (const finding of result.findings) {
      expect(Object.keys(finding).sort()).toEqual([
        "column",
        "line",
        "rule",
        "severity",
      ]);
      expect(Number.isSafeInteger(finding.line) && finding.line > 0).toBe(true);
      expect(Number.isSafeInteger(finding.column) && finding.column > 0).toBe(
        true,
      );
    }
  });

  it("is deterministic and treats empty/comment-only input as a complete empty scan", () => {
    for (const sql of [
      "",
      " \r\n\t",
      ";;;",
      "-- no statements\n/* explanation */",
    ])
      expect(scanMigrationSql(sql)).toEqual({
        complete: true,
        findings: [],
        unknownReasons: [],
      });
    const sql =
      "ALTER TABLE t ADD c text NOT NULL UNIQUE; DROP TABLE t CASCADE;";
    expect(scanMigrationSql(sql)).toEqual(scanMigrationSql(sql));
  });

  it("bounds source bytes rather than UTF-16 length", () => {
    const limit = 2 * 1024 * 1024;
    expect(scanMigrationSql(" ".repeat(limit)).complete).toBe(true);
    expect(unknown(" ".repeat(limit + 1), "input_limit").findings).toEqual([]);
    expect(unknown("é".repeat(limit / 2 + 1), "input_limit").findings).toEqual(
      [],
    );
  });

  it("bounds tokens, findings, grouping and nested comments without throwing", () => {
    expect(
      unknown("SELECT 1;".repeat(7000), "input_limit").findings.length,
    ).toBeLessThanOrEqual(1000);
    expect(
      unknown("DROP TABLE t;".repeat(1100), "input_limit").findings,
    ).toHaveLength(1000);
    unknown("SELECT " + "(".repeat(129) + "1" + ")".repeat(129), "input_limit");
    unknown("/*".repeat(129) + "*/".repeat(129), "input_limit");
  });
});
