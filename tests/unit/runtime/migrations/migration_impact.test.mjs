import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndActivateBaseline } from "../../../../dist/src/baseline/artifact.mjs";
import {
  inspectMigrationImpact,
  measureMigrationImpact,
  renderMigrationImpact,
} from "../../../../dist/src/runtime/migrations/migration_impact.mjs";
import { MigrationImpactRuntimeError } from "../../../../dist/src/targets/migration_impact_runtime.mjs";
import { inspectMigrationReviewPlan } from "../../../../dist/src/runtime/migrations/migration_plan.mjs";
import { runWithOperationCancellation } from "../../../../dist/src/shared/cancellation.mjs";

const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const configuration = pathToFileURL(
  join(process.cwd(), "dist/src/project/configuration.mjs"),
).href;
const sourcePath = (root) =>
  join(root, "database/migrations/20260101000100_change.sql");
const makeWritable = async (path) => {
  await chmod(path, 0o700).catch(() => {});
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
};
const fixture = async (
  sql = "ALTER TABLE public.private_parent ALTER COLUMN private_payload SET NOT NULL;",
) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-impact-"));
  roots.push(root);
  await mkdir(join(root, "database/migrations"), { recursive: true });
  const historical = {
    filename: "20260101000000_create_widgets.sql",
    content: "create table public.widgets(id integer);\n",
  };
  const policy = JSON.stringify({
    policyVersion: 1,
    migrationCutoff: "20260101000000",
    tables: [
      {
        name: "widgets",
        sourceRows: "STREAM AND SANITIZE",
        columns: [
          {
            name: "id",
            action: "KEEP",
            generated: "NEVER",
            identity: "NO",
            foreignKey: null,
          },
        ],
      },
    ],
  });
  await writeFile(join(root, "policy.json"), policy);
  await writeFile(
    join(root, "database/migrations", historical.filename),
    historical.content,
  );
  await writeFile(sourcePath(root), sql);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "synthetic-impact" }),
  );
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `import {defineRehearsalConfig} from ${JSON.stringify(configuration)};
export default defineRehearsalConfig({schemaVersion:1,project:{name:"synthetic-impact"},postgresql:{migrationDirectory:"database/migrations",runtimeWorkdir:".rehearsal/runtime",image:"postgres:17-alpine",database:"postgres",user:"postgres"},baseline:{artifactDirectory:".rehearsal",sanitizationPolicy:"policy.json"},application:{startCommand:"node no-start.mjs",proofCommand:"node no-proof.mjs"},runtime:{target:"postgresql",applicationUrl:"http://127.0.0.1:5275",projectId:"synthetic-impact",databasePort:59422}});`,
  );
  await createAndActivateBaseline({
    artifactRoot: join(root, ".rehearsal"),
    generationId: "20260101T000000Z-aaaaaaaaaaaa",
    records: [{ table: "widgets", row: { id: 1 } }],
    metadata: {
      migrationCutoff: "20260101000000",
      migrationHistorySha256: "a".repeat(64),
      sanitizationPolicySha256: digest(policy),
    },
    expectedTables: ["widgets"],
    migrationFiles: [historical],
  });
  return root;
};
const output = (counts = ["2"]) =>
  JSON.stringify({ snapshotAt: "2026-10-22T16:00:00.000Z" }) +
  "\n" +
  counts
    .map((count, index) =>
      JSON.stringify({
        index,
        count,
        reason: count === null ? "unsupported_runtime_metadata" : null,
      }),
    )
    .join("\n");
