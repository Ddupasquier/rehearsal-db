import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ phase: null, phases: [], reads: [] }));
vi.mock("../../../dist/src/targets/knex_restricted_role.mjs", () => ({
  withKnexRestrictedRole: async ({ phase, work }) => {
    const before = state.phase;
    state.phase = phase;
    state.phases.push(phase);
    try {
      return await work();
    } finally {
      state.phase = before;
    }
  },
  currentKnexSqlCredentials: () => {
    if (!state.phase) throw Error("No authenticated phase");
    return {
      user: "rehearsal_knex_" + "a".repeat(16) + "_" + state.phase,
      password: "b".repeat(64),
      database: "owned",
    };
  },
  currentKnexSqlSignal: () => undefined,
}));
vi.mock("../../../dist/src/targets/knex_restricted_sql.mjs", () => ({
  runKnexRestrictedSql: (options) => {
    state.reads.push(options);
    return "[]";
  },
}));
import { createPostgresqlMigrationRuntime } from "../../../dist/src/targets/postgresql_migrations.mjs";
const currentFiles = [
  {
    nativeIdentity: { kind: "knex", name: "001_initial.cjs" },
    filename: "001_initial.cjs",
    name: "001_initial.cjs",
    fileSha256: "d".repeat(64),
  },
];
const runtime = () =>
  createPostgresqlMigrationRuntime({
    loaded: {
      projectRoot: "/owned",
      config: {
        runtime: { projectId: "owned-project" },
        postgresql: { migrationTool: { kind: "knex" } },
      },
      paths: { runtimeWorkdir: "/owned/runtime" },
    },
    runSql: () => {
      throw Error("Administrative SQL must not read this ledger");
    },
    assertOwnedTarget: () => "c".repeat(64),
    assertExpectedBaseline: async () => {},
    containerName: "owned",
    database: "owned",
    databaseUser: "postgres",
  });
afterEach(() => {
  state.phase = null;
  state.phases = [];
  state.reads = [];
});
it("reads migration-owned ledger objects through the authenticated verification transport", async () => {
  const migration = runtime();
  const result = await migration.withRestrictedPhase("verify", () =>
    migration.verifyLedger({ currentFiles, baseline: { migrations: {} } }),
  );
  expect(result.appliedCandidateCount).toBe(0);
  expect(state.phases).toEqual(["verify"]);
  expect(state.reads).toHaveLength(1);
  expect(state.reads[0].credentials.user).toMatch(/_verify$/);
  expect(state.reads[0].sql).toContain("public.knex_migrations");
});
it("refuses ledger evaluation without a phase instead of falling back to administration", () => {
  expect(() =>
    runtime().verifyLedger({ currentFiles, baseline: { migrations: {} } }),
  ).toThrow(/ledger is unavailable/);
  expect(state.reads).toEqual([]);
});
