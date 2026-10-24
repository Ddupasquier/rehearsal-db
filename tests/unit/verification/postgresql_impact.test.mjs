import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPACT_FIXTURE_CANARIES,
  IMPACT_FIXTURE_SQL,
  IMPACT_RACE_FIXTURE_LIMITS,
  assertImpactFixtureCounts,
  assertImpactPublicOutput,
  assertImpactRaceIndexResult,
  buildImpactDeadlineProbe,
  buildImpactRaceIndexProbe,
  waitForImpactLock,
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
  it("matches auxiliary DDL to the existing holder bound without changing product limits", () => {
    const limits = IMPACT_RACE_FIXTURE_LIMITS;
    expect(limits).toEqual({
      observationMilliseconds: 5000,
      serverMilliseconds: 8000,
      indexClientMilliseconds: 10000,
      holderClientMilliseconds: 15000,
    });
    const probe = buildImpactRaceIndexProbe("rehearsal-impact-index-42");
    expect(probe).toContain("set lock_timeout = '8000ms';");
    expect(probe).toContain("set statement_timeout = '8000ms';");
    expect(probe).not.toContain("4s");
    // The separate measurement oracle still requires the public 1/5/30s bounds.
    expect(assertImpactFixtureCounts(sample(), options())).toBeDefined();
  });
  it.each([
    "rehearsal-impact-index-0",
    "other",
    "rehearsal-impact-index-42';",
    null,
  ])("refuses an unreviewed queued-index label %s", (application) => {
    expect(() => buildImpactRaceIndexProbe(application)).toThrow();
  });
  it("accepts only a successfully closed queued-index client", () => {
    expect(() =>
      assertImpactRaceIndexResult({ status: 0, signal: null, fault: false }),
    ).not.toThrow();
    for (const result of [undefined, { status: 0, fault: true }, { status: 1 }])
      expect(() => assertImpactRaceIndexResult(result)).toThrow(
        /queued-index setup failed/u,
      );
  });
  it.each(["55P03", "57014", "25P03", "25P04"])(
    "reports only an allowlisted queued-index SQLSTATE %s",
    (sqlstate) => {
      expect(() =>
        assertImpactRaceIndexResult({
          status: 3,
          signal: null,
          fault: false,
          stderr: `ERROR:  ${sqlstate}\n`,
        }),
      ).toThrow(`status=3, signal=unknown, sqlstate=${sqlstate};`);
    },
  );
  it("withholds provider text, unknown codes and arbitrary result fields", () => {
    for (const stderr of [
      "ERROR: PRIVATE_DIAGNOSTIC_CANARY\n",
      "ERROR:  XX000\n",
      "ERROR:  55P03 PRIVATE_DIAGNOSTIC_CANARY\n",
    ]) {
      expect(() =>
        assertImpactRaceIndexResult({
          status: "PRIVATE_DIAGNOSTIC_CANARY",
          signal: "PRIVATE_DIAGNOSTIC_CANARY",
          stderr,
        }),
      ).toThrow("status=unknown, signal=unknown, sqlstate=withheld;");
    }
  });
  it("binds the same SQL oracle to the explicitly selected Supabase provider", () => {
    const report = sample();
    report.data.target.provider = "supabase";
    expect(() => assertImpactFixtureCounts(report, options())).toThrow();
    expect(
      assertImpactFixtureCounts(report, { ...options(), provider: "supabase" }),
    ).toBe(report.data);
    expect(() =>
      assertImpactFixtureCounts(report, { ...options(), provider: "other" }),
    ).toThrow();
  });
  it("keeps mismatch diagnostics to bounded counts and fixed reasons", () => {
    const report = sample();
    report.data.entries[1].measurements[0].count = "PRIVATE_DIAGNOSTIC_CANARY";
    report.data.entries[1].measurements[0].unknownReason =
      "PRIVATE_DIAGNOSTIC_CANARY";
    try {
      assertImpactFixtureCounts(report, options());
      throw Error("Expected oracle refusal");
    } catch (error) {
      expect(error.message).toContain("count=withheld, reason=withheld");
      expect(error.message).not.toContain("PRIVATE_DIAGNOSTIC_CANARY");
    }
  });
  it("forces real server deadlines using only fixed read-only statements", () => {
    for (const kind of ["statement", "transaction"]) {
      const script = buildImpactDeadlineProbe(
        kind,
        `rehearsal-impact-deadline-42-${kind}`,
      );
      expect(script).toContain(
        "begin isolation level repeatable read read only;",
      );
      expect(script).toContain("set local lock_timeout = '1000ms';");
      expect(script).toContain("set local statement_timeout = '5000ms';");
      expect(script).toContain("set local transaction_timeout = '30000ms';");
      expect(script.endsWith("rollback;\n")).toBe(true);
      const statements = script
        .split("\n")
        .filter((line) => line.startsWith("select "));
      expect(statements).toEqual(
        Array(kind === "statement" ? 1 : 32).fill(
          `select pg_catalog.pg_sleep(${kind === "statement" ? 6 : 1});`,
        ),
      );
      for (const canary of IMPACT_FIXTURE_CANARIES)
        expect(script).not.toContain(canary);
    }
  });
  it.each([
    ["other", "rehearsal-impact-deadline-42-statement"],
    ["statement", "rehearsal-impact-deadline-0-statement"],
    ["statement", "rehearsal-impact-deadline-42-statement'; select 1; --"],
    ["transaction", "rehearsal-impact-deadline-42-transaction\n"],
    ["statement", null],
  ])("refuses an unreviewed deadline probe kind or label", (kind, label) => {
    expect(() => buildImpactDeadlineProbe(kind, label)).toThrow();
  });
  it("observes a short-lived lock on the existing client without extending its deadline", async () => {
    let clock = 0;
    const observations = [[], [0], [41, 42], [42]];
    const pid = await waitForImpactLock({
      client: { child: { exitCode: null, signalCode: null } },
      readPids: async () => observations.shift(),
      now: () => clock,
      wait: async () => {
        clock += 25;
      },
    });
    expect(pid).toBe(42);
    expect(clock).toBe(75);
  });
  it("refuses an expired observation, an exited client and a terminated client", async () => {
    for (const child of [
      { exitCode: 1, signalCode: null },
      { exitCode: null, signalCode: "SIGTERM" },
      { exitCode: null, signalCode: null },
    ]) {
      let clock = 0;
      await expect(
        waitForImpactLock({
          client: { child },
          readPids: async () => [],
          now: () => clock,
          wait: async () => {
            clock += 5000;
          },
        }),
      ).rejects.toThrow(/private output withheld/u);
      expect(clock).toBeLessThanOrEqual(5000);
    }
  });
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
