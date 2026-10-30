import { performance } from "node:perf_hooks";
import {
  readKnexApplicationCredential,
  writeKnexApplicationCredential,
} from "./knex_application_credential.mjs";
import {
  getOperationCancellationSignal,
  throwIfOperationCancelled,
} from "../shared/cancellation.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { KnexSqlPhase } from "./knex_role_receipt.mjs";
import type { KnexSqlCredentials } from "./knex_restricted_sql.mjs";
const phases = new AsyncLocalStorage<{
  phase: KnexSqlPhase;
  projectId: string;
  database: string;
  runtimeWorkdir: string;
  identity: string;
  generationId?: string;
  credentials: KnexSqlCredentials;
  signal: AbortSignal;
  deadline: number;
}>();
export const currentKnexSqlSignal = (): AbortSignal | undefined =>
  phases.getStore()?.signal;
export const currentKnexSqlRemainingMs = (): number => {
  const scope = phases.getStore();
  if (!scope) throw new Error("Restricted Knex phase required.");
  throwIfOperationCancelled();
  scope.signal.throwIfAborted();
  const remaining = scope.deadline - performance.now();
  if (remaining <= 0)
    throw new Error(
      "Restricted Knex phase deadline expired; dispatch is refused.",
    );
  return Math.ceil(remaining);
};
export const currentKnexSqlCredentials = (): KnexSqlCredentials => {
  const current = phases.getStore();
  if (!current)
    throw new Error(
      "Restricted Knex phase authentication is required; administrator fallback is refused.",
    );
  throwIfOperationCancelled();
  currentKnexSqlRemainingMs();
  return current.credentials;
};
import { withOperationCancellationShield } from "../shared/cancellation.mjs";
/** Native code receives only this schema-limited credential, never runtime administration. */
import { createHash, randomBytes } from "node:crypto";
import {
  readKnexRoleReceipt,
  isKnexSqlPhase,
  writeKnexRoleReceipt,
} from "./knex_role_receipt.mjs";
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const identifier = (s: string) => `"${s.replaceAll('"', '""')}"`;
const refused = () =>
  new Error(
    "Knex worker database privilege isolation is unavailable or unsafe; the owned target is retained.",
  );
export const knexRoleName = (
  projectId: string,
  phase: KnexSqlPhase = "worker",
) =>
  `rehearsal_knex_${createHash("sha256").update(projectId).digest("hex").slice(0, 16)}${phase === "worker" ? "" : "_" + phase}`;
