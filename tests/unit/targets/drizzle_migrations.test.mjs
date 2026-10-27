import { expect, it } from "vitest";
import { createPostgresqlMigrationRuntime } from "../../../dist/src/targets/postgresql_migrations.mjs";
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
it("checks native hash/timestamp replay identity independently of source serial-ID gaps", () => {
  expect(
    runtime(rows).verifyLedger({ currentFiles: entries, baseline })
      .appliedCandidateCount,
  ).toBe(0);
  expect(
    runtime(rows.map((row, i) => ({ ...row, id: i ? 8 : 2 }))).verifyLedger({
      currentFiles: entries,
      baseline,
    }).appliedCandidateCount,
  ).toBe(0);
});
it("refuses missing, divergent or reordered native ledger before migration dispatch", () => {
  for (const ledger of [
    rows.slice(0, 1),
    [{ ...rows[0], hash: "d".repeat(64) }, rows[1]],
    rows.toReversed(),
    [{ ...rows[0], created_at: 1720000000001 }, rows[1]],
  ])
    expect(() =>
      runtime(ledger).verifyLedger({ currentFiles: entries, baseline }),
    ).toThrow();
});
it("requires target ownership before querying native ledger", () => {
  expect(() =>
    runtime(rows, () => {
      throw new Error("foreign target refused");
    }).verifyLedger({ currentFiles: entries, baseline }),
  ).toThrow("foreign target refused");
});
