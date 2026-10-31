/** Bounded administrative metadata/credential queries; no raw SQL or provider errors escape. */
import { spawnSync } from "node:child_process";
import {
  runtimeDockerEnvironment,
  scopedDockerEnvironment,
} from "../runtime/local_docker_context.mjs";
export const knexCommandBounds = (
  kind: string | undefined,
  args: readonly string[],
): { timeoutMs?: number } => {
  if (kind !== "knex") return {};
  const a = args[0] === "--host" ? args.slice(2) : args;
  if (
    a[0] === "inspect" ||
    a[0] === "ps" ||
    (["container", "volume", "image"].includes(a[0] ?? "") &&
      ["inspect", "ls"].includes(a[1] ?? ""))
  )
    return { timeoutMs: 5000 };
  if (["run", "start", "stop"].includes(a[0] ?? ""))
    return { timeoutMs: 45000 };
  return {};
};
export const runKnexAdminSql = ({
  cwd,
  containerId,
  database,
  user,
  sql,
}: {
  cwd: string;
  containerId: string;
  database: string;
  user: string;
  sql: string;
}) => {
  const failure = () =>
    new Error(
      "Bounded owned Knex administrative query failed or timed out; SQL, credentials and provider output are withheld.",
    );
  const binding = runtimeDockerEnvironment(),
    endpoint = binding.DOCKER_HOST;
  if (
    !endpoint ||
    !/^[a-f0-9]{64}$/u.test(containerId) ||
    Buffer.byteLength(sql) > 65536
  )
    throw failure();
  const env = scopedDockerEnvironment({
    inheritedEnvironment: { ...process.env, ...binding },
    endpoint,
  });
  const result = spawnSync(
    "docker",
    [
      "--host",
      endpoint,
      "exec",
      "--interactive",
      "--env",
      "PGCONNECT_TIMEOUT=2",
      "--env",
      "PGOPTIONS=-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c idle_session_timeout=5000",
      containerId,
      "psql",
      "--no-psqlrc",
      "--no-password",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      user,
      "--dbname",
      database,
    ],
    {
      cwd,
      env,
      input: sql,
      encoding: "utf8",
      timeout: 7000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) throw failure();
  return result.stdout;
};
