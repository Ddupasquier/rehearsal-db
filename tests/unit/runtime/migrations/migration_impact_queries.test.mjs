import { describe, expect, it } from "vitest";
import { planMigrationImpactSql } from "../../../../dist/src/runtime/migrations/migration_impact_plan.mjs";
import {
  buildMigrationImpactScript,
  parseMigrationImpactOutput,
  parseMigrationImpactBatchOutput,
  MIGRATION_IMPACT_LIMITS,
} from "../../../../dist/src/runtime/migrations/migration_impact_queries.mjs";

const tasksFor = (sql) => planMigrationImpactSql(sql).tasks;
const record = (count = "0", index = 0, reason = null) =>
  JSON.stringify({ index, count, reason });

describe("fixed private aggregate query compilation", () => {
  it("never forwards migration text and counts in one bounded read-only snapshot after readonly preflight", () => {
    const sql =
      "-- PRIVATE_SQL_CANARY\nALTER TABLE public.parent ALTER COLUMN payload SET NOT NULL;";
    const script = buildMigrationImpactScript(tasksFor(sql));
    expect(script).not.toContain("PRIVATE_SQL_CANARY");
    expect(script).not.toContain("ALTER TABLE");
    expect(script).toContain(
      "begin isolation level repeatable read read only;",
    );
    expect(script).toContain("lock_timeout = '1s'");
    expect(script).toContain("statement_timeout = '5s'");
    expect(script).toContain("idle_in_transaction_session_timeout = '5s'");
    expect(script).toContain("set row_security = off;");
    expect(script).toContain("set max_parallel_workers_per_gather = 0;");
    expect(script).toContain("set temp_file_limit = '8MB';");
    expect(script).toContain("set transaction_timeout = '30000ms';");
    expect(script).toContain(
      "set local transaction_timeout = :'impact_remaining_milliseconds';",
    );
    expect(script).toContain("server_version_num')::integer >= 170000");
    expect(script).toContain("set constraint_exclusion = off;");
    expect(script.match(/rollback;/gu)).toHaveLength(2);
    expect(script).not.toMatch(/\bcommit\b/iu);
    expect(script).toContain('from only "public"."parent"');
    expect(script).toContain('where "payload" is null');
  });

  it.each([
    [
      "DROP TABLE public.parent;",
      'pg_catalog.count(*)::text as count from only "public"."parent"',
    ],
    [
      "TRUNCATE TABLE public.parent;",
      'pg_catalog.count(*)::text as count from only "public"."parent"',
    ],
    [
      "DELETE FROM public.child;",
      'pg_catalog.count(*)::text as count from only "public"."child"',
    ],
    [
      "ALTER TABLE public.parent DROP COLUMN payload;",
      'where "payload" is not null',
    ],
  ])("compiles only its declared count for %s", (sql, expected) => {
    const tasks = tasksFor(sql);
    expect(tasks).toHaveLength(1);
    expect(buildMigrationImpactScript(tasks)).toContain(expected);
  });

  it("counts all rows in duplicate non-NULL groups, not just excess rows", () => {
    const script = buildMigrationImpactScript(
      tasksFor("ALTER TABLE public.parent ADD UNIQUE (code, kind);"),
    );
    expect(script).toContain("coalesce(pg_catalog.sum(n), 0)::text as count");
    expect(script).toContain('c."code" is not null and c."kind" is not null');
    expect(script).toContain('group by c."code", c."kind"');
    expect(script).toContain("having pg_catalog.count(*) > 1");
    expect(script).not.toContain("sum(n - 1)");
  });

  it("uses MATCH SIMPLE null semantics and built-in equality for orphan rows", () => {
    const script = buildMigrationImpactScript(
      tasksFor(
        "ALTER TABLE public.child ADD FOREIGN KEY (parent_id, kind) REFERENCES public.parent (id, kind);",
      ),
    );
    expect(script).toContain(
      'c."parent_id" is not null and c."kind" is not null',
    );
    expect(script).toContain('p."id" operator(pg_catalog.=) c."parent_id"');
    expect(script).toContain(
      "ca.atttypid = pa.atttypid and ca.attcollation = pa.attcollation",
    );
  });

  it("preflights metadata, locks before the count snapshot, then rechecks retained OIDs and supported metadata", () => {
    const script = buildMigrationImpactScript(
      tasksFor("ALTER TABLE public.parent ADD UNIQUE (code);"),
    );
    const firstCheck = script.indexOf("with eligible as");
    const preflightEnd = script.indexOf("rollback;");
    const transaction = script.indexOf(
      "begin isolation level repeatable read read only;",
    );
    const lock = script.indexOf(
      'lock table only "public"."parent" in share row exclusive mode;',
    );
    const snapshot = script.indexOf("json_build_object('snapshotAt'");
    const secondCheck = script.indexOf("as ok \\gset locked_0_");
    expect(firstCheck).toBeGreaterThan(0);
    expect(preflightEnd).toBeGreaterThan(firstCheck);
    expect(transaction).toBeGreaterThan(preflightEnd);
    expect(lock).toBeGreaterThan(transaction);
    const namespaceLock = script.indexOf(
      "lock table pg_catalog.pg_namespace in share mode;",
    );
    expect(namespaceLock).toBeGreaterThan(transaction);
    expect(namespaceLock).toBeLessThan(lock);
    expect(snapshot).toBeGreaterThan(lock);
    expect(secondCheck).toBeGreaterThan(snapshot);
    expect(script.slice(transaction, lock)).not.toMatch(/\bselect\b/iu);
    expect(script).toContain(
      "r.oid = :'impact_relation_0_oid'::pg_catalog.oid",
    );
    for (const fragment of [
      "r.relkind = 'r'",
      "not r.relrowsecurity",
      "not r.relispartition",
      "pg_catalog.pg_inherits",
      "amname = 'heap'",
      "a.attgenerated in ('', 's')",
      "tn.nspname = 'pg_catalog'",
      "co.collisdeterministic",
      "pg_catalog.to_regclass",
    ])
      expect(script).toContain(fragment);
    expect(script).toContain("'unsupported_runtime_metadata'");
    expect(script).not.toMatch(/select\s+\*/iu);
  });

  it("locks both sides of a self-reference only once", () => {
    const script = buildMigrationImpactScript(
      tasksFor(
        "ALTER TABLE public.parent ADD FOREIGN KEY (parent_id) REFERENCES public.parent(id);",
      ),
    );
    expect(script.match(/lock table only/gu)).toHaveLength(1);
  });

  it("locks all eligible distinct relations in one global order before any count snapshot", () => {
    const script = buildMigrationImpactScript(
      tasksFor(
        "DELETE FROM public.z; ALTER TABLE public.z ADD FOREIGN KEY (a) REFERENCES public.a(id); TRUNCATE public.a;",
      ),
    );
    const locks = script.match(/lock table only [^;]+;/gu);
    expect(locks).toEqual([
      'lock table only "public"."a" in share row exclusive mode;',
      'lock table only "public"."z" in share row exclusive mode;',
    ]);
    expect(script.indexOf(locks[1])).toBeLessThan(
      script.indexOf("json_build_object('snapshotAt'"),
    );
    expect(script).toContain(
      "p.oid = :'impact_relation_0_oid'::pg_catalog.oid",
    );
    expect(script).toContain("\\if :impact_relation_0_ok");
    expect(script).toContain("\\if :impact_relation_1_ok");
  });

  it.each([
    'evil"; select private_canary;--',
    "public.other",
    "é",
    "A",
    "a".repeat(64),
    "a:b",
    "a`b",
    "a\\b",
  ])(
    "rejects injected private identifiers without echoing them: %s",
    (schema) => {
      const task = {
        metric: "rows",
        operation: "drop_table",
        relation: { schema, name: "parent" },
        line: 1,
        column: 1,
      };
      expect(() => buildMigrationImpactScript([task])).toThrow(
        "private measurement identifier is unsupported",
      );
    },
  );

  it("enforces kind, column, count and byte bounds even on forged internal task objects", () => {
    const task = tasksFor("ALTER TABLE public.parent ADD UNIQUE (code);")[0];
    expect(() =>
      buildMigrationImpactScript([{ ...task, metric: "raw_sql" }]),
    ).toThrow("kind is unsupported");
    expect(() =>
      buildMigrationImpactScript([{ ...task, columns: ["code", "code"] }]),
    ).toThrow("columns are unsupported");
    expect(() =>
      buildMigrationImpactScript([
        {
          ...task,
          columns: Array.from({ length: 9 }, (_, index) => `c${index}`),
        },
      ]),
    ).toThrow("columns are unsupported");
    expect(() => buildMigrationImpactScript([{ ...task, line: 0 }])).toThrow(
      "location is unsupported",
    );
    expect(() =>
      buildMigrationImpactScript(Array.from({ length: 101 }, () => task)),
    ).toThrow("count exceeds");
    expect(MIGRATION_IMPACT_LIMITS).toMatchObject({
      maximumMeasurements: 100,
      maximumScriptBytes: 262144,
      totalTimeoutMilliseconds: 30000,
    });
    expect(() => buildMigrationImpactScript([task], 30001)).toThrow(
      "deadline exceeds",
    );
    expect(() => buildMigrationImpactScript([task], 0)).toThrow(
      "deadline exceeds",
    );
    expect(buildMigrationImpactScript([task], 501)).toContain(
      "transaction_timeout = '501ms'",
    );
  });
});

