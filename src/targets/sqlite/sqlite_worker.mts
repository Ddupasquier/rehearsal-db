/** Native SQLite work runs only in a bounded private child; provider errors never cross stdout. */
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readdirSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {
  SQLITE_WORKER_MAXIMUM_INPUT_BYTES,
  SQLITE_WORKER_MAXIMUM_ROWS,
  SQLITE_WORKER_MAXIMUM_TABLES,
} from "./sqlite_worker_contract.mjs";
import type {
  SQLitePrivacyPolicy,
  SqliteWorkerJob,
  SqliteWorkerResult,
  SqliteHistoryEntry,
} from "./sqlite_worker_contract.mjs";

type Value = null | string | number | bigint | Uint8Array;
type Row = Record<string, Value>;
interface Statement {
  all(...args: Value[]): Row[];
  get(...args: Value[]): Row | undefined;
  run(...args: Value[]): unknown;
  iterate(...args: Value[]): Iterable<Row>;
  setReadBigInts(value: boolean): void;
}
interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  setAuthorizer(
    callback:
      | ((
          action: number,
          first: string | null,
          second: string | null,
          database: string | null,
        ) => number)
      | null,
  ): void;
  enableDefensive(value: boolean): void;
}
class BackendUnavailable extends Error {}
const Native = DatabaseSync as unknown as new (
  path: string,
  options?: {
    readOnly?: boolean;
    allowExtension?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  },
) => NativeDatabase;
function fail(): never {
  throw new Error("SQLite job refused.");
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const JOURNAL = "_rehearsal_sqlite_history";
const JOURNAL_SQL =
  'CREATE TABLE "_rehearsal_sqlite_history" ("position" INTEGER PRIMARY KEY, "filename" TEXT NOT NULL UNIQUE, "sha256" TEXT NOT NULL)';
const validateHistory = (entries: readonly SqliteHistoryEntry[]) => {
  if (
    !Array.isArray(entries) ||
    entries.length > 1000 ||
    new Set(entries.map((entry) => entry?.filename)).size !== entries.length
  )
    fail();
  for (const entry of entries)
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !== "filename,sha256" ||
      typeof entry.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,250}\.sql$/u.test(entry.filename) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    )
      fail();
};
const readHistory = (db: NativeDatabase): SqliteHistoryEntry[] => {
  if (
    db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(JOURNAL)
      ?.sql !== JOURNAL_SQL
  )
    fail();
  const rows = db
    .prepare(
      `SELECT position,filename,sha256 FROM "${JOURNAL}" ORDER BY position LIMIT 1001`,
    )
    .all();
  const entries = rows.map((row, index) => {
    if (
      row.position !== index + 1 ||
      typeof row.filename !== "string" ||
      typeof row.sha256 !== "string"
    )
      fail();
    return { filename: row.filename, sha256: row.sha256 };
  });
  validateHistory(entries);
  return entries;
};
const insertHistory = (
  db: NativeDatabase,
  entries: readonly SqliteHistoryEntry[],
  offset = 0,
) => {
  for (const [index, entry] of entries.entries())
    db.prepare(`INSERT INTO "${JOURNAL}" VALUES (?,?,?)`).run(
      offset + index + 1,
      entry.filename,
      entry.sha256,
    );
};
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
interface Held {
  path: string;
  fd: number;
  dev: number;
  ino: number;
}
const held: Held[] = [];
const directories = new Map<string, Held>();
const same = (
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
) => a.dev === b.dev && a.ino === b.ino;
const holdDirectory = (path: string, privateRoot = false) => {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    fail();
  const details = lstatSync(path);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (privateRoot &&
      ((details.mode & 0o077) !== 0 || details.uid !== process.getuid?.()))
  )
    fail();
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  const item = { path, fd, dev: details.dev, ino: details.ino };
  if (!same(details, fstatSync(fd))) {
    closeSync(fd);
    fail();
  }
  held.push(item);
  directories.set(path, item);
};
const checkDirectory = (path: string) => {
  const item = directories.get(path);
  if (
    !item ||
    !same(item, lstatSync(path)) ||
    !same(item, fstatSync(item.fd)) ||
    realpathSync(path) !== path
  )
    fail();
};
const holdFile = (path: string, create = false): Held => {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  if (!directories.has(dirname(path))) holdDirectory(dirname(path), create);
  checkDirectory(dirname(path));
  const fd = openSync(
    path,
    (create
      ? fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL
      : fsConstants.O_RDONLY) |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_NONBLOCK,
    0o600,
  );
  const details = fstatSync(fd);
  const item = { path, fd, dev: details.dev, ino: details.ino };
  held.push(item);
  if (
    !details.isFile() ||
    details.nlink !== 1 ||
    !same(details, lstatSync(path)) ||
    realpathSync(path) !== path
  )
    fail();
  return item;
};
const checkFile = (item: Held) => {
  checkDirectory(dirname(item.path));
  const details = lstatSync(item.path);
  if (
    !details.isFile() ||
    details.nlink !== 1 ||
    !same(item, details) ||
    !same(item, fstatSync(item.fd)) ||
    realpathSync(item.path) !== item.path
  )
    fail();
};
const boundFiles = (path: string, maximumBytes: number) => {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = path + suffix;
    try {
      const details = lstatSync(candidate);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.nlink !== 1 ||
        realpathSync(candidate) !== candidate
      )
        fail();
      total += details.size;
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT" &&
        suffix
      ))
        throw error;
    }
  }
  if (total > maximumBytes) fail();
};
const openDatabase = (path: string, readOnly = false): NativeDatabase => {
  const db = new Native(path, {
    readOnly,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  db.exec("PRAGMA mmap_size=0;");
  if (
    path !== ":memory:" &&
    db.prepare("PRAGMA mmap_size").get()?.mmap_size !== 0
  ) {
    db.close();
    fail();
  }
  if (
    typeof db.setAuthorizer !== "function" ||
    typeof db.enableDefensive !== "function" ||
    db.prepare("SELECT sqlite_version() AS version").get()?.version !== "3.53.4"
  ) {
    db.close();
    throw new BackendUnavailable();
  }
  db.enableDefensive(true);
  db.exec(
    "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192;",
  );
  return db;
};
// SQLite authorizer action codes: only ordinary main-schema SQL, no attachment,
// PRAGMA, transaction control, virtual tables or unrecognized operations.
const allowedActions = new Set([
  1, 2, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 23, 26, 27, 28, 31, 33,
]);
const authorize = (
  action: number,
  first: string | null,
  second: string | null,
  database: string | null,
) => {
  if (
    first === JOURNAL ||
    second === JOURNAL ||
    action === 19 ||
    !allowedActions.has(action) ||
    (database !== null && database !== "main")
  )
    return 1;
  if (
    action === 31 &&
    ["load_extension", "readfile", "writefile"].includes(
      (second ?? first ?? "").toLowerCase(),
    )
  )
    return 1;
  return 0;
};
interface Schema {
  type: string;
  name: string;
  sql: string;
}
const schema = (db: NativeDatabase): Schema[] => {
  const records = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE substr(name,1,7) != 'sqlite_' AND name != '_rehearsal_sqlite_history' ORDER BY type,name",
    )
    .all();
  if (
    Buffer.byteLength(JSON.stringify(records)) > MAX_SCHEMA_BYTES ||
    records.length > 2048
  )
    fail();
  const entries = records.map((row) => {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string" ||
      !["table", "index", "trigger", "view"].includes(row.type) ||
      /\bVIRTUAL\s+TABLE\b/iu.test(row.sql) ||
      row.sql.toLowerCase().includes(JOURNAL)
    )
      fail();
    return { type: row.type, name: row.name, sql: row.sql };
  });
  const tables = entries.filter((entry) => entry.type === "table");
  if (tables.length > SQLITE_WORKER_MAXIMUM_TABLES) fail();
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_xinfo(${quote(table.name)})`)
      .all();
    if (columns.length > 1024 || columns.some((column) => column.hidden !== 0))
      fail();
  }
  return entries;
};
const applicationMetadata = (db: NativeDatabase) => {
  const userVersion = db.prepare("PRAGMA user_version").get()?.user_version;
  const applicationId = db
    .prepare("PRAGMA application_id")
    .get()?.application_id;
  if (
    typeof userVersion !== "number" ||
    !Number.isInteger(userVersion) ||
    userVersion < -2147483648 ||
    userVersion > 2147483647 ||
    typeof applicationId !== "number" ||
    !Number.isInteger(applicationId) ||
    applicationId < -2147483648 ||
    applicationId > 2147483647
  )
    fail();
  return { userVersion, applicationId };
};
const inspect = (
  db: NativeDatabase,
  history: readonly SqliteHistoryEntry[] = [],
): SqliteWorkerResult => {
  const entries = schema(db);
  if (
    db
      .prepare("PRAGMA integrity_check")
      .all()
      .some((row) => Object.values(row)[0] !== "ok") ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    fail();
  let rowCount = 0;
  const tables = entries.filter((entry) => entry.type === "table");
  for (const table of tables) {
    const count = db
      .prepare(`SELECT count(*) AS n FROM ${quote(table.name)}`)
      .get()?.n;
    if (typeof count !== "number" || !Number.isSafeInteger(count)) fail();
    rowCount += count;
    if (rowCount > SQLITE_WORKER_MAXIMUM_ROWS) fail();
  }
  return {
    sqliteVersion: "3.53.4",
    tableCount: tables.length,
    rowCount,
    schemaSha256: hash(
      JSON.stringify({ schema: entries, ...applicationMetadata(db) }),
    ),
    history,
  };
};
const validatePolicy = (
  policy: SQLitePrivacyPolicy,
  db: NativeDatabase,
  entries: Schema[],
) => {
  if (
    policy?.policyVersion !== 1 ||
    policy.engine !== "sqlite" ||
    !Array.isArray(policy.tables) ||
    Object.keys(policy).sort().join(",") !== "engine,policyVersion,tables"
  )
    fail();
  const tables = entries.filter((entry) => entry.type === "table");
  if (
    policy.tables.length !== tables.length ||
    new Set(policy.tables.map((t) => t.name)).size !== tables.length
  )
    fail();
  for (const table of tables) {
    const rule = policy.tables.find((t) => t.name === table.name);
    const columns = db
      .prepare(`PRAGMA table_xinfo(${quote(table.name)})`)
      .all();
    if (
      !rule ||
      Object.keys(rule).sort().join(",") !== "columns,name" ||
      !Array.isArray(rule.columns) ||
      rule.columns.length !== columns.length ||
      new Set(
        rule.columns.map(
          (c: SQLitePrivacyPolicy["tables"][number]["columns"][number]) =>
            c.name,
        ),
      ).size !== columns.length
    )
      fail();
    for (const column of columns) {
      const action = rule.columns.find(
        (c: SQLitePrivacyPolicy["tables"][number]["columns"][number]) =>
          c.name === column.name,
      );
      if (
        !action ||
        (action.action !== "KEEP" && action.action !== "REPLACE") ||
        Object.keys(action).some(
          (k) => !["name", "action", "value"].includes(k),
        ) ||
        (action.action === "KEEP" && Object.hasOwn(action, "value"))
      )
        fail();
      if (
        action.action === "REPLACE" &&
        (!Object.hasOwn(action, "value") ||
          !(
            action.value === null ||
            typeof action.value === "string" ||
            (typeof action.value === "number" && Number.isFinite(action.value))
          ))
      )
        fail();
    }
  }
};
const limitDatabase = (db: NativeDatabase, maximumBytes: number) => {
  const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof pageSize !== "number") fail();
  db.exec(`PRAGMA max_page_count=${Math.floor(maximumBytes / pageSize)};`);
};
/** Preserve implicit row identity without overriding reviewed INTEGER PRIMARY KEY values. */
const implicitRowid = (db: NativeDatabase, table: string): string | null => {
  const metadata = db
    .prepare(`PRAGMA table_list(${quote(table)})`)
    .all()
    .find((row) => row.schema === "main" && row.name === table);
  if (!metadata || (metadata.wr !== 0 && metadata.wr !== 1)) fail();
  if (metadata.wr === 1) return null;
  const columns = db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
  const primary = columns.filter((column) => Number(column.pk) > 0);
  const separatePrimaryIndex = db
    .prepare(`PRAGMA index_list(${quote(table)})`)
    .all()
    .some((index) => index.origin === "pk");
  // INTEGER PRIMARY KEY DESC has a separate index and is not a rowid alias.
  if (
    primary.length === 1 &&
    String(primary[0]!.type).toUpperCase() === "INTEGER" &&
    !separatePrimaryIndex
  )
    return null;
  const names = new Set(
    columns.map((column) => String(column.name).toLowerCase()),
  );
  const alias = ["rowid", "_rowid_", "oid"].find((name) => !names.has(name));
  if (!alias) fail();
  return alias;
};
const snapshot = async (
  job: Extract<SqliteWorkerJob, { operation: "snapshot" }>,
): Promise<SqliteWorkerResult> => {
  if (
    job.sourceDatabase === job.destinationDatabase ||
    dirname(job.sourceDatabase) === job.destinationDatabase
  )
    fail();
  const sourceIdentity = holdFile(job.sourceDatabase);
  boundFiles(job.sourceDatabase, job.maximumBytes);
  holdDirectory(dirname(job.destinationDatabase), true);
  // Destination must not exist, including dangling links.
  if (
    readdirSync(dirname(job.destinationDatabase)).includes(
      job.destinationDatabase.slice(
        dirname(job.destinationDatabase).length + 1,
      ),
    )
  )
    fail();
  const raw = holdFile(
    resolve(dirname(job.destinationDatabase), `.sqlite-raw-${randomUUID()}`),
    true,
  );
  const clean = holdFile(
    resolve(dirname(job.destinationDatabase), `.sqlite-clean-${randomUUID()}`),
    true,
  );
  let source: NativeDatabase | undefined,
    copy: NativeDatabase | undefined,
    output: NativeDatabase | undefined;
  try {
    source = openDatabase(job.sourceDatabase, true);
    await backup(
      source as unknown as InstanceType<typeof DatabaseSync>,
      raw.path,
    );
    source.close();
    source = undefined;
    checkFile(sourceIdentity);
    boundFiles(job.sourceDatabase, job.maximumBytes);
    copy = openDatabase(raw.path, true);
    boundFiles(raw.path, job.maximumBytes);
    if (
      copy.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(JOURNAL)
    )
      fail();
    validateHistory(job.history);
    const entries = schema(copy);
    inspect(copy);
    validatePolicy(job.policy, copy, entries);
    output = openDatabase(clean.path);
    limitDatabase(output, job.maximumBytes);
    output.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
    output.setAuthorizer(authorize);
    for (const entry of entries.filter((entry) => entry.type === "table"))
      output.exec(entry.sql);
    for (const rule of job.policy.tables) {
      const columns = rule.columns.map(
        (c: SQLitePrivacyPolicy["tables"][number]["columns"][number]) => c.name,
      );
      const rowid = implicitRowid(copy, rule.name);
      let rowidKey = "__rehearsal_copy_rowid";
      while (
        columns.some((name) => name.toLowerCase() === rowidKey.toLowerCase())
      )
        rowidKey += "_";
      const statement = copy.prepare(
        `SELECT ${rowid ? `${quote(rowid)} AS ${quote(rowidKey)},` : ""}* FROM ${quote(rule.name)}`,
      );
      statement.setReadBigInts(true);
      const insertedColumns = rowid ? [rowid, ...columns] : columns;
      const insert = output.prepare(
        `INSERT INTO ${quote(rule.name)} (${insertedColumns.map(quote).join(",")}) VALUES (${insertedColumns.map(() => "?").join(",")})`,
      );
      for (const row of statement.iterate())
        insert.run(
          ...(rowid ? [row[rowidKey]!] : []),
          ...rule.columns.map((column) =>
            column.action === "KEEP" ? row[column.name]! : column.value!,
          ),
        );
    }
    // Install triggers only after approved rows, so insertion cannot execute them.
    for (const entry of entries.filter((entry) => entry.type !== "table"))
      output.exec(entry.sql);
    output.setAuthorizer(null);
    if (
      copy
        .prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'")
        .get()
    ) {
      output.exec("DELETE FROM sqlite_sequence;");
      const sequence = copy.prepare("SELECT name,seq FROM sqlite_sequence");
      sequence.setReadBigInts(true);
      for (const row of sequence.all())
        output
          .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)")
          .run(row.name!, row.seq!);
    }
    const metadata = applicationMetadata(copy);
    output.exec(
      `PRAGMA user_version=${metadata.userVersion}; PRAGMA application_id=${metadata.applicationId};`,
    );
    output.exec(JOURNAL_SQL);
    insertHistory(output, job.history);
    output.exec("COMMIT;");
    const result = inspect(output, readHistory(output));
    output.close();
    output = undefined;
    copy.close();
    copy = undefined;
    checkFile(raw);
    checkFile(clean);
    boundFiles(clean.path, job.maximumBytes);
    // Exclusive activation cannot overwrite an independently created destination.
    linkSync(clean.path, job.destinationDatabase);
    unlinkSync(clean.path);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const path = raw.path + suffix;
      if (
        readdirSync(dirname(path)).includes(
          path.slice(dirname(path).length + 1),
        )
      ) {
        const sidecar = holdFile(path);
        checkFile(sidecar);
        unlinkSync(path);
      }
    }
    checkFile(raw);
    unlinkSync(raw.path);
    return result;
  } finally {
    source?.close();
    copy?.close();
    output?.close();
  }
};
const execute = async (job: SqliteWorkerJob): Promise<SqliteWorkerResult> => {
  if (
    !job ||
    !Number.isSafeInteger(job.maximumBytes) ||
    job.maximumBytes < 4096 ||
    job.maximumBytes > MAX_BYTES
  )
    fail();
  if (job.operation === "probe") {
    const db = openDatabase(":memory:");
    try {
      return inspect(db);
    } finally {
      db.close();
    }
  }
  if (job.operation === "snapshot") return snapshot(job);
  if (job.operation !== "verify" && job.operation !== "migrate") fail();
  const identity = holdFile(job.databasePath);
  boundFiles(job.databasePath, job.maximumBytes);
  let journal: Held | undefined;
  const assertJournal = () => {
    if (!journal || job.operation !== "migrate") fail();
    checkFile(journal);
    const stats = fstatSync(journal.fd, { bigint: true });
    if (
      String(stats.dev) !== job.expectedJournal?.dev ||
      String(stats.ino) !== job.expectedJournal?.ino ||
      String(stats.birthtimeNs) !== job.expectedJournal?.birthtimeNs
    )
      fail();
  };
  if (job.operation === "migrate") {
    journal = holdFile(job.databasePath + "-journal");
    assertJournal();
    if (fstatSync(journal.fd).size !== 0) fail();
  }
  const db = openDatabase(
    job.databasePath,
    job.operation === "verify" && !job.exclusive,
  );
  try {
    validateHistory(job.expectedHistory);
    let history = readHistory(db);
    if (JSON.stringify(history) !== JSON.stringify(job.expectedHistory)) fail();
    inspect(db, history);
    if (job.operation === "verify" && job.exclusive)
      db.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    if (job.operation === "migrate") {
      if (
        !Array.isArray(job.migrations) ||
        job.migrations.length + history.length > 1000 ||
        new Set(job.migrations.map((m) => m.filename)).size !==
          job.migrations.length
      )
        fail();
      for (const migration of job.migrations)
        if (
          typeof migration.filename !== "string" ||
          !/^[a-zA-Z0-9_.-]+\.sql$/u.test(migration.filename) ||
          typeof migration.sql !== "string" ||
          hash(migration.sql) !== migration.sha256
        )
          fail();
      validateHistory(
        job.migrations.map(({ filename, sha256 }) => ({ filename, sha256 })),
      );
      if (
        job.migrations.some((migration) =>
          history.some((entry) => entry.filename === migration.filename),
        )
      )
        fail();
      limitDatabase(db, job.maximumBytes);
      assertJournal();
      db.exec("BEGIN IMMEDIATE;");
      db.setAuthorizer(authorize);
      try {
        for (const migration of job.migrations) {
          assertJournal();
          db.exec(migration.sql);
          assertJournal();
        }
        db.setAuthorizer(null);
        insertHistory(db, job.migrations, history.length);
        inspect(db);
        assertJournal();
        db.exec("COMMIT;");
        history = readHistory(db);
      } catch (error) {
        db.setAuthorizer(null);
        db.exec("ROLLBACK;");
        throw error;
      }
    }
    const result = inspect(db, history);
    checkFile(identity);
    boundFiles(job.databasePath, job.maximumBytes);
    return result;
  } finally {
    db.close();
  }
};
let input = "";
try {
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > SQLITE_WORKER_MAXIMUM_INPUT_BYTES) fail();
  }
  const result = await execute(JSON.parse(input) as SqliteWorkerJob);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (error instanceof BackendUnavailable)
    process.stdout.write('{"sqliteWorkerFailure":"backend-unavailable"}');
  else if (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === 7
  )
    process.stdout.write('{"sqliteWorkerFailure":"memory-limit"}');
  process.exitCode = 1;
} finally {
  for (const item of held.reverse()) closeSync(item.fd);
}
