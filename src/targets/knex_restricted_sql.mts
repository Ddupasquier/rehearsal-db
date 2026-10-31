import {
  currentKnexSqlSignal,
  currentKnexSqlRemainingMs,
} from "./knex_restricted_role.mjs";
import { throwIfOperationCancelled } from "../shared/cancellation.mjs";
/** Independently authenticated transport for evaluating migration-owned SQL. */
import { spawnSync } from "node:child_process";
import {
  runtimeDockerEnvironment,
  scopedDockerEnvironment,
} from "../runtime/local_docker_context.mjs";

export interface KnexSqlCredentials {
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

const refused = () =>
  new Error(
    "Restricted Knex SQL authentication, target or execution could not be verified; private SQL and provider output are withheld.",
  );

/** Shared by bounded queries and the streaming restore owner. No SET ROLE. */
export const knexRestrictedSqlInvocation = ({
  containerId,
  credentials,
  stream = false,
}: {
  readonly stream?: boolean;
  readonly containerId: string;
  readonly credentials: KnexSqlCredentials;
}) => {
  const binding = runtimeDockerEnvironment();
  const endpoint = binding.DOCKER_HOST;
  if (
    !endpoint ||
    !/^[a-f0-9]{64}$/u.test(containerId) ||
    !/^rehearsal_knex_[a-f0-9]{16}(?:_restore|_verify|_application|_application_query)?$/u.test(
      credentials.user,
    ) ||
    (stream && !credentials.user.endsWith("_restore")) ||
    !/^[a-f0-9]{64}$/u.test(credentials.password) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(credentials.database)
  )
    throw refused();
  return {
    command: "docker",
    args: [
      "--host",
      endpoint,
      "exec",
      "--interactive",
      // Forward from the private process environment, never put a password in argv.
      "--env",
      "PGPASSWORD",
      "--env",
      "PGCONNECT_TIMEOUT=2",
      "--env",
      `PGOPTIONS=-c statement_timeout=${stream ? 120000 : 5000} -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000 -c search_path=pg_catalog,public`,
      containerId,
      "psql",
      "--no-psqlrc",
      "--no-password",
      // A Unix socket may use local trust/peer rules. Select the explicit TCP role.
      "--host=127.0.0.1",
      "--port=5432",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--set=ON_ERROR_STOP=1",
      "--username",
      credentials.user,
      "--dbname",
      credentials.database,
    ],
    environment: {
      ...scopedDockerEnvironment({
        inheritedEnvironment: { ...process.env, ...binding },
        endpoint,
      }),
      PGPASSWORD: credentials.password,
    },
  };
};

export const runKnexRestrictedSql = ({
  cwd,
  credentials,
  assertOwnedTarget,
  sql,
}: {
  readonly cwd: string;
  readonly credentials: KnexSqlCredentials;
  readonly assertOwnedTarget: () => string;
  readonly sql: string;
}): string => {
  throwIfOperationCancelled();
  if (
    Buffer.byteLength(sql) > 65536 ||
    (credentials.user.endsWith("_application") &&
      sql !== "select session_user;")
  )
    throw refused();
  const containerId = assertOwnedTarget();
  const invocation = knexRestrictedSqlInvocation({ containerId, credentials });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: invocation.environment,
    input: sql,
    encoding: "utf8",
    timeout: Math.min(
      7000,
      currentKnexSqlSignal() ? currentKnexSqlRemainingMs() : 7000,
    ),
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  throwIfOperationCancelled();
  currentKnexSqlSignal()?.throwIfAborted();
  if (currentKnexSqlSignal()) currentKnexSqlRemainingMs();
  if (
    result.error ||
    result.status !== 0 ||
    assertOwnedTarget() !== containerId
  )
    throw refused();
  if (currentKnexSqlSignal()) currentKnexSqlRemainingMs();
  return result.stdout;
};
