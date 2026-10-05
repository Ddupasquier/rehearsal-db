/** Verify an externally provisioned PostgreSQL reader without source writes. */

import pg from "pg";
import { externalViewDefinitionFingerprint } from "./access.mjs";

const { Client } = pg;

const connect = async (connectionString, clientFactory) => {
  const client = clientFactory
    ? await clientFactory(connectionString)
    : new Client({
        connectionString,
        application_name: "rehearsal-external-source-verification",
      });
  if (typeof client.connect === "function") await client.connect();
  return client;
};

const columnKey = (schema, relation, column) =>
  `${schema}\0${relation}\0${column}`;

const expectedReadableColumns = (plan) =>
  new Set([
    ...plan.policy.relations.flatMap((relation) =>
      relation.columns.map((column) =>
        columnKey(plan.policy.exportSchema, relation.view, column),
      ),
    ),
    ...[
      plan.policy.migrationLedger.versionColumn,
      plan.policy.migrationLedger.nameColumn,
      plan.policy.migrationLedger.statementsColumn,
    ].map((column) =>
      columnKey(
        plan.policy.migrationLedger.schema,
        plan.policy.migrationLedger.table,
        column,
      ),
    ),
  ]);

const count = (result, label) => {
  const value = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`External source reader ${label} check was inconclusive.`);
  }
  return value;
};

