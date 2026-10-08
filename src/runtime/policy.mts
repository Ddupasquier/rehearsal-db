/** Build narrowly validated local restore prerequisites and structural checks. */

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const IDENTITY_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const EXTENSIONS = new Set([
  "citext",
  "pg_trgm",
  "pgcrypto",
  "unaccent",
  "uuid-ossp",
  "vector",
]);

type PolicyObject = Record<string, unknown>;

interface RuntimeRelation {
  readonly schema: string;
  readonly name: string;
}

interface RuntimeExtension {
  readonly name: string;
  readonly schema: string;
}

interface RuntimeTrigger {
  readonly name: string;
  readonly table: RuntimeRelation;
  readonly timing: "before" | "after";
  readonly events: readonly ("insert" | "update" | "delete")[];
  readonly function: RuntimeRelation;
}

interface RuntimeLocalRow {
  readonly table: RuntimeRelation;
  readonly keyColumns: readonly string[];
  readonly values: PolicyObject;
  readonly identityAssociation: Readonly<{
    identity: string;
    column: string;
  }> | null;
}

interface RuntimeExpectation {
  readonly table: RuntimeRelation;
  readonly rowLevelSecurity: boolean;
  readonly columns: readonly Readonly<{
    name: string;
    generated: boolean;
    identity: boolean;
  }>[];
  readonly foreignKeys: readonly Readonly<{
    columns: readonly string[];
    references: Readonly<{
      schema: string;
      table: string;
      columns: readonly string[];
    }>;
  }>[];
  readonly policies: readonly Readonly<{
    name: string;
    command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    roles: readonly string[];
  }>[];
}

export interface RuntimePolicy {
  readonly policyVersion: 1;
  readonly prerequisites: Readonly<{
    schemas: readonly string[];
    extensions: readonly RuntimeExtension[];
  }>;
  readonly triggers: readonly RuntimeTrigger[];
  readonly localRows: readonly RuntimeLocalRow[];
  readonly expectations: readonly RuntimeExpectation[];
}

const object = (value: unknown, label: string): PolicyObject => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as PolicyObject;
};
const keys = (
  value: PolicyObject,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
};
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(`${label} is not a safe PostgreSQL identifier.`);
  return value;
};
const qid = (value: unknown): string => `"${id(value, "SQL identifier")}"`;
const qext = (value: unknown): string => {
  if (typeof value !== "string" || !EXTENSIONS.has(value))
    throw new Error("Unsupported extension identifier.");
  return `"${value}"`;
};
const literal = (value: unknown): string =>
  `'${String(value).replaceAll("'", "''")}'`;
const relation = (value: unknown, label: string): RuntimeRelation => {
  const relationObject = object(value, label);
  keys(relationObject, ["schema", "name"], label);
  return Object.freeze({
    schema: id(relationObject.schema, `${label}.schema`),
    name: id(relationObject.name, `${label}.name`),
  });
};

const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};

export const IDENTITY_CLAIM_RECEIPT_SQL = `create schema if not exists rehearsal_internal;
create table if not exists rehearsal_internal.identity_claims (
  identity_name text primary key,
  placeholder_user_id uuid not null unique,
  local_user_id uuid not null,
  claimed_at timestamptz not null default now()
);`;

