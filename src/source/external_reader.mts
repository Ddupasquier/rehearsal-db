/** Verify an externally provisioned PostgreSQL reader without source writes. */

import pg from "pg";
import { RehearsalError } from "../shared/diagnostics.mjs";
import { externalViewDefinitionFingerprint } from "./access.mjs";

const { Client } = pg;

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

interface ExternalReaderClient {
  connect?(): Promise<void> | void;
  query(query: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  end?(): Promise<void> | void;
}

interface ExternalReaderPlan {
  policy: {
    exportSchema: string;
    reader: {
      mode: string;
      role: string;
      allowedMemberships: readonly string[];
      maximumValidForMinutes: number;
    };
    migrationLedger: {
      schema: string;
      table: string;
      versionColumn: string;
      nameColumn: string;
      statementsColumn: string;
    };
    relations: readonly {
      view: string;
      columns: readonly string[];
      viewDefinitionSha256: string;
    }[];
  };
}

type ExternalReaderClientFactory = (
  connectionString: string,
) => ExternalReaderClient | Promise<ExternalReaderClient>;

const connect = async (
  connectionString: string,
  clientFactory?: ExternalReaderClientFactory,
): Promise<ExternalReaderClient> => {
  const client = clientFactory
    ? await clientFactory(connectionString)
    : new Client({
        connectionString,
        application_name: "rehearsal-external-source-verification",
      });
  if (typeof client.connect === "function") await client.connect();
  return client as unknown as ExternalReaderClient;
};

const columnKey = (schema: string, relation: string, column: string): string =>
  `${schema}\0${relation}\0${column}`;

const expectedReadableColumns = (plan: ExternalReaderPlan): Set<string> =>
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

const count = (result: QueryResultLike, label: string): number => {
  const value = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`External source reader ${label} check was inconclusive.`);
  }
  return value;
};

const sourceAuthorizationRefusal = ({
  message,
  expected,
  actual,
}: {
  message: string;
  expected: unknown;
  actual: unknown;
}): RehearsalError =>
  new RehearsalError({
    category: "unsafe_environment",
    code: "SOURCE_AUTHORIZATION_REFUSED",
    message,
    expected,
    actual,
    refused: "The external source credential was not activated or saved.",
    suggestions: [
      "Review sourcePolicy.reader and the database role grants, then preview source plan again.",
    ],
  });

