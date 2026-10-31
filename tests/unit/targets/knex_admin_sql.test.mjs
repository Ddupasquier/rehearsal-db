import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [], fail: false, bound: true }));
vi.mock("node:child_process", () => ({
  spawnSync: (command, args, options) => {
    state.calls.push({ command, args, options });
    return {
      status: state.fail ? null : 0,
      error: state.fail ? Error("PRIVATE_TRANSPORT_CANARY") : undefined,
      stdout: state.fail ? "PRIVATE_SQL_OUTPUT" : "0",
      stderr: "PRIVATE_PROVIDER_CANARY",
    };
  },
}));
vi.mock("../../../dist/src/runtime/local_docker_context.mjs", () => ({
  runtimeDockerEnvironment: () =>
    state.bound
      ? {
          DOCKER_HOST: "unix:///owned/private.sock",
          DOCKER_CONFIG: "/owned/docker-config",
        }
      : {},
  scopedDockerEnvironment: ({ inheritedEnvironment, endpoint }) => ({
    ...inheritedEnvironment,
    DOCKER_HOST: endpoint,
  }),
}));
import {
  runKnexAdminSql,
  knexCommandBounds,
} from "../../../dist/src/targets/knex_admin_sql.mjs";
afterEach(() => {
  state.calls = [];
  state.fail = false;
  state.bound = true;
});
const options = {
  cwd: "/owned/project",
  containerId: "a".repeat(64),
  database: "postgres",
  user: "rehearsal",
  sql: "select 'PRIVATE_INPUT_CANARY';",
};
it("pins administrative probes to exact fullID/endpoint/config with transport and server bounds, no SQL in argv", () => {
  expect(runKnexAdminSql(options)).toBe("0");
  const call = state.calls[0];
  expect(call.args.slice(0, 4)).toEqual([
    "--host",
    "unix:///owned/private.sock",
    "exec",
    "--interactive",
  ]);
  expect(call.args).toContain(options.containerId);
  expect(call.args).toContain("--no-psqlrc");
  expect(call.args).toContain("--no-password");
  expect(call.args).toContain("PGCONNECT_TIMEOUT=2");
  expect(call.args).toContain(
    "PGOPTIONS=-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c idle_session_timeout=5000",
  );
  expect(call.options.env.DOCKER_CONFIG).toBe("/owned/docker-config");
  expect(call.options.timeout).toBe(7000);
  expect(call.options.input).toBe(options.sql);
  expect(call.args.join(" ")).not.toContain("PRIVATE_INPUT_CANARY");
});
it("refuses missing runtime binding, oversized SQL and failed transport without leaking provider text", () => {
  state.bound = false;
  expect(() => runKnexAdminSql(options)).toThrow(/withheld/);
  expect(state.calls).toEqual([]);
  state.bound = true;
  expect(() =>
    runKnexAdminSql({ ...options, sql: "x".repeat(65537) }),
  ).toThrow();
  state.fail = true;
  let error;
  try {
    runKnexAdminSql(options);
  } catch (e) {
    error = e;
  }
  expect(String(error)).not.toContain("PRIVATE_");
  expect(error.cause).toBeUndefined();
});
it("adds bounds only to selected Knex Docker commands and preserves existing PostgreSQL stop grace", () => {
  expect(knexCommandBounds("prisma", ["inspect", "owned"])).toEqual({});
  expect(knexCommandBounds(undefined, ["exec"])).toEqual({});
  expect(
    knexCommandBounds("knex", [
      "--host",
      "unix:///owned",
      "container",
      "inspect",
      "owned",
    ]),
  ).toEqual({ timeoutMs: 5000 });
  expect(knexCommandBounds("knex", ["stop", "--time", "10", "owned"])).toEqual({
    timeoutMs: 45000,
  });
  expect(knexCommandBounds("knex", ["exec", "owned", "psql"])).toEqual({});
});

it("pins catalog-only startup independently of ambient PostgreSQL startup options", () => {
  const before = process.env.PGOPTIONS;
  process.env.PGOPTIONS =
    "-c search_path=public -c session_preload_libraries=attacker";
  try {
    runKnexAdminSql(options);
    const args = state.calls[0].args;
    const startup = args.filter((value) => value.startsWith("PGOPTIONS="));
    expect(startup).toHaveLength(1);
    expect(startup[0]).toContain("search_path=pg_catalog ");
    expect(startup[0]).not.toContain("public");
    expect(startup[0]).not.toContain("attacker");
    expect(args).toContain("--no-psqlrc");
  } finally {
    if (before === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = before;
  }
});
