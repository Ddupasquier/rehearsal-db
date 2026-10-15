import { describe, expect, it } from "vitest";
import {
  classifyConfiguredEnvironment,
  evaluateObservableEnvironmentReview,
} from "../../../dist/src/runtime/environment_classification.mjs";

const now = new Date("2026-10-15T12:00:00Z");
const provenance = {
  schemaVersion: 1,
  inspectorVersion: "0.1.0-rc.5",
  verification: "recorded-not-reverified",
  configuredPorts: [],
  runtime: {
    rehearsalVersion: "0.0.1",
    versionReason: null,
    baselineGenerationId: "20261015T000000Z-aaaaaaaaaaaa",
    baselineDataSha256: "a".repeat(64),
    candidateSha256: null,
    migrationReason: "receipt-unavailable",
  },
  runtimeReason: null,
};
const input = (overrides = {}) => ({
  inspectionAvailable: true,
  containerCount: 1,
  volumeCount: 1,
  provenance,
  providerRecorded: true,
  staleAfterSeconds: 3600,
  containers: [
    { running: true, startedAt: "2026-10-15T09:00:00Z", finishedAt: null },
  ],
  now,
  ...overrides,
});

describe("orthogonal configured-environment classification", () => {
  it("separates actual owned presence, record format/provider, long-running review and persistent data", () => {
    expect(classifyConfiguredEnvironment(input())).toEqual({
      schemaVersion: 1,
      role: "configured-environment",
      dataPersistence: "preserved-on-stop",
      presence: { state: "created", reason: "owned-resources-observed" },
      receipt: {
        state: "compatible",
        reason: "supported-receipt-format-and-provider",
        scope: "format-and-provider-only",
      },
      review: {
        state: "due",
        reason: "observable-cutoff-exceeded",
        staleAfterSeconds: 3600,
        lastObservableActivityAt: "2026-10-15T09:00:00Z",
      },
    });
    expect(
      classifyConfiguredEnvironment(
        input({ containerCount: 0, volumeCount: 1, containers: [] }),
      ).presence.state,
    ).toBe("created");
  });
  it("does not infer creation from valid receipts or call an unavailable engine absent", () => {
    expect(
      classifyConfiguredEnvironment(
        input({ containerCount: 0, volumeCount: 0, containers: [] }),
      ).presence.state,
    ).toBe("not-created");
    const unavailable = classifyConfiguredEnvironment(
      input({
        inspectionAvailable: false,
        containerCount: 0,
        volumeCount: 0,
        containers: [],
      }),
    );
    expect(unavailable.presence).toEqual({
      state: "unknown",
      reason: "ownership-inspection-unavailable",
    });
    expect(unavailable.review.state).toBe("unknown");
    expect(
      classifyConfiguredEnvironment(input({ containerCount: -1 })).presence
        .state,
    ).toBe("unknown");
  });
  it("keeps missing legacy provider and receipts unknown; different writer versions do not imply incompatibility", () => {
    expect(
      classifyConfiguredEnvironment(input({ providerRecorded: false })).receipt,
    ).toMatchObject({ state: "unknown", reason: "provider-not-recorded" });
    expect(
      classifyConfiguredEnvironment(
        input({
          provenance: {
            ...provenance,
            runtime: null,
            runtimeReason: "receipt-unavailable",
          },
        }),
      ).receipt,
    ).toMatchObject({ state: "unknown", reason: "receipt-unavailable" });
    for (const rehearsalVersion of ["0.0.1", "9.9.9", null])
      expect(
        classifyConfiguredEnvironment(
          input({
            provenance: {
              ...provenance,
              runtime: {
                ...provenance.runtime,
                rehearsalVersion,
                versionReason:
                  rehearsalVersion === null ? "not-recorded" : null,
              },
            },
          }),
        ).receipt.state,
      ).toBe("compatible");
  });
  it("classifies invalid format/provider or candidate bindings as incompatible records, never fresh database compatibility", () => {
    expect(
      classifyConfiguredEnvironment(
        input({
          provenance: {
            ...provenance,
            runtime: null,
            runtimeReason: "receipt-invalid",
          },
        }),
      ).receipt,
    ).toMatchObject({
      state: "incompatible",
      reason: "receipt-invalid",
      scope: "format-and-provider-only",
    });
    expect(
      classifyConfiguredEnvironment(
        input({
          provenance: {
            ...provenance,
            runtime: {
              ...provenance.runtime,
              migrationReason: "receipt-does-not-match-baseline",
            },
          },
        }),
      ).receipt,
    ).toMatchObject({
      state: "incompatible",
      reason: "receipt-binding-mismatch",
    });
  });
  it("shares the exact cutoff boundary without treating stopped targets as long-running", () => {
    for (const [startedAt, state] of [
      ["2026-10-15T11:00:00Z", "due"],
      ["2026-10-15T11:00:00.001Z", "not-due"],
    ])
      expect(
        evaluateObservableEnvironmentReview(
          input({
            containers: [{ running: true, startedAt, finishedAt: null }],
          }),
        ).state,
      ).toBe(state);
    expect(
      evaluateObservableEnvironmentReview(
        input({
          containers: [
            {
              running: false,
              startedAt: "2026-10-15T09:00:00Z",
              finishedAt: "2026-10-15T09:01:00Z",
            },
          ],
        }),
      ),
    ).toMatchObject({ state: "not-due", reason: "not-running" });
    expect(
      evaluateObservableEnvironmentReview(input({ staleAfterSeconds: null })),
    ).toMatchObject({ state: "disabled", reason: "cutoff-disabled" });
  });
  it("refuses future, missing, invalid or ambiguous observations instead of guessing inactivity", () => {
    for (const containers of [
      [{ running: true, startedAt: undefined, finishedAt: null }],
      [{ running: true, startedAt: "2026-10-16T00:00:00Z", finishedAt: null }],
      [{ running: true, startedAt: "0001-01-01T00:00:00Z", finishedAt: null }],
      [
        {
          running: undefined,
          startedAt: "2026-10-15T09:00:00Z",
          finishedAt: null,
        },
      ],
    ])
      expect(
        evaluateObservableEnvironmentReview(input({ containers })),
      ).toMatchObject({
        state: "unknown",
        reason: "observable-activity-unavailable",
        lastObservableActivityAt: null,
      });
    expect(
      evaluateObservableEnvironmentReview(
        input({ inspectionAvailable: false, staleAfterSeconds: null }),
      ).state,
    ).toBe("unknown");
  });
});