describe("closed aggregate-only output", () => {
  it("keeps counts exact above the JavaScript safe integer limit", () => {
    expect(parseMigrationImpactOutput(record("9007199254740993"), 1)).toEqual([
      { index: 0, count: "9007199254740993", reason: null },
    ]);
    expect(
      parseMigrationImpactOutput(record("9223372036854775807"), 1)[0].count,
    ).toBe("9223372036854775807");
  });

  it("distinguishes a real zero from unknown", () => {
    expect(
      parseMigrationImpactOutput(
        record() + "\n" + record(null, 1, "unsupported_runtime_metadata"),
        2,
      ),
    ).toEqual([
      { index: 0, count: "0", reason: null },
      { index: 1, count: null, reason: "unsupported_runtime_metadata" },
    ]);
  });

  it.each([
    record(0),
    record("-1"),
    record("01"),
    record("1.5"),
    record("1e3"),
    record("9223372036854775808"),
    record("0", 1),
    record(null),
    record("0", 0, "unsupported_runtime_metadata"),
    record(null, 0, "PRIVATE_PROVIDER_CANARY"),
    JSON.stringify({
      index: 0,
      count: "0",
      reason: null,
      row: "PRIVATE_ROW_CANARY",
    }),
    "NOTICE: PRIVATE_SQL_CANARY",
    "not JSON",
    "[]",
    "null",
  ])(
    "refuses non-contract provider output without echoing it (%#)",
    (output) => {
      expect(() => parseMigrationImpactOutput(output, 1)).toThrow(
        "unsupported aggregate report",
      );
    },
  );

  it("refuses missing, duplicate, reordered, oversized and out-of-bound results", () => {
    expect(() => parseMigrationImpactOutput("", 1)).toThrow();
    expect(() =>
      parseMigrationImpactOutput(record() + "\n" + record(), 2),
    ).toThrow();
    expect(() => parseMigrationImpactOutput("x".repeat(131073), 1)).toThrow();
    expect(() => parseMigrationImpactOutput("", 101)).toThrow();
    expect(() => parseMigrationImpactOutput("", -1)).toThrow();
    expect(parseMigrationImpactOutput("", 0)).toEqual([]);
  });

  it("requires a closed, valid server snapshot timestamp and complete measurements", () => {
    const snapshotAt = "2026-10-22T16:00:00.000Z";
    expect(
      parseMigrationImpactBatchOutput(
        JSON.stringify({ snapshotAt }) + "\n" + record(),
        1,
      ),
    ).toEqual({ snapshotAt, counts: [{ index: 0, count: "0", reason: null }] });
    for (const header of [
      { snapshotAt: "2026-02-30T00:00:00.000Z" },
      { snapshotAt, raw: "PRIVATE_ROW_CANARY" },
      { snapshotAt: "not a timestamp" },
    ])
      expect(() =>
        parseMigrationImpactBatchOutput(
          JSON.stringify(header) + "\n" + record(),
          1,
        ),
      ).toThrow("unsupported aggregate snapshot");
    expect(() =>
      parseMigrationImpactBatchOutput(JSON.stringify({ snapshotAt }), 1),
    ).toThrow();
  });

  it("reports older unsupported servers as unknown without a snapshot or zero count", () => {
    expect(
      parseMigrationImpactBatchOutput('{"unsupportedServerVersion":true}', 1),
    ).toEqual({
      snapshotAt: null,
      counts: [{ index: 0, count: null, reason: "unsupported_server_version" }],
    });
    expect(() =>
      parseMigrationImpactBatchOutput(
        '{"unsupportedServerVersion":true}\n' + record(),
        1,
      ),
    ).toThrow();
    expect(() =>
      parseMigrationImpactBatchOutput('{"unsupportedServerVersion":true}', 101),
    ).toThrow();
  });

  it("projects an exhausted server preflight budget as closed unknown counts", () => {
    expect(parseMigrationImpactBatchOutput('{"totalTimeout":true}', 2)).toEqual(
      {
        snapshotAt: null,
        counts: [
          { index: 0, count: null, reason: "total_timeout" },
          { index: 1, count: null, reason: "total_timeout" },
        ],
      },
    );
    for (const raw of [
      '{"totalTimeout":false}',
      '{"totalTimeout":true,"raw":"PRIVATE_CANARY"}',
      '{"totalTimeout":true}\n' + record(),
    ])
      expect(() => parseMigrationImpactBatchOutput(raw, 1)).toThrow();
  });
});
