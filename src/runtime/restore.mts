import {
  isDrizzleMigrationFile,
  isKnexMigrationFile,
  type AnyMigrationFileEntry,
} from "./migration_identity.mjs";
/**
 * Purpose: Build the bounded PostgreSQL restore program for a verified sanitized
 * Rehearsal baseline. Do not run directly; this module is reusable script infrastructure.
 */

import { createHash } from "node:crypto";
import type { BaselineManifest } from "../baseline/artifact.mjs";
import type { RuntimeSanitizationPolicy } from "../baseline/sanitization_policy.mjs";
import type { PrismaNativeBinding } from "./prisma_history.mjs";
import type { MigrationFileEntry } from "./migration_history.mjs";
import {
  parseNativeMigrationBinding,
  sameNativeMigrationHistory,
  type NativeMigrationBinding,
} from "./native_migration_contract.mjs";

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const constraintFailurePattern =
  /^ERROR:\s+(?:[A-Z0-9]{5}:\s+)?new row for relation "([a-z][a-z0-9_]*)" violates check constraint "([a-z][a-z0-9_]*)"$/mu;
const sqlStatePattern = /^ERROR:\s+([A-Z0-9]{5}):/mu;
const notNullFailurePattern =
  /^ERROR:\s+(?:23502:\s+)?null value in column "([a-z][a-z0-9_]*)" of relation "([a-z][a-z0-9_]*)" violates not-null constraint$/mu;
interface RestorePolicyManifest {
  readonly tables: RuntimeSanitizationPolicy["tables"];
}

type RestorePolicyTable = RuntimeSanitizationPolicy["tables"][number];

interface RestoreRecord {
  readonly schema?: string;
  readonly table: string;
  readonly row: Record<string, unknown>;
}

const quoteIdentifier = (value: string): string => {
  if (!identifierPattern.test(value)) {
    throw new Error(`Unsafe Rehearsal restore identifier: ${value}`);
  }
  return `"${value}"`;
};
const quoteLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;
const tableSchema = (table: RestorePolicyTable): string =>
  table.schema ?? "public";
const relationKey = (schema: string, table: string): string =>
  schema === "public" ? table : `${schema}.${table}`;
const qualifiedRelation = (table: RestorePolicyTable): string =>
  `${quoteIdentifier(tableSchema(table))}.${quoteIdentifier(table.name)}`;

const includedPolicies = (
  manifest: RestorePolicyManifest,
): RestorePolicyTable[] =>
  manifest.tables
    .filter((table) => table.sourceRows !== "EXCLUDE")
    .sort((left, right) => left.name.localeCompare(right.name));

export const summarizeRestoreError = (stderr: unknown): string => {
  const match = String(stderr).match(constraintFailurePattern);
  if (match) return `Sanitized data violated ${match[1]}.${match[2]}.`;
  const notNull = String(stderr).match(notNullFailurePattern);
  if (notNull) {
    return `Sanitized data omitted required column ${notNull[2]}.${notNull[1]}.`;
  }
  const sqlState = String(stderr).match(sqlStatePattern)?.[1];
  return sqlState
    ? `PostgreSQL rejected the sanitized baseline stream with SQLSTATE ${sqlState}; row details were withheld.`
    : "PostgreSQL rejected the sanitized baseline stream; row details were withheld.";
};

export const encodeBaselineRecordForCopy = (line: string): string => {
  let record: RestoreRecord;
  try {
    record = JSON.parse(line.trimEnd()) as RestoreRecord;
  } catch (error) {
    throw new Error("A Rehearsal baseline record is not valid JSON.", {
      cause: error,
    });
  }
  if (
    (record?.schema !== undefined && !identifierPattern.test(record.schema)) ||
    !identifierPattern.test(record?.table ?? "") ||
    !record.row ||
    typeof record.row !== "object" ||
    Array.isArray(record.row)
  ) {
    throw new Error(
      "A Rehearsal baseline record has an invalid restore shape.",
    );
  }
  return `${record.schema ?? "public"}\t${record.table}\t${Buffer.from(JSON.stringify(record.row), "utf8").toString("base64")}`;
};

export const buildRestoreSqlPrefix = () => `\\set ON_ERROR_STOP on
\\set VERBOSITY verbose
begin;
set local session_replication_role = replica;
create temporary table rehearsal_restore_rows (
	sequence bigint generated always as identity primary key,
	schema_name text not null,
	table_name text not null,
	encoded text not null
) on commit drop;
copy rehearsal_restore_rows (schema_name, table_name, encoded) from stdin;
`;

