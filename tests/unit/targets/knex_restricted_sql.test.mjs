import * as phase from "../../../dist/src/targets/knex_restricted_role.mjs";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [], fail: false, bound: true }));
vi.mock("node:child_process", () => ({
  spawnSync: (command, args, options) => {
    state.calls.push({ command, args, options });
    return {
      status: state.fail ? null : 0,
      error: state.fail ? Error("PRIVATE_TRANSPORT") : undefined,
      stdout: state.fail ? "PRIVATE_SQL" : "restricted-result",
      stderr: "PRIVATE_PROVIDER",
    };
  },
}));
vi.mock("../../../dist/src/runtime/local_docker_context.mjs", () => ({
  runtimeDockerEnvironment: () =>
    state.bound ? { DOCKER_HOST: "unix:///owned/engine.sock" } : {},
  scopedDockerEnvironment: ({ endpoint }) => ({ DOCKER_HOST: endpoint }),
}));
import {
  knexRestrictedSqlInvocation,
  runKnexRestrictedSql,
} from "../../../dist/src/targets/knex_restricted_sql.mjs";
const credentials = {
  user: "rehearsal_knex_" + "a".repeat(16),
  password: "b".repeat(64),
  database: "owned",
};
const options = {
  cwd: "/owned/workspace",
  credentials,
  assertOwnedTarget: () => "c".repeat(64),
  sql: "select 'PRIVATE_INPUT';",
};
afterEach(() => {
  vi.restoreAllMocks();
  state.calls = [];
  state.fail = false;
  state.bound = true;
});
it("authenticates the restricted user over explicit TCP, without admin role switching or credential argv", () => {
  expect(runKnexRestrictedSql(options)).toBe("restricted-result");
  const { args, options: process } = state.calls[0];
  expect(args).toContain("--host=127.0.0.1");
  expect(args).toContain("--no-psqlrc");
  expect(args).toContain("--no-password");
  expect(args).toContain(credentials.user);
  expect(args).toContain("c".repeat(64));
  expect(args.join(" ")).not.toContain(credentials.password);
  expect(args.join(" ")).not.toContain("PRIVATE_INPUT");
  expect(process.env.PGPASSWORD).toBe(credentials.password);
  expect(process.input).toBe(options.sql);
  expect(process.timeout).toBe(7000);
});
it("refuses admin credentials and missing binding before dispatch", () => {
  expect(() =>
    knexRestrictedSqlInvocation({
      containerId: "c".repeat(64),
      credentials: { ...credentials, user: "postgres" },
    }),
  ).toThrow(/withheld/);
  state.bound = false;
  expect(() => runKnexRestrictedSql(options)).toThrow(/withheld/);
  expect(state.calls).toEqual([]);
});
it("retains failure confidentiality and refuses changed exact target identity", () => {
  state.fail = true;
  let error;
  try {
    runKnexRestrictedSql(options);
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).not.toContain("PRIVATE_");
  expect(error.cause).toBeUndefined();
  state.fail = false;
  let observations = 0;
  expect(() =>
    runKnexRestrictedSql({
      ...options,
      assertOwnedTarget: () => (++observations === 1 ? "c" : "d").repeat(64),
    }),
  ).toThrow(/withheld/);
});

it("permits streaming restore only with its distinct restore principal", () => {
  expect(() =>
    knexRestrictedSqlInvocation({
      containerId: "c".repeat(64),
      credentials,
      stream: true,
    }),
  ).toThrow(/withheld/);
  const invocation = knexRestrictedSqlInvocation({
    containerId: "c".repeat(64),
    credentials: { ...credentials, user: credentials.user + "_restore" },
    stream: true,
  });
  expect(invocation.args.join(" ")).toContain("statement_timeout=120000");
});

it("checks the explicit phase budget before spawning despite a non-aborted delayed timer", () => {
  const controller = new AbortController();
  vi.spyOn(phase, "currentKnexSqlSignal").mockReturnValue(controller.signal);
  vi.spyOn(phase, "currentKnexSqlRemainingMs").mockImplementation(() => {
    throw Error("phase deadline expired");
  });
  expect(() => runKnexRestrictedSql(options)).toThrow(/deadline expired/);
  expect(controller.signal.aborted).toBe(false);
  expect(state.calls).toEqual([]);
});

it("uses the parent budget through post-query validation even before the timer fires", () => {
  const controller = new AbortController();
  vi.spyOn(phase, "currentKnexSqlSignal").mockReturnValue(controller.signal);
  vi.spyOn(phase, "currentKnexSqlRemainingMs")
    .mockReturnValueOnce(2000)
    .mockReturnValueOnce(1000)
    .mockImplementation(() => {
      throw Error("phase deadline expired");
    });
  expect(() => runKnexRestrictedSql(options)).toThrow(/deadline expired/);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].options.timeout).toBe(2000);
  expect(controller.signal.aborted).toBe(false);
});

it("allows only the fixed authentication probe on a persistent application credential", () => {
  const app = { ...credentials, user: credentials.user + "_application" };
  expect(() =>
    runKnexRestrictedSql({
      ...options,
      credentials: app,
      sql: "select public.migration_owned_function();",
    }),
  ).toThrow(/withheld/);
  expect(state.calls).toEqual([]);
  expect(
    runKnexRestrictedSql({
      ...options,
      credentials: app,
      sql: "select session_user;",
    }),
  ).toBe("restricted-result");
});
