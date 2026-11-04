import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  symlink,
  link,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqliteWorkerJob as executeWorkerJob } from "../../../../dist/src/targets/sqlite/sqlite_worker_process.mjs";
// Each standalone migration fixture owns an exclusive preclaimed DELETE journal.
const runSqliteWorkerJob = async (job, options) => {
  if (job.operation !== "migrate" || job.expectedJournal)
    return executeWorkerJob(job, options);
  const path = job.databasePath + "-journal",
    fd = openSync(path, "wx+", 0o600),
    s = fstatSync(fd, { bigint: true });
  let closed = false;
  try {
    const result = await executeWorkerJob(
      {
        ...job,
        expectedJournal: {
          dev: String(s.dev),
          ino: String(s.ino),
          birthtimeNs: String(s.birthtimeNs),
        },
      },
      options,
    );
    closed = true;
    return result;
  } catch (error) {
    closed = error.cleanupUnconfirmed === false;
    throw error;
  } finally {
    if (closed && existsSync(path)) {
      const current = lstatSync(path, { bigint: true });
      if (
        current.dev === s.dev &&
        current.ino === s.ino &&
        current.birthtimeNs === s.birthtimeNs &&
        current.size === 0n
      )
        unlinkSync(path);
    }
    closeSync(fd);
  }
};
const probe = new DatabaseSync(":memory:");
const qualified =
  probe.prepare("SELECT sqlite_version() AS v").get().v === "3.53.4" &&
  typeof probe.setAuthorizer === "function" &&
  typeof probe.enableDefensive === "function";
probe.close();
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const max = 64 * 1024 * 1024;
const migration = (sql, filename = "001_change.sql") => ({
  filename,
  sql,
  sha256: createHash("sha256").update(sql).digest("hex"),
});
const fixture = async (
  sql = "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'PRIVATE_SQLITE_CANARY');",
  runtime = false,
) => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-worker-"));
  roots.push(root);
  const databasePath = join(root, "source.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(sql);
  if (runtime)
    db.exec(
      'CREATE TABLE "_rehearsal_sqlite_history" ("position" INTEGER PRIMARY KEY, "filename" TEXT NOT NULL UNIQUE, "sha256" TEXT NOT NULL)',
    );
  db.close();
  return {
    root,
    databasePath,
    destinationDatabase: join(root, "baseline.sqlite"),
  };
};
const policy = (tables) => ({
  policyVersion: 1,
  engine: "sqlite",
  tables: Object.entries(tables).map(([name, columns]) => ({
    name,
    columns: columns.map((name) => ({ name, action: "KEEP" })),
  })),
});
const verify = (databasePath, expectedHistory = []) =>
  runSqliteWorkerJob({
    operation: "verify",
    databasePath,
    expectedHistory,
    maximumBytes: max,
  });
