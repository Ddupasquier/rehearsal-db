/** Compile only fixed aggregate queries; migration SQL and identifiers stay private. */
import type {
  MigrationImpactRelation,
  MigrationImpactTask,
} from "./migration_impact_plan.mjs";
import {
  nativeMigrationImpactIndexes,
  nativeMigrationImpactStatistics,
  nativeMigrationImpactComparison,
} from "./migration_impact_catalog.mjs";

export const MIGRATION_IMPACT_LIMITS = Object.freeze({
  maximumMeasurements: 100,
  lockTimeoutMilliseconds: 1_000,
  statementTimeoutMilliseconds: 5_000,
  totalTimeoutMilliseconds: 30_000,
  maximumOutputBytes: 131_072,
  maximumScriptBytes: 262_144,
});

export interface MigrationImpactCount {
  readonly index: number;
  readonly count: string | null;
  readonly reason:
    | "unsupported_runtime_metadata"
    | "unsupported_server_version"
    | "total_timeout"
    | null;
}

const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_$]{0,62}$/u.test(value))
    throw new Error("The private measurement identifier is unsupported.");
  return value;
};
const quoted = (value: string): string => `"${identifier(value)}"`;
const literal = (value: string): string => `'${identifier(value)}'`;
const relationName = (relation: MigrationImpactRelation): string =>
  `${quoted(relation.schema)}.${quoted(relation.name)}`;
const relationLiteral = (relation: MigrationImpactRelation): string =>
  `'${relationName(relation)}'`;
const relationPredicate = (
  relation: MigrationImpactRelation,
  alias: "r" | "p",
): string =>
  `${alias}.relnamespace = (select oid from pg_catalog.pg_namespace where nspname = ${literal(relation.schema)})
    and ${alias}.relname = ${literal(relation.name)}
    and ${alias}.relkind = 'r' and ${alias}.relpersistence in ('p', 'u')
    and not ${alias}.relrowsecurity and not ${alias}.relispartition
    and ${alias}.relam = (select oid from pg_catalog.pg_am where amname = 'heap')
    and not exists (select 1 from pg_catalog.pg_inherits h
      where h.inhparent = ${alias}.oid or h.inhrelid = ${alias}.oid)
    and pg_catalog.to_regclass(${relationLiteral(relation)})::oid = ${alias}.oid
    and ${nativeMigrationImpactIndexes(alias)}
    and ${nativeMigrationImpactStatistics(alias)}`;

const columnPredicate = (
  relationAlias: string,
  column: string,
  compare: boolean,
): string => `exists (
    select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_type t on t.oid = a.atttypid
    join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
    where a.attrelid = ${relationAlias}.oid and a.attname = ${literal(column)}
      and a.attnum > 0 and not a.attisdropped and a.attgenerated in ('', 's')
      and tn.nspname = 'pg_catalog' and t.oid < 16384 and t.typbasetype = 0
      and t.typname in ('bool', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8',
        'text', ${compare ? "" : "'varchar', 'bpchar',"} 'uuid', 'date', 'timestamp', 'timestamptz')
      ${compare ? `and ${nativeMigrationImpactComparison("t")}` : ""}
      ${compare ? `and (a.attcollation = 0 or exists (select 1 from pg_catalog.pg_collation co join pg_catalog.pg_namespace cn on cn.oid = co.collnamespace where co.oid = a.attcollation and co.oid < 16384 and cn.nspname = 'pg_catalog' and co.collisdeterministic))` : ""}
  )`;