const decodedPayloadSql =
  "convert_from(decode(source.encoded, 'base64'), 'UTF8')::jsonb";

const authReferenceSelects = (manifest: RestorePolicyManifest): string[] =>
  includedPolicies(manifest).flatMap((table) =>
    table.columns
      .filter(
        (column) =>
          column.action !== "EXCLUDE" &&
          column.foreignKey?.schema === "auth" &&
          column.foreignKey?.table === "users" &&
          column.foreignKey?.column === "id",
      )
      .map(
        (
          column,
        ) => `select nullif(${decodedPayloadSql}->>${quoteLiteral(column.name)}, '')::uuid as id
	from rehearsal_restore_rows source
	where source.schema_name = ${quoteLiteral(tableSchema(table))}
	  and source.table_name = ${quoteLiteral(table.name)}`,
      ),
  );

const buildAuthRestoreSql = (manifest: RestorePolicyManifest): string => {
  const selects = authReferenceSelects(manifest);
  if (selects.length === 0) return "";
  return `with referenced_auth_users as (
	${selects.join("\n\tunion\n\t")}
)
insert into auth.users (
	instance_id,
	id,
	aud,
	role,
	email,
	confirmation_token,
	recovery_token,
	email_change_token_new,
	email_change,
	email_change_token_current,
	phone_change,
	phone_change_token,
	reauthentication_token,
	raw_app_meta_data,
	raw_user_meta_data,
	is_sso_user,
	is_anonymous,
	created_at,
	updated_at
)
select distinct
	'00000000-0000-0000-0000-000000000000'::uuid,
	id,
	'authenticated',
	'authenticated',
	'rehearsal-' || replace(id::text, '-', '') || '@rehearsal.invalid',
	'',
	'',
	'',
	'',
	'',
	'',
	'',
	'',
	'{"provider":"email","providers":["email"]}'::jsonb,
	'{"rehearsal":true}'::jsonb,
	false,
	false,
	now(),
	now()
from referenced_auth_users
where id is not null
on conflict (id) do nothing;
`;
};

const buildTableRestoreSql = (table: RestorePolicyTable): string => {
  const target = qualifiedRelation(table);
  const columns = table.columns.filter(
    (column) => column.action !== "EXCLUDE" && column.generated !== "ALWAYS",
  );
  if (columns.length === 0) return "";
  const columnList = columns
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  const selectedColumns = columns
    .map((column) => `restored.${quoteIdentifier(column.name)}`)
    .join(", ");
  const overridesIdentity = columns.some((column) => column.identity === "YES")
    ? " overriding system value"
    : "";
  return `insert into ${target} (${columnList})${overridesIdentity}
select ${selectedColumns}
from rehearsal_restore_rows source
cross join lateral jsonb_populate_record(
	null::${target},
	${decodedPayloadSql}
) restored
where source.schema_name = ${quoteLiteral(tableSchema(table))}
  and source.table_name = ${quoteLiteral(table.name)}
order by source.sequence;
`;
};

const buildIdentitySequenceSql = (
  table: RestorePolicyTable,
  includeSerial = false,
): string =>
  table.columns
    .filter(
      (column) =>
        column.action !== "EXCLUDE" &&
        (column.identity === "YES" || includeSerial) &&
        column.generated !== "ALWAYS",
    )
    .map((column) => {
      const schema = tableSchema(table);
      const relation = qualifiedRelation(table);
      const columnName = quoteIdentifier(column.name);
      const sequenceValueQuery = `select max(${columnName})::bigint, exists(select 1 from ${relation}) from ${relation}`;
      return `do $rehearsal_sequence$
declare
	sequence_name text := pg_get_serial_sequence(${quoteLiteral(`${schema}.${table.name}`)}, ${quoteLiteral(column.name)});
	maximum_value bigint;
	has_rows boolean;
begin
	if sequence_name is not null then
		execute ${quoteLiteral(sequenceValueQuery)} into maximum_value, has_rows;
		perform setval(sequence_name, coalesce(maximum_value, 1), has_rows);
	end if;
end
$rehearsal_sequence$;`;
    })
    .join("\n");

