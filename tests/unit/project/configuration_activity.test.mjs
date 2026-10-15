import { describe, expect, it } from "vitest";
import { normalizeRehearsalConfig } from "../../../dist/src/project/configuration_normalization.mjs";

const input = () => ({
  schemaVersion: 1,
  project: { name: "activity-test" },
  postgresql: { migrationDirectory: "database/migrations" },
  baseline: { sanitizationPolicy: "rehearsal/privacy.json" },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
    readiness: { url: "http://localhost:5175/health", expectedStatus: 200 },
    activity: { url: "http://localhost:5175/activity" },
  },
  runtime: { target: "postgresql", databasePort: 58322 },
  lifecycle: { open: "stop-on-application-exit", openIdleTimeoutSeconds: 30 },
});

describe("foreground idle configuration", () => {
  it("defaults off and supports explicit activity without enabling shutdown", () => {
    const config = input();
    expect(
      normalizeRehearsalConfig(config).lifecycle.openIdleTimeoutSeconds,
    ).toBe(30);
    delete config.lifecycle;
    expect(
      normalizeRehearsalConfig(config).lifecycle.openIdleTimeoutSeconds,
    ).toBeNull();
    expect(normalizeRehearsalConfig(config).application.activity.url).toBe(
      "http://localhost:5175/activity",
    );
    config.application.activity.url = null;
    expect(normalizeRehearsalConfig(config).application.activity).toBeNull();
  });
  it("refuses incompatible persistence, missing signal/readiness, origin mismatch and out-of-bound timeouts", () => {
    for (const timeout of [0, 29, 86401, 30.1, "30", Number.MAX_SAFE_INTEGER])
      expect(() =>
        normalizeRehearsalConfig({
          ...input(),
          lifecycle: {
            open: "stop-on-application-exit",
            openIdleTimeoutSeconds: timeout,
          },
        }),
      ).toThrow(/30 to 86400/u);
    expect(() =>
      normalizeRehearsalConfig({
        ...input(),
        lifecycle: { open: "keep-until-stop", openIdleTimeoutSeconds: 30 },
      }),
    ).toThrow(/stop-on-application-exit/u);
    for (const activity of [
      undefined,
      null,
      { url: null },
      { url: "http://localhost:5176/activity" },
      { url: "http://127.0.0.1:5175/activity" },
      { url: "http://localhost:5175/activity?token=secret" },
      { url: "http://localhost:5175/activity", token: "secret" },
    ])
      expect(() =>
        normalizeRehearsalConfig({
          ...input(),
          application: { ...input().application, activity },
        }),
      ).toThrow();
    expect(() =>
      normalizeRehearsalConfig({
        ...input(),
        application: { ...input().application, readiness: undefined },
      }),
    ).toThrow();
  });
});
