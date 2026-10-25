import { mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import {
  completeImpactBlockedMeasurement,
  classifyImpactGateCommand,
  createImpactSqlGate,
  waitForImpactGateReady,
  runImpactGateWrapper,
} from "../../../scripts/verification/fixtures/postgresql_impact_gate.mjs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IMPACT_FIXTURE_CANARIES,
  IMPACT_FIXTURE_SQL,
  IMPACT_RACE_FIXTURE_LIMITS,
  assertImpactFixtureCounts,
  assertImpactPublicOutput,
  assertImpactRaceIndexResult,
  assertImpactDeadlineResult,
  withImpactDeadlineProbe,
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
  it("separates bounded runtime opening from the unchanged 35-second probe budget", async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const result = withImpactDeadlineProbe(
        async (value) => {
          signal = value;
          await new Promise((done) => setTimeout(done, 10000));
          return "runtime";
        },
        async (runtime) => {
          expect(runtime).toBe("runtime");
          await new Promise((done) => setTimeout(done, 32000));
          expect(signal.aborted).toBe(false);
          return "server-deadline-observed";
        },
      );
      await vi.advanceTimersByTimeAsync(42000);
      await expect(result).resolves.toBe("server-deadline-observed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not renew an expired opening or a running probe", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn();
      const opening = withImpactDeadlineProbe(async () => {
        await new Promise((done) => setTimeout(done, 35001));
      }, probe);
      const refused = expect(opening).rejects.toThrow(
        /private output withheld/u,
      );
      await vi.advanceTimersByTimeAsync(35001);
      await refused;
      expect(probe).not.toHaveBeenCalled();
      let signal;
      const running = withImpactDeadlineProbe(
        async (value) => {
          signal = value;
          return "runtime";
        },
        async () =>
          new Promise((done) =>
            signal.addEventListener("abort", () => done("cancelled"), {
              once: true,
            }),
          ),
      );
      await vi.advanceTimersByTimeAsync(34999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toBe("cancelled");
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("clears each phase timer on failure without retrying", async () => {
    vi.useFakeTimers();
    try {
      for (const phase of ["opening", "probe"]) {
        const open = vi.fn(async () => {
          if (phase === "opening") throw Error("fixed failure");
          return "runtime";
        });
        const query = vi.fn(async () => {
          throw Error("fixed failure");
        });
        await expect(withImpactDeadlineProbe(open, query)).rejects.toThrow(
          "fixed failure",
        );
        expect(open).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledTimes(phase === "probe" ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports only fixed deadline kinds/reasons and bounded timing", () => {
    expect(() =>
      assertImpactDeadlineResult("statement", "statement_timeout", 5000),
    ).not.toThrow();
    expect(() =>
      assertImpactDeadlineResult("transaction", "transaction_timeout", 30000),
    ).not.toThrow();
    expect(() =>
      assertImpactDeadlineResult("transaction", "cancelled", 35000),
    ).toThrow("probe=transaction, reason=cancelled, elapsedMs=35000;");
    expect(() =>
      assertImpactDeadlineResult(
        "PRIVATE_CANARY",
        "PRIVATE_CANARY",
        "PRIVATE_CANARY",
      ),
    ).toThrow("probe=withheld, reason=withheld, elapsedMs=withheld;");
    expect(() =>
      assertImpactDeadlineResult("statement", undefined, Infinity),
    ).toThrow("reason=withheld, elapsedMs=withheld;");
  });
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

const gateBinding = {
  context: "reviewed",
  endpoint: "unix:///synthetic/docker.sock",
  containerId: "b".repeat(64),
  containerName: "fixture-owned-postgresql",
};
const gateSqlArgs = [
  "--host",
  gateBinding.endpoint,
  "exec",
  "--interactive",
  gateBinding.containerId,
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "PGSSLMODE=disable",
  "PGPASSFILE=/dev/null",
  "psql",
  "--no-psqlrc",
  "--no-password",
  "--host=/var/run/postgresql",
  "--port=5432",
  "--quiet",
  "--no-align",
  "--tuples-only",
  "--set",
  "ON_ERROR_STOP=1",
  "--set",
  "VERBOSITY=sqlstate",
  "--username",
  "postgres",
  "--dbname",
  "postgres",
];
const gateInfoArgs = [
  "--host",
  gateBinding.endpoint,
  "info",
  "--format",
  "{{json .ID}}",
];
async function gateTestFixture(stubborn = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "impact-gate-test-")),
  );
  const marker = join(root, "forwarded"),
    docker = join(root, "fake-docker");
  await writeFile(
    docker,
    [
      `#!${process.execPath}`,
      `import {writeFileSync} from "node:fs";`,
      `writeFileSync(${JSON.stringify(marker)},String(process.pid));`,
      stubborn
        ? `process.on("SIGTERM",()=>{});setInterval(()=>{},1000);`
        : `process.stdin.resume();process.stdin.on("end",()=>{});`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const gate = await createImpactSqlGate({
    cwd: root,
    docker,
    binding: gateBinding,
  });
  const launch = (args) => {
    const child = spawn(
      join(gate.environment.PATH.split(":")[0], "docker"),
      args,
      {
        env: { ...process.env, ...gate.environment },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const completion = new Promise((resolve) =>
      child.once("close", (status, signal) => resolve({ status, signal })),
    );
    return { child, completion };
  };
  return { root, marker, docker, gate, launch };
}
async function waitGateMarker(path) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await pause(10);
  }
  throw new Error("Synthetic forwarded child did not become ready.");
}
describe("fixture-only public impact SQL gate", () => {
  it("permits only exact pinned metadata and the one sanitized owned SQL command", () => {
    expect(classifyImpactGateCommand(gateInfoArgs, gateBinding)).toBe(
      "metadata",
    );
    expect(classifyImpactGateCommand(gateSqlArgs, gateBinding)).toBe("sql");
    for (const args of [
      ["run", "foreign"],
      ["context", "show"],
      [...gateInfoArgs, "--debug"],
      ["--host", "ssh://foreign", ...gateInfoArgs.slice(2)],
      [...gateSqlArgs.slice(0, 4), "c".repeat(64), ...gateSqlArgs.slice(5)],
      gateSqlArgs.map((a) => (a === "--no-password" ? "--password" : a)),
    ])
      expect(() => classifyImpactGateCommand(args, gateBinding)).toThrow();
  });
  it("keeps slow public preflight outside the short holder clock without renewing overall expiry", async () => {
    let clock = 0,
      holderStarted = null,
      reads = 0;
    await waitForImpactGateReady({
      client: { child: { exitCode: null, signalCode: null } },
      expiresAt: 35000,
      now: () => clock,
      readReady: async () => ++reads === 2,
      wait: async () => {
        expect(holderStarted).toBe(null);
        clock += 6000;
      },
    });
    holderStarted = clock;
    expect(holderStarted).toBe(6000);
    expect(clock).toBeLessThan(35000);
    await expect(
      waitForImpactGateReady({
        client: { child: { exitCode: null, signalCode: null } },
        expiresAt: clock,
        now: () => clock,
        readReady: async () => true,
      }),
    ).rejects.toThrow();
  });
  it("holds only the SQL child until release and forwards no command early", async () => {
    const f = await gateTestFixture();
    let client;
    try {
      client = f.launch(gateSqlArgs);
      client.child.stdin.end();
      await waitForImpactGateReady({
        client,
        readReady: f.gate.readReady,
        expiresAt: f.gate.expiresAt,
      });
      await expect(readFile(f.marker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await f.gate.release();
      expect((await client.completion).status).toBe(0);
      expect(Number(await readFile(f.marker, "utf8"))).toBeGreaterThan(0);
    } finally {
      client?.child.kill("SIGTERM");
      await f.gate.cleanup();
      await rm(f.root, { recursive: true });
    }
  });
  it("cancels a waiting SQL gate without forwarding and reaps only an owned stubborn metadata child", async () => {
    const f = await gateTestFixture(true);
    let waiting, forwarded;
    try {
      waiting = f.launch(gateSqlArgs);
      waiting.child.stdin.end();
      await waitForImpactGateReady({
        client: waiting,
        readReady: f.gate.readReady,
        expiresAt: f.gate.expiresAt,
      });
      waiting.child.kill("SIGTERM");
      expect((await waiting.completion).status).toBe(1);
      await expect(readFile(f.marker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      forwarded = f.launch(gateInfoArgs);
      forwarded.child.stdin.end();
      const pid = Number(await waitGateMarker(f.marker));
      forwarded.child.kill("SIGTERM");
      expect((await forwarded.completion).status).toBe(1);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      waiting?.child.kill("SIGTERM");
      forwarded?.child.kill("SIGTERM");
      await f.gate.cleanup();
      await rm(f.root, { recursive: true });
    }
  });
  it("refuses expired gates before invoking even an allowlisted child", async () => {
    const f = await gateTestFixture();
    try {
      await expect(
        runImpactGateWrapper(
          {
            root: f.root,
            docker: f.docker,
            binding: gateBinding,
            expiresAt: Date.now() - 1,
          },
          gateInfoArgs,
        ),
      ).rejects.toThrow();
      await expect(readFile(f.marker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.gate.cleanup();
      await rm(f.root, { recursive: true });
    }
  });
});

describe("remaining impact lock/cancellation holder phases", () => {
  it("releases the observed backend holder before delayed CLI postvalidation while still checking the full result", async () => {
    let clock = 0,
      heldAt = null,
      releasedAt = null;
    const stages = [];
    const expected = {
      status: 1,
      fault: false,
      stdout: JSON.stringify(
        sample(Array(7).fill(null), Array(7).fill("lock_timeout")),
      ),
    };
    const client = {
      child: { kill: vi.fn() },
      stop: vi.fn(),
      get completion() {
        expect(releasedAt).not.toBe(null);
        stages.push("public-result");
        clock += 9000;
        return Promise.resolve(expected);
      },
    };
    const outcome = await completeImpactBlockedMeasurement({
      client,
      startedAt: 0,
      now: () => clock,
      awaitReady: async () => {
        clock += 6000;
        expect(heldAt).toBe(null);
        stages.push("ready");
      },
      hold: async () => {
        heldAt = clock;
        stages.push("hold");
        return { owned: true };
      },
      releaseGate: async () => stages.push("sql-release"),
      waitForLock: async () => {
        clock += 100;
        return 42;
      },
      waitForBackendGone: async (pid) => {
        expect(pid).toBe(42);
        clock += 1000;
        stages.push("backend-gone");
      },
      releaseHolder: async (holder) => {
        expect(holder).toEqual({ owned: true });
        releasedAt = clock;
        stages.push("holder-release");
      },
    });
    expect(releasedAt - heldAt).toBe(1100);
    expect(outcome.elapsedMilliseconds).toBe(16100);
    expect(stages).toEqual([
      "ready",
      "hold",
      "sql-release",
      "backend-gone",
      "holder-release",
      "public-result",
    ]);
    expect(outcome.result).toBe(expected);
    expect(
      assertImpactFixtureCounts(
        JSON.parse(outcome.result.stdout),
        options(Array(7).fill(null), Array(7).fill("lock_timeout")),
      ),
    ).toBeDefined();
  });
  it("does not ignore long full-CLI postvalidation or an expired holder release", async () => {
    const make = (badRelease = false) => {
      let clock = 0;
      return {
        client: {
          child: { kill: vi.fn() },
          stop: vi.fn(),
          get completion() {
            clock += 30001;
            return Promise.resolve({ status: 1 });
          },
        },
        startedAt: 0,
        now: () => clock,
        awaitReady: async () => {},
        hold: async () => ({}),
        releaseGate: async () => {},
        waitForLock: async () => 42,
        waitForBackendGone: async () => {},
        releaseHolder: async () => {
          if (badRelease) throw new Error("expired holder");
        },
      };
    };
    await expect(completeImpactBlockedMeasurement(make())).rejects.toThrow();
    await expect(completeImpactBlockedMeasurement(make(true))).rejects.toThrow(
      "expired holder",
    );
  });
  it("ticks the unchanged 10s cancellation bound while backend/holder cleanup is still pending", async () => {
    vi.useFakeTimers();
    let backendDone,
      cliDone,
      released = false;
    const backend = new Promise((resolve) => (backendDone = resolve)),
      completion = new Promise((resolve) => (cliDone = resolve));
    const client = { child: { kill: vi.fn() }, stop: vi.fn(), completion };
    const promise = completeImpactBlockedMeasurement({
      client,
      cancel: true,
      startedAt: Date.now(),
      now: () => Date.now(),
      awaitReady: async () => {},
      hold: async () => ({}),
      releaseGate: async () => {},
      waitForLock: async () => 42,
      waitForBackendGone: () => backend,
      releaseHolder: async () => {
        released = true;
      },
    });
    const check = expect(promise).rejects.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.child.kill).toHaveBeenCalledWith("SIGINT");
      await vi.advanceTimersByTimeAsync(10000);
      await check;
      expect(client.stop).toHaveBeenCalledOnce();
      expect(released).toBe(false);
      backendDone();
      cliDone({ status: 130 });
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});