const runtime = (stdout = output()) => {
  const scripts = [];
  return {
    identitySha256: "b".repeat(64),
    scripts,
    runSql: vi.fn(async (input) => {
      scripts.push(typeof input === "function" ? input() : input);
      return stdout;
    }),
    assertCurrent: vi.fn(async () => {}),
  };
};
const measure = async (root, transport = runtime(), confirmation) => {
  const preview = await inspectMigrationImpact(
    { projectRoot: root },
    "primary",
  );
  const openRuntime = vi.fn(async () => transport);
  const report = await measureMigrationImpact(
    {
      options: { projectRoot: root },
      targetName: "primary",
      confirmation: confirmation ?? preview.candidateSha256,
    },
    { openRuntime },
  );
  return { preview, report, transport, openRuntime };
};
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("exact aggregate impact review and projection", () => {
  it("requires one explicit target and does not contact the runtime during preview", async () => {
    const root = await fixture();
    await expect(
      inspectMigrationImpact({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    await expect(
      inspectMigrationImpact({ projectRoot: root }, "all"),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    const before = await inspectMigrationReviewPlan({ projectRoot: root });
    const report = await inspectMigrationImpact(
      { projectRoot: root },
      "primary",
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: "preview",
      measurementStatus: "planned",
      candidateSha256: before.candidateSha256,
      summary: { plannedCount: 1, measuredCount: 0 },
      snapshotAt: null,
      runtimeIdentitySha256: null,
      safety: {
        contactsDatabase: false,
        appliesMigrations: false,
        startsOrRepairsRuntime: false,
      },
    });
    expect(report.entries[0].measurements[0]).toMatchObject({
      metric: "nulls",
      evidence: "planned",
      count: null,
    });
    expect(JSON.stringify(report)).not.toContain("private_parent");
    expect(JSON.stringify(report)).not.toContain("private_payload");
    expect(renderMigrationImpact(report)).toContain(
      "do not simulate sequential",
    );
  });

  it("refuses missing and stale whole-plan consent before opening a runtime", async () => {
    const root = await fixture();
    const openRuntime = vi.fn();
    for (const confirmation of [undefined, "0".repeat(64)])
      await expect(
        measureMigrationImpact(
          {
            options: { projectRoot: root },
            targetName: "primary",
            confirmation,
          },
          { openRuntime },
        ),
      ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("returns only exact decimal counts, fixed kinds and a server snapshot", async () => {
    const root = await fixture(
      "-- PRIVATE_SQL_CANARY\nALTER TABLE public.private_parent ALTER COLUMN private_payload SET NOT NULL;",
    );
    const before = await readFile(sourcePath(root));
    const { report, transport, openRuntime } = await measure(
      root,
      runtime(output(["9007199254740993"])),
    );
    expect(report).toMatchObject({
      mode: "measurement",
      measurementStatus: "measured",
      snapshotAt: "2026-10-22T16:00:00.000Z",
      runtimeIdentitySha256: "b".repeat(64),
      safety: {
        contactsDatabase: true,
        transaction: "repeatable_read_read_only",
        returnsRowContents: false,
        returnsSqlOrObjectNames: false,
      },
      summary: { measuredCount: 1, unknownEntryCount: 0 },
    });
    expect(report.entries[0].measurements[0]).toMatchObject({
      evidence: "measured_current_snapshot",
      count: "9007199254740993",
      unknownReason: null,
    });
    expect(openRuntime).toHaveBeenCalledOnce();
    expect(openRuntime.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(transport.assertCurrent).toHaveBeenCalledOnce();
    expect(transport.scripts[0]).toContain("repeatable read read only");
    expect(transport.scripts[0]).not.toContain("PRIVATE_SQL_CANARY");
    for (const value of [JSON.stringify(report), renderMigrationImpact(report)])
      for (const canary of [
        "private_parent",
        "private_payload",
        "PRIVATE_SQL_CANARY",
      ])
        expect(value).not.toContain(canary);
    expect(await readFile(sourcePath(root))).toEqual(before);
  });

  it("keeps partial/unsupported evidence unknown rather than converting it to zero or a safe verdict", async () => {
    const root = await fixture(
      "DELETE FROM public.private_parent; SELECT private_function();",
    );
    const { report } = await measure(root, runtime(output(["0"])));
    expect(report.measurementStatus).toBe("partial");
    expect(report.summary).toMatchObject({
      measuredCount: 1,
      unknownEntryCount: 1,
    });
    expect(report.entries[0]).toMatchObject({
      unknownReasons: ["unsupported_sql"],
      coverage: "incomplete",
    });
    expect(report.entries[0].measurements[0].count).toBe("0");
    expect(report).not.toHaveProperty("safe");
    expect(report).not.toHaveProperty("verdict");
  });

  it("does not open a database for wholly unsupported SQL", async () => {
    const root = await fixture(
      "UPDATE public.private_parent SET payload = private_function();",
    );
    const { report, openRuntime } = await measure(root);
    expect(openRuntime).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      measurementStatus: "unknown",
      safety: { contactsDatabase: false },
      summary: { plannedCount: 0, unknownEntryCount: 1 },
    });
  });

  it("marks unsupported runtime metadata and older server guards as unknown", async () => {
    const root = await fixture();
    const unknown = await measure(root, runtime(output([null])));
    expect(unknown.report).toMatchObject({
      measurementStatus: "unknown",
      summary: { unknownMeasurementCount: 1 },
      safety: { contactsDatabase: true },
    });
    expect(unknown.report.entries[0].measurements[0]).toMatchObject({
      count: null,
      unknownReason: "unsupported_runtime_metadata",
    });
    const older = await measure(
      root,
      runtime('{"unsupportedServerVersion":true}'),
    );
    expect(older.report).toMatchObject({
      measurementStatus: "unknown",
      snapshotAt: null,
    });
    expect(older.report.entries[0].measurements[0]).toMatchObject({
      count: null,
      unknownReason: "unsupported_server_version",
    });
  });

  it.each(["runtime_unavailable", "ownership_mismatch", "stale_runtime"])(
    "refuses %s without repairing a runtime or returning counts",
    async (reason) => {
      const root = await fixture();
      const preview = await inspectMigrationImpact(
        { projectRoot: root },
        "primary",
      );
      await expect(
        measureMigrationImpact(
          {
            options: { projectRoot: root },
            targetName: "primary",
            confirmation: preview.candidateSha256,
          },
          {
            openRuntime: async () => {
              throw new MigrationImpactRuntimeError(reason);
            },
          },
        ),
      ).rejects.toMatchObject({
        category: "unsafe_environment",
        code: "UNSAFE_ENVIRONMENT",
      });
    },
  );

  it.each([
    "lock_timeout",
    "statement_timeout",
    "transaction_timeout",
    "query_failed",
  ])(
    "reports %s without leaking provider output or a stale count",
    async (reason) => {
      const root = await fixture();
      const transport = runtime();
      transport.runSql.mockRejectedValueOnce(
        new MigrationImpactRuntimeError(reason),
      );
      const { report } = await measure(root, transport);
      expect(report).toMatchObject({
        measurementStatus: "unknown",
        snapshotAt: null,
        runtimeIdentitySha256: null,
        safety: { contactsDatabase: true },
      });
      expect(report.entries[0].measurements[0]).toMatchObject({
        count: null,
        unknownReason:
          reason === "transaction_timeout" ? "total_timeout" : reason,
      });
    },
  );

  it("rejects row/provider/SQL canary output rather than reflecting it", async () => {
    const root = await fixture();
    const { report } = await measure(
      root,
      runtime(
        "PRIVATE_SQL_CANARY PRIVATE_ROW_CANARY postgresql://private:private@private/db",
      ),
    );
    expect(report.measurementStatus).toBe("unknown");
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|postgresql:\/\//u);
  });

  it("discards counts if source changes while the query is in flight", async () => {
    const root = await fixture();
    const transport = runtime();
    transport.runSql.mockImplementationOnce(async () => {
      await writeFile(sourcePath(root), "TRUNCATE public.private_parent;");
      return output();
    });
    await expect(measure(root, transport)).rejects.toMatchObject({
      code: "CONFIGURATION_INVALID",
    });
  });

  it("discards counts if the owned runtime changes after query completion", async () => {
    const root = await fixture();
    const transport = runtime();
    transport.assertCurrent.mockRejectedValueOnce(
      new MigrationImpactRuntimeError("stale_runtime"),
    );
    await expect(measure(root, transport)).rejects.toMatchObject({
      category: "unsafe_environment",
    });
  });

  it("caps aggregate work across files and marks the omitted portion unknown", async () => {
    const root = await fixture(
      "DELETE FROM public.private_parent;\n".repeat(90),
    );
    await writeFile(
      join(root, "database/migrations/20260101000200_more.sql"),
      "DELETE FROM public.private_parent;\n".repeat(20),
    );
    const report = await inspectMigrationImpact(
      { projectRoot: root },
      "primary",
    );
    expect(report.summary.plannedCount).toBe(100);
    expect(report.summary.unknownEntryCount).toBe(1);
    expect(report.entries[1].unknownReasons).toContain("input_limit");
    expect(report.entries[1].measurements).toHaveLength(10);
  });

  it("uses the whole-operation injected clock budget without inventing a database cancellation proof", async () => {
    const root = await fixture();
    const preview = await inspectMigrationImpact(
      { projectRoot: root },
      "primary",
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    let suppliedSignal;
    const transport = runtime();
    const operation = measureMigrationImpact(
      {
        options: { projectRoot: root },
        targetName: "primary",
        confirmation: preview.candidateSha256,
      },
      {
        openRuntime: async ({ signal }) => {
          suppliedSignal = signal;
          transport.runSql.mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => reject(new MigrationImpactRuntimeError("cancelled")),
                  { once: true },
                );
                began();
              }),
          );
          return transport;
        },
      },
    );
    await started;
    await vi.advanceTimersByTimeAsync(30000);
    const report = await operation;
    expect(suppliedSignal.aborted).toBe(true);
    expect(report).toMatchObject({
      measurementStatus: "unknown",
      snapshotAt: null,
      safety: { contactsDatabase: true },
    });
    expect(report.entries[0].measurements[0]).toMatchObject({
      count: null,
      unknownReason: "total_timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("projects an expired preparation budget without opening the runtime or leaking an internal cancellation", async () => {
    const root = await fixture();
    const preview = await inspectMigrationImpact(
      { projectRoot: root },
      "primary",
    );
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(30001);
    const openRuntime = vi.fn();
    const report = await measureMigrationImpact(
      {
        options: { projectRoot: root },
        targetName: "primary",
        confirmation: preview.candidateSha256,
      },
      { openRuntime },
    );
    expect(openRuntime).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      measurementStatus: "unknown",
      snapshotAt: null,
      safety: { contactsDatabase: false },
    });
    expect(report.entries[0].measurements[0]).toMatchObject({
      count: null,
      unknownReason: "total_timeout",
    });
  });

  it("derives the server budget after transport preflight rather than before it", async () => {
    const root = await fixture();
    const preview = await inspectMigrationImpact(
      { projectRoot: root },
      "primary",
    );
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const transport = runtime();
    transport.runSql.mockImplementationOnce(async (compile) => {
      // A transport preflight consumed28s; only the remaining2s may be submitted.
      clock.mockReturnValue(29000);
      expect(compile()).toContain("transaction_timeout = '2000ms'");
      return output();
    });
    const report = await measureMigrationImpact(
      {
        options: { projectRoot: root },
        targetName: "primary",
        confirmation: preview.candidateSha256,
      },
      { openRuntime: async () => transport },
    );
    expect(report.measurementStatus).toBe("measured");
  });

  it("propagates real package cancellation as exit130 instead of a completed unknown report", async () => {
    const root = await fixture();
    const preview = await inspectMigrationImpact(
      { projectRoot: root },
      "primary",
    );
    const signals = new EventEmitter();
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const transport = runtime();
    const operation = runWithOperationCancellation({
      signalTarget: signals,
      input: null,
      task: async () =>
        measureMigrationImpact(
          {
            options: { projectRoot: root },
            targetName: "primary",
            confirmation: preview.candidateSha256,
          },
          {
            openRuntime: async ({ signal }) => {
              transport.runSql.mockImplementationOnce(
                () =>
                  new Promise((_resolve, reject) => {
                    signal.addEventListener(
                      "abort",
                      () =>
                        reject(new MigrationImpactRuntimeError("cancelled")),
                      { once: true },
                    );
                    began();
                  }),
              );
              return transport;
            },
          },
        ),
    });
    const rejected = expect(operation).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
      exitCode: 130,
    });
    await started;
    signals.emit("SIGTERM");
    await rejected;
    expect(signals.eventNames()).toEqual([]);
  });
});