describe.skipIf(!qualified)("qualified SQLite worker", () => {
  it("probes the exact native capability without touching files", async () => {
    expect(
      await runSqliteWorkerJob({ operation: "probe", maximumBytes: max }),
    ).toMatchObject({
      sqliteVersion: "3.53.4",
      tableCount: 0,
      rowCount: 0,
      history: [],
    });
  });
  it("rebuilds sanitized typed rows, constraints, indexes, triggers and sequence without executing copy triggers", async () => {
    const f = await fixture(
      `PRAGMA foreign_keys=ON; CREATE TABLE parents(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT); CREATE TABLE children(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES parents(id),b BLOB,n INTEGER,r REAL,z TEXT); CREATE TABLE audit(id INTEGER); CREATE INDEX children_parent ON children(parent); INSERT INTO parents VALUES(7,'PRIVATE_SQLITE_CANARY'); INSERT INTO children VALUES(1,7,x'00ff',9223372036854775806,1.25,NULL); UPDATE sqlite_sequence SET seq=50 WHERE name='parents'; CREATE TRIGGER child_audit AFTER INSERT ON children BEGIN INSERT INTO audit VALUES(NEW.id); END;`,
    );
    const p = policy({
      parents: ["id", "value"],
      children: ["id", "parent", "b", "n", "r", "z"],
      audit: ["id"],
    });
    p.tables[0].columns[1] = {
      name: "value",
      action: "REPLACE",
      value: "公開é",
    };
    const result = await runSqliteWorkerJob({
      operation: "snapshot",
      history: [],
      sourceDatabase: f.databasePath,
      destinationDatabase: f.destinationDatabase,
      policy: p,
      maximumBytes: max,
    });
    expect(result).toMatchObject({
      sqliteVersion: "3.53.4",
      tableCount: 3,
      rowCount: 2,
    });
    const db = new DatabaseSync(f.destinationDatabase);
    const query = db.prepare("SELECT * FROM children");
    query.setReadBigInts(true);
    expect(query.get()).toMatchObject({
      n: 9223372036854775806n,
      r: 1.25,
      z: null,
    });
    expect([...query.get().b]).toEqual([0, 255]);
    expect(db.prepare("SELECT value FROM parents").get().value).toBe("公開é");
    expect(db.prepare("SELECT count(*) AS n FROM audit").get().n).toBe(0);
    db.exec(
      "INSERT INTO parents(value) VALUES('new'); INSERT INTO children(id,parent) VALUES(2,51);",
    );
    expect(db.prepare("SELECT count(*) AS n FROM audit").get().n).toBe(1);
    db.close();
    expect(
      (await readFile(f.destinationDatabase)).includes(
        Buffer.from("PRIVATE_SQLITE_CANARY"),
      ),
    ).toBe(false);
    expect(
      (await readdir(f.root)).some((name) => name.startsWith(".sqlite-")),
    ).toBe(false);
    expect(await verify(f.destinationDatabase)).toMatchObject({ rowCount: 5 });
  });
  it.each([
    [41, 1196444487],
    [-12, 2147483647],
  ])(
    "preserves source application metadata and binds later drift (%s,%s)",
    async (userVersion, applicationId) => {
      const f = await fixture(
        `PRAGMA user_version=${userVersion}; PRAGMA application_id=${applicationId}; CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'safe');`,
      );
      const result = await runSqliteWorkerJob({
        operation: "snapshot",
        sourceDatabase: f.databasePath,
        destinationDatabase: f.destinationDatabase,
        history: [],
        policy: policy({ items: ["id", "value"] }),
        maximumBytes: max,
      });
      const db = new DatabaseSync(f.destinationDatabase);
      try {
        expect(db.prepare("PRAGMA user_version").get().user_version).toBe(
          userVersion,
        );
        expect(db.prepare("PRAGMA application_id").get().application_id).toBe(
          applicationId,
        );
        expect((await verify(f.destinationDatabase)).schemaSha256).toBe(
          result.schemaSha256,
        );
        db.exec(`PRAGMA user_version=${userVersion + 1};`);
        expect((await verify(f.destinationDatabase)).schemaSha256).not.toBe(
          result.schemaSha256,
        );
      } finally {
        db.close();
      }
    },
  );
  it("preserves gapped 64-bit implicit rowids, shadowed aliases and WITHOUT ROWID keys", async () => {
    const f = await fixture(
      "CREATE TABLE ordinary(value TEXT); INSERT INTO ordinary(rowid,value) VALUES(-9,'a'),(9007199254740993,'b'); CREATE TABLE shadow(rowid TEXT,value TEXT); INSERT INTO shadow(_rowid_,rowid,value) VALUES(41,'declared','c'); CREATE TABLE descending(id INTEGER PRIMARY KEY DESC,value TEXT); INSERT INTO descending(rowid,id,value) VALUES(71,8,'d'); CREATE TABLE keyed(id TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID; INSERT INTO keyed VALUES('key','e');",
    );
    await runSqliteWorkerJob({
      operation: "snapshot",
      sourceDatabase: f.databasePath,
      destinationDatabase: f.destinationDatabase,
      history: [],
      maximumBytes: max,
      policy: policy({
        ordinary: ["value"],
        shadow: ["rowid", "value"],
        descending: ["id", "value"],
        keyed: ["id", "value"],
      }),
    });
    const db = new DatabaseSync(f.destinationDatabase);
    try {
      const q = db.prepare("SELECT rowid,value FROM ordinary ORDER BY rowid");
      q.setReadBigInts(true);
      expect(q.all().map((row) => [row.rowid, row.value])).toEqual([
        [-9n, "a"],
        [9007199254740993n, "b"],
      ]);
      expect(
        db.prepare("SELECT _rowid_ AS actual,rowid FROM shadow").get(),
      ).toMatchObject({ actual: 41, rowid: "declared" });
      expect(db.prepare("SELECT rowid,id FROM descending").get()).toMatchObject(
        { rowid: 71, id: 8 },
      );
      expect(db.prepare("SELECT * FROM keyed").get()).toMatchObject({
        id: "key",
        value: "e",
      });
    } finally {
      db.close();
    }
  });
  it("honors an explicit INTEGER PRIMARY KEY replacement and refuses inaccessible implicit rowids", async () => {
    const f = await fixture(
      "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(42,'keep');",
    );
    const p = policy({ items: ["id", "value"] });
    p.tables[0].columns[0] = { name: "id", action: "REPLACE", value: 7 };
    await runSqliteWorkerJob({
      operation: "snapshot",
      sourceDatabase: f.databasePath,
      destinationDatabase: f.destinationDatabase,
      history: [],
      maximumBytes: max,
      policy: p,
    });
    const db = new DatabaseSync(f.destinationDatabase);
    try {
      expect(db.prepare("SELECT id FROM items").get().id).toBe(7);
    } finally {
      db.close();
    }
    const hidden = await fixture(
      "CREATE TABLE hidden(rowid TEXT,_rowid_ TEXT,oid TEXT); INSERT INTO hidden VALUES('a','b','c');",
    );
    await expect(
      runSqliteWorkerJob({
        operation: "snapshot",
        sourceDatabase: hidden.databasePath,
        destinationDatabase: hidden.destinationDatabase,
        history: [],
        maximumBytes: max,
        policy: policy({ hidden: ["rowid", "_rowid_", "oid"] }),
      }),
    ).rejects.toMatchObject({ kind: "operation" });
    expect(existsSync(hidden.destinationDatabase)).toBe(false);
  });
  it("backs up an active WAL reader consistently without altering source rows", async () => {
    const f = await fixture();
    const writer = new DatabaseSync(f.databasePath);
    try {
      writer.exec(
        "PRAGMA journal_mode=WAL; INSERT INTO items VALUES(2,'committed'); BEGIN IMMEDIATE; INSERT INTO items VALUES(3,'uncommitted');",
      );
      const result = await runSqliteWorkerJob({
        operation: "snapshot",
        history: [],
        sourceDatabase: f.databasePath,
        destinationDatabase: f.destinationDatabase,
        policy: policy({ items: ["id", "value"] }),
        maximumBytes: max,
      });
      expect(result.rowCount).toBe(2);
      expect(writer.prepare("SELECT count(*) AS n FROM items").get().n).toBe(3);
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });
  it("commits an entire valid batch and rolls back earlier statements when a later statement fails", async () => {
    const f = await fixture(undefined, true);
    const prior = migration("CREATE INDEX item_value ON items(value);");
    await runSqliteWorkerJob({
      operation: "migrate",
      expectedHistory: [],
      databasePath: f.databasePath,
      maximumBytes: max,
      migrations: [prior],
    });
    await expect(
      runSqliteWorkerJob({
        operation: "migrate",
        expectedHistory: [{ filename: prior.filename, sha256: prior.sha256 }],
        databasePath: f.databasePath,
        maximumBytes: max,
        migrations: [
          migration("INSERT INTO items VALUES(2,'new');", "002_insert.sql"),
          migration(
            "INSERT INTO items VALUES(1,'duplicate');",
            "003_failure.sql",
          ),
        ],
      }),
    ).rejects.toThrow(/withheld/);
    const db = new DatabaseSync(f.databasePath);
    expect(db.prepare("SELECT count(*) AS n FROM items").get().n).toBe(1);
    db.close();
  });
  it.each([
    "ATTACH DATABASE ':memory:' AS other;",
    "PRAGMA foreign_keys=OFF;",
    "COMMIT;",
    "SELECT load_extension('PRIVATE_SQLITE_CANARY');",
    "CREATE VIRTUAL TABLE v USING fts5(x);",
  ])("refuses external or unsafe migration capability %#", async (sql) => {
    const f = await fixture(undefined, true);
    await expect(
      runSqliteWorkerJob({
        operation: "migrate",
        expectedHistory: [],
        databasePath: f.databasePath,
        maximumBytes: max,
        migrations: [migration(sql)],
      }),
    ).rejects.toThrow(/withheld/);
    expect((await verify(f.databasePath)).rowCount).toBe(1);
  });
  it("binds exact declared history and blocks direct or dormant trigger journal changes", async () => {
    const f = await fixture();
    const prior = migration(
      "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);",
      "001_original.sql",
    );
    const history = [{ filename: prior.filename, sha256: prior.sha256 }];
    await runSqliteWorkerJob({
      operation: "snapshot",
      sourceDatabase: f.databasePath,
      destinationDatabase: f.destinationDatabase,
      history,
      policy: policy({ items: ["id", "value"] }),
      maximumBytes: max,
    });
    expect((await verify(f.destinationDatabase, history)).history).toEqual(
      history,
    );
    await expect(verify(f.destinationDatabase, [])).rejects.toThrow(/withheld/);
    for (const sql of [
      "DELETE FROM _rehearsal_sqlite_history;",
      "CREATE TRIGGER evil AFTER INSERT ON items BEGIN DELETE FROM _rehearsal_sqlite_history; END;",
    ]) {
      await expect(
        runSqliteWorkerJob({
          operation: "migrate",
          databasePath: f.destinationDatabase,
          expectedHistory: history,
          migrations: [migration(sql, "002_attempt.sql")],
          maximumBytes: max,
        }),
      ).rejects.toThrow(/withheld/);
      expect((await verify(f.destinationDatabase, history)).history).toEqual(
        history,
      );
    }
    const next = migration(
      "ALTER TABLE items ADD COLUMN extra TEXT;",
      "002_next.sql",
    );
    const result = await runSqliteWorkerJob({
      operation: "migrate",
      databasePath: f.destinationDatabase,
      expectedHistory: history,
      migrations: [next],
      maximumBytes: max,
    });
    expect(result.history).toEqual([
      ...history,
      { filename: next.filename, sha256: next.sha256 },
    ]);
    expect(result.rowCount).toBe(1);
  });
  it("returns the maximum bounded history without truncation", async () => {
    const f = await fixture();
    const history = Array.from({ length: 1000 }, (_, index) => ({
      filename: `${String(index).padStart(4, "0")}_${"x".repeat(246)}.sql`,
      sha256: "a".repeat(64),
    }));
    const result = await runSqliteWorkerJob({
      operation: "snapshot",
      sourceDatabase: f.databasePath,
      destinationDatabase: f.destinationDatabase,
      history,
      policy: policy({ items: ["id", "value"] }),
      maximumBytes: max,
    });
    expect(result.history).toEqual(history);
    expect((await verify(f.destinationDatabase, history)).history).toEqual(
      history,
    );
  });
  it("refuses a source journal collision and preserves an existing destination", async () => {
    const f = await fixture(undefined, true);
    await expect(
      runSqliteWorkerJob({
        operation: "snapshot",
        sourceDatabase: f.databasePath,
        destinationDatabase: f.destinationDatabase,
        history: [],
        policy: policy({ items: ["id", "value"] }),
        maximumBytes: max,
      }),
    ).rejects.toThrow(/withheld/);
    await writeFile(f.destinationDatabase, "unrelated sentinel");
    await expect(
      runSqliteWorkerJob({
        operation: "snapshot",
        sourceDatabase: f.databasePath,
        destinationDatabase: f.destinationDatabase,
        history: [],
        policy: policy({ items: ["id", "value"] }),
        maximumBytes: max,
      }),
    ).rejects.toThrow(/withheld/);
    expect(await readFile(f.destinationDatabase, "utf8")).toBe(
      "unrelated sentinel",
    );
  });
  it("refuses a missing/replaced journal receipt before executing SQL", async () => {
    const f = await fixture(undefined, true);
    const job = {
      operation: "migrate",
      databasePath: f.databasePath,
      expectedHistory: [],
      maximumBytes: max,
      migrations: [migration("INSERT INTO items VALUES(2,'new');")],
    };
    await expect(executeWorkerJob(job)).rejects.toMatchObject({
      code: "SQLITE_OPERATION_FAILED",
    });
    const fd = openSync(f.databasePath + "-journal", "wx+", 0o600);
    const s = fstatSync(fd, { bigint: true });
    try {
      await expect(
        executeWorkerJob({
          ...job,
          expectedJournal: {
            dev: String(s.dev),
            ino: "0",
            birthtimeNs: String(s.birthtimeNs),
          },
        }),
      ).rejects.toMatchObject({ code: "SQLITE_OPERATION_FAILED" });
    } finally {
      closeSync(fd);
    }
    expect((await verify(f.databasePath)).rowCount).toBe(1);
  });
  it("interrupts sampled RSS excess and recovers prior transactional data writes", async () => {
    const f = await fixture(undefined, true),
      before = await readFile(f.databasePath);
    await expect(
      runSqliteWorkerJob({
        operation: "migrate",
        databasePath: f.databasePath,
        expectedHistory: [],
        maximumBytes: max,
        migrations: [
          migration(
            "UPDATE items SET value='temporary'; SELECT length(randomblob(300000000));",
          ),
        ],
      }),
    ).rejects.toMatchObject({
      code: "SQLITE_WORKER_MEMORY_LIMIT",
      kind: "memory-limit",
      cleanupUnconfirmed: false,
    });
    expect(await readFile(f.databasePath)).toEqual(before);
    expect((await verify(f.databasePath)).rowCount).toBe(1);
  });
  it("requires exhaustive privacy and refuses generated columns without publishing a destination", async () => {
    for (const sql of [
      undefined,
      "CREATE TABLE items(id INTEGER,value INTEGER GENERATED ALWAYS AS (id+1)); INSERT INTO items(id) VALUES(1);",
    ]) {
      const f = await fixture(sql);
      await expect(
        runSqliteWorkerJob({
          operation: "snapshot",
          history: [],
          sourceDatabase: f.databasePath,
          destinationDatabase: f.destinationDatabase,
          maximumBytes: max,
          policy: policy({ items: ["id"] }),
        }),
      ).rejects.toThrow(/withheld/);
      await expect(readFile(f.destinationDatabase)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
  it("rejects symbolic and hard-link file aliases", async () => {
    const f = await fixture();
    const symbolic = join(f.root, "symbolic.sqlite"),
      hard = join(f.root, "hard.sqlite");
    await symlink(f.databasePath, symbolic);
    await expect(verify(symbolic)).rejects.toThrow(/withheld/);
    await link(f.databasePath, hard);
    await expect(verify(hard)).rejects.toThrow(/withheld/);
  });
  it("rejects corrupted input, wrong migration digests and bounded database sizes without exposing row text", async () => {
    const f = await fixture(undefined, true);
    await expect(
      runSqliteWorkerJob({
        operation: "verify",
        expectedHistory: [],
        databasePath: f.databasePath,
        maximumBytes: 4096,
      }),
    ).rejects.toThrow(/withheld/);
    await expect(
      runSqliteWorkerJob({
        operation: "migrate",
        expectedHistory: [],
        databasePath: f.databasePath,
        maximumBytes: max,
        migrations: [{ ...migration("SELECT 1"), sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow(/withheld/);
    await writeFile(f.databasePath, "PRIVATE_SQLITE_CANARY");
    await expect(verify(f.databasePath)).rejects.toThrow(
      /^SQLite worker refused or failed; private diagnostics withheld; recovery retained\.$/,
    );
  });
  it("bounds a blocked writer and cancellation while preserving the existing database", async () => {
    const f = await fixture(undefined, true);
    const lock = new DatabaseSync(f.databasePath);
    lock.exec("BEGIN IMMEDIATE;");
    try {
      const job = {
        operation: "migrate",
        expectedHistory: [],
        databasePath: f.databasePath,
        maximumBytes: max,
        migrations: [migration("INSERT INTO items VALUES(2,'new');")],
      };
      await expect(
        runSqliteWorkerJob(job, { timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "SQLITE_WORKER_DEADLINE" });
      const controller = new AbortController();
      const pending = runSqliteWorkerJob(job, { signal: controller.signal });
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await expect(pending).rejects.toMatchObject({
          code: "SQLITE_WORKER_CANCELLED",
        });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      lock.exec("ROLLBACK;");
      lock.close();
    }
    expect((await verify(f.databasePath)).rowCount).toBe(1);
  });
});
it("refuses invalid deadlines and pre-aborted jobs before dispatch", async () => {
  const job = {
    operation: "verify",
    expectedHistory: [],
    databasePath: "/not-used",
    maximumBytes: max,
  };
  await expect(runSqliteWorkerJob(job, { timeoutMs: 0 })).rejects.toThrow(
    /deadline/,
  );
  await expect(
    runSqliteWorkerJob(job, { signal: AbortSignal.abort() }),
  ).rejects.toThrow(/cancelled/);
});
