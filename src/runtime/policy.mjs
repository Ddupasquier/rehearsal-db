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

const object = (value, label) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};
const keys = (value, allowed, label) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
};
const id = (value, label) => {
  if (!IDENTIFIER.test(value ?? ""))
    throw new Error(`${label} is not a safe PostgreSQL identifier.`);
  return value;
};
const qid = (value) => `"${id(value, "SQL identifier")}"`;
const qext = (value) => {
  if (!EXTENSIONS.has(value))
    throw new Error("Unsupported extension identifier.");
  return `"${value}"`;
};
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const relation = (value, label) => {
  object(value, label);
  keys(value, ["schema", "name"], label);
  return Object.freeze({
    schema: id(value.schema, `${label}.schema`),
    name: id(value.name, `${label}.name`),
  });
};

export const IDENTITY_CLAIM_RECEIPT_SQL = `create schema if not exists rehearsal_internal;
create table if not exists rehearsal_internal.identity_claims (
  identity_name text primary key,
  placeholder_user_id uuid not null unique,
  local_user_id uuid not null,
  claimed_at timestamptz not null default now()
);`;

export const validateRuntimePolicy = (input) => {
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
  const schemas = (prerequisites.schemas ?? []).map((value, index) =>
    id(value, `runtimePolicy.prerequisites.schemas[${index}]`),
  );
  const extensions = (prerequisites.extensions ?? []).map((entry, index) => {
    const label = `runtimePolicy.prerequisites.extensions[${index}]`;
    object(entry, label);
    keys(entry, ["name", "schema"], label);
    if (!EXTENSIONS.has(entry.name))
      throw new Error(
        `${label}.name is not in Rehearsal's reviewed extension allowlist.`,
      );
    return Object.freeze({
      name: entry.name,
      schema: id(entry.schema, `${label}.schema`),
    });
  });
  const triggers = (policy.triggers ?? []).map((entry, index) => {
    const label = `runtimePolicy.triggers[${index}]`;
    object(entry, label);
    keys(entry, ["name", "table", "timing", "events", "function"], label);
    if (!["before", "after"].includes(entry.timing))
      throw new Error(`${label}.timing is unsupported.`);
    if (
      !Array.isArray(entry.events) ||
      entry.events.length === 0 ||
      entry.events.some(
        (event) => !["insert", "update", "delete"].includes(event),
      )
    ) {
      throw new Error(`${label}.events are unsupported.`);
    }
    return Object.freeze({
      name: id(entry.name, `${label}.name`),
      table: relation(entry.table, `${label}.table`),
      timing: entry.timing,
      events: Object.freeze([...new Set(entry.events)]),
      function: relation(entry.function, `${label}.function`),
    });
  });
  const localRows = (policy.localRows ?? []).map((entry, index) => {
    const label = `runtimePolicy.localRows[${index}]`;
    object(entry, label);
    keys(
      entry,
      ["table", "keyColumns", "values", "identityAssociation"],
      label,
    );
    const table = relation(entry.table, `${label}.table`);
    object(entry.values, `${label}.values`);
    const valueColumns = Object.keys(entry.values).map((name) =>
      id(name, `${label}.values key`),
    );
    if (
      !Array.isArray(entry.keyColumns) ||
      entry.keyColumns.length === 0 ||
      entry.keyColumns.some((name) => !valueColumns.includes(name))
    ) {
      throw new Error(`${label}.keyColumns must be present in values.`);
    }
    let identityAssociation = null;
    if (entry.identityAssociation != null) {
      const associationLabel = `${label}.identityAssociation`;
      object(entry.identityAssociation, associationLabel);
      keys(entry.identityAssociation, ["identity", "column"], associationLabel);
      if (!IDENTITY_NAME.test(entry.identityAssociation.identity ?? "")) {
        throw new Error(`${associationLabel}.identity is invalid.`);
      }
      const column = id(
        entry.identityAssociation.column,
        `${associationLabel}.column`,
      );
      if (!entry.keyColumns.includes(column)) {
        throw new Error(`${associationLabel}.column must be a key column.`);
      }
      if (!UUID.test(entry.values[column] ?? "")) {
        throw new Error(
          `${associationLabel}.column must contain the placeholder UUID.`,
        );
      }
      identityAssociation = Object.freeze({
        identity: entry.identityAssociation.identity,
        column,
      });
    }
    return Object.freeze({
      table,
      keyColumns: Object.freeze(entry.keyColumns),
      values: entry.values,
      identityAssociation,
    });
  });
  const expectations = (policy.expectations ?? []).map((entry, index) => {
    const label = `runtimePolicy.expectations[${index}]`;
    object(entry, label);
    keys(
      entry,
      ["table", "rowLevelSecurity", "columns", "foreignKeys", "policies"],
      label,
    );
    if (typeof entry.rowLevelSecurity !== "boolean")
      throw new Error(`${label}.rowLevelSecurity must be true or false.`);
    if (!Array.isArray(entry.columns) || entry.columns.length === 0)
      throw new Error(`${label}.columns must not be empty.`);
    const foreignKeys = (entry.foreignKeys ?? []).map((foreignKey, fkIndex) => {
      const fkLabel = `${label}.foreignKeys[${fkIndex}]`;
      object(foreignKey, fkLabel);
      keys(foreignKey, ["columns", "references"], fkLabel);
      if (
        !Array.isArray(foreignKey.columns) ||
        foreignKey.columns.length === 0
      ) {
        throw new Error(`${fkLabel}.columns must not be empty.`);
      }
      object(foreignKey.references, `${fkLabel}.references`);
      keys(
        foreignKey.references,
        ["schema", "table", "columns"],
        `${fkLabel}.references`,
      );
      if (
        !Array.isArray(foreignKey.references.columns) ||
        foreignKey.references.columns.length !== foreignKey.columns.length
      ) {
        throw new Error(
          `${fkLabel}.references.columns must match the local columns.`,
        );
      }
      return Object.freeze({
        columns: Object.freeze(
          foreignKey.columns.map((column) =>
            id(column, `${fkLabel}.columns[]`),
          ),
        ),
        references: Object.freeze({
          schema: id(
            foreignKey.references.schema,
            `${fkLabel}.references.schema`,
          ),
          table: id(foreignKey.references.table, `${fkLabel}.references.table`),
          columns: Object.freeze(
            foreignKey.references.columns.map((column) =>
              id(column, `${fkLabel}.references.columns[]`),
            ),
          ),
        }),
      });
    });
    const policies = (entry.policies ?? []).map((rowPolicy, policyIndex) => {
      const policyLabel = `${label}.policies[${policyIndex}]`;
      object(rowPolicy, policyLabel);
      keys(rowPolicy, ["name", "command", "roles"], policyLabel);
      if (
        !["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].includes(
          rowPolicy.command,
        )
      ) {
        throw new Error(`${policyLabel}.command is unsupported.`);
      }
      if (!Array.isArray(rowPolicy.roles) || rowPolicy.roles.length === 0) {
        throw new Error(`${policyLabel}.roles must not be empty.`);
      }
      return Object.freeze({
        name: id(rowPolicy.name, `${policyLabel}.name`),
        command: rowPolicy.command,
        roles: Object.freeze(
          rowPolicy.roles.map((role) => id(role, `${policyLabel}.roles[]`)),
        ),
      });
    });
    return Object.freeze({
      table: relation(entry.table, `${label}.table`),
      rowLevelSecurity: entry.rowLevelSecurity,
      columns: Object.freeze(
        entry.columns.map((column, columnIndex) => {
          const columnLabel = `${label}.columns[${columnIndex}]`;
          object(column, columnLabel);
          keys(column, ["name", "generated", "identity"], columnLabel);
          return Object.freeze({
            name: id(column.name, `${columnLabel}.name`),
            generated: column.generated === true,
            identity: column.identity === true,
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

export const buildRuntimePrerequisiteSql = (input) => {
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

export const buildRuntimePostSchemaSql = (input) => {
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

export const buildRuntimePreparationSql = (input) =>
  `${buildRuntimePrerequisiteSql(input)}${buildRuntimePostSchemaSql(input)}`;

export const buildRuntimeFinalizationSql = (input) => {
  const policy = validateRuntimePolicy(input);
  const statements = ["begin;"];
  if (policy.localRows.some((row) => row.identityAssociation)) {
    statements.push(IDENTITY_CLAIM_RECEIPT_SQL);
  }
  for (const row of policy.localRows) {
    const target = `${qid(row.table.schema)}.${qid(row.table.name)}`;
    const columns = Object.keys(row.values);
    statements.push(
      `insert into ${target} (${columns.map(qid).join(", ")})
select ${columns.map((name) => `restored.${qid(name)}`).join(", ")}
from jsonb_populate_record(null::${target}, ${literal(JSON.stringify(row.values))}::jsonb) restored
on conflict (${row.keyColumns.map(qid).join(", ")}) do nothing;`,
    );
  }
  statements.push("commit;");
  return `${statements.join("\n")}\n`;
};

export const buildRuntimeVerificationSql = (input) => {
  const policy = validateRuntimePolicy(input);
  const checks = [];
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
