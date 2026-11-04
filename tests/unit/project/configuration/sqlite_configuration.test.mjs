import { describe, expect, it } from "vitest";
import { normalizeRehearsalConfig } from "../../../../dist/src/project/configuration/configuration_normalization.mjs";
const fixture = () => ({
  schemaVersion: 1,
  project: { name: "sqlite-config" },
  runtime: { target: "sqlite", projectId: "sqlite-test" },
  sqlite: { sourceDatabase: "source.sqlite", migrationDirectory: "migrations" },
  baseline: { sanitizationPolicy: "policy.json" },
  application: {
    startCommand: "node app.mjs",
    proofCommand: "node proof.mjs",
    environmentVariables: { DATABASE_PATH: "primary:SQLITE_DATABASE_PATH" },
  },
});
describe("explicit embedded SQLite configuration", () => {
  it("requires no database ports or container configuration", () => {
    const c = normalizeRehearsalConfig(fixture());
    expect(c.runtime.ports).toEqual({});
    expect(c.sqlite).toMatchObject({
      expectedVersion: "3.53.4",
      maximumBytes: 64 * 1024 * 1024,
      timeoutSeconds: 10,
    });
    expect(c.application.environmentVariables.DATABASE_PATH).toBe(
      "primary:SQLITE_DATABASE_PATH",
    );
  });
  it.each([
    "supabase",
    "postgresql",
    "containerRuntime",
    "preparation",
    "runtimePolicy",
    "identityPolicy",
  ])(
    "rejects incompatible %s rather than reinterpreting another engine",
    (key) => {
      const c = fixture();
      c[key] = {};
      expect(() => normalizeRehearsalConfig(c)).toThrow();
    },
  );
  it.each(["apiPort", "databasePort", "studioPort"])(
    "rejects server-only %s",
    (key) => {
      const c = fixture();
      c.runtime[key] = 5432;
      expect(() => normalizeRehearsalConfig(c)).toThrow();
    },
  );
  it("rejects unqualified engines and excessive file/deadline budgets", () => {
    for (const patch of [
      { expectedVersion: "3.0.0" },
      { maximumBytes: 64 * 1024 * 1024 + 1 },
      { timeoutSeconds: 61 },
    ]) {
      const c = fixture();
      Object.assign(c.sqlite, patch);
      expect(() => normalizeRehearsalConfig(c)).toThrow();
    }
  });
  it("does not imply auth, Storage, multi-target or container quota support", () => {
    for (const patch of [
      { application: { ...fixture().application, requiredServices: ["auth"] } },
      { dependentTargets: [{ name: "other", configPath: "other.mjs" }] },
      { resources: { capacityAdmission: { enabled: true } } },
      { resources: { maximumBytes: 1024 } },
    ])
      expect(() =>
        normalizeRehearsalConfig({ ...fixture(), ...patch }),
      ).toThrow();
  });
});