const buildRowCountChecks = (
  tables: readonly RestorePolicyTable[],
  tableCounts: Readonly<Record<string, number>>,
): string =>
  tables
    .map((table) => ({
      table,
      key: relationKey(tableSchema(table), table.name),
      expected: tableCounts[relationKey(tableSchema(table), table.name)],
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ table, key, expected }) => {
      if (
        typeof expected !== "number" ||
        !Number.isSafeInteger(expected) ||
        expected < 0
      ) {
        throw new Error(`Invalid Rehearsal row count for ${key}.`);
      }
      return `if (select count(*) from ${qualifiedRelation(table)}) <> ${expected} then
		raise exception 'Rehearsal row-count mismatch for ${key}';
	end if;`;
    })
    .join("\n\t");

const buildForeignKeyChecks = (manifest: RestorePolicyManifest): string =>
  includedPolicies(manifest)
    .flatMap((table) =>
      table.columns.flatMap((column) =>
        column.action !== "EXCLUDE" && column.foreignKey
          ? [{ table, column, target: column.foreignKey }]
          : [],
      ),
    )
    .map(({ table, column, target }) => {
      for (const value of [
        table.name,
        column.name,
        tableSchema(table),
        target.schema,
        target.table,
        target.column,
      ])
        quoteIdentifier(value);
      return `if exists (
		select 1
		from ${qualifiedRelation(table)} child
		left join ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)} parent
			on parent.${quoteIdentifier(target.column)} = child.${quoteIdentifier(column.name)}
		where child.${quoteIdentifier(column.name)} is not null
			and parent.${quoteIdentifier(target.column)} is null
	) then
		raise exception 'Rehearsal foreign-key mismatch for ${relationKey(tableSchema(table), table.name)}.${column.name}';
	end if;`;
    })
    .join("\n\t");

export const buildRestoreSqlSuffix = ({
  manifest,
  tableCounts,
  restoreSupabaseAuth = true,
  identityMode = "restart",
}: {
  manifest: RuntimeSanitizationPolicy;
  tableCounts: Readonly<Record<string, number>>;
  restoreSupabaseAuth?: boolean;
  identityMode?: "restart" | "continue";
}): string => {
  if (
    !Array.isArray(manifest?.tables) ||
    !tableCounts ||
    !["restart", "continue"].includes(identityMode)
  ) {
    throw new Error("A reviewed manifest and exact row counts are required.");
  }
  const tables = includedPolicies(manifest);
  const expectedNames = tables
    .map((table) => relationKey(tableSchema(table), table.name))
    .sort();
  if (expectedNames.join("\0") !== Object.keys(tableCounts).sort().join("\0")) {
    throw new Error("Rehearsal restore table counts do not match the policy.");
  }
  return `\\.
create index rehearsal_restore_rows_table_name_idx
on rehearsal_restore_rows (schema_name, table_name, sequence);
truncate table ${manifest.tables.map(qualifiedRelation).join(", ")}
${identityMode} identity cascade;
${restoreSupabaseAuth ? buildAuthRestoreSql(manifest) : ""}
${tables.map(buildTableRestoreSql).join("\n")}
${tables
  .map((table) => buildIdentitySequenceSql(table, identityMode === "continue"))
  .filter(Boolean)
  .join("\n")}
set local session_replication_role = origin;
do $rehearsal_checks$
begin
	${buildRowCountChecks(tables, tableCounts)}
	${buildForeignKeyChecks(manifest)}
end
$rehearsal_checks$;
commit;
`;
};