export const validateRuntimePolicy = (input: unknown): RuntimePolicy => {
  const policy = object(input, "runtimePolicy");
  keys(
    policy,
    ["policyVersion", "prerequisites", "triggers", "localRows", "expectations"],
    "runtimePolicy",
  );
  if (policy.policyVersion !== 1)
    throw new Error("Runtime policy must use policyVersion 1.");
  const prerequisites = object(
    policy.prerequisites ?? {},
    "runtimePolicy.prerequisites",
  );
  keys(prerequisites, ["schemas", "extensions"], "runtimePolicy.prerequisites");
  const schemas = array(
    prerequisites.schemas ?? [],
    "runtimePolicy.prerequisites.schemas",
  ).map((value, index) =>
    id(value, `runtimePolicy.prerequisites.schemas[${index}]`),
  );
  const extensions: RuntimeExtension[] = array(
    prerequisites.extensions ?? [],
    "runtimePolicy.prerequisites.extensions",
  ).map((entry, index) => {
    const label = `runtimePolicy.prerequisites.extensions[${index}]`;
    const extension = object(entry, label);
    keys(extension, ["name", "schema"], label);
    if (typeof extension.name !== "string" || !EXTENSIONS.has(extension.name))
      throw new Error(
        `${label}.name is not in Rehearsal's reviewed extension allowlist.`,
      );
    return Object.freeze({
      name: extension.name,
      schema: id(extension.schema, `${label}.schema`),
    });
  });
  const triggers: RuntimeTrigger[] = array(
    policy.triggers ?? [],
    "runtimePolicy.triggers",
  ).map((entry, index) => {
    const label = `runtimePolicy.triggers[${index}]`;
    const trigger = object(entry, label);
    keys(trigger, ["name", "table", "timing", "events", "function"], label);
    if (trigger.timing !== "before" && trigger.timing !== "after")
      throw new Error(`${label}.timing is unsupported.`);
    const events = array(trigger.events, `${label}.events`);
    if (
      events.length === 0 ||
      events.some(
        (event) =>
          event !== "insert" && event !== "update" && event !== "delete",
      )
    ) {
      throw new Error(`${label}.events are unsupported.`);
    }
    const normalizedEvents = events as ("insert" | "update" | "delete")[];
    return Object.freeze({
      name: id(trigger.name, `${label}.name`),
      table: relation(trigger.table, `${label}.table`),
      timing: trigger.timing,
      events: Object.freeze([...new Set(normalizedEvents)]),
      function: relation(trigger.function, `${label}.function`),
    });
  });
  const localRows: RuntimeLocalRow[] = array(
    policy.localRows ?? [],
    "runtimePolicy.localRows",
  ).map((entry, index) => {
    const label = `runtimePolicy.localRows[${index}]`;
    const row = object(entry, label);
    keys(row, ["table", "keyColumns", "values", "identityAssociation"], label);
    const table = relation(row.table, `${label}.table`);
    const values = object(row.values, `${label}.values`);
    const valueColumns = Object.keys(values).map((name) =>
      id(name, `${label}.values key`),
    );
    const keyColumnsInput = array(row.keyColumns, `${label}.keyColumns`);
    const keyColumns = keyColumnsInput.map((name, keyIndex) =>
      id(name, `${label}.keyColumns[${keyIndex}]`),
    );
    if (
      keyColumns.length === 0 ||
      keyColumns.some((name) => !valueColumns.includes(name))
    ) {
      throw new Error(`${label}.keyColumns must be present in values.`);
    }
    let identityAssociation: RuntimeLocalRow["identityAssociation"] = null;
    if (row.identityAssociation != null) {
      const associationLabel = `${label}.identityAssociation`;
      const association = object(row.identityAssociation, associationLabel);
      keys(association, ["identity", "column"], associationLabel);
      if (
        typeof association.identity !== "string" ||
        !IDENTITY_NAME.test(association.identity)
      ) {
        throw new Error(`${associationLabel}.identity is invalid.`);
      }
      const column = id(association.column, `${associationLabel}.column`);
      if (!keyColumns.includes(column)) {
        throw new Error(`${associationLabel}.column must be a key column.`);
      }
      const placeholder = values[column];
      if (typeof placeholder !== "string" || !UUID.test(placeholder)) {
        throw new Error(
          `${associationLabel}.column must contain the placeholder UUID.`,
        );
      }
      identityAssociation = Object.freeze({
        identity: association.identity,
        column,
      });
    }
    return Object.freeze({
      table,
      keyColumns: Object.freeze(keyColumns),
      values,
      identityAssociation,
    });
  });
  const expectations: RuntimeExpectation[] = array(
    policy.expectations ?? [],
    "runtimePolicy.expectations",
  ).map((entry, index) => {
    const label = `runtimePolicy.expectations[${index}]`;
    const expectation = object(entry, label);
    keys(
      expectation,
      ["table", "rowLevelSecurity", "columns", "foreignKeys", "policies"],
      label,
    );
    if (typeof expectation.rowLevelSecurity !== "boolean")
      throw new Error(`${label}.rowLevelSecurity must be true or false.`);
    const columnsInput = array(expectation.columns, `${label}.columns`);
    if (columnsInput.length === 0)
      throw new Error(`${label}.columns must not be empty.`);
    const foreignKeys = array(
      expectation.foreignKeys ?? [],
      `${label}.foreignKeys`,
    ).map((foreignKey, fkIndex) => {
      const fkLabel = `${label}.foreignKeys[${fkIndex}]`;
      const foreignKeyObject = object(foreignKey, fkLabel);
      keys(foreignKeyObject, ["columns", "references"], fkLabel);
      const localColumns = array(
        foreignKeyObject.columns,
        `${fkLabel}.columns`,
      );
      if (localColumns.length === 0) {
        throw new Error(`${fkLabel}.columns must not be empty.`);
      }
      const references = object(
        foreignKeyObject.references,
        `${fkLabel}.references`,
      );
      keys(references, ["schema", "table", "columns"], `${fkLabel}.references`);
      const referencedColumns = array(
        references.columns,
        `${fkLabel}.references.columns`,
      );
      if (referencedColumns.length !== localColumns.length) {
        throw new Error(
          `${fkLabel}.references.columns must match the local columns.`,
        );
      }
      return Object.freeze({
        columns: Object.freeze(
          localColumns.map((column) => id(column, `${fkLabel}.columns[]`)),
        ),
        references: Object.freeze({
          schema: id(references.schema, `${fkLabel}.references.schema`),
          table: id(references.table, `${fkLabel}.references.table`),
          columns: Object.freeze(
            referencedColumns.map((column) =>
              id(column, `${fkLabel}.references.columns[]`),
            ),
          ),
        }),
      });
    });
    const policies = array(expectation.policies ?? [], `${label}.policies`).map(
      (rowPolicy, policyIndex) => {
        const policyLabel = `${label}.policies[${policyIndex}]`;
        const rowPolicyObject = object(rowPolicy, policyLabel);
        keys(rowPolicyObject, ["name", "command", "roles"], policyLabel);
        if (
          rowPolicyObject.command !== "ALL" &&
          rowPolicyObject.command !== "SELECT" &&
          rowPolicyObject.command !== "INSERT" &&
          rowPolicyObject.command !== "UPDATE" &&
          rowPolicyObject.command !== "DELETE"
        ) {
          throw new Error(`${policyLabel}.command is unsupported.`);
        }
        const roles = array(rowPolicyObject.roles, `${policyLabel}.roles`);
        if (roles.length === 0) {
          throw new Error(`${policyLabel}.roles must not be empty.`);
        }
        return Object.freeze({
          name: id(rowPolicyObject.name, `${policyLabel}.name`),
          command: rowPolicyObject.command,
          roles: Object.freeze(
            roles.map((role) => id(role, `${policyLabel}.roles[]`)),
          ),
        });
      },
    );
    return Object.freeze({
      table: relation(expectation.table, `${label}.table`),
      rowLevelSecurity: expectation.rowLevelSecurity,
      columns: Object.freeze(
        columnsInput.map((column, columnIndex) => {
          const columnLabel = `${label}.columns[${columnIndex}]`;
          const columnObject = object(column, columnLabel);
          keys(columnObject, ["name", "generated", "identity"], columnLabel);
          return Object.freeze({
            name: id(columnObject.name, `${columnLabel}.name`),
            generated: columnObject.generated === true,
            identity: columnObject.identity === true,
          });
        }),
      ),
      foreignKeys: Object.freeze(foreignKeys),
      policies: Object.freeze(policies),
    });
  });
  return Object.freeze({
    policyVersion: 1,
    prerequisites: Object.freeze({
      schemas: Object.freeze(schemas),
      extensions: Object.freeze(extensions),
    }),
    triggers: Object.freeze(triggers),
    localRows: Object.freeze(localRows),
    expectations: Object.freeze(expectations),
  });
};

