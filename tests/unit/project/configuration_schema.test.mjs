import { describe, expect, it } from "vitest";
import { validateConfigurationSchema } from "../../../dist/src/project/configuration_schema.mjs";

const rawConfiguration = () => ({
  schemaVersion: 1,
  project: { name: "schema-test" },
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",
  },
  baseline: {
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
  },
  runtime: {
    apiPort: 58321,
    databasePort: 58322,
    studioPort: 58323,
  },
});

describe("configuration schema", () => {
  it("validates raw structure without applying normalized defaults", () => {
    const raw = rawConfiguration();
    const validated = validateConfigurationSchema(raw);

    expect(validated.root).toBe(raw);
    expect(validated.runtimeTarget).toBe("supabase");
    expect(validated.cleanup).toEqual({});
    expect(validated.lifecycle).toEqual({});
    expect(validated.root).not.toHaveProperty("cleanup");
    expect(validated.application).not.toHaveProperty("environmentFile");
  });

  it("rejects unknown lifecycle properties before normalization", () => {
    const raw = rawConfiguration();
    raw.lifecycle = { typo: "stop-everything" };

    expect(() => validateConfigurationSchema(raw)).toThrow(
      "Unknown Rehearsal configuration property: config.lifecycle.typo",
    );
  });

  it("rejects unknown nested keys before normalization", () => {
    const raw = rawConfiguration();
    raw.application.typo = true;

    expect(() => validateConfigurationSchema(raw)).toThrow(
      "Unknown Rehearsal configuration property: config.application.typo",
    );
  });

  it("requires object entries in schema arrays", () => {
    const raw = rawConfiguration();
    raw.dependentTargets = ["publication"];

    expect(() => validateConfigurationSchema(raw)).toThrow(
      "config.dependentTargets[0] must be an object",
    );
  });
});
