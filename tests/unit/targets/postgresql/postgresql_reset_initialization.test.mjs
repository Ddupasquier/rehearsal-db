import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  action: "reset",
  optIn: true,
  validBaseline: true,
  engineRunning: false,
  events: [],
}));
const paths = vi.hoisted(() => {
  const root = process.cwd() + "/test-results/nonexistent-reset-order-fixture";
  return {
    artifactDirectory: root,
    runtimeWorkdir: root + "/runtime",
    applicationEnvironment: root + "/runtime.env",
    sanitizationPolicy: root + "/policy.json",
  };
});
vi.mock("../../../../dist/src/project/configuration.mjs", async (original) => ({
  ...(await original()),
  loadRehearsalConfig: async () => ({
    projectRoot: process.cwd(),
    paths,
    config: {
      runtime: {
        projectId: "owned-fixture",
        protected: false,
        ports: { database: 55432 },
      },
      postgresql: {
        image: "postgres:17-alpine",
        database: "postgres",
        user: "postgres",
      },
      containerRuntime: { autoStartColima: fixture.optIn },
      resources: {},
    },
  }),
}));
vi.mock("../../../../dist/src/targets/target.mjs", () => ({
  parseRuntimeInvocation: () => ({ action: fixture.action }),
}));
vi.mock(
  "../../../../dist/src/runtime/lifecycle/runtime_manager_guards.mjs",
  () => ({
    guardRuntimeManagerAction: async () => {
      fixture.events.push("admission");
    },
  }),
);
vi.mock(
  "../../../../dist/src/targets/supabase/supabase_environment.mjs",
  () => ({
    ensureConfiguredContainerRuntime: ({ policy }) => {
      fixture.events.push("initialize-runtime");
      if (!policy.autoStartColima)
        throw Error("Explicit engine startup required.");
      fixture.engineRunning = true;
    },
  }),
);
vi.mock(
  "../../../../dist/src/targets/postgresql/postgresql_resources.mjs",
  () => ({
    createPostgresqlResourceManagement: () => ({
      assertOwnedResource: vi.fn(),
      removeResources: async () => {
        fixture.events.push("observe-resources");
        if (!fixture.engineRunning)
          throw Error("Engine is stopped; preserve resources.");
        // End this synthetic scenario before any filesystem/container mutation.
        throw Error("Owned engine reached resource observation.");
      },
    }),
  }),
);
vi.mock(
  "../../../../dist/src/runtime/lifecycle/lifecycle_engine.mjs",
  async (original) => ({
    ...(await original()),
    readActiveRuntimeInput: async ({ validate }) => {
      fixture.events.push("validate-baseline");
      if (!fixture.validBaseline) throw Error("Baseline validation refused.");
      const active = {
        baseline: { storageAssets: {} },
        manifest: { tables: [] },
      };
      await validate(active);
      return active;
    },
    runRuntimeLifecycle: async ({ operations, action }) => operations[action](),
  }),
);

beforeEach(() => {
  vi.resetModules();
  Object.assign(fixture, {
    action: "reset",
    optIn: true,
    validBaseline: true,
    engineRunning: false,
    events: [],
  });
});
it("initializes an explicitly opted-in stopped engine after validation and before reset resource observation", async () => {
  await expect(
    import("../../../../dist/src/targets/postgresql.mjs"),
  ).rejects.toThrow("Owned engine reached resource observation.");
  expect(fixture.events).toEqual([
    "admission",
    "validate-baseline",
    "initialize-runtime",
    "observe-resources",
  ]);
});
it("preserves declined engine startup without observing or deleting resources", async () => {
  fixture.optIn = false;
  await expect(
    import("../../../../dist/src/targets/postgresql.mjs"),
  ).rejects.toThrow("Explicit engine startup required.");
  expect(fixture.events).toEqual([
    "admission",
    "validate-baseline",
    "initialize-runtime",
  ]);
});
it("refuses an invalid baseline before engine initialization", async () => {
  fixture.validBaseline = false;
  await expect(
    import("../../../../dist/src/targets/postgresql.mjs"),
  ).rejects.toThrow("Baseline validation refused.");
  expect(fixture.events).toEqual(["admission", "validate-baseline"]);
});
it("does not make discard implicitly start the engine even when reset auto-start is enabled", async () => {
  fixture.action = "discard";
  await expect(
    import("../../../../dist/src/targets/postgresql.mjs"),
  ).rejects.toThrow("Engine is stopped; preserve resources.");
  expect(fixture.events).toEqual(["admission", "observe-resources"]);
});