export const buildRuntimePrerequisiteSql = (input: unknown): string => {
  const policy = validateRuntimePolicy(input);
  const statements = ["begin;"];
  for (const schema of policy.prerequisites.schemas) {
    statements.push(`create schema if not exists ${qid(schema)};`);
  }
  for (const extension of policy.prerequisites.extensions) {
    statements.push(
      `create extension if not exists ${qext(extension.name)} with schema ${qid(extension.schema)};`,
    );
  }
  statements.push("commit;");
  return `${statements.join("\n")}\n`;
};

export const buildRuntimePostSchemaSql = (input: unknown): string => {
  const policy = validateRuntimePolicy(input);
  const statements = ["begin;"];
  for (const trigger of policy.triggers) {
    const target = `${qid(trigger.table.schema)}.${qid(trigger.table.name)}`;
    const fn = `${qid(trigger.function.schema)}.${qid(trigger.function.name)}`;
    statements.push(`do $rehearsal_trigger$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = ${literal(trigger.name)}
      and tgrelid = ${literal(`${trigger.table.schema}.${trigger.table.name}`)}::regclass
      and not tgisinternal
  ) then
    execute ${literal(
      `create trigger ${qid(trigger.name)} ${trigger.timing} ${trigger.events.join(" or ")} on ${target} for each row execute function ${fn}()`,
    )};
  end if;
end
$rehearsal_trigger$;`);
  }
  statements.push("commit;");
  return `${statements.join("\n")}\n`;
};

