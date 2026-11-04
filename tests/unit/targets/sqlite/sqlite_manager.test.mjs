import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { openSync, readSync, closeSync, lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runWithOperationCancellation } from "../../../../dist/src/shared/cancellation.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRehearsalConfig } from "../../../../dist/src/project/configuration.mjs";
import {
  createSqliteBaseline,
  sqliteCandidatePlan,
  readSqliteBaseline,
} from "../../../../dist/src/baseline/producers/sqlite_baseline.mjs";
import {
  executeSqliteRuntime,
  readVerifiedSqliteRuntimeReceipt,
} from "../../../../dist/src/targets/sqlite/sqlite_manager.mjs";
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
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-manager-"));
  roots.push(root);
  await mkdir(join(root, "migrations"));
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `export default {schemaVersion:1,project:{name:'sqlite-fixture'},sqlite:{sourceDatabase:'source.sqlite',migrationDirectory:'migrations'},baseline:{sanitizationPolicy:'privacy.json'},application:{startCommand:'node app.mjs',proofCommand:'node proof.mjs'},runtime:{target:'sqlite',projectId:'sqlite-fixture-rehearsal'}};`,
  );
  const db = new DatabaseSync(join(root, "source.sqlite"));
  db.exec(
    "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'safe');",
  );
  db.close();
  await writeFile(
    join(root, "privacy.json"),
    JSON.stringify({
      policyVersion: 1,
      engine: "sqlite",
      tables: [
        {
          name: "items",
          columns: [
            { name: "id", action: "KEEP" },
            { name: "value", action: "KEEP" },
          ],
        },
      ],
    }),
  );
  await writeFile(join(root, "ledger.json"), "[]");
  const loaded = await loadRehearsalConfig({ projectRoot: root });
  await createSqliteBaseline(loaded, {
    recordsPath: "source.sqlite",
    ledgerPath: "ledger.json",
  });
  const database = join(loaded.paths.runtimeWorkdir, "sqlite/database.sqlite"),
    marker = join(loaded.paths.runtimeWorkdir, "sqlite/runtime.json");
  const invoke = (action, options = {}) =>
    executeSqliteRuntime(
      loaded,
      {
        action,
        configPath: undefined,
        confirmation: sqliteCandidatePlan(loaded).candidateSha256,
        structuredResult: true,
        ...options,
      },
      { assertOperationOwner: async () => {} },
    );
  return { root, loaded, database, marker, invoke };
};
describe.skipIf(!qualified)("owned SQLite manager", () => {
  it("restores only its sandbox and preserves edits across stop/start before reviewed reset/discard", async () => {
    const f = await fixture();
    const baseline = readSqliteBaseline(f.loaded);
    const sourceBefore = await readFile(join(f.root, "source.sqlite")),
      baselineBefore = await readFile(baseline.database);
    expect((await f.invoke("reset")).endpoint.kind).toBe("embedded-file");
    expect(
      (await stat(f.loaded.paths.applicationEnvironment)).mode & 0o077,
    ).toBe(0);
    expect(
      await readFile(f.loaded.paths.applicationEnvironment, "utf8"),
    ).toContain("SQLITE_DATABASE_PATH=");
    const db = new DatabaseSync(f.database);
    db.exec("INSERT INTO items VALUES(2,'user edit');");
    db.close();
    expect((await f.invoke("stop")).state).toBe("stopped");
    await expect(
      readFile(f.loaded.paths.applicationEnvironment),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.invoke("start")).state).toBe("running");
    const edited = new DatabaseSync(f.database);
    expect(edited.prepare("SELECT count(*) AS n FROM items").get().n).toBe(2);
    edited.close();
    await f.invoke("verify");
    await f.invoke("reset");
    const reset = new DatabaseSync(f.database);
    expect(reset.prepare("SELECT count(*) AS n FROM items").get().n).toBe(1);
    reset.close();
    expect((await f.invoke("discard")).state).toBe("stopped");
    await expect(readFile(f.database)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(f.root, "source.sqlite"))).toEqual(sourceBefore);
    expect(await readFile(baseline.database)).toEqual(baselineBefore);
  });
  it("requires exact reset/discard consent and an actual production parent owner", async () => {
    const f = await fixture();
    await expect(
      f.invoke("reset", { confirmation: undefined }),
    ).rejects.toMatchObject({ code: "SQLITE_OPERATION_FAILED" });
    await expect(
      executeSqliteRuntime(f.loaded, {
        action: "reset",
        configPath: undefined,
        confirmation: sqliteCandidatePlan(f.loaded).candidateSha256,
        structuredResult: true,
      }),
    ).rejects.toMatchObject({ code: "SQLITE_OWNERSHIP_UNPROVEN" });
    await f.invoke("reset");
    const before = await readFile(f.database);
    await expect(
      f.invoke("discard", { confirmation: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "SQLITE_OPERATION_FAILED" });
    expect(await readFile(f.database)).toEqual(before);
  });
  it("marks failure dirty before worker execution and requires explicit reset after rollback", async () => {
    const f = await fixture();
    await f.invoke("reset");
    await writeFile(
      join(f.root, "migrations/20261104010101_bad.sql"),
      "INSERT INTO items VALUES(2,'transient');INSERT INTO items VALUES(1,'duplicate');",
    );
    await expect(f.invoke("migrate")).rejects.toMatchObject({
      code: "SQLITE_OPERATION_FAILED",
    });
    expect(JSON.parse(await readFile(f.marker, "utf8")).state).toBe("dirty");
    for (const action of ["start", "migrate", "verify"])
      await expect(f.invoke(action)).rejects.toMatchObject({
        code: "SQLITE_RUNTIME_DIRTY",
      });
    const db = new DatabaseSync(f.database);
    expect(db.prepare("SELECT count(*) AS n FROM items").get().n).toBe(1);
    db.close();
    await f.invoke("reset");
    expect(JSON.parse(await readFile(f.marker, "utf8")).state).toBe("running");
  });
  it("retains dirty state after committed work loses its input binding and recovers only by reset", async () => {
    const f = await fixture();
    await f.invoke("reset");
    await writeFile(
      join(f.root, "migrations/20261104010101_add.sql"),
      "ALTER TABLE items ADD COLUMN extra TEXT;",
    );
    let observations = 0;
    await expect(
      executeSqliteRuntime(
        f.loaded,
        {
          action: "migrate",
          configPath: undefined,
          confirmation: sqliteCandidatePlan(f.loaded).candidateSha256,
          structuredResult: true,
        },
        {
          assertOperationOwner: async () => {
            observations++;
            if (observations === 3)
              await writeFile(
                join(f.root, "migrations/20261104010102_later.sql"),
                "CREATE INDEX item_value ON items(value);",
              );
          },
        },
      ),
    ).rejects.toMatchObject({ code: "SQLITE_OPERATION_FAILED" });
    expect(JSON.parse(await readFile(f.marker, "utf8")).state).toBe("dirty");
    const db = new DatabaseSync(f.database);
    expect(
      db
        .prepare("PRAGMA table_info(items)")
        .all()
        .some((column) => column.name === "extra"),
    ).toBe(true);
    db.close();
    await expect(f.invoke("start")).rejects.toMatchObject({
      code: "SQLITE_RUNTIME_DIRTY",
    });
    await f.invoke("reset");
    expect((await f.invoke("verify")).state).toBe("running");
  });
  it("requires reset for a refreshed baseline and preserves the old sandbox until that reviewed reset", async () => {
    const f = await fixture();
    await f.invoke("reset");
    const old = await readFile(f.database);
    const db = new DatabaseSync(join(f.root, "source.sqlite"));
    db.exec("INSERT INTO items VALUES(2,'new source');");
    db.close();
    await createSqliteBaseline(f.loaded, {
      recordsPath: "source.sqlite",
      ledgerPath: "ledger.json",
    });
    await expect(f.invoke("start")).rejects.toMatchObject({
      code: "SQLITE_OWNERSHIP_UNPROVEN",
    });
    expect(await readFile(f.database)).toEqual(old);
    await f.invoke("reset");
    const restored = new DatabaseSync(f.database);
    expect(restored.prepare("SELECT count(*) AS n FROM items").get().n).toBe(2);
    restored.close();
  });
  it("recovers a witnessed real hot journal only after confirmed worker cancellation", async () => {
    const f = await fixture();
    await f.invoke("reset");
    const baseline = readSqliteBaseline(f.loaded),
      baselineBefore = await readFile(baseline.database),
      sourceBefore = await readFile(join(f.root, "source.sqlite"));
    await writeFile(
      join(f.root, "migrations/20261104010101_large.sql"),
      "CREATE TABLE payloads(id INTEGER PRIMARY KEY,payload BLOB);WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO payloads SELECT x,zeroblob(8192) FROM n;WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;",
    );
    const signals = new EventEmitter();
    let witness = null;
    await expect(
      runWithOperationCancellation({
        signalTarget: signals,
        input: null,
        task: async () => {
          let settled = false;
          const pending = f.invoke("migrate");
          pending.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          try {
            const deadline = Date.now() + 5000;
            while (!settled && Date.now() < deadline) {
              try {
                const fd = openSync(f.database + "-journal", "r");
                try {
                  const bytes = Buffer.alloc(8);
                  if (
                    readSync(fd, bytes, 0, 8, 0) === 8 &&
                    bytes.toString("hex") === "d9d505f920a163d7"
                  ) {
                    const s = lstatSync(f.database + "-journal", {
                      bigint: true,
                    });
                    witness = {
                      dev: String(s.dev),
                      ino: String(s.ino),
                      birthtimeNs: String(s.birthtimeNs),
                    };
                    break;
                  }
                } finally {
                  closeSync(fd);
                }
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
              }
              await delay(10);
            }
            expect(witness).not.toBeNull();
            const before = JSON.parse(await readFile(f.marker, "utf8"));
            expect(before.state).toBe("dirty");
            expect(before.workerClosure).toBe("pending");
            expect(before.sidecars["-journal"]).toEqual(witness);
            signals.emit("SIGINT");
            await expect(pending).rejects.toMatchObject({
              code: "SQLITE_WORKER_CANCELLED",
              cleanupUnconfirmed: false,
            });
          } finally {
            if (!settled) signals.emit("SIGINT");
            await pending.catch(() => {});
          }
        },
      }),
    ).rejects.toMatchObject({ category: "operation_cancelled" });
    const dirty = JSON.parse(await readFile(f.marker, "utf8"));
    expect(dirty.state).toBe("dirty");
    expect(dirty.workerClosure).toBe("confirmed");
    const remaining = lstatSync(f.database + "-journal", { bigint: true });
    expect({
      dev: String(remaining.dev),
      ino: String(remaining.ino),
      birthtimeNs: String(remaining.birthtimeNs),
    }).toEqual(witness);
    await f.invoke("reset");
    await f.invoke("verify");
    await expect(readFile(f.database + "-journal")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const restored = new DatabaseSync(f.database);
    expect(restored.prepare("SELECT count(*) AS n FROM items").get().n).toBe(1);
    expect(
      restored
        .prepare("SELECT name FROM sqlite_schema WHERE name='payloads'")
        .get(),
    ).toBeUndefined();
    restored.close();
    expect(await readFile(baseline.database)).toEqual(baselineBefore);
    expect(await readFile(join(f.root, "source.sqlite"))).toEqual(sourceBefore);
  });
  it("preserves replaced journals and refuses automatic recovery of uncertain worker closure", async () => {
    const f = await fixture();
    await f.invoke("reset");
    await writeFile(
      join(f.root, "migrations/20261104010101_fail.sql"),
      "INSERT INTO items VALUES(1,'duplicate');",
    );
    await expect(f.invoke("migrate")).rejects.toMatchObject({
      code: "SQLITE_OPERATION_FAILED",
    });
    const dirty = JSON.parse(await readFile(f.marker, "utf8"));
    expect(dirty.workerClosure).toBe("confirmed");
    await rm(f.database + "-journal", { force: true });
    await writeFile(f.database + "-journal", "foreign journal sentinel");
    await expect(f.invoke("reset")).rejects.toMatchObject({
      code: "SQLITE_OWNERSHIP_UNPROVEN",
    });
    expect(await readFile(f.database + "-journal", "utf8")).toBe(
      "foreign journal sentinel",
    );
    await writeFile(
      f.marker,
      JSON.stringify({ ...dirty, workerClosure: "unconfirmed" }),
    );
    const before = await readFile(f.database);
    for (const action of ["reset", "discard"])
      await expect(f.invoke(action)).rejects.toMatchObject({
        code: "SQLITE_WORKER_CLEANUP_UNCONFIRMED",
        cleanupUnconfirmed: true,
      });
    expect(await readFile(f.database)).toEqual(before);
  });
  it("appends exact history atomically, supports idempotence, and rejects schema drift", async () => {
    const f = await fixture();
    await f.invoke("reset");
    await writeFile(
      join(f.root, "migrations/20261104010101_add.sql"),
      "ALTER TABLE items ADD COLUMN extra TEXT;",
    );
    await f.invoke("migrate");
    await f.invoke("migrate");
    await f.invoke("verify");
    const marker = JSON.parse(await readFile(f.marker, "utf8"));
    expect(marker.history).toHaveLength(1);
    const db = new DatabaseSync(f.database);
    db.exec("CREATE TABLE foreign_schema(id INTEGER);");
    db.close();
    await expect(f.invoke("start")).rejects.toMatchObject({
      code: "SQLITE_RUNTIME_DIRTY",
    });
    await f.invoke("reset");
    expect((await f.invoke("verify")).state).toBe("running");
  });
  it("refuses an actual idle open SQLite connection before reset or discard", async () => {
    const f = await fixture();
    await f.invoke("reset");
    const before = await readFile(f.database),
      db = new DatabaseSync(f.database);
    try {
      for (const action of ["reset", "discard"])
        await expect(f.invoke(action)).rejects.toMatchObject({
          code: "SQLITE_OWNERSHIP_UNPROVEN",
        });
      expect(await readFile(f.database)).toEqual(before);
    } finally {
      db.close();
    }
    await f.invoke("discard");
  });
  it("preserves unknown leaves, foreign environment files and replaced database identities", async () => {
    const f = await fixture();
    await f.invoke("reset");
    const extra = join(f.loaded.paths.runtimeWorkdir, "sqlite/unrelated.txt");
    await writeFile(extra, "sentinel");
    await expect(f.invoke("discard")).rejects.toMatchObject({
      code: "SQLITE_OWNERSHIP_UNPROVEN",
    });
    expect(await readFile(extra, "utf8")).toBe("sentinel");
    await rm(extra);
    await writeFile(f.loaded.paths.applicationEnvironment, "FOREIGN=value\n");
    await expect(f.invoke("stop")).rejects.toMatchObject({
      code: "SQLITE_OWNERSHIP_UNPROVEN",
    });
    const replacement = await readFile(f.database);
    await rm(f.database);
    await writeFile(f.database, replacement);
    await expect(f.invoke("reset")).rejects.toMatchObject({
      code: "SQLITE_OWNERSHIP_UNPROVEN",
    });
  });
  it("retains unexpected healthy journal corruption instead of silently falling back to destructive recovery", async () => {
    const f = await fixture();
    await f.invoke("reset");
    const db = new DatabaseSync(f.database);
    db.exec("DROP TABLE _rehearsal_sqlite_history;");
    db.close();
    const before = await readFile(f.database);
    for (const action of ["reset", "discard"])
      await expect(f.invoke(action)).rejects.toMatchObject({
        code: "SQLITE_OPERATION_FAILED",
      });
    expect(await readFile(f.database)).toEqual(before);
  });
  it("inspection requires actual journal/schema/identity rather than forged marker claims", async () => {
    const f = await fixture();
    expect(await readVerifiedSqliteRuntimeReceipt(f.loaded)).toBeNull();
    await f.invoke("reset");
    expect(await readVerifiedSqliteRuntimeReceipt(f.loaded)).toEqual({
      history: [],
      candidateSha256: sqliteCandidatePlan(f.loaded).candidateSha256,
      baselineGenerationId: readSqliteBaseline(f.loaded).manifest.generationId,
    });
    const original = await readFile(f.marker, "utf8"),
      marker = JSON.parse(original);
    await writeFile(
      f.marker,
      JSON.stringify({ ...marker, schemaSha256: "0".repeat(64) }),
    );
    expect(await readVerifiedSqliteRuntimeReceipt(f.loaded)).toBeNull();
    await writeFile(f.marker, JSON.stringify({ ...marker, state: "dirty" }));
    expect(await readVerifiedSqliteRuntimeReceipt(f.loaded)).toBeNull();
    await writeFile(f.marker, original);
    await writeFile(
      join(f.root, "migrations/20261104010101_add.sql"),
      "ALTER TABLE items ADD COLUMN extra TEXT;",
    );
    const plan = sqliteCandidatePlan(f.loaded);
    await writeFile(
      f.marker,
      JSON.stringify({
        ...marker,
        history: plan.files.map(({ filename, sha256 }) => ({
          filename,
          sha256,
        })),
      }),
    );
    expect(await readVerifiedSqliteRuntimeReceipt(f.loaded)).toBeNull();
    await writeFile(f.marker, original);
    const bytes = await readFile(f.database);
    await rm(f.database);
    await writeFile(f.database, bytes);
    expect(await readVerifiedSqliteRuntimeReceipt(f.loaded)).toBeNull();
  });
  it("preserves a protected target before mutation", async () => {
    const f = await fixture();
    const configPath = join(f.root, "rehearsal.config.mjs");
    const text = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      text.replace("target:'sqlite'", "target:'sqlite',protected:true"),
    );
    const loaded = await loadRehearsalConfig({ projectRoot: f.root });
    await expect(
      executeSqliteRuntime(
        loaded,
        {
          action: "reset",
          configPath: undefined,
          confirmation: sqliteCandidatePlan(loaded).candidateSha256,
          structuredResult: true,
        },
        { assertOperationOwner: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "SQLITE_OPERATION_FAILED" });
    await expect(readFile(f.database)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
