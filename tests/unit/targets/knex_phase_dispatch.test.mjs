import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  phase: null,
  phases: [],
  reads: [],
  events: [],
  rows: [],
  replayFailure: false,
}));
vi.mock("../../../dist/src/targets/knex_restricted_role.mjs", () => ({
  withKnexRestrictedRole: async ({ phase = "worker", work }) => {
    const before = state.phase;
    if (before === phase) return work();
    state.phase = phase;
    state.phases.push(phase);
    state.events.push(`open:${phase}`);
    try {
      return await work();
    } finally {
      state.events.push(`close:${phase}`);
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
  currentKnexSqlSignal: () =>
    state.phase ? new AbortController().signal : undefined,
}));
vi.mock("../../../dist/src/targets/knex_restricted_sql.mjs", () => ({
  runKnexRestrictedSql: (options) => {
    state.reads.push(options);
    return JSON.stringify(state.rows);
  },
}));
vi.mock("../../../dist/src/runtime/knex_toolchain.mjs", () => ({
  inspectKnexToolchain: async () => ({ sha256: "a".repeat(64) }),
}));
vi.mock("../../../dist/src/runtime/knex_history.mjs", async (original) => ({
  ...(await original()),
  readKnexMigrationInventory: async () => ({ entries: currentFiles }),
}));
vi.mock("../../../dist/src/targets/knex_migration_process.mjs", () => ({
  deployKnexMigrations: async () => {
    const { withKnexRestrictedRole } =
      await import("../../../dist/src/targets/knex_restricted_role.mjs");
    await withKnexRestrictedRole({
      phase: "worker",
      work: async () => {
        expect(state.phase).toBe("worker");
        state.events.push("native-replay");
        if (state.replayFailure) throw Error("Synthetic replay failed");
      },
    });
  },
}));
import { createHash } from "node:crypto";
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
  state.events = [];
  state.rows = [];
  state.replayFailure = false;
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

it("finishes native replay worker authentication before opening verification as a sibling", async () => {
  const codeFiles = [
    { filename: "001_initial.cjs", fileSha256: "d".repeat(64), bytes: 1 },
  ];
  const nativeMigrations = {
    schemaVersion: 1,
    kind: "knex",
    version: "3.3.0",
    driver: "pg",
    driverVersion: "8.23.1",
    provider: "postgresql",
    bundleSha256: createHash("sha256")
      .update(JSON.stringify(codeFiles))
      .digest("hex"),
    toolchainSha256: "a".repeat(64),
    isolationPolicySha256: "b".repeat(64),
    historicalFileChecksums: "unavailable",
    ledger: { schema: "public", table: "knex_migrations" },
    codeFiles,
  };
  state.rows = [
    {
      id: 1,
      name: "001_initial.cjs",
      batch: 1,
      migration_time: "2026-01-01T00:00:00.000Z",
    },
  ];
  await runtime().restore(
    { nativeMigrations, migrations: {} },
    "/owned/migrations",
    "postgresql://unconsumed",
    () => {
      expect(state.phase).toBe("worker");
      state.events.push("schema-prerequisites");
    },
  );
  expect(state.events).toEqual([
    "open:worker",
    "schema-prerequisites",
    "native-replay",
    "close:worker",
    "open:verify",
    "close:verify",
  ]);
  expect(state.phase).toBeNull();
  expect(state.reads[0].credentials.user).toMatch(/_verify$/);
});

it("does not enter verification when native replay fails, and leaves no active worker scope", async () => {
  state.replayFailure = true;
  const codeFiles = [
    { filename: "001_initial.cjs", fileSha256: "d".repeat(64), bytes: 1 },
  ];
  const nativeMigrations = {
    schemaVersion: 1,
    kind: "knex",
    version: "3.3.0",
    driver: "pg",
    driverVersion: "8.23.1",
    provider: "postgresql",
    bundleSha256: createHash("sha256")
      .update(JSON.stringify(codeFiles))
      .digest("hex"),
    toolchainSha256: "a".repeat(64),
    isolationPolicySha256: "b".repeat(64),
    historicalFileChecksums: "unavailable",
    ledger: { schema: "public", table: "knex_migrations" },
    codeFiles,
  };
  await expect(
    runtime().restore(
      { nativeMigrations, migrations: {} },
      "/owned/migrations",
      "postgresql://unconsumed",
    ),
  ).rejects.toThrow("Synthetic replay failed");
  expect(state.events).toEqual([
    "open:worker",
    "native-replay",
    "close:worker",
  ]);
  expect(state.phase).toBeNull();
  expect(state.reads).toEqual([]);
});

it.each(["worker", "restore", "verify", "application", "application_query"])(
  "refuses reset restore nested inside %s before preparation, SDK or verification",
  async (phase) => {
    state.phase = phase;
    const beforeReplay = vi.fn();
    await expect(
      runtime().restore(
        {},
        "/owned/migrations",
        "postgresql://unconsumed",
        beforeReplay,
      ),
    ).rejects.toThrow(
      "Knex reset schema restore requires an independent phase boundary; no preparation or replay was attempted.",
    );
    expect(beforeReplay).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
    expect(state.reads).toEqual([]);
    expect(state.phase).toBe(phase);
  },
);