export const buildRuntimePreparationSql = (input: unknown): string =>
  `${buildRuntimePrerequisiteSql(input)}${buildRuntimePostSchemaSql(input)}`;

export const buildRuntimeFinalizationSql = (input: unknown): string => {
  const policy = validateRuntimePolicy(input);
  const statements: string[] = ["begin;"];
  if (policy.localRows.some((row) => row.identityAssociation)) {
    statements.push(IDENTITY_CLAIM_RECEIPT_SQL);
  }
  for (const row of policy.localRows) {
    const target = `${qid(row.table.schema)}.${qid(row.table.name)}`;
    const columns = Object.keys(row.values);
    statements.push(
      `insert into ${target} (${columns.map((column) => qid(column)).join(", ")})
select ${columns.map((name) => `restored.${qid(name)}`).join(", ")}
from jsonb_populate_record(null::${target}, ${literal(JSON.stringify(row.values))}::jsonb) restored
on conflict (${row.keyColumns.map((column) => qid(column)).join(", ")}) do nothing;`,
    );
  }
  statements.push("commit;");
  return `${statements.join("\n")}\n`;
};

export const buildRuntimeVerificationSql = (input: unknown): string => {
  const policy = validateRuntimePolicy(input);
  const checks: string[] = [];
  for (const extension of policy.prerequisites.extensions) {
    checks.push(`if not exists (
      select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = ${literal(extension.name)} and n.nspname = ${literal(extension.schema)}
    ) then raise exception 'Rehearsal extension prerequisite is missing'; end if;`);
  }
  for (const trigger of policy.triggers) {
    const triggerType =
      1 +
      (trigger.timing === "before" ? 2 : 0) +
      (trigger.events.includes("insert") ? 4 : 0) +
      (trigger.events.includes("delete") ? 8 : 0) +
      (trigger.events.includes("update") ? 16 : 0);
    checks.push(`if not exists (
      select 1 from pg_trigger
      where tgname = ${literal(trigger.name)}
        and tgrelid = ${literal(`${trigger.table.schema}.${trigger.table.name}`)}::regclass
        and tgfoid = ${literal(`${trigger.function.schema}.${trigger.function.name}()`)}::regprocedure
        and tgtype = ${triggerType}
        and not tgisinternal
    ) then raise exception 'Rehearsal managed trigger is missing'; end if;`);
  }
  for (const row of policy.localRows) {
    const target = `${qid(row.table.schema)}.${qid(row.table.name)}`;
    checks.push(`if not exists (
      select 1
      from ${target} current_row,
           jsonb_populate_record(null::${target}, ${literal(JSON.stringify(row.values))}::jsonb) expected
      where ${row.keyColumns
        .map((column) =>
          row.identityAssociation?.column === column
            ? `current_row.${qid(column)}::text = coalesce(
              (select claim.local_user_id::text
               from rehearsal_internal.identity_claims claim
               where claim.identity_name = ${literal(row.identityAssociation.identity)}
                 and claim.placeholder_user_id::text = expected.${qid(column)}::text),
              expected.${qid(column)}::text
            )`
            : `current_row.${qid(column)} is not distinct from expected.${qid(column)}`,
        )
        .join(" and ")}
    ) then raise exception 'Rehearsal local-only row is missing'; end if;`);
  }
  for (const expectation of policy.expectations) {
    const name = `${expectation.table.schema}.${expectation.table.name}`;
    checks.push(`if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${literal(expectation.table.schema)}
        and c.relname = ${literal(expectation.table.name)}
        and c.relrowsecurity = ${expectation.rowLevelSecurity ? "true" : "false"}
    ) then raise exception 'Rehearsal table or RLS expectation failed'; end if;`);
    for (const column of expectation.columns) {
      checks.push(`if not exists (
        select 1 from information_schema.columns
        where table_schema = ${literal(expectation.table.schema)}
          and table_name = ${literal(expectation.table.name)}
          and column_name = ${literal(column.name)}
          and (is_generated <> 'NEVER') = ${column.generated ? "true" : "false"}
          and (is_identity = 'YES') = ${column.identity ? "true" : "false"}
      ) then raise exception ${literal(`Rehearsal column expectation failed for ${name}.${column.name}`)}; end if;`);
    }
    for (const foreignKey of expectation.foreignKeys) {
      const localColumns = `array[${foreignKey.columns.map(literal).join(", ")}]::text[]`;
      const targetColumns = `array[${foreignKey.references.columns.map(literal).join(", ")}]::text[]`;
      checks.push(`if not exists (
        select 1 from pg_constraint c
        where c.contype = 'f'
          and c.conrelid = ${literal(name)}::regclass
          and c.confrelid = ${literal(
            `${foreignKey.references.schema}.${foreignKey.references.table}`,
          )}::regclass
          and (select array_agg(a.attname order by u.ordinality)::text[]
               from unnest(c.conkey) with ordinality u(attnum, ordinality)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum) = ${localColumns}
          and (select array_agg(a.attname order by u.ordinality)::text[]
               from unnest(c.confkey) with ordinality u(attnum, ordinality)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = u.attnum) = ${targetColumns}
      ) then raise exception 'Rehearsal foreign-key expectation failed'; end if;`);
    }
    for (const rowPolicy of expectation.policies) {
      checks.push(`if not exists (
        select 1 from pg_policies
        where schemaname = ${literal(expectation.table.schema)}
          and tablename = ${literal(expectation.table.name)}
          and policyname = ${literal(rowPolicy.name)}
          and cmd = ${literal(rowPolicy.command)}
          and roles @> array[${rowPolicy.roles.map(literal).join(", ")}]::name[]
      ) then raise exception 'Rehearsal row-policy expectation failed'; end if;`);
    }
  }
  checks.push(`if exists (select 1 from pg_constraint where not convalidated) then
    raise exception 'Rehearsal found an unvalidated structural constraint'; end if;`);
  return `do $rehearsal_verify$
begin
  ${checks.join("\n  ")}
end
$rehearsal_verify$;
`;
};
