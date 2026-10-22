import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPACT_FIXTURE_CANARIES,
  IMPACT_FIXTURE_SQL,
  assertImpactFixtureCounts,
  assertImpactPublicOutput,
} from "../../../scripts/verification/fixtures/postgresql_impact.mjs";

const candidateSha256 = "a".repeat(64),
  version = "1.2.0";
const counts = ["2", "4", "2", "2", "5", "6", "6"];
const kinds = [
  ["not_null", "nulls"],
  ["drop_column", "populated"],
  ["new_constraint", "duplicate_rows"],
  ["new_constraint", "orphan_rows"],
  ["broad_delete", "rows"],
  ["truncate", "rows"],
  ["drop_table", "rows"],
];
const columns = [
  IMPACT_FIXTURE_SQL.split("\n")[1].indexOf("NOT NULL") + 1,
  IMPACT_FIXTURE_SQL.split("\n")[2].indexOf("DROP COLUMN") + 1,
  IMPACT_FIXTURE_SQL.split("\n")[3].indexOf("ADD CONSTRAINT") + 1,
  IMPACT_FIXTURE_SQL.split("\n")[4].indexOf("ADD CONSTRAINT") + 1,
  1,
  1,
  1,
];
const sample = (values = counts, reasons = values.map(() => null)) => {
  const measured = values.filter((value) => value !== null).length;
  return {
    status: "not_ready",
    data: {
      schemaVersion: 1,
      inspectorVersion: version,
      mode: "measurement",
      candidateSha256,
      target: { name: "primary", provider: "postgresql" },
      measurementStatus: measured ? "partial" : "unknown",
      snapshotAt: measured ? "2026-10-22T12:00:00.000Z" : null,
      runtimeIdentitySha256: measured ? "b".repeat(64) : null,
      entries: [
        {
          filename: "20260101000100_add_widget_description.sql",
          coverage: "incomplete",
          unknownReasons: ["unsupported_sql"],
          measurements: [],
        },
        {
          filename: "20260101000200_impact_review.sql",
          sha256: createHash("sha256").update(IMPACT_FIXTURE_SQL).digest("hex"),
          coverage: "recognized_forms",
          unknownReasons: [],
          measurements: values.map((count, index) => ({
            operation: kinds[index][0],
            metric: kinds[index][1],
            line: index + 2,
            column: columns[index],
            evidence: count === null ? "unknown" : "measured_current_snapshot",
            count,
            unknownReason: reasons[index],
          })),
        },
      ],
      summary: {
        plannedCount: 7,
        measuredCount: measured,
        unknownMeasurementCount: 7 - measured,
        unknownEntryCount: measured === 7 ? 1 : 2,
      },
      safety: {
        appliesMigrations: false,
        startsOrRepairsRuntime: false,
        returnsRowContents: false,
        returnsSqlOrObjectNames: false,
        contactsDatabase: true,
        transaction: measured ? "repeatable_read_read_only" : null,
      },
      limits: {
        lockTimeoutMilliseconds: 1000,
        statementTimeoutMilliseconds: 5000,
        totalTimeoutMilliseconds: 30000,
      },
    },
  };
};
const options = (values = counts, reasons) => ({
  candidateSha256,
  counts: values,
  ...(reasons ? { reasons } : {}),
  version,
});