export const assertBaselineMigrationHistory = ({
  baselineManifest,
  currentFiles,
  nativeMigrations,
}: {
  baselineManifest: BaselineManifest;
  currentFiles: readonly AnyMigrationFileEntry[];
  nativeMigrations?: PrismaNativeBinding | NativeMigrationBinding | null;
}): void => {
  if (baselineManifest.formatVersion === 5) {
    const bound = parseNativeMigrationBinding(
      baselineManifest.nativeMigrations,
    );
    if (
      bound.kind !== "knex" ||
      nativeMigrations?.kind !== "knex" ||
      bound.version !== nativeMigrations.version ||
      bound.driverVersion !== nativeMigrations.driverVersion ||
      bound.isolationPolicySha256 !== nativeMigrations.isolationPolicySha256
    )
      throw new Error(
        "Knex tool, provider or isolation policy differs from baseline.",
      );
    const expected = baselineManifest.knexHistory;
    if (
      !expected?.entries.length ||
      expected.entries.length > currentFiles.length
    )
      throw new Error("Knex baseline history is absent from current source.");
    for (let i = 0; i < expected.entries.length; i++) {
      const current = currentFiles[i]!,
        old = expected.entries[i]!;
      if (
        !isKnexMigrationFile(current) ||
        current.filename !== old.filename ||
        current.fileSha256 !== old.fileSha256 ||
        current.nativeIdentity.name !== old.nativeIdentity.name
      )
        throw new Error(
          "Knex migration code diverges from the reviewed baseline prefix; native historical checksums remain unavailable.",
        );
    }
    const files = new Map(
      nativeMigrations.codeFiles.map((f) => [f.filename, f]),
    );
    for (const old of expected.files) {
      const current = files.get(old.filename);
      if (
        !current ||
        current.fileSha256 !== old.fileSha256 ||
        current.bytes !== old.bytes
      )
        throw new Error(
          "Knex historical support code changed; create a new reviewed baseline.",
        );
    }
    return;
  }
  if (baselineManifest.formatVersion === 4) {
    const bound = parseNativeMigrationBinding(
      baselineManifest.nativeMigrations,
    );
    if (
      bound.kind !== "drizzle" ||
      nativeMigrations?.kind !== "drizzle" ||
      bound.kitVersion !== nativeMigrations.kitVersion ||
      bound.ormVersion !== nativeMigrations.ormVersion ||
      bound.driverVersion !== nativeMigrations.driverVersion
    )
      throw new Error("Native Drizzle tool/provider differs from baseline.");
    const expected = baselineManifest.drizzleHistory?.entries;
    if (!expected?.length || expected.length > currentFiles.length)
      throw new Error("Drizzle baseline history is absent from source.");
    for (let i = 0; i < expected.length; i++) {
      const current = currentFiles[i]!,
        old = expected[i]!;
      if (
        !isDrizzleMigrationFile(current) ||
        current.nativeIdentity.idx !== old.idx ||
        current.nativeIdentity.when !== old.when ||
        current.nativeIdentity.tag !== old.tag ||
        current.breakpoints !== old.breakpoints ||
        current.filename !== old.filename ||
        current.fileSha256 !== old.hash
      )
        throw new Error("Drizzle source diverges from baseline native prefix.");
    }
    return;
  }
  if (
    baselineManifest.formatVersion === 3 ||
    baselineManifest.nativeMigrations !== undefined ||
    nativeMigrations
  ) {
    const bound = parseNativeMigrationBinding(
      baselineManifest.nativeMigrations,
    );
    if (
      !nativeMigrations ||
      baselineManifest.formatVersion !== 3 ||
      !sameNativeMigrationHistory(bound, nativeMigrations)
    )
      throw new Error(
        "Native migration tool, version, provider or lock differs from the baseline; review a new baseline before proceeding.",
      );
  }
  const baselineEntries = Object.entries(
    baselineManifest?.migrations ?? {},
  ).sort(([left], [right]) => left.localeCompare(right));
  if (baselineEntries.length === 0) {
    throw new Error("The active Rehearsal baseline has no migration bundle.");
  }
  if (baselineEntries.length > currentFiles.length) {
    throw new Error(
      "The active Rehearsal history is absent from local source.",
    );
  }
  for (let index = 0; index < baselineEntries.length; index += 1) {
    const [filename, receipt] = baselineEntries[index]!;
    const current = currentFiles[index]!;
    if (
      current.filename !== filename ||
      current.fileSha256 !== receipt.sha256
    ) {
      throw new Error(
        `Local migration history diverges from the active baseline at ${filename}.`,
      );
    }
  }
};

export const createCandidateMigrationReceipt = ({
  baselineManifest,
  currentFiles,
  nativeMigrations,
}: {
  baselineManifest: BaselineManifest;
  currentFiles: readonly AnyMigrationFileEntry[];
  nativeMigrations?: NativeMigrationBinding | null;
}) => {
  const currentBinding = nativeMigrations
    ? parseNativeMigrationBinding(nativeMigrations)
    : nativeMigrations;
  assertBaselineMigrationHistory({
    baselineManifest,
    currentFiles,
    ...(currentBinding === undefined
      ? {}
      : { nativeMigrations: currentBinding }),
  });
  const candidates = currentFiles.slice(
    Object.keys(baselineManifest.migrations).length,
  );
  const candidateSha256 = createHash("sha256")
    .update(
      `${JSON.stringify(
        nativeMigrations
          ? {
              nativeMigrations,
              candidates: candidates.map(({ filename, fileSha256 }) => ({
                filename,
                fileSha256,
              })),
            }
          : candidates.map(({ filename, fileSha256 }) => ({
              filename,
              fileSha256,
            })),
        null,
        "\t",
      )}\n`,
    )
    .digest("hex");
  return { candidates, candidateSha256 };
};