export const verifyExternalPostgresqlReader = async ({
  plan,
  connectionString,
  clientFactory,
  now = new Date(),
}) => {
  if (plan.policy.reader.mode !== "external") {
    throw new Error("External reader verification requires external mode.");
  }
  const client = await connect(connectionString, clientFactory);
  let transactionOpen = false;
  try {
    await client.query("begin transaction read only");
    transactionOpen = true;
    const roleResult = await client.query(
      `select rolname as role, rolcanlogin, rolvaliduntil,
              rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
       from pg_roles where rolname = current_user`,
    );
    const role = roleResult.rows[0];
    if (!role || role.role !== plan.policy.reader.role || !role.rolcanlogin) {
      throw new Error(
        "External source credential does not authenticate as the reviewed login role.",
      );
    }
    if (
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.rolreplication ||
      role.rolbypassrls
    ) {
      throw new Error("External source reader has privileged role attributes.");
    }
    const expiresAt = new Date(role.rolvaliduntil);
    const maximumExpiration =
      now.valueOf() + plan.policy.reader.maximumValidForMinutes * 60_000;
    if (
      !Number.isFinite(expiresAt.valueOf()) ||
      expiresAt.valueOf() <= now.valueOf() ||
      expiresAt.valueOf() > maximumExpiration
    ) {
      throw new Error(
        "External source reader must have a future database-enforced expiration within the reviewed limit.",
      );
    }

    const memberships = await client.query(
      `select count(*)::integer as count
       from pg_auth_members membership
       join pg_roles member on member.oid = membership.member
       where member.rolname = current_user`,
    );
    if (count(memberships, "role membership") !== 0) {
      throw new Error(
        "External source reader belongs to another database role.",
      );
    }

    const databaseWrites = await client.query(
      `select count(*)::integer as count
       where has_database_privilege(current_user, current_database(), 'CREATE')`,
    );
    const schemaWrites = await client.query(
      `select count(*)::integer as count
       from pg_namespace
       where nspname not like 'pg_temp_%'
         and has_schema_privilege(current_user, oid, 'CREATE')`,
    );
    const relationWrites = await client.query(
      `select count(*)::integer as count
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname not in ('pg_catalog', 'information_schema')
         and relation.relkind in ('r', 'p', 'v', 'm', 'f')
         and (has_table_privilege(current_user, relation.oid, 'INSERT')
           or has_table_privilege(current_user, relation.oid, 'UPDATE')
           or has_table_privilege(current_user, relation.oid, 'DELETE')
           or has_table_privilege(current_user, relation.oid, 'TRUNCATE')
           or has_table_privilege(current_user, relation.oid, 'REFERENCES')
           or has_table_privilege(current_user, relation.oid, 'TRIGGER'))`,
    );
    const columnWrites = await client.query(
      `select count(*)::integer as count
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       join pg_attribute attribute on attribute.attrelid = relation.oid
       where namespace.nspname not in ('pg_catalog', 'information_schema')
         and relation.relkind in ('r', 'p', 'v', 'm', 'f')
         and attribute.attnum > 0 and not attribute.attisdropped
         and (has_column_privilege(current_user, relation.oid, attribute.attnum, 'INSERT')
           or has_column_privilege(current_user, relation.oid, attribute.attnum, 'UPDATE')
           or has_column_privilege(current_user, relation.oid, attribute.attnum, 'REFERENCES'))`,
    );
    const sequenceAccess = await client.query(
      `select count(*)::integer as count
       from pg_class sequence
       join pg_namespace namespace on namespace.oid = sequence.relnamespace
       where namespace.nspname not in ('pg_catalog', 'information_schema')
         and sequence.relkind = 'S'
         and (has_sequence_privilege(current_user, sequence.oid, 'SELECT')
           or has_sequence_privilege(current_user, sequence.oid, 'USAGE')
           or has_sequence_privilege(current_user, sequence.oid, 'UPDATE'))`,
    );
    if (
      [
        databaseWrites,
        schemaWrites,
        relationWrites,
        columnWrites,
        sequenceAccess,
      ].some((result) => count(result, "write or sequence privilege") !== 0)
    ) {
      throw new Error(
        "External source reader has database write or sequence privileges.",
      );
    }

    const readable = await client.query(
      `select namespace.nspname as schema, relation.relname as relation,
              attribute.attname as column
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       join pg_attribute attribute on attribute.attrelid = relation.oid
       where namespace.nspname not in ('pg_catalog', 'information_schema')
         and namespace.nspname not like 'pg_toast%'
         and relation.relkind in ('r', 'p', 'v', 'm', 'f')
         and attribute.attnum > 0 and not attribute.attisdropped
         and has_column_privilege(current_user, relation.oid, attribute.attnum, 'SELECT')
       order by namespace.nspname, relation.relname, attribute.attnum`,
    );
    const expected = expectedReadableColumns(plan);
    const actual = new Set(
      readable.rows.map((row) =>
        columnKey(row.schema, row.relation, row.column),
      ),
    );
    if (
      actual.size !== expected.size ||
      [...actual].some((entry) => !expected.has(entry))
    ) {
      throw new Error(
        "External source reader's readable columns do not exactly match the reviewed export surface.",
      );
    }

    for (const relation of plan.policy.relations) {
      const view = await client.query(
        `select pg_get_viewdef(relation.oid, false) as definition,
                relation.reloptions,
                owner.rolname as owner
         from pg_class relation
         join pg_namespace namespace on namespace.oid = relation.relnamespace
         join pg_roles owner on owner.oid = relation.relowner
         where namespace.nspname = $1 and relation.relname = $2
           and relation.relkind = 'v'`,
        [plan.policy.exportSchema, relation.view],
      );
      const actual = view.rows[0];
      if (!actual) {
        throw new Error("An externally reviewed export view is missing.");
      }
      if (
        !Array.isArray(actual.reloptions) ||
        !actual.reloptions.includes("security_barrier=true")
      ) {
        throw new Error(
          "External export views must enable PostgreSQL security_barrier.",
        );
      }
      if (actual.owner === plan.policy.reader.role) {
        throw new Error("External source reader must not own an export view.");
      }
      if (
        externalViewDefinitionFingerprint(actual.definition) !==
        relation.viewDefinitionSha256
      ) {
        throw new Error(
          "External export view definition does not match its reviewed fingerprint.",
        );
      }
    }

    const securityDefiners = await client.query(
      `select count(*)::integer as count
       from pg_proc procedure
       join pg_namespace namespace on namespace.oid = procedure.pronamespace
       where namespace.nspname not in ('pg_catalog', 'information_schema')
         and procedure.prosecdef
         and has_function_privilege(current_user, procedure.oid, 'EXECUTE')`,
    );
    if (count(securityDefiners, "security-definer function") !== 0) {
      throw new Error(
        "External source reader can execute a non-system security-definer function.",
      );
    }
    await client.query("rollback");
    transactionOpen = false;
    return Object.freeze({ expiresAt: expiresAt.toISOString() });
  } catch (error) {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end?.();
  }
};
