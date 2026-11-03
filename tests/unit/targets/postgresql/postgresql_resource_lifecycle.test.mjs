/** Actual driver operations with an injected provider; no engine, SQL or runtime. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUnitTemporaryDirectory } from "../../../helpers/unit_temporary_global.mjs";
const scenario = vi.hoisted(() => ({
  loaded: null,
  active: null,
  operations: null,
  run: null,
  startup: null,
  commandOptions: [],
}));
vi.mock("../../../../dist/src/project/configuration.mjs", () => ({
  loadRehearsalConfig: async () => scenario.loaded,
}));
vi.mock("../../../../dist/src/targets/target.mjs", () => ({
  parseRuntimeInvocation: () => ({ action: "reset" }),
}));
vi.mock(
  "../../../../dist/src/runtime/lifecycle/runtime_manager_guards.mjs",
  () => ({ guardRuntimeManagerAction: async () => {} }),
);
vi.mock(
  "../../../../dist/src/runtime/engines/local_docker_context.mjs",
  async (original) => ({
    ...(await original()),
    runtimeDockerEnvironment: () => ({
      DOCKER_HOST: "unix:///owned/engine.sock",
    }),
  }),
);
vi.mock(
  "../../../../dist/src/targets/postgresql/postgresql_process.mjs",
  async (original) => ({
    ...(await original()),
    runPostgresqlCommand: (_command, args, options) => {
      scenario.commandOptions.push({
        args: [...args],
        timeoutMs: options.timeoutMs,
      });
      return scenario.run(args);
    },
  }),
);
vi.mock("../../../../dist/src/targets/port_start_failure.mjs", () => ({
  runPostgresqlStartupCommand: (_run, args) => scenario.startup(args),
}));
vi.mock(
  "../../../../dist/src/targets/supabase/supabase_environment.mjs",
  async (original) => ({
    ...(await original()),
    ensureConfiguredContainerRuntime() {},
  }),
);
vi.mock("../../../../dist/src/runtime/lifecycle/baseline_identity.mjs", () => ({
  assertActiveBaselineUnchanged() {},
  assertNativeBaselineManifestUnchanged: async () => {},
}));
vi.mock(
  "../../../../dist/src/runtime/lifecycle/lifecycle_engine.mjs",
  async (original) => ({
    ...(await original()),
    readActiveRuntimeInput: async () => scenario.active,
    runRuntimeLifecycle: async ({ operations }) => {
      scenario.operations = operations;
    },
    // Separate maintained suites own reset recovery and retained-start data proofs.
    withOwnedRuntimeRollback: ({ operation }) => operation(),
  }),
);
vi.mock(
  "../../../../dist/src/targets/postgresql/postgresql_migrations.mjs",
  () => ({
    createPostgresqlMigrationRuntime: () => ({
      prepareMutation: async () => {},
      validateHistory: async () => {},
    }),
  }),
);
let root;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("REHEARSAL_DOCKER_DAEMON_ID", "owned-daemon");
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  vi.unstubAllEnvs();
});
const driver = async (kind = "knex") => {
  scenario.commandOptions = [];
  root = await createUnitTemporaryDirectory("postgresql-resource-lifecycle-");
  const runtime = join(root, "runtime"),
    environment = join(root, "application.env"),
    projectId = "owned-project",
    containerName = projectId + "-postgresql",
    volumeName = containerName + "-data",
    labels = { "com.rehearsal-db.project": projectId },
    calls = [];
  await mkdir(runtime);
  await writeFile(join(runtime, "recovery-canary"), "preserve");
  await writeFile(environment, "synthetic");
  const state = {
    daemon: "owned-daemon",
    inspectFailure: false,
    inventoryFailure: false,
    afterCreate: null,
    container: {
      name: "/" + containerName,
      id: "a".repeat(64),
      labels: { ...labels },
    },
    volume: {
      name: volumeName,
      createdAt: "2026-10-24T00:00:00Z",
      driver: "local",
      labels: { ...labels },
    },
  };
  scenario.loaded = {
    projectRoot: root,
    config: {
      postgresql: {
        image: "postgres:17-alpine",
        database: "postgres",
        user: "postgres",
        ...(kind === "sql" ? {} : { migrationTool: { kind } }),
      },
      runtime: { projectId, ports: { database: 55432 }, protected: false },
      resources: {},
    },
    paths: {
      artifactDirectory: root,
      runtimeWorkdir: runtime,
      applicationEnvironment: environment,
      sanitizationPolicy: join(root, "policy.json"),
      runtimeAdapter: null,
      runtimePolicy: null,
    },
  };
  scenario.active = {
    baseline: {
      generationId: "synthetic-generation",
      ...(kind === "sql" ? {} : { nativeMigrations: {} }),
    },
    paths: { migrationsDirectory: root },
  };
  scenario.startup = vi.fn(() => {
    throw Error("synthetic-stop-before-database-startup");
  });
  scenario.run = (args) => {
    calls.push([...args]);
    const kind = args[0],
      action = args[1];
    if (kind === "info")
      return { status: 0, stdout: JSON.stringify(state.daemon) };
    if (kind === "image" && action === "inspect")
      return { status: 0, stdout: "synthetic-image" };
    if (action === "inspect")
      return state.inspectFailure || !state[kind]
        ? { status: 1, stdout: "PRIVATE_PROVIDER_OUTPUT" }
        : { status: 0, stdout: JSON.stringify(state[kind]) };
    if (action === "ls")
      return {
        status: state.inventoryFailure ? 1 : 0,
        stdout:
          kind === "volume"
            ? state.volume
              ? volumeName + "\n"
              : ""
            : state.container
              ? state.container.id + "\t" + containerName + "\n"
              : "",
      };
    if (action === "rm") {
      state[kind] = null;
      return { status: 0, stdout: args.at(-1) };
    }
    if (kind === "volume" && action === "create") {
      state.volume = {
        name: volumeName,
        createdAt: "2026-11-03T00:00:00Z",
        driver: "local",
        labels: { ...labels },
      };
      state.afterCreate?.();
      return { status: 0, stdout: volumeName };
    }
    throw Error("Unallowlisted synthetic provider command");
  };
  await import("../../../../dist/src/targets/postgresql.mjs");
  return {
    state,
    calls,
    runtime,
    environment,
    operations: scenario.operations,
  };
};
it("actual discard preserves recovery files after failed inspection of a still-present target", async () => {
  const d = await driver();
  d.state.inspectFailure = true;
  await expect(d.operations.discard()).rejects.toThrow(/unverified/);
  expect(await readFile(join(d.runtime, "recovery-canary"), "utf8")).toBe(
    "preserve",
  );
  expect(await readFile(d.environment, "utf8")).toBe("synthetic");
  expect(d.calls.some((args) => args[1] === "rm")).toBe(false);
});
it("actual discard accepts proven absence without creating or deleting Docker resources", async () => {
  const d = await driver();
  d.state.container = d.state.volume = null;
  await d.operations.discard();
  await expect(
    readFile(join(d.runtime, "recovery-canary")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    d.calls.some((args) => ["rm", "create", "run"].includes(args[1])),
  ).toBe(false);
});
it("actual discard preserves metadata if the complete inventory is unavailable", async () => {
  const d = await driver();
  d.state.container = null;
  d.state.inventoryFailure = true;
  await expect(d.operations.discard()).rejects.toThrow(/unverified/);
  expect(await readFile(join(d.runtime, "recovery-canary"), "utf8")).toBe(
    "preserve",
  );
});
it.each(["knex", "sql", "prisma", "drizzle"])(
  "actual %s presence wiring forwards finite identity/inspect/inventory bounds to its transport",
  async (kind) => {
    const d = await driver(kind);
    d.state.container = d.state.volume = null;
    await d.operations.discard();
    expect(
      scenario.commandOptions.some((call) => call.args[0] === "info"),
    ).toBe(true);
    expect(
      new Set(
        scenario.commandOptions
          .filter((call) => call.args[1] === "ls")
          .map((call) => call.args[0]),
      ),
    ).toEqual(new Set(["container", "volume"]));
    for (const call of scenario.commandOptions)
      expect(call.timeoutMs).toBe(5000);
  },
);
it.each(["changed-daemon", "malformed-daemon"])(
  "actual discard refuses %s before resource or recovery mutation",
  async (mode) => {
    const d = await driver();
    d.state.daemon =
      mode === "changed-daemon" ? "different-daemon" : "private/invalid";
    await expect(d.operations.discard()).rejects.toThrow(/unverified/);
    expect(await readFile(join(d.runtime, "recovery-canary"), "utf8")).toBe(
      "preserve",
    );
    expect(d.calls.some((args) => args[1] === "rm")).toBe(false);
  },
);
it("actual native reset refuses a foreign volume-create race before mounting", async () => {
  const d = await driver();
  d.state.afterCreate = () => {
    d.state.volume.labels = { "com.rehearsal-db.project": "foreign" };
  };
  await expect(d.operations.reset()).rejects.toThrow(/unverified/);
  expect(scenario.startup).not.toHaveBeenCalled();
  expect(d.state.volume.labels["com.rehearsal-db.project"]).toBe("foreign");
  expect(
    d.calls.filter((args) => args[0] === "volume" && args[1] === "rm"),
  ).toHaveLength(1);
});
it.each(["knex", "sql", "prisma", "drizzle"])(
  "actual %s reset bounds owned create/removal and reaches only the reviewed startup boundary",
  async (kind) => {
    const d = await driver(kind);
    await expect(d.operations.reset()).rejects.toThrow(
      "synthetic-stop-before-database-startup",
    );
    expect(scenario.startup).toHaveBeenCalledOnce();
    const args = scenario.startup.mock.calls[0][0];
    expect(args[args.indexOf("--volume") + 1]).toBe(
      "owned-project-postgresql-data:/var/lib/postgresql/data",
    );
    expect(args.includes("--pull=never")).toBe(true);
    expect(d.state.volume.createdAt).toBe("2026-11-03T00:00:00Z");
    const mutations = scenario.commandOptions.filter((call) =>
      ["create", "rm"].includes(call.args[1]),
    );
    expect(mutations).toHaveLength(3);
    for (const call of mutations) expect(call.timeoutMs).toBe(45000);
  },
);
