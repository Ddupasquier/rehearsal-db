import { expect, it } from "vitest";
import { createPostgresqlMigrationRuntime } from "../../../dist/src/targets/postgresql/postgresql_migrations.mjs";
import { PostgresqlTransportError } from "../../../dist/src/targets/postgresql/postgresql_process.mjs";
import { EventEmitter } from "node:events";
import { runWithOperationCancellation } from "../../../dist/src/shared/cancellation.mjs";
import { drizzleTool } from "../../helpers/drizzle_fixture.mjs";
const entries = [
  {
    nativeIdentity: {
      kind: "drizzle",
      idx: 0,
      when: 1720000000000,
      tag: "z_init",
    },
    filename: "z_init.sql",
    name: "z_init",
    fileSha256: "a".repeat(64),
    breakpoints: true,
  },
  {
    nativeIdentity: {
      kind: "drizzle",
      idx: 1,
      when: 1720000001000,
      tag: "a_index",
    },
    filename: "a_index.sql",
    name: "a_index",
    fileSha256: "b".repeat(64),
    breakpoints: true,
  },
];
const baseline = {
  formatVersion: 4,
  migrations: {
    "z_init.sql": { sha256: entries[0].fileSha256 },
    "a_index.sql": { sha256: entries[1].fileSha256 },
  },
};
const rows = entries.map((entry, i) => ({
  id: i + 1,
  hash: entry.fileSha256,
  created_at: String(entry.nativeIdentity.when),
}));
function runtime(ledger, assertOwnedTarget = () => "c".repeat(64)) {
  return createPostgresqlMigrationRuntime({
    loaded: { config: { postgresql: { migrationTool: drizzleTool } } },
    runSql: (sql) => {
      expect(sql).toContain("drizzle.__drizzle_migrations");
      expect(sql).not.toContain("_prisma_migrations");
      return JSON.stringify(ledger);
    },
    assertOwnedTarget,
    assertExpectedBaseline: async () => {},
    containerName: "synthetic",
    database: "postgres",
    databaseUser: "postgres",
  });
}
it("checks native hash/timestamp replay identity independently of source serial-ID gaps", async () => {
  expect(
    (await runtime(rows).verifyLedger({ currentFiles: entries, baseline }))
      .appliedCandidateCount,
  ).toBe(0);
  expect(
    (
      await runtime(
        rows.map((row, i) => ({ ...row, id: i ? 8 : 2 })),
      ).verifyLedger({
        currentFiles: entries,
        baseline,
      })
    ).appliedCandidateCount,
  ).toBe(0);
});
it("refuses missing, divergent or reordered native ledger before migration dispatch", async () => {
  for (const ledger of [
    rows.slice(0, 1),
    [{ ...rows[0], hash: "d".repeat(64) }, rows[1]],
    rows.toReversed(),
    [{ ...rows[0], created_at: 1720000000001 }, rows[1]],
  ])
    await expect(
      runtime(ledger).verifyLedger({ currentFiles: entries, baseline }),
    ).rejects.toThrow();
});
it("requires target ownership before querying native ledger", async () => {
  await expect(
    runtime(rows, () => {
      throw new Error("foreign target refused");
    }).verifyLedger({ currentFiles: entries, baseline }),
  ).rejects.toThrow("foreign target refused");
});

it("awaits native target ownership and ledger transport before exposing verification", async () => {
  const delayed = runtime(rows, async () => {
    await new Promise((done) => setImmediate(done));
    return "c".repeat(64);
  });
  expect(
    (await delayed.verifyLedger({ currentFiles: entries, baseline }))
      .appliedCandidateCount,
  ).toBe(0);
  await expect(
    runtime(rows, async () => {
      throw Error("async target refused");
    }).verifyLedger({ currentFiles: entries, baseline }),
  ).rejects.toThrow("async target refused");
});

it("preserves typed transport uncertainty through Drizzle ledger parsing and operation cancellation", async () => {
  const failure = new PostgresqlTransportError();
  const signals = new EventEmitter();
  const guarded = createPostgresqlMigrationRuntime({
    loaded: { config: { postgresql: { migrationTool: drizzleTool } } },
    runSql: async () => {
      signals.emit("SIGINT");
      throw failure;
    },
    assertOwnedTarget: async () => "c".repeat(64),
    assertExpectedBaseline: async () => {},
    containerName: "synthetic",
    database: "postgres",
    databaseUser: "postgres",
  });
  await expect(
    runWithOperationCancellation({
      signalTarget: signals,
      input: null,
      task: () => guarded.verifyLedger({ currentFiles: entries, baseline }),
    }),
  ).rejects.toBe(failure);
});
