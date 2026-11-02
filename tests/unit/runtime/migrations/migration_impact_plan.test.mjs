import { describe, expect, it } from "vitest";
import { planMigrationImpactSql } from "../../../../dist/src/runtime/migrations/migration_impact_plan.mjs";

const relation = { schema: "public", name: "accounts" };
const plan = (sql) => planMigrationImpactSql(sql);
const reject = (sql, reason = "unsupported_sql") => {
  const result = plan(sql);
  expect(result.complete).toBe(false);
  expect(result.unknownReasons).toContain(reason);
  expect(result.tasks).toEqual([]);
  return result;
};

describe("private bounded current-snapshot migration impact planner", () => {
  it.each([
    ["DROP TABLE public.accounts", "drop_table"],
    ["drop table if exists PUBLIC.ACCOUNTS restrict;", "drop_table"],
    [
      "DROP /* nested /* explanation */ end */ TABLE public.accounts",
      "drop_table",
    ],
    ["TRUNCATE public.accounts", "truncate"],
    ["TRUNCATE TABLE public.accounts", "truncate"],
    ["TRUNCATE ONLY public.accounts", "truncate"],
    ["TRUNCATE TABLE ONLY public.accounts RESTRICT", "truncate"],
    ["TRUNCATE public.accounts RESTART IDENTITY", "truncate"],
    ["TRUNCATE public.accounts CONTINUE IDENTITY RESTRICT", "truncate"],
    [
      "TRUNCATE TABLE ONLY public.accounts RESTART IDENTITY RESTRICT;",
      "truncate",
    ],
    ["DELETE FROM public.accounts", "broad_delete"],
    ["DELETE FROM ONLY public.accounts;", "broad_delete"],
  ])("recognizes one whole row-count shape: %s", (sql, operation) => {
    expect(plan(sql)).toEqual({
      complete: true,
      tasks: [{ relation, metric: "rows", operation, line: 1, column: 1 }],
      unknownReasons: [],
    });
  });

  it.each([
    "ALTER TABLE public.accounts DROP COLUMN obsolete",
    "ALTER TABLE public.accounts DROP obsolete",
    "ALTER TABLE ONLY public.accounts DROP COLUMN IF EXISTS obsolete RESTRICT;",
    "ALTER TABLE public.accounts DROP IF EXISTS obsolete RESTRICT",
  ])("recognizes one populated-column shape: %s", (sql) => {
    expect(plan(sql)).toEqual({
      complete: true,
      tasks: [
        {
          relation,
          metric: "populated",
          operation: "drop_column",
          columns: ["obsolete"],
          line: 1,
          column: sql.indexOf("DROP") + 1,
        },
      ],
      unknownReasons: [],
    });
  });

  it.each([
    "ALTER TABLE public.accounts ALTER COLUMN obsolete SET NOT NULL",
    "ALTER TABLE public.accounts ALTER obsolete SET NOT NULL;",
    "ALTER TABLE ONLY public.accounts ALTER COLUMN obsolete SET NOT NULL",
  ])("recognizes one NULL-count shape: %s", (sql) => {
    expect(plan(sql)).toEqual({
      complete: true,
      tasks: [
        {
          relation,
          metric: "nulls",
          operation: "not_null",
          columns: ["obsolete"],
          line: 1,
          column: sql.indexOf("NOT") + 1,
        },
      ],
      unknownReasons: [],
    });
  });

  it.each([
    "ALTER TABLE public.accounts ADD UNIQUE (email)",
    "ALTER TABLE ONLY public.accounts ADD CONSTRAINT unique_email UNIQUE (email);",
  ])("recognizes default NULLS DISTINCT unique violations: %s", (sql) => {
    expect(plan(sql)).toEqual({
      complete: true,
      tasks: [
        {
          relation,
          metric: "duplicate_rows",
          operation: "new_constraint",
          columns: ["email"],
          line: 1,
          column: sql.indexOf("ADD") + 1,
        },
      ],
      unknownReasons: [],
    });
  });

  it("folds ASCII names, retains declared column order and discards constraint names", () => {
    const sql =
      "ALTER TABLE Public.Accounts ADD CONSTRAINT Private_Constraint UNIQUE (Email, Tenant_ID, _x$2)";
    const result = plan(sql);
    expect(result).toMatchObject({
      complete: true,
      tasks: [{ relation, columns: ["email", "tenant_id", "_x$2"] }],
    });
    expect(JSON.stringify(result)).not.toContain("private_constraint");
    expect(JSON.stringify(result)).not.toContain(sql);
  });

  it.each([
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES identities.owners (id)",
    "ALTER TABLE ONLY public.accounts ADD CONSTRAINT owner_fk FOREIGN KEY (owner_id) REFERENCES identities.owners (id) MATCH SIMPLE;",
  ])("recognizes default MATCH SIMPLE orphan counts: %s", (sql) => {
    expect(plan(sql)).toEqual({
      complete: true,
      tasks: [
        {
          relation,
          metric: "orphan_rows",
          operation: "new_constraint",
          columns: ["owner_id"],
          referencedRelation: { schema: "identities", name: "owners" },
          referencedColumns: ["id"],
          line: 1,
          column: sql.indexOf("ADD") + 1,
        },
      ],
      unknownReasons: [],
    });
  });

  it("keeps paired composite foreign-key columns in exact order", () => {
    expect(
      plan(
        "ALTER TABLE public.accounts ADD FOREIGN KEY (tenant, owner) REFERENCES app.owners (tenant_id, id) MATCH SIMPLE",
      ),
    ).toMatchObject({
      complete: true,
      tasks: [
        {
          columns: ["tenant", "owner"],
          referencedRelation: { schema: "app", name: "owners" },
          referencedColumns: ["tenant_id", "id"],
        },
      ],
    });
  });

  it.each([
    "DROP TABLE accounts",
    "TRUNCATE accounts",
    "DELETE FROM accounts",
    "ALTER TABLE accounts DROP obsolete",
    "DROP TABLE catalog.public.accounts",
    'DROP TABLE "public".accounts',
    'DROP TABLE public."accounts"',
    "DROP TABLE public.accounts CASCADE",
    "DROP TABLE public.accounts, public.other",
    "TRUNCATE public.accounts *",
    "TRUNCATE public.accounts, public.other",
    "TRUNCATE public.accounts CASCADE",
    "TRUNCATE public.accounts IDENTITY",
    "TRUNCATE public.accounts RESTART",
    "TRUNCATE public.accounts RESTRICT RESTART IDENTITY",
    "DELETE FROM public.accounts WHERE true",
    "DELETE FROM public.accounts USING public.other",
    "DELETE FROM public.accounts RETURNING *",
    "DELETE FROM public.accounts AS a",
    "DELETE FROM ONLY (public.accounts)",
    "UPDATE public.accounts SET active = false",
    "WITH x AS (SELECT 1) DELETE FROM public.accounts",
    "WITH x AS (DELETE FROM public.accounts) SELECT 1",
    "ALTER TABLE IF EXISTS public.accounts DROP COLUMN obsolete",
    "ALTER TABLE public.accounts DROP COLUMN obsolete CASCADE",
    "ALTER TABLE public.accounts DROP COLUMN obsolete, DROP COLUMN other",
    "ALTER TABLE public.accounts DROP CONSTRAINT owner_fk",
    'ALTER TABLE public.accounts DROP COLUMN "obsolete"',
    "ALTER TABLE public.accounts ALTER COLUMN obsolete DROP NOT NULL",
    "ALTER TABLE public.accounts ADD COLUMN obsolete text NOT NULL",
    "ALTER TABLE public.accounts ADD CHECK (total > 0)",
    "ALTER TABLE public.accounts ADD CONSTRAINT positive CHECK (total > 0)",
    "ALTER TABLE public.accounts ADD PRIMARY KEY (id)",
    "ALTER TABLE public.accounts ADD UNIQUE NULLS NOT DISTINCT (email)",
    "ALTER TABLE public.accounts ADD UNIQUE NULLS DISTINCT (email)",
    "ALTER TABLE public.accounts ADD UNIQUE (lower(email))",
    "ALTER TABLE public.accounts ADD UNIQUE (email DESC)",
    'ALTER TABLE public.accounts ADD UNIQUE ("email")',
    "ALTER TABLE public.accounts ADD UNIQUE (email, EMAIL)",
    "ALTER TABLE public.accounts ADD UNIQUE (email) DEFERRABLE",
    "ALTER TABLE public.accounts ADD UNIQUE USING INDEX email_index",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES owners (id)",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES app.owners",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES app.owners (id, tenant)",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner, owner) REFERENCES app.owners (id, tenant)",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES app.owners (id) MATCH FULL",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES app.owners (id) ON DELETE CASCADE",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES app.owners (id) ON DELETE NO ACTION",
    "ALTER TABLE public.accounts ADD FOREIGN KEY (owner_id) REFERENCES app.owners (id) NOT VALID",
    "ALTER TABLE public.accounts ATTACH PARTITION public.child FOR VALUES IN (1)",
    "CREATE TABLE public.accounts (id integer)",
    "SELECT 1",
    "not SQL at all",
  ])("refuses unsupported whole shapes without a partial task: %s", (sql) => {
    reject(sql);
  });

  it.each([
    "DROP TABLE",
    "DROP TABLE IF public.accounts",
    "DROP TABLE public.",
    "ALTER TABLE public.accounts DROP COLUMN",
    "ALTER TABLE public.accounts ALTER obsolete SET NOT",
    "ALTER TABLE public.accounts ADD CONSTRAINT",
    "ALTER TABLE public.accounts ADD UNIQUE ()",
    "ALTER TABLE public.accounts ADD UNIQUE (email,)",
    "ALTER TABLE public.accounts ADD FOREIGN KEY () REFERENCES app.owners (id)",
  ])("does not declare unmatched or incomplete grammar valid: %s", (sql) => {
    reject(sql);
  });

  it.each([
    "DROP TABLE public.ß",
    "DROP TABLE public.aß",
    "DROP TABLE public.é",
    "DROP TABLE public.ı",
    "DROP TABLE publıc.accounts",
    "DROP TABLE public.accountsé",
    "DROP TABLE public.😀",
    "DROP TABLE public.e\u0301",
    "ALTER TABLE public.accounts ALTER obsolete ſet NOT NULL",
    "DROP TABLE ıf EXISTS public.accounts",
    "ALTER TABLE public.accounts ADD UNIQUE (emaiſ)",
    "ALTER TABLE public.accounts ADD CONSTRAINT ß UNIQUE (email)",
  ])("does not interpret Unicode folds as supported ASCII: %s", (sql) => {
    reject(sql);
  });

  it("accepts at most63-byte identifiers without PostgreSQL truncation assumptions", () => {
    const name = "a".repeat(63);
    expect(plan(`DROP TABLE public.${name}`)).toMatchObject({
      complete: true,
      tasks: [{ relation: { schema: "public", name } }],
    });
    reject(`DROP TABLE public.${name}a`);
    reject(`DROP TABLE ${name}a.accounts`);
    reject(`ALTER TABLE public.accounts DROP COLUMN ${name}a`);
    reject(
      `ALTER TABLE public.accounts ADD CONSTRAINT ${name}a UNIQUE (email)`,
    );
  });

  it("allows8 columns but not9 in either side of a constraint", () => {
    const eight = Array.from({ length: 8 }, (_, index) => `c${index}`);
    const nine = [...eight, "c8"];
    expect(
      plan(`ALTER TABLE public.accounts ADD UNIQUE (${eight})`),
    ).toMatchObject({ complete: true, tasks: [{ columns: eight }] });
    expect(
      plan(
        `ALTER TABLE public.accounts ADD FOREIGN KEY (${eight}) REFERENCES app.parents (${eight})`,
      ),
    ).toMatchObject({
      complete: true,
      tasks: [{ columns: eight, referencedColumns: eight }],
    });
    reject(`ALTER TABLE public.accounts ADD UNIQUE (${nine})`);
    reject(
      `ALTER TABLE public.accounts ADD FOREIGN KEY (${nine}) REFERENCES app.parents (${nine})`,
    );
    reject(
      `ALTER TABLE public.accounts ADD FOREIGN KEY (${eight}) REFERENCES app.parents (${nine})`,
    );
  });

  it("retains independent supported tasks while explicitly reporting incomplete coverage", () => {
    const result = plan(
      "SELECT 'private row'; DROP TABLE public.accounts; UPDATE public.other SET n=1; DELETE FROM public.other",
    );
    expect(result).toMatchObject({
      complete: false,
      unknownReasons: ["unsupported_sql"],
    });
    expect(result.tasks.map(({ operation }) => operation)).toEqual([
      "drop_table",
      "broad_delete",
    ]);
    expect(JSON.stringify(result)).not.toContain("private row");
  });

  it.each([
    "SELECT 'DROP TABLE public.hidden;';",
    "SELECT 'it''s DELETE FROM public.hidden;';",
    String.raw`SELECT E'it\'s TRUNCATE public.hidden;';`,
    "DO $$BEGIN DROP TABLE public.hidden; END$$;",
    "CREATE FUNCTION public.f() RETURNS void AS $fn$BEGIN DELETE FROM public.hidden; END$fn$ LANGUAGE plpgsql;",
    'SELECT "DROP TABLE public.hidden;";',
    "SELECT (SELECT 'DELETE FROM public.hidden;');",
  ])("does not split opaque content into measurement tasks: %s", (prefix) => {
    const result = plan(`${prefix} DROP TABLE public.accounts;`);
    expect(result.complete).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      relation,
      operation: "drop_table",
    });
  });

  it.each([
    "BEGIN; DROP TABLE public.accounts; COMMIT;",
    "START TRANSACTION; DELETE FROM public.accounts; ROLLBACK;",
    "SAVEPOINT a; DROP TABLE public.accounts; RELEASE a;",
    "DROP TABLE public.accounts; PREPARE TRANSACTION 'x';",
    "CREATE FUNCTION public.f() RETURNS void LANGUAGE SQL BEGIN ATOMIC SELECT 1; DELETE FROM public.accounts; END;",
  ])(
    "refuses all tasks across transaction or unparsed routine boundaries: %s",
    (sql) => {
      reject(sql);
    },
  );

  it("does not mistake transaction words in ordinary identifiers or opaque content for blocks", () => {
    expect(
      plan("DROP TABLE public.begin; DELETE FROM public.commit;"),
    ).toMatchObject({
      complete: true,
      tasks: [
        { relation: { schema: "public", name: "begin" } },
        { relation: { schema: "public", name: "commit" } },
      ],
    });
    expect(
      plan("SELECT 'BEGIN ATOMIC'; DROP TABLE public.accounts").tasks,
    ).toHaveLength(1);
  });

  it.each([
    "DROP TABLE public.accounts; SELECT 'unterminated",
    'DROP TABLE public.accounts; SELECT "unterminated',
    "DROP TABLE public.accounts; SELECT $fn$unterminated",
    "DROP TABLE public.accounts; /* unterminated",
    "DROP TABLE public.accounts; SELECT (1]",
    "DROP TABLE public.accounts; SELECT (1; 2)",
    "DROP TABLE public.accounts; SELECT (1",
    "DROP TABLE public.accounts; */",
    "DROP TABLE public.accounts; \0",
  ])("clears every task for lexical malformed input: %s", (sql) => {
    reject(sql, "malformed_sql");
  });

  it.each([
    String.raw`DROP TABLE public.accounts; SELECT 'ambiguous\escape'`,
    String.raw`DROP TABLE public.accounts; \gexec`,
    "DROP TABLE public.accounts; SELECT `unsupported`",
    "DROP TABLE public.accounts; SELECT $",
  ])(
    "does not retain tasks when lexical boundaries/settings are unsupported: %s",
    (sql) => {
      reject(sql);
    },
  );

  it("supports empty statements and comments without inventing measurements", () => {
    expect(
      plan("; ; /* DROP TABLE hidden; /* nested */ */ -- DELETE\r\n;"),
    ).toEqual({ complete: true, tasks: [], unknownReasons: [] });
  });

  it("reports UTF-16 editor positions through CRLF, bare CR, comments and emoji", () => {
    const sql =
      "-- 😀 shadow\r\n  ALTER TABLE public.accounts\r\n    ALTER COLUMN obsolete SET NOT NULL;\r  /* 😀 */ DROP TABLE public.other;";
    expect(plan(sql)).toMatchObject({
      complete: true,
      tasks: [
        { line: 3, column: 31, operation: "not_null" },
        { line: 4, column: 12, operation: "drop_table" },
      ],
    });
  });

  it("retains deterministic source order, not sequential-effect predictions", () => {
    const result = plan(
      "DELETE FROM public.accounts; ALTER TABLE public.accounts ALTER obsolete SET NOT NULL; DROP TABLE public.accounts",
    );
    expect(result.tasks.map(({ metric }) => metric)).toEqual([
      "rows",
      "nulls",
      "rows",
    ]);
    expect(result.tasks.map(({ relation: target }) => target)).toEqual([
      relation,
      relation,
      relation,
    ]);
    expect(Object.keys(result)).toEqual([
      "complete",
      "tasks",
      "unknownReasons",
    ]);
  });

  it("accepts100 tasks and clears all tasks rather than silently truncating101", () => {
    expect(plan("DROP TABLE public.accounts;".repeat(100)).tasks).toHaveLength(
      100,
    );
    reject("DROP TABLE public.accounts;".repeat(101), "input_limit");
  });

  it("enforces the shared2MiB UTF-8 input bound", () => {
    const exact = `DROP TABLE public.accounts;--${"x".repeat(2 * 1024 * 1024 - 29)}`;
    expect(Buffer.byteLength(exact)).toBe(2 * 1024 * 1024);
    expect(plan(exact).tasks).toHaveLength(1);
    reject(`${exact}x`, "input_limit");
    reject(
      `DROP TABLE public.accounts;--${"😀".repeat(524288)}`,
      "input_limit",
    );
  });

  it("enforces the shared token bound without returning earlier tasks", () => {
    expect(plan(";".repeat(20000))).toEqual({
      complete: true,
      tasks: [],
      unknownReasons: [],
    });
    reject(";".repeat(20001), "input_limit");
    const prefix = "DROP TABLE public.accounts;";
    reject(`${prefix}${"SELECT a;".repeat(7000)}`, "input_limit");
  });

  it("enforces shared nested grouping/comment bounds without earlier tasks", () => {
    const prefix = "DROP TABLE public.accounts;";
    expect(
      plan(`${prefix}SELECT ${"(".repeat(128)}1${")".repeat(128)}`).tasks,
    ).toHaveLength(1);
    reject(
      `${prefix}SELECT ${"(".repeat(129)}1${")".repeat(129)}`,
      "input_limit",
    );
    expect(
      plan(`${prefix}${"/*".repeat(128)}${"*/".repeat(128)}`).tasks,
    ).toHaveLength(1);
    reject(`${prefix}${"/*".repeat(129)}${"*/".repeat(129)}`, "input_limit");
  });
});