describe("installed PostgreSQL impact fixture's independent oracles", () => {
  it("requires all seven exact current-row counts and preserves unrelated unsupported SQL", () => {
    const report = sample();
    expect(assertImpactFixtureCounts(report, options())).toBe(report.data);
    const current = ["1", "5", "2", "2", "5", "6", "6"];
    expect(() =>
      assertImpactFixtureCounts(sample(current), options(current)),
    ).not.toThrow();
  });
  it("keeps duplicated rows distinct from excess duplicates and empty payloads populated", () => {
    for (const [index, value] of [
      [1, "3"],
      [2, "1"],
      [3, "1"],
      [5, "0"],
    ]) {
      const report = sample();
      report.data.entries[1].measurements[index].count = value;
      expect(() => assertImpactFixtureCounts(report, options())).toThrow(
        /private output withheld/u,
      );
    }
  });
  it("requires typed decimal strings, positions, fixed metric order and whole-plan binding", () => {
    const mutations = [
      (report) => (report.data.entries[1].measurements[0].count = 2),
      (report) => (report.data.entries[1].measurements[0].count = "02"),
      (report) => (report.data.entries[1].measurements[0].line = 1),
      (report) => report.data.entries[1].measurements.reverse(),
      (report) => (report.data.entries[1].sha256 = "c".repeat(64)),
      (report) => (report.data.candidateSha256 = "c".repeat(64)),
      (report) => (report.data.target.name = "different"),
      (report) => (report.data.safety.appliesMigrations = true),
      (report) => (report.data.limits.totalTimeoutMilliseconds = 60000),
      (report) => (report.status = "success"),
    ];
    for (const mutate of mutations) {
      const report = sample();
      mutate(report);
      expect(() => assertImpactFixtureCounts(report, options())).toThrow();
    }
  });
  it("accepts reordered object properties without weakening array order", () => {
    const report = sample();
    const measurement = report.data.entries[1].measurements[0];
    report.data.entries[1].measurements[0] = Object.fromEntries(
      Object.entries(measurement).reverse(),
    );
    expect(() => assertImpactFixtureCounts(report, options())).not.toThrow();
  });
  it("requires unsupported index/statistics metadata to stay unknown while independent rows are measured", () => {
    const values = [null, null, null, null, "5", null, null];
    const reasons = values.map((count) =>
      count === null ? "unsupported_runtime_metadata" : null,
    );
    const report = sample(values, reasons);
    expect(() =>
      assertImpactFixtureCounts(report, options(values, reasons)),
    ).not.toThrow();
    report.data.entries[1].measurements[0].count = "0";
    expect(() =>
      assertImpactFixtureCounts(report, options(values, reasons)),
    ).toThrow();
  });
  it("never interprets an aborted batch or lock timeout as zero or partial successful counts", () => {
    const values = Array(7).fill(null),
      reasons = Array(7).fill("lock_timeout");
    const report = sample(values, reasons);
    expect(() =>
      assertImpactFixtureCounts(report, options(values, reasons)),
    ).not.toThrow();
    report.data.entries[1].measurements[0].unknownReason = "query_failed";
    expect(() =>
      assertImpactFixtureCounts(report, options(values, reasons)),
    ).toThrow();
  });
  it.each(IMPACT_FIXTURE_CANARIES)(
    "rejects %s anywhere in success/error/metadata/text output",
    (canary) => {
      for (const output of [
        JSON.stringify({ data: {}, metadata: { leak: canary } }),
        JSON.stringify({ error: { cause: canary } }),
        `Report: ${canary}`,
        JSON.stringify({ leak: canary }).replaceAll(
          canary,
          [...canary]
            .map(
              (character) =>
                `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
            )
            .join(""),
        ),
      ])
        expect(() =>
          assertImpactPublicOutput({ stdout: output, stderr: "" }),
        ).toThrow(/private output withheld/u);
      expect(() =>
        assertImpactPublicOutput({ stdout: "{}", stderr: canary }),
      ).toThrow();
    },
  );
  it("checks the actual runtime secret in addition to synthetic canaries", () => {
    const secret = "0123456789abcdef".repeat(3);
    expect(() =>
      assertImpactPublicOutput(
        { stdout: JSON.stringify({ debug: secret }), stderr: "" },
        [...IMPACT_FIXTURE_CANARIES, secret],
      ),
    ).toThrow();
    expect(() =>
      assertImpactPublicOutput({
        stdout: JSON.stringify(sample()),
        stderr: "",
      }),
    ).not.toThrow();
  });
  it("bounds raw output and decoded nesting before accepting an envelope", () => {
    expect(() =>
      assertImpactPublicOutput({ stdout: "x".repeat(131073), stderr: "" }),
    ).toThrow();
    let nested = "safe";
    for (let index = 0; index < 34; index++) nested = { nested };
    expect(() =>
      assertImpactPublicOutput({ stdout: JSON.stringify(nested), stderr: "" }),
    ).toThrow();
  });
});