const validateTask = (task: MigrationImpactTask): void => {
  relationName(task.relation);
  if (
    !Number.isSafeInteger(task.line) ||
    task.line < 1 ||
    !Number.isSafeInteger(task.column) ||
    task.column < 1
  )
    throw new Error("The private measurement location is unsupported.");
  const operations: Record<MigrationImpactTask["metric"], readonly string[]> = {
    rows: ["drop_table", "truncate", "broad_delete"],
    populated: ["drop_column"],
    nulls: ["not_null"],
    duplicate_rows: ["new_constraint"],
    orphan_rows: ["new_constraint"],
  };
  if (!operations[task.metric]?.includes(task.operation))
    throw new Error("The private measurement kind is unsupported.");
  if (task.metric !== "rows") {
    if (
      !Array.isArray(task.columns) ||
      task.columns.length < 1 ||
      task.columns.length > 8 ||
      new Set(task.columns).size !== task.columns.length ||
      (["populated", "nulls"].includes(task.metric) &&
        task.columns.length !== 1)
    )
      throw new Error("The private measurement columns are unsupported.");
    task.columns.forEach(identifier);
  }
  if (task.metric === "orphan_rows") {
    relationName(task.referencedRelation);
    if (
      !Array.isArray(task.referencedColumns) ||
      task.referencedColumns.length !== task.columns.length ||
      new Set(task.referencedColumns).size !== task.referencedColumns.length
    )
      throw new Error("The private measurement reference is unsupported.");
    task.referencedColumns.forEach(identifier);
  }
};

const metadataCheck = (
  task: MigrationImpactTask,
  relationIds: ReadonlyMap<string, number>,
): string => {
  const compare = ["duplicate_rows", "orphan_rows"].includes(task.metric);
  const expectedOid = (relation: MigrationImpactRelation, alias: "r" | "p") =>
    `${alias}.oid = :'impact_relation_${relationIds.get(relationName(relation))!}_oid'::pg_catalog.oid`;
  const predicates = [
    relationPredicate(task.relation, "r"),
    expectedOid(task.relation, "r"),
  ];
  if (task.metric !== "rows")
    predicates.push(
      ...task.columns.map((column) => columnPredicate("r", column, compare)),
    );
  if (task.metric === "orphan_rows") {
    const pairedColumns = task.columns.map(
      (column, index) =>
        `exists (select 1 from pg_catalog.pg_attribute ca join pg_catalog.pg_attribute pa
        on pa.attrelid = p.oid and pa.attname = ${literal(task.referencedColumns[index]!)}
        where ca.attrelid = r.oid and ca.attname = ${literal(column)}
          and ca.atttypid = pa.atttypid and ca.attcollation = pa.attcollation)`,
    );
    predicates.push(`exists (select 1 from pg_catalog.pg_class p where
      ${relationPredicate(task.referencedRelation, "p")} and ${expectedOid(task.referencedRelation, "p")} and
      ${task.referencedColumns.map((column) => columnPredicate("p", column, true)).join(" and ")} and
      ${pairedColumns.join(" and ")})`);
  }
  return `select exists (select 1 from pg_catalog.pg_class r where ${predicates.join(" and ")}) as ok`;
};

const countQuery = (task: MigrationImpactTask): string => {
  const table = relationName(task.relation);
  if (task.metric === "rows")
    return `select pg_catalog.count(*)::text as count from only ${table}`;
  if (task.metric === "nulls" || task.metric === "populated")
    return `select pg_catalog.count(*)::text as count from only ${table}
      where ${quoted(task.columns[0]!)} is ${task.metric === "populated" ? "not " : ""}null`;
  const populated = task.columns
    .map((column) => `c.${quoted(column)} is not null`)
    .join(" and ");
  if (task.metric === "duplicate_rows")
    return `select coalesce(pg_catalog.sum(n), 0)::text as count from (
      select pg_catalog.count(*) as n from only ${table} c where ${populated}
      group by ${task.columns.map((column) => `c.${quoted(column)}`).join(", ")}
      having pg_catalog.count(*) > 1) duplicates`;
  const equal = task.columns
    .map(
      (column, index) =>
        `p.${quoted(task.referencedColumns[index]!)} operator(pg_catalog.=) c.${quoted(column)}`,
    )
    .join(" and ");
  return `select pg_catalog.count(*)::text as count from only ${table} c
    where ${populated} and not exists (select 1 from only ${relationName(task.referencedRelation)} p where ${equal})`;
};