export const verifyExternalPostgresqlReader = async ({
  plan,
  connectionString,
  clientFactory,
  now = new Date(),
}: {
  plan: ExternalReaderPlan;
  connectionString: string;
  clientFactory?: ExternalReaderClientFactory;
  now?: Date;
}): Promise<Readonly<{ expiresAt: string }>> => {
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
      throw sourceAuthorizationRefusal({
        message:
          "External source credential does not authenticate as the reviewed login role.",
        expected: "the reviewed login role",
        actual: "a missing, different, or non-login role",
      });
    }
    if (
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.rolreplication ||
      role.rolbypassrls
    ) {
      throw sourceAuthorizationRefusal({
        message: "External source reader has privileged role attributes.",
        expected: "a non-privileged login role",
        actual: "one or more privileged role attributes",
      });
    }
    const expiresAt = new Date(String(role.rolvaliduntil));
    const maximumExpiration =
      now.valueOf() + plan.policy.reader.maximumValidForMinutes * 60_000;
    if (
      !Number.isFinite(expiresAt.valueOf()) ||
      expiresAt.valueOf() <= now.valueOf() ||
      expiresAt.valueOf() > maximumExpiration
    ) {
      throw sourceAuthorizationRefusal({
        message:
          "External source reader must have a future database-enforced expiration within the reviewed limit.",
        expected: `a future expiration within ${plan.policy.reader.maximumValidForMinutes} minutes`,
        actual: "an absent, expired, or overly long expiration",
      });
    }

    const memberships = await client.query(
      `select granted.rolname as role, granted.rolcanlogin,
              granted.rolsuper, granted.rolcreaterole, granted.rolcreatedb,
              granted.rolreplication, granted.rolbypassrls,
              membership.admin_option,
              coalesce(
                (to_jsonb(membership) ->> 'inherit_option')::boolean,
                member.rolinherit
              ) as inherit_option,
              coalesce(
                (to_jsonb(membership) ->> 'set_option')::boolean,
                true
              ) as set_option
       from pg_auth_members membership
       join pg_roles member on member.oid = membership.member
       join pg_roles granted on granted.oid = membership.roleid
       where member.rolname = current_user
       order by granted.rolname`,
    );
    const expectedMemberships = [
      ...plan.policy.reader.allowedMemberships,
    ].sort();
    const actualMemberships = memberships.rows
      .map((membership) => String(membership.role))
      .sort();
    if (
      actualMemberships.length !== expectedMemberships.length ||
      actualMemberships.some(
        (membership, index) => membership !== expectedMemberships[index],
      )
    ) {
      throw sourceAuthorizationRefusal({
        message:
          "External source reader role memberships do not exactly match the reviewed allowlist.",
        expected: expectedMemberships,
        actual: actualMemberships,
      });
    }
    for (const membership of memberships.rows) {
      if (
        membership.rolcanlogin ||
        membership.rolsuper ||
        membership.rolcreaterole ||
        membership.rolcreatedb ||
        membership.rolreplication ||
        membership.rolbypassrls ||
        membership.admin_option ||
        membership.inherit_option !== true ||
        membership.set_option !== false
      ) {
        throw sourceAuthorizationRefusal({
          message:
            "External source reader has an unsafe reviewed role membership.",
          expected:
            "a non-login, non-privileged group with inheritance enabled and role switching and delegation disabled",
          actual: `unsafe membership options for ${String(membership.role)}`,
        });
      }
    }
    if (expectedMemberships.length > 0) {
      const nestedMemberships = await client.query(
        `select count(*)::integer as count
         from pg_auth_members direct_membership
         join pg_roles direct_role
           on direct_role.oid = direct_membership.roleid
         join pg_auth_members nested_membership
           on nested_membership.member = direct_membership.roleid
         join pg_roles member on member.oid = direct_membership.member
         where member.rolname = current_user
           and direct_role.rolname = any($1::name[])`,
        [expectedMemberships],
      );
      if (count(nestedMemberships, "nested role membership") !== 0) {
        throw sourceAuthorizationRefusal({
          message:
            "An allowed external source group inherits another database role.",
          expected: "no nested role memberships",
          actual: "one or more nested memberships",
        });
      }
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
      throw sourceAuthorizationRefusal({
        message:
          "External source reader has database write or sequence privileges.",
        expected:
          "no database, schema, relation, column, or sequence write access",
        actual: "one or more disallowed effective privileges",
      });
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
        columnKey(String(row.schema), String(row.relation), String(row.column)),
      ),
    );
    if (
      actual.size !== expected.size ||
      [...actual].some((entry) => !expected.has(entry))
    ) {
      throw sourceAuthorizationRefusal({
        message:
          "External source reader's readable columns do not exactly match the reviewed export surface.",
        expected: `${expected.size} reviewed readable columns`,
        actual: `${actual.size} effective readable columns`,
      });
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
      if (
        [
          plan.policy.reader.role,
          ...plan.policy.reader.allowedMemberships,
        ].includes(String(actual.owner))
      ) {
        throw sourceAuthorizationRefusal({
          message: "External source reader roles must not own an export view.",
          expected: "a separate non-reader view owner",
          actual: "the login or an allowed membership owns a reviewed view",
        });
      }
      if (
        externalViewDefinitionFingerprint(String(actual.definition)) !==
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
      throw sourceAuthorizationRefusal({
        message:
          "External source reader can execute a non-system security-definer function.",
        expected: "no executable non-system security-definer functions",
        actual: "one or more executable security-definer functions",
      });
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
