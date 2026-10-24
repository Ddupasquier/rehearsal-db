import { describe, expect, it } from "vitest";
import { normalizeRehearsalConfig } from "../../../dist/src/project/configuration_normalization.mjs";

const input = () => ({
  schemaVersion: 1,
  project: { name: "policy-test" },
  postgresql: { migrationDirectory: "database/migrations" },
  baseline: { sanitizationPolicy: "rehearsal/policy.json" },
  application: { startCommand: "npm run dev", proofCommand: "npm test" },
  runtime: { target: "postgresql", databasePort: 58322 },
});
const supabase = () => {
  const config = input();
  delete config.postgresql;
  return {
    ...config,
    supabase: {
      workdir: ".",
      migrationDirectory: "supabase/migrations",
      rehearsalConfig: "rehearsal/config.toml",
      runtimeWorkdir: ".rehearsal/runtime",
    },
    runtime: {
      target: "supabase",
      apiPort: 58321,
      databasePort: 58322,
      studioPort: 58323,
    },
  };
};

describe("resource configuration", () => {
  it("normalizes only explicitly configured lifecycle queues and validates every bound", () => {
    expect(normalizeRehearsalConfig(input()).resources).not.toHaveProperty(
      "workloadQueue",
    );
    expect(
      normalizeRehearsalConfig({
        ...input(),
        resources: { workloadQueue: { enabled: true } },
      }).resources.workloadQueue,
    ).toEqual({ enabled: true, waitTimeoutSeconds: 30 });
    for (const waitTimeoutSeconds of [0, 300])
      expect(
        normalizeRehearsalConfig({
          ...input(),
          resources: { workloadQueue: { enabled: false, waitTimeoutSeconds } },
        }).resources.workloadQueue.waitTimeoutSeconds,
      ).toBe(waitTimeoutSeconds);
    for (const workloadQueue of [
      null,
      [],
      {},
      { enabled: "yes" },
      { enabled: true, force: true },
      ...[null, -1, 301, 0.5, "30", NaN, Infinity].map(
        (waitTimeoutSeconds) => ({
          enabled: true,
          waitTimeoutSeconds,
        }),
      ),
    ])
      expect(() =>
        normalizeRehearsalConfig({ ...input(), resources: { workloadQueue } }),
      ).toThrow();
  });
  it("refuses application/readiness/profile URLs that collide with native service ports", () => {
    const config = input();
    expect(() =>
      normalizeRehearsalConfig({
        ...config,
        runtime: {
          ...config.runtime,
          applicationUrl: "http://localhost:58322",
        },
      }),
    ).toThrow("overlaps");
    expect(() =>
      normalizeRehearsalConfig({
        ...config,
        application: {
          ...config.application,
          readiness: {
            url: "http://127.0.0.1:58322/health",
            expectedStatus: 200,
          },
        },
      }),
    ).toThrow("overlaps");
    expect(() =>
      normalizeRehearsalConfig({
        ...config,
        profiles: [
          {
            name: "Wrong port",
            targets: ["primary"],
            applicationUrl: "http://localhost:58322",
          },
        ],
      }),
    ).toThrow("overlaps");
    const api = supabase();
    expect(() =>
      normalizeRehearsalConfig({
        ...api,
        runtime: { ...api.runtime, applicationUrl: "http://localhost:58321" },
      }),
    ).toThrow("overlaps");
    expect(
      normalizeRehearsalConfig({
        ...config,
        runtime: { ...config.runtime, applicationUrl: "http://[::1]:5175" },
      }).runtime.applicationUrl,
    ).toBe("http://[::1]:5175");
  });
  it("provides non-destructive defaults and explicit valid budgets", () => {
    expect(normalizeRehearsalConfig(input()).resources).toEqual({
      staleAfterSeconds: null,
      retainedEnvironmentCount: 2,
      maximumBytes: null,
      cleanupSchedule: "manual",
    });
    expect(
      normalizeRehearsalConfig({
        ...input(),
        resources: {
          staleAfterSeconds: 3600,
          retainedEnvironmentCount: 3,
          maximumBytes: 1024,
          cleanupSchedule: "weekly-preview",
        },
      }).resources.maximumBytes,
    ).toBe(1024);
    expect(normalizeRehearsalConfig(input()).profiles).toEqual([]);
  });
  it.each([
    { idleTimeoutSeconds: 10 },
    { staleAfterSeconds: 0 },
    { staleAfterSeconds: -1 },
    { maximumBytes: "100" },
    { maximumBytes: Number.MAX_SAFE_INTEGER + 1 },
    { retainedEnvironmentCount: 1001 },
    { cleanupSchedule: "automatic-prune" },
    { cleanupSchedule: ["daily-preview"] },
  ])("rejects unsupported or unsafe resource declarations %j", (resources) => {
    expect(() => normalizeRehearsalConfig({ ...input(), resources })).toThrow();
  });
  it("refuses proofs that require services absent from the selected provider/profile", () => {
    expect(() =>
      normalizeRehearsalConfig({
        ...input(),
        application: {
          ...input().application,
          requiredServices: ["database", "auth"],
        },
      }),
    ).toThrow("excludes required application services: auth");
    const full = supabase();
    expect(() =>
      normalizeRehearsalConfig({
        ...full,
        application: {
          ...full.application,
          requiredServices: ["studio", "realtime"],
        },
      }),
    ).toThrow("excludes required application services");
    expect(
      normalizeRehearsalConfig({
        ...full,
        supabase: { ...full.supabase, serviceProfile: "full" },
        application: {
          ...full.application,
          requiredServices: ["studio", "realtime"],
        },
      }).application.requiredServices,
    ).toEqual(["studio", "realtime"]);
    expect(
      normalizeRehearsalConfig({
        ...full,
        application: {
          ...full.application,
          requiredServices: [
            "database",
            "auth",
            "storage",
            "postgrest",
            "gateway",
            "mail",
          ],
        },
      }).application.requiredServices,
    ).toHaveLength(6);
  });
  it.each([
    { requiredServices: ["unknown"] },
    { requiredServices: ["database", "database"] },
    { requiredServices: [1] },
    { requiredServices: "database" },
  ])(
    "rejects unknown/duplicate service declarations %j",
    ({ requiredServices }) => {
      expect(() =>
        normalizeRehearsalConfig({
          ...input(),
          application: { ...input().application, requiredServices },
        }),
      ).toThrow();
    },
  );
  it("validates named profiles against existing targets and loopback URLs", () => {
    const config = {
      ...input(),
      dependentTargets: [
        { name: "read-api", configPath: "read-api.config.mjs" },
      ],
    };
    expect(
      normalizeRehearsalConfig({
        ...config,
        profiles: [
          {
            name: "API check",
            targets: ["primary", "read-api"],
            applicationUrl: "http://localhost:5176",
          },
        ],
      }).profiles[0],
    ).toEqual({
      name: "API check",
      targets: ["primary", "read-api"],
      applicationUrl: "http://localhost:5176",
    });
    for (const profiles of [
      [{ name: "unknown", targets: ["wrong"] }],
      [{ name: "empty", targets: [] }],
      [{ name: "duplicate", targets: ["primary", "primary"] }],
      [
        {
          name: "network",
          targets: ["primary"],
          applicationUrl: "https://production.example",
        },
      ],
      [{ name: "bad\nname", targets: ["primary"] }],
      [
        { name: "same", targets: ["primary"] },
        { name: "same", targets: ["primary"] },
      ],
      Array.from({ length: 21 }, (_, i) => ({
        name: `profile${i}`,
        targets: ["primary"],
      })),
    ])
      expect(() => normalizeRehearsalConfig({ ...config, profiles })).toThrow();
  });
});