export const withKnexRestrictedRole = async <T,>({
  projectId,
  phase = "worker",
  generationId,
  authenticateApplication,
  database,
  runtimeWorkdir,
  runSql,
  assertOwnedTarget,
  work,
}: {
  projectId: string;
  phase?: KnexSqlPhase;
  generationId?: string;
  authenticateApplication?: (credentials: KnexSqlCredentials) => void;
  database: string;
  runtimeWorkdir: string;
  runSql: (sql: string) => string;
  assertOwnedTarget: () => string;
  work: (credentials: {
    user: string;
    password: string;
    database: string;
  }) => Promise<T>;
}): Promise<T> => {
  if (!isKnexSqlPhase(phase)) throw refused();
  const active = phases.getStore();
  if (active) currentKnexSqlRemainingMs();
  if (
    active?.phase === phase &&
    active.projectId === projectId &&
    active.database === database &&
    active.runtimeWorkdir === runtimeWorkdir
  ) {
    if (
      assertOwnedTarget() !== active.identity ||
      (phase === "application" && generationId !== active.generationId)
    )
      throw refused();
    return work(currentKnexSqlCredentials());
  }
  const parent = getOperationCancellationSignal();
  const deadline = Math.min(
    performance.now() + 120000,
    active?.deadline ?? Infinity,
  );
  const phaseSignal = AbortSignal.any([
    AbortSignal.timeout(120000),
    ...(parent ? [parent] : []),
    ...(active ? [active.signal] : []),
  ]);
  let cleaning = false;
  const assertBudget = () => {
    throwIfOperationCancelled();
    phaseSignal.throwIfAborted();
    if (performance.now() >= deadline)
      throw new Error(
        "Restricted Knex phase deadline expired; dispatch is refused.",
      );
  };
  const name = knexRoleName(projectId, phase),
    role = identifier(name),
    db = identifier(database),
    identity = assertOwnedTarget();
  let password = randomBytes(32).toString("hex");
  const sql = (query: string) => {
    if (!cleaning) assertBudget();
    try {
      if (assertOwnedTarget() !== identity) throw refused();
      if (!cleaning) assertBudget();
      return runSql(query);
    } catch {
      throw refused();
    }
  };
  const check = () => {
    const raw = sql(
      `select pg_catalog.json_build_object('roles', (select pg_catalog.count(*) from pg_catalog.pg_roles where rolname=${literal(name)} and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolinherit),'memberships',(select pg_catalog.count(*) from pg_catalog.pg_auth_members where member=(select oid from pg_catalog.pg_roles where rolname=${literal(name)})),'definers',(select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where p.prosecdef and pg_catalog.has_function_privilege(${literal(name)},p.oid,'EXECUTE')),'extensions',(select pg_catalog.count(*) from pg_catalog.pg_extension where extname<>'plpgsql'),'foreignServers',(select pg_catalog.count(*) from pg_catalog.pg_foreign_server),'foreignWrappers',(select pg_catalog.count(*) from pg_catalog.pg_foreign_data_wrapper),'unsafeFunctions',(select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace join pg_catalog.pg_language l on l.oid=p.prolang where pg_catalog.has_function_privilege(${literal(name)},p.oid,'EXECUTE') and ((n.nspname not in ('pg_catalog','information_schema') and not l.lanpltrusted) or p.proname in ('pg_read_file','pg_read_binary_file','pg_ls_dir','pg_stat_file','lo_import','lo_export','pg_file_write','pg_file_rename','pg_file_unlink','pg_file_sync','pg_write_file','pg_reload_conf'))),'databaseCreate',pg_catalog.has_database_privilege(${literal(name)},pg_catalog.current_database(),'CREATE'),'schemaCreate',pg_catalog.has_schema_privilege(${literal(name)},'public','CREATE'))::text;`,
    );
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      throw refused();
    }
    if (
      r.roles !== 1 ||
      r.memberships !== 0 ||
      r.definers !== 0 ||
      r.extensions !== 0 ||
      r.foreignServers !== 0 ||
      r.foreignWrappers !== 0 ||
      r.unsafeFunctions !== 0 ||
      r.databaseCreate !== false ||
      (phase !== "worker" && r.schemaCreate !== false)
    )
      throw refused();
  };
  const receipt = await readKnexRoleReceipt(runtimeWorkdir, phase);
  const observe = () => {
    let r;
    try {
      r = JSON.parse(
        sql(
          `select pg_catalog.json_build_object('systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()),'databaseOid',(select oid::bigint from pg_catalog.pg_database where datname=pg_catalog.current_database()),'roleOid',(select oid::bigint from pg_catalog.pg_roles where rolname=${literal(name)}))::text;`,
        ),
      );
    } catch {
      throw refused();
    }
    if (
      typeof r.systemIdentifier !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(r.systemIdentifier) ||
      !Number.isSafeInteger(r.databaseOid) ||
      r.databaseOid <= 0 ||
      (r.roleOid !== null &&
        (!Number.isSafeInteger(r.roleOid) || r.roleOid <= 0))
    )
      throw refused();
    return r as {
      systemIdentifier: string;
      databaseOid: number;
      roleOid: number | null;
    };
  };
  const before = observe();
  if (
    before.roleOid !== null &&
    (!receipt ||
      receipt.projectId !== projectId ||
      receipt.role !== name ||
      receipt.roleOid !== before.roleOid ||
      receipt.databaseOid !== before.databaseOid ||
      receipt.systemIdentifier !== before.systemIdentifier)
  )
    throw refused();
  if (before.roleOid === null && receipt) throw refused();
  const applicationCredential =
    phase === "application"
      ? await readKnexApplicationCredential(runtimeWorkdir)
      : null;
  const reusingApplication = phase === "application" && before.roleOid !== null;
  if (phase === "application") {
    if (
      !generationId ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(generationId) ||
      !authenticateApplication
    )
      throw refused();
    if (reusingApplication) {
      if (
        !applicationCredential ||
        applicationCredential.projectId !== projectId ||
        applicationCredential.generationId !== generationId ||
        applicationCredential.role !== name ||
        applicationCredential.roleOid !== before.roleOid ||
        applicationCredential.databaseOid !== before.databaseOid ||
        applicationCredential.systemIdentifier !== before.systemIdentifier ||
        applicationCredential.database !== database
      )
        throw refused();
      password = applicationCredential.password;
    } else if (applicationCredential) throw refused();
  }

  if (
    before.roleOid !== null &&
    phase !== "application" &&
    sql(
      `select pg_catalog.count(*)::text from pg_catalog.pg_authid where oid=${before.roleOid} and not rolcanlogin and rolpassword is null and not exists (select 1 from pg_catalog.pg_stat_activity where usename=${literal(name)});`,
    ).trim() !== "1"
  )
    throw refused();
  let completed = false;
  let created = false,
    ownedOid: number | null = before.roleOid,
    failed: unknown;

  try {
    if (before.roleOid === null) {
      sql(
        `create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;`,
      );
      created = true;
      const fresh = observe();
      if (
        fresh.systemIdentifier !== before.systemIdentifier ||
        fresh.databaseOid !== before.databaseOid ||
        fresh.roleOid === null
      )
        throw refused();
      ownedOid = fresh.roleOid;
      await writeKnexRoleReceipt(
        runtimeWorkdir,
        {
          schemaVersion: 1,
          kind: "knex-restricted-role",
          projectId,
          role: name,
          roleOid: ownedOid,
          databaseOid: fresh.databaseOid,
          systemIdentifier: fresh.systemIdentifier,
        },
        phase,
      );
    }
    if (
      sql(
        `select pg_catalog.has_parameter_privilege(${literal(name)}, 'session_replication_role', 'SET')::text;`,
      ).trim() !== "f"
    )
      throw refused();
    check(); // Inspect unsafe effective PUBLIC privileges; never rewrite application ACLs.
    sql(
      `grant connect, temporary on database ${db} to ${role}; grant usage${phase === "worker" ? ", create" : ""} on schema public to ${role};`,
    );
    if (phase !== "worker")
      sql(
        `grant ${phase === "verify" ? "select" : phase === "application" || phase === "application_query" ? "select, insert, update, delete" : "select, insert, update, delete, truncate, references"} on all tables in schema public to ${role}; grant ${phase === "verify" ? "select" : phase === "restore" ? "usage, select, update" : "usage, select"} on all sequences in schema public to ${role};`,
      );
    if (phase === "restore") {
      sql(`grant set on parameter session_replication_role to ${role};`);
      if (
        sql(
          `select pg_catalog.has_parameter_privilege(${literal(name)}, 'session_replication_role', 'SET')::text;`,
        ).trim() !== "t"
      )
        throw refused();
    }
    if (!reusingApplication) {
      if (phase === "application") {
        if (ownedOid === null || !generationId) throw refused();
        await writeKnexApplicationCredential(runtimeWorkdir, {
          schemaVersion: 1,
          kind: "knex-application-credential",
          projectId,
          generationId,
          role: name,
          roleOid: ownedOid,
          databaseOid: before.databaseOid,
          systemIdentifier: before.systemIdentifier,
          database,
          password,
        });
      }
      sql(
        `set log_statement='none'; set log_min_error_statement='panic'; set log_parameter_max_length_on_error=0; alter role ${role} login password ${literal(password)}; alter role ${role} set statement_timeout='120s'; alter role ${role} set lock_timeout='10s'; alter role ${role} set idle_in_transaction_session_timeout='10s';`,
      );
    }
    const credentials = { user: name, password, database };
    const result = await phases.run(
      {
        phase,
        ...(generationId ? { generationId } : {}),
        projectId,
        database,
        runtimeWorkdir,
        identity,
        credentials,
        signal: phaseSignal,
        deadline,
      },
      () => {
        currentKnexSqlRemainingMs();
        if (phase === "application") authenticateApplication!(credentials);
        currentKnexSqlRemainingMs();
        return work(credentials);
      },
    );
    assertBudget();
    check();
    completed = true;
    return result;
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    cleaning = true;
    await withOperationCancellationShield(async () => {
      try {
        const fresh = observe();
        if (
          ownedOid === null ||
          fresh.roleOid !== ownedOid ||
          fresh.databaseOid !== before.databaseOid ||
          fresh.systemIdentifier !== before.systemIdentifier
        )
          throw refused();
        // Exact OID + cluster/database proof precedes every credential/session mutation.
        if (!created) {
          const current = await readKnexRoleReceipt(runtimeWorkdir, phase);
          if (!current || JSON.stringify(current) !== JSON.stringify(receipt))
            throw refused();
        }
        if (phase === "restore") {
          sql(`revoke set on parameter session_replication_role from ${role};`);
          if (
            sql(
              `select pg_catalog.has_parameter_privilege(${literal(name)}, 'session_replication_role', 'SET')::text;`,
            ).trim() !== "f"
          )
            throw refused();
        }
        if (phase === "application" && (completed || reusingApplication))
          return;
        sql(
          `alter role ${role} nologin password null; select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename=${literal(name)} and datname=pg_catalog.current_database() and pid<>pg_catalog.pg_backend_pid();`,
        );
        if (
          sql(
            `select pg_catalog.count(*)::text from pg_catalog.pg_stat_activity where usename=${literal(name)} and datname=pg_catalog.current_database();`,
          ).trim() !== "0"
        )
          throw refused();
      } catch {
        throw new AggregateError(
          failed ? [failed] : [],
          "Knex restricted-role cleanup is unconfirmed; the data volume and recovery state are retained.",
        );
      }
    });
  }
};