/** One consistent current-row snapshot. No pending migration statement is executed. */
export const buildMigrationImpactScript = (
  tasks: readonly MigrationImpactTask[],
  transactionTimeoutMilliseconds: number = MIGRATION_IMPACT_LIMITS.totalTimeoutMilliseconds,
): string => {
  if (tasks.length > MIGRATION_IMPACT_LIMITS.maximumMeasurements)
    throw new Error("The measurement count exceeds its fixed bound.");
  tasks.forEach(validateTask);
  if (
    !Number.isSafeInteger(transactionTimeoutMilliseconds) ||
    transactionTimeoutMilliseconds < 1 ||
    transactionTimeoutMilliseconds >
      MIGRATION_IMPACT_LIMITS.totalTimeoutMilliseconds
  )
    throw new Error("The server transaction deadline exceeds its fixed bound.");
  const relations = [
    ...new Map(
      tasks.flatMap((task) =>
        [
          task.relation,
          ...(task.metric === "orphan_rows" ? [task.referencedRelation] : []),
        ].map((relation) => [relationName(relation), relation] as const),
      ),
    ).entries(),
  ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const relationIds = new Map(relations.map(([name], index) => [name, index]));
  const script = [
    "\\set ON_ERROR_STOP on",
    "set default_transaction_read_only = on;",
    "set lock_timeout = '1s';",
    "set statement_timeout = '5s';",
    "set idle_in_transaction_session_timeout = '5s';",
    "set search_path = pg_catalog;",
    "set row_security = off;",
    "set max_parallel_workers_per_gather = 0;",
    "set work_mem = '1MB';",
    "set temp_file_limit = '8MB';",
    "set constraint_exclusion = off;",
    "select pg_catalog.current_setting('server_version_num')::integer >= 170000 as supported \\gset impact_server_",
    "\\if :impact_server_supported",
    `set transaction_timeout = '${transactionTimeoutMilliseconds}ms';`,
    "select pg_catalog.clock_timestamp()::text as started \\gset impact_clock_",
    "begin isolation level read committed read only;",
    ...relations.map(
      (
        [, relation],
        index,
      ) => `with eligible as (select r.oid from pg_catalog.pg_class r where ${relationPredicate(relation, "r")})
      select exists (select 1 from eligible) as ok, coalesce((select oid from eligible), 0)::pg_catalog.oid as oid \\gset impact_relation_${index}_`,
    ),
    "rollback;",
    // Preflight must not freeze the later repeatable-read catalog snapshot.
    `select greatest(1, least(${transactionTimeoutMilliseconds}, ${transactionTimeoutMilliseconds} - elapsed))::text as milliseconds,
      elapsed < ${transactionTimeoutMilliseconds} as available from
      (select pg_catalog.ceil(extract(epoch from (pg_catalog.clock_timestamp() - :'impact_clock_started'::pg_catalog.timestamptz)) * 1000) as elapsed) budget \\gset impact_remaining_`,
    "\\if :impact_remaining_available",
    "begin isolation level repeatable read read only;",
    "set local transaction_timeout = :'impact_remaining_milliseconds';",
    // Schema names also participate in query resolution. A database-local
    // namespace-catalog lock prevents schema rename/swap after the checks;
    // relation locks alone do not stabilize that mapping.
    "lock table pg_catalog.pg_namespace in share mode;",
    // Globally ordered strong locks exclude ordinary/concurrent index and statistics
    // DDL before the first repeatable-read SELECT establishes the count snapshot.
    // A name swapped to a view can transiently lock its dependencies; the retained
    // OID/ordinary-table checks still prohibit reading it or executing its query.
    ...relations.flatMap(([name], index) => [
      `\\if :impact_relation_${index}_ok`,
      `lock table only ${name} in share row exclusive mode;`,
      "\\endif",
    ]),
    `select pg_catalog.json_build_object('snapshotAt', pg_catalog.to_char(pg_catalog.statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));`,
  ];
  tasks.forEach((task, index) => {
    const unknown = `select pg_catalog.json_build_object('index', ${index}, 'count', null, 'reason', 'unsupported_runtime_metadata');`;
    script.push(
      `${metadataCheck(task, relationIds)} \\gset locked_${index}_`,
      `\\if :locked_${index}_ok`,
      `select pg_catalog.json_build_object('index', ${index}, 'count', measured.count, 'reason', null) from (${countQuery(task)}) measured;`,
      "\\else",
      unknown,
      "\\endif",
    );
  });
  script.push(
    "rollback;",
    "\\else",
    "select pg_catalog.json_build_object('totalTimeout', true);",
    "\\endif",
    "\\else",
    "select pg_catalog.json_build_object('unsupportedServerVersion', true);",
    "\\endif",
    "",
  );
  const result = script.join("\n");
  if (Buffer.byteLength(result) > MIGRATION_IMPACT_LIMITS.maximumScriptBytes)
    throw new Error("The fixed measurement script exceeds its byte bound.");
  return result;
};

export const parseMigrationImpactBatchOutput = (
  output: string,
  expectedCount: number,
): {
  readonly snapshotAt: string | null;
  readonly counts: readonly MigrationImpactCount[];
} => {
  const invalid = (): never => {
    throw new Error("The sandbox returned an unsupported aggregate snapshot.");
  };
  if (Buffer.byteLength(output) > MIGRATION_IMPACT_LIMITS.maximumOutputBytes)
    return invalid();
  const lines = output.trim().split(/\r?\n/u);
  let header: unknown;
  try {
    header = JSON.parse(lines.shift() ?? "");
  } catch {
    return invalid();
  }
  if (!header || typeof header !== "object" || Array.isArray(header))
    return invalid();
  const value = header as Record<string, unknown>;
  if (
    (Object.keys(value).join(",") === "unsupportedServerVersion" &&
      value.unsupportedServerVersion === true) ||
    (Object.keys(value).join(",") === "totalTimeout" &&
      value.totalTimeout === true)
  ) {
    if (
      lines.length ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      expectedCount > MIGRATION_IMPACT_LIMITS.maximumMeasurements
    )
      return invalid();
    return {
      snapshotAt: null,
      counts: Array.from({ length: expectedCount }, (_, index) => ({
        index,
        count: null,
        reason:
          value.totalTimeout === true
            ? ("total_timeout" as const)
            : ("unsupported_server_version" as const),
      })),
    };
  }
  if (
    Object.keys(value).join(",") !== "snapshotAt" ||
    typeof value.snapshotAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.snapshotAt) ||
    !Number.isFinite(Date.parse(value.snapshotAt)) ||
    new Date(value.snapshotAt).toISOString() !== value.snapshotAt
  )
    return invalid();
  return {
    snapshotAt: value.snapshotAt,
    counts: parseMigrationImpactOutput(lines.join("\n"), expectedCount),
  };
};

export const parseMigrationImpactOutput = (
  output: string,
  expectedCount: number,
): readonly MigrationImpactCount[] => {
  const invalid = (): never => {
    throw new Error("The sandbox returned an unsupported aggregate report.");
  };
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > MIGRATION_IMPACT_LIMITS.maximumMeasurements ||
    Buffer.byteLength(output) > MIGRATION_IMPACT_LIMITS.maximumOutputBytes
  )
    return invalid();
  const lines = output.trim() ? output.trim().split(/\r?\n/u) : [];
  if (lines.length !== expectedCount) return invalid();
  return lines.map((line, index): MigrationImpactCount => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return invalid();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return invalid();
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "count,index,reason" ||
      value.index !== index
    )
      return invalid();
    if (value.count === null && value.reason === "unsupported_runtime_metadata")
      return { index, count: null, reason: value.reason };
    if (
      typeof value.count !== "string" ||
      !/^(?:0|[1-9][0-9]{0,18})$/u.test(value.count) ||
      BigInt(value.count) > 9_223_372_036_854_775_807n ||
      value.reason !== null
    )
      return invalid();
    return { index, count: value.count, reason: null };
  });
};
