/** Bounded installed-CLI impact proof inside the PostgreSQL scenario's existing target. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { assertLocalDockerContext } from "../../../dist/src/runtime/local_docker_context.mjs";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";
import { spawnScenarioCommand } from "../scenarios/process.mjs";

export const IMPACT_FIXTURE_SCHEMA = "impact_private_fixture";
export const IMPACT_FIXTURE_FILENAME = "20260101000200_impact_review.sql";
const SCHEMA = IMPACT_FIXTURE_SCHEMA;
const FILE = IMPACT_FIXTURE_FILENAME;
const SQL_CANARY = "PRIVATE_IMPACT_SQL_CANARY";
const ROW_CANARY = "PRIVATE_IMPACT_ROW_CANARY";
const UDF_CANARY = "PRIVATE_IMPACT_UDF_CANARY";
const ID = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 131072;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = () => {
  throw new Error(
    "The bounded PostgreSQL impact fixture did not match its reviewed contract; private output withheld.",
  );
};
export const IMPACT_FIXTURE_SQL = `-- ${SQL_CANARY}
ALTER TABLE ${SCHEMA}.parent ALTER COLUMN payload SET NOT NULL;
ALTER TABLE ${SCHEMA}.parent DROP COLUMN payload;
ALTER TABLE ${SCHEMA}.parent ADD CONSTRAINT reviewed_unique UNIQUE (duplicate_key);
ALTER TABLE ${SCHEMA}.child ADD CONSTRAINT reviewed_reference FOREIGN KEY (parent_id) REFERENCES ${SCHEMA}.parent (id);
DELETE FROM ${SCHEMA}.child;
TRUNCATE TABLE ${SCHEMA}.parent;
DROP TABLE ${SCHEMA}.parent;
`;
export const IMPACT_FIXTURE_CANARIES = Object.freeze([
  SCHEMA,
  SQL_CANARY,
  ROW_CANARY,
  UDF_CANARY,
]);
const KINDS = Object.freeze([
  ["not_null", "nulls"],
  ["drop_column", "populated"],
  ["new_constraint", "duplicate_rows"],
  ["new_constraint", "orphan_rows"],
  ["broad_delete", "rows"],
  ["truncate", "rows"],
  ["drop_table", "rows"],
]);
const COLUMNS = Object.freeze([
  IMPACT_FIXTURE_SQL.split("\n")[1].indexOf("NOT NULL") + 1,
  IMPACT_FIXTURE_SQL.split("\n")[2].indexOf("DROP COLUMN") + 1,
  IMPACT_FIXTURE_SQL.split("\n")[3].indexOf("ADD CONSTRAINT") + 1,
  IMPACT_FIXTURE_SQL.split("\n")[4].indexOf("ADD CONSTRAINT") + 1,
  1,
  1,
  1,
]);

/** Inspect the complete raw/decoded public envelopes, including text and errors. */
export const assertImpactPublicOutput = (
  result,
  canaries = IMPACT_FIXTURE_CANARIES,
) => {
  if (
    !result ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  )
    fail();
  let visited = 0;
  const scan = (value, depth = 0) => {
    if (++visited > 10000 || depth > 32) fail();
    if (typeof value === "string") {
      if (
        canaries.some(
          (canary) =>
            typeof canary !== "string" || !canary || value.includes(canary),
        )
      )
        fail();
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        scan(key, depth + 1);
        scan(item, depth + 1);
      }
    }
  };
  for (const output of [result.stdout, result.stderr]) {
    if (Buffer.byteLength(output) > MAX_BYTES) fail();
    scan(output);
    let decoded;
    try {
      decoded = JSON.parse(output);
    } catch {
      continue;
    }
    scan(decoded);
  }
};

/** Independent fixed seven-metric oracle; unknown never substitutes a zero count. */
export const assertImpactFixtureCounts = (
  envelope,
  {
    candidateSha256,
    counts,
    reasons = counts.map(() => null),
    version,
    provider = "postgresql",
  },
) => {
  const report = envelope?.data;
  const entries = report?.entries?.filter((entry) => entry.filename === FILE);
  if (
    !["postgresql", "supabase"].includes(provider) ||
    !ID.test(candidateSha256) ||
    counts.length !== 7 ||
    reasons.length !== 7 ||
    report?.schemaVersion !== 1 ||
    report.inspectorVersion !== version ||
    report.mode !== "measurement" ||
    report.candidateSha256 !== candidateSha256 ||
    report.target?.name !== "primary" ||
    report.target.provider !== provider ||
    entries?.length !== 1 ||
    entries[0].sha256 !== digest(IMPACT_FIXTURE_SQL) ||
    entries[0].coverage !== "recognized_forms" ||
    entries[0].unknownReasons?.length !== 0 ||
    entries[0].measurements?.length !== 7 ||
    report.safety?.appliesMigrations !== false ||
    report.safety.startsOrRepairsRuntime !== false ||
    report.safety.returnsRowContents !== false ||
    report.safety.returnsSqlOrObjectNames !== false ||
    report.safety.contactsDatabase !== true ||
    report.limits?.lockTimeoutMilliseconds !== 1000 ||
    report.limits.statementTimeoutMilliseconds !== 5000 ||
    report.limits.totalTimeoutMilliseconds !== 30000
  )
    fail();
  for (const [index, measurement] of entries[0].measurements.entries()) {
    const [operation, metric] = KINDS[index],
      count = counts[index],
      reason = reasons[index];
    if (
      (count !== null &&
        (typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count))) ||
      !isDeepStrictEqual(measurement, {
        operation,
        metric,
        line: index + 2,
        column: COLUMNS[index],
        evidence: count === null ? "unknown" : "measured_current_snapshot",
        count,
        unknownReason: reason,
      })
    ) {
      const observedCount =
        measurement?.count === null
          ? "null"
          : typeof measurement?.count === "string" &&
              /^[0-9]{1,20}$/u.test(measurement.count)
            ? measurement.count
            : "withheld";
      const observedReason = [
        null,
        "unsupported_runtime_metadata",
        "unsupported_server_version",
        "query_failed",
        "lock_timeout",
        "statement_timeout",
        "total_timeout",
      ].includes(measurement?.unknownReason)
        ? String(measurement.unknownReason)
        : "withheld";
      throw new Error(
        `The bounded impact fixture did not match metric ${index}: count=${observedCount}, reason=${observedReason}; private output withheld.`,
      );
    }
    if ((count === null) !== (typeof reason === "string" && reason.length > 0))
      fail();
  }
  const expectedMeasured = counts.filter((count) => count !== null).length;
  const unknownEntryCount = report.entries.filter(
    (entry) =>
      entry.unknownReasons.length ||
      entry.measurements.some(
        (measurement) => measurement.evidence === "unknown",
      ),
  ).length;
  const measurementStatus = unknownEntryCount
    ? expectedMeasured
      ? "partial"
      : "unknown"
    : "measured";
  if (
    !isDeepStrictEqual(report.summary, {
      plannedCount: 7,
      measuredCount: expectedMeasured,
      unknownMeasurementCount: 7 - expectedMeasured,
      unknownEntryCount,
    }) ||
    report.measurementStatus !== measurementStatus ||
    envelope.status !== (unknownEntryCount ? "not_ready" : "success") ||
    report.entries.some(
      (entry) => entry.filename !== FILE && entry.measurements.length !== 0,
    )
  )
    fail();
  if (expectedMeasured) {
    if (
      !ID.test(report.runtimeIdentitySha256) ||
      !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(report.snapshotAt ?? "") ||
      report.safety.transaction !== "repeatable_read_read_only"
    )
      fail();
  }
  return report;
};

const PSQL = [
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

export const protectedFingerprint = async (cwd, excluded) => {
  const entries = [];
  let bytes = 0;
  const visit = async (relative) => {
    if (relative === excluded) return;
    const path = join(cwd, relative),
      detail = await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (!detail) {
      entries.push([relative, "absent"]);
      return;
    }
    if (entries.length >= 512) fail();
    if (detail.isSymbolicLink()) {
      const target = await readlink(path);
      if (
        relative !== ".rehearsal/current" ||
        !/^generations\/\d{8}T\d{6}Z-[a-f0-9]{12}$/u.test(target)
      )
        fail();
      entries.push([relative, "link", target]);
    } else if (detail.isDirectory()) {
      entries.push([relative, "directory", detail.mode & 0o777]);
      for (const name of (await readdir(path)).sort())
        await visit(join(relative, name));
    } else if (
      detail.isFile() &&
      detail.size <= 1048576 &&
      (bytes += detail.size) <= 8388608
    ) {
      entries.push([
        relative,
        "file",
        detail.mode & 0o777,
        detail.ino,
        detail.mtimeMs,
        digest(await readFile(path)),
      ]);
    } else fail();
  };
  for (const path of [
    "package.json",
    "rehearsal.config.mjs",
    "database/migrations",
    "supabase/migrations",
    "supabase/config.toml",
    ".env.rehearsal-service.local",
    "rehearsal",
    ".rehearsal/current",
    ".rehearsal/generations",
    ".rehearsal/secrets",
    ".rehearsal/runtime.env",
    ".rehearsal/runtime/baseline.json",
    ".rehearsal/runtime/candidate-receipt.json",
    ".rehearsal/runtime/supabase/config.toml",
  ])
    await visit(path);
  return digest(JSON.stringify(entries));
};

/** Every spawned client is bounded, captured and reaped; backend proof is separate. */
const childClient = (command, args, { cwd, environment = {}, timeout }) => {
  const child = spawn(command, args, {
    cwd,
    env: createCleanProcessEnvironment({ overrides: environment }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    fault = false,
    killTimer;
  const stop = () => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  const timer = setTimeout(stop, timeout);
  const collect = (kind, chunk) => {
    if (kind === "stdout") stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_BYTES) {
      fault = true;
      stdout = "";
      stderr = "";
      stop();
    }
  };
  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));
  child.stdin.on("error", () => {
    fault = true;
  });
  child.on("error", () => {
    fault = true;
  });
  const completion = new Promise((resolve) =>
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ status, signal, stdout, stderr, fault });
    }),
  );
  return { child, completion, stop, output: () => stdout };
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Fixed auxiliary-client diagnostics, never provider text or fixture SQL. */
export const assertImpactRaceIndexResult = (result) => {
  if (result?.fault === false && result.status === 0 && !result.signal) return;
  const sqlstate =
    typeof result?.stderr === "string" &&
    result.stderr.length <= MAX_BYTES &&
    /(?:^|\n)ERROR:\s+(55P03|57014|25P03|25P04)\s*(?:\n|$)/u.exec(
      result.stderr,
    )?.[1];
  const status =
    Number.isInteger(result?.status) &&
    result.status >= 0 &&
    result.status <= 255
      ? result.status
      : "unknown";
  const signal = ["SIGTERM", "SIGKILL"].includes(result?.signal)
    ? result.signal
    : "unknown";
  throw new Error(
    `The bounded impact queued-index setup failed: status=${status}, signal=${signal}, sqlstate=${sqlstate || "withheld"}; private output withheld.`,
  );
};

/** Fixed read-only transport probes, never derived from pending migration SQL. */
export const buildImpactDeadlineProbe = (kind, application) => {
  if (
    !["statement", "transaction"].includes(kind) ||
    typeof application !== "string" ||
    !/^rehearsal-impact-deadline-[1-9][0-9]{0,9}-(?:statement|transaction)$/u.test(
      application,
    )
  )
    fail();
  const queries =
    kind === "statement"
      ? "select pg_catalog.pg_sleep(6);"
      : Array(32).fill("select pg_catalog.pg_sleep(1);").join("\n");
  return `set application_name = '${application}';
begin isolation level repeatable read read only;
set local lock_timeout = '1000ms';
set local statement_timeout = '5000ms';
set local transaction_timeout = '30000ms';
${queries}
rollback;
`;
};

/** Observe short-lived locks without repeatedly starting a Docker/psql client. */
export const waitForImpactLock = async ({
  client,
  readPids,
  now = () => performance.now(),
  wait = pause,
}) => {
  const deadline = now() + 5000;
  while (
    now() < deadline &&
    client.child.exitCode === null &&
    client.child.signalCode === null
  ) {
    const pids = await readPids();
    if (
      Array.isArray(pids) &&
      pids.length === 1 &&
      Number.isSafeInteger(pids[0]) &&
      pids[0] > 0
    )
      return pids[0];
    await wait();
  }
  fail();
};

export const provePostgresqlMigrationImpact = async ({
  cwd,
  projectId,
  databasePort,
  artifact,
}) => {
  if (
    !/^[a-zA-Z0-9-]+$/u.test(projectId) ||
    !Number.isInteger(databasePort) ||
    !ID.test(artifact?.sha256) ||
    digest(await readFile(artifact.path)) !== artifact.sha256
  )
    fail();
  const bounded = (command, args, options = {}) =>
    spawnScenarioCommand(command, args, {
      cwd,
      timeout: 5000,
      maxBuffer: MAX_BYTES,
      ...options,
    });
  const local = assertLocalDockerContext({
    cwd,
    runner: (command, args) => bounded(command, args),
  });
  const docker = (args, options) => {
    const result = bounded(
      "docker",
      ["--host", local.endpoint, ...args],
      options,
    );
    if (result.error || result.signal || result.status !== 0) fail();
    return result.stdout.trim();
  };
  const engine = docker(["info", "--format", "{{.ID}}"]);
  const id = docker([
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `label=com.rehearsal-db.project=${projectId}`,
    "--format",
    "{{.ID}}",
  ]);
  if (!ID.test(id)) fail();
  const inspect = () => {
    const value = JSON.parse(
      docker([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"started":{{json .State.StartedAt}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}',
        id,
      ]),
    );
    if (
      value.id !== id ||
      value.name !== `/${projectId}-postgresql` ||
      value.running !== true ||
      value.labels?.["com.rehearsal-db.project"] !== projectId ||
      value.labels?.["com.supabase.cli.project"] !== undefined ||
      !isDeepStrictEqual(value.ports?.["5432/tcp"], [
        { HostIp: "127.0.0.1", HostPort: String(databasePort) },
      ])
    )
      fail();
    return digest(JSON.stringify(value));
  };
  const identity = inspect();
  const assertPinned = () => {
    if (
      docker(["info", "--format", "{{.ID}}"]) !== engine ||
      inspect() !== identity
    )
      fail();
  };
  const observe = (input) =>
    docker(["exec", "--interactive", id, ...PSQL], { input });
  const sql = (input) => {
    assertPinned();
    return observe(input);
  };
  const cliPath = join(cwd, "node_modules/.bin/rehearsal");
  const marker = JSON.parse(
    await readFile(join(cwd, ".rehearsal/runtime/baseline.json"), "utf8"),
  );
  const canaries = [...IMPACT_FIXTURE_CANARIES, marker.databasePassword];
  if (
    typeof marker.databasePassword !== "string" ||
    marker.databasePassword.length < 32
  )
    fail();
  const cli = (args, success = true) => {
    const result = bounded(cliPath, args, { timeout: 35000 });
    assertImpactPublicOutput(result, canaries);
    if (result.error || result.signal || (success && result.status !== 0))
      fail();
    return result;
  };
  const json = (args, success = true) => {
    const result = cli([...args, "--json"], success);
    return { result, envelope: JSON.parse(result.stdout) };
  };
  const version = json(["version"]).envelope;
  if (version.name !== artifact.name || version.version !== artifact.version)
    fail();
  const path = join(cwd, "database/migrations", FILE),
    relative = join("database/migrations", FILE);
  if (
    await lstat(path).then(
      () => true,
      (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    )
  )
    fail();
  const before = await protectedFingerprint(cwd, relative);
  const originalRowsSql =
    "select jsonb_build_object('public', (select jsonb_agg(to_jsonb(w) order by id) from public.widgets w), 'publication', (select jsonb_agg(to_jsonb(w) order by id) from blendcalc_api.widgets w));";
  const rowsBefore = digest(sql(originalRowsSql));
  const ledgerSql =
    "select coalesce(jsonb_agg(to_jsonb(m) order by version), '[]'::jsonb) from rehearsal_internal.schema_migrations m;";
  const ledgerBefore = digest(sql(ledgerSql));
  if (
    sql(`select pg_catalog.to_regnamespace('${SCHEMA}') is null;`) !== "t" ||
    Number(sql("show server_version_num;")) < 170000
  )
    fail();
  let schemaAttempted = false,
    fileCreated = false,
    observer,
    operationFailure,
    holderCounter = 0;
  const nonce = randomUUID();
  const clients = [],
    holders = [],
    deadlineApplications = [];
  const noBackend = (pid) =>
    observe(
      `select not exists (select 1 from pg_catalog.pg_stat_activity where pid = ${pid});`,
    ) === "t";
  const waitGone = async (pid) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (noBackend(pid)) return;
      await pause();
    }
    fail();
  };
  const hold = async () => {
    assertPinned();
    const application = `rehearsal-impact-holder-${process.pid}-${++holderCounter}`;
    const client = childClient(
      "docker",
      ["--host", local.endpoint, "exec", "--interactive", id, ...PSQL],
      { cwd, timeout: 15000 },
    );
    clients.push(client);
    const holder = { client, application, pid: null };
    holders.push(holder);
    client.child.stdin.write(
      `set application_name = '${application}'; begin; set local idle_in_transaction_session_timeout = '8s'; set local transaction_timeout = '8s'; lock table only ${SCHEMA}.parent in access exclusive mode; select pg_backend_pid();\n`,
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      const pid = client.output().trim();
      if (/^[1-9][0-9]{0,9}$/u.test(pid)) {
        holder.pid = Number(pid);
        return holder;
      }
      if (client.child.exitCode !== null) fail();
      await pause();
    }
    fail();
  };
  const release = async (holder) => {
    holder.client.child.stdin.end("rollback;\n\\q\n");
    const result = await holder.client.completion;
    if (holder.pid && !noBackend(holder.pid)) {
      sql(
        `select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where pid = ${holder.pid} and application_name = '${holder.application}';`,
      );
      await waitGone(holder.pid);
    }
    if (result.fault || result.status !== 0) fail();
  };
  let summary;
  try {
    // All fields are explicit: no PG* environment/service fallback and no secret
    // in argv. This fixture already pins the sole owned loopback container/port.
    observer = new pg.Client({
      host: "127.0.0.1",
      port: databasePort,
      database: "postgres",
      user: "postgres",
      password: marker.databasePassword,
      ssl: false,
      application_name: `rehearsal-impact-observer-${process.pid}`,
      connectionTimeoutMillis: 2000,
      query_timeout: 1000,
      options:
        "-c statement_timeout=750ms -c default_transaction_read_only=on -c search_path=pg_catalog",
    });
    observer.on("error", () => {});
    await observer.connect();
    const waiting = (client, application, query = null) =>
      waitForImpactLock({
        client,
        readPids: async () => {
          const result = await observer.query(
            "select coalesce(json_agg(pid), '[]'::json) as pids from pg_stat_activity where datname = 'postgres' and state = 'active' and wait_event_type = 'Lock' and application_name = $1 and ($2::text is null or query = $2);",
            [application, query],
          );
          return result.rows[0]?.pids;
        },
      });
    schemaAttempted = true;
    sql(
      `begin; create schema ${SCHEMA}; comment on schema ${SCHEMA} is '${nonce}'; commit;`,
    );
    sql(`create table ${SCHEMA}.parent (id integer primary key, payload text, duplicate_key text);
      create table ${SCHEMA}.child (id integer primary key, parent_id integer);
      insert into ${SCHEMA}.parent values (1,null,'a'),(2,null,'a'),(3,'','b'),(4,'value','c'),(5,'value',null),(6,'value',null);
      insert into ${SCHEMA}.child values (1,1),(2,2),(3,9),(4,9),(5,null);`);
    await writeFile(path, IMPACT_FIXTURE_SQL, { flag: "wx", mode: 0o600 });
    fileCreated = true;
    const preview = json(["inspect", "impact", "--target=primary"]).envelope
      .data;
    if (
      !ID.test(preview?.candidateSha256) ||
      preview.mode !== "preview" ||
      preview.safety?.contactsDatabase !== false
    )
      fail();
    const confirmation = `--confirm-candidates=${preview.candidateSha256}`;
    const impactRowsSql = `select pg_catalog.jsonb_build_object('parent', (select pg_catalog.jsonb_agg(to_jsonb(p) order by id) from ${SCHEMA}.parent p), 'child', (select pg_catalog.jsonb_agg(to_jsonb(c) order by id) from ${SCHEMA}.child c));`;
    const fixtureRowsBefore = digest(sql(impactRowsSql));
    const measure = (counts, reasons) => {
      const { envelope, result } = json(
        ["measure", "impact", "--target=primary", confirmation],
        false,
      );
      if (![0, 1].includes(result.status)) fail();
      const report = assertImpactFixtureCounts(envelope, {
        candidateSha256: preview.candidateSha256,
        counts,
        ...(reasons ? { reasons } : {}),
        version: artifact.version,
      });
      if (
        result.status !==
        (["partial", "unknown"].includes(report.measurementStatus) ? 1 : 0)
      )
        fail();
      return report;
    };
    const first = measure(["2", "4", "2", "2", "5", "6", "6"]);
    if (digest(sql(impactRowsSql)) !== fixtureRowsBefore) fail();
    sql(`update ${SCHEMA}.parent set payload = '${ROW_CANARY}' where id = 1;`);
    const fixtureRowsEdited = digest(sql(impactRowsSql));
    const current = measure(["1", "5", "2", "2", "5", "6", "6"]);
    if (
      first.runtimeIdentitySha256 !== current.runtimeIdentitySha256 ||
      (await protectedFingerprint(cwd, relative)) !== before
    )
      fail();
    cli(["measure", "impact", "--target=primary", confirmation], false);
    await writeFile(path, `${IMPACT_FIXTURE_SQL}-- changed reviewed bytes\n`);
    const stale = json(
      ["measure", "impact", "--target=primary", confirmation],
      false,
    );
    if (
      stale.result.status === 0 ||
      !stale.envelope.error ||
      json(["inspect", "impact", "--target=primary"]).envelope.data
        .candidateSha256 === preview.candidateSha256
    )
      fail();
    await writeFile(path, IMPACT_FIXTURE_SQL);
    sql(`create function ${SCHEMA}.guard(value integer) returns integer language plpgsql immutable as $$ begin
      if pg_catalog.current_setting('transaction_read_only') = 'on' then raise exception '${UDF_CANARY}'; end if;
      return value; end $$;
      create index impact_review_index on ${SCHEMA}.parent ((${SCHEMA}.guard(id)));`);
    const guardedCounts = [null, null, null, null, "5", null, null];
    const guardedReasons = guardedCounts.map((count) =>
      count === null ? "unsupported_runtime_metadata" : null,
    );
    measure(guardedCounts, guardedReasons);
    sql(`drop index ${SCHEMA}.impact_review_index;
      create statistics ${SCHEMA}.impact_review_statistics on (${SCHEMA}.guard(id)) from ${SCHEMA}.parent;`);
    measure(guardedCounts, guardedReasons);
    sql(`drop statistics ${SCHEMA}.impact_review_statistics;`);
    // Queue DDL ahead of the measurement's strong lock. Its catalog preflight
    // sees the old table, but its count snapshot must see the committed index.
    // The old ACCESS SHARE/snapshot-first protocol would miss that metadata and
    // invoke the expression canary while planning, aborting the whole batch.
    const raceHolder = await hold();
    const indexApplication = `rehearsal-impact-index-${process.pid}`;
    const indexClient = childClient(
      "docker",
      ["--host", local.endpoint, "exec", "--interactive", id, ...PSQL],
      { cwd, timeout: 10000 },
    );
    clients.push(indexClient);
    indexClient.child.stdin.end(
      `set application_name = '${indexApplication}';\nset lock_timeout = '4s';\ncreate index impact_review_race_index on ${SCHEMA}.parent ((${SCHEMA}.guard(id)));\n`,
    );
    const indexPid = await waiting(indexClient, indexApplication);
    const raceMeasurement = childClient(
      cliPath,
      ["measure", "impact", "--target=primary", confirmation, "--json"],
      { cwd, timeout: 35000 },
    );
    clients.push(raceMeasurement);
    raceMeasurement.child.stdin.end();
    const racePid = await waiting(
      raceMeasurement,
      "psql",
      `lock table only "${SCHEMA}"."parent" in share row exclusive mode;`,
    );
    await release(raceHolder);
    const indexResult = await indexClient.completion;
    assertImpactRaceIndexResult(indexResult);
    const raceResult = await raceMeasurement.completion;
    assertImpactPublicOutput(raceResult, canaries);
    if (raceResult.fault || raceResult.status !== 1) fail();
    assertImpactFixtureCounts(JSON.parse(raceResult.stdout), {
      candidateSha256: preview.candidateSha256,
      counts: guardedCounts,
      reasons: guardedReasons,
      version: artifact.version,
    });
    await waitGone(indexPid);
    await waitGone(racePid);
    sql(
      `drop index ${SCHEMA}.impact_review_race_index; drop function ${SCHEMA}.guard(integer);`,
    );
    const locked = await hold();
    const lockStarted = performance.now();
    measure(Array(7).fill(null), Array(7).fill("lock_timeout"));
    const lockLatencyMs = Math.round(performance.now() - lockStarted);
    if (lockLatencyMs > 30000) fail();
    await release(locked);
    const cancelledHolder = await hold();
    const measurement = childClient(
      cliPath,
      ["measure", "impact", "--target=primary", confirmation, "--json"],
      { cwd, timeout: 35000 },
    );
    clients.push(measurement);
    measurement.child.stdin.end();
    const backend = await waiting(
      measurement,
      "psql",
      `lock table only "${SCHEMA}"."parent" in share row exclusive mode;`,
    );
    const cancellationStarted = performance.now();
    measurement.child.kill("SIGINT");
    const cancelled = await measurement.completion;
    assertImpactPublicOutput(cancelled, canaries);
    const cancellation = JSON.parse(cancelled.stdout);
    if (
      cancelled.fault ||
      cancelled.status !== 130 ||
      cancellation.error?.category !== "operation_cancelled" ||
      cancellation.error?.context?.signal !== "SIGINT" ||
      performance.now() - cancellationStarted > 10000
    )
      fail();
    await waitGone(backend);
    await release(cancelledHolder);
    if (json(["activity"]).envelope.data.state !== "idle") fail();
    // Core-owned acceptance may exercise the installed private transport. The
    // independent Lab remains a public-CLI consumer. A 35s fixture signal lets
    // the real server's 30s transaction expiry reach the transport before the
    // harness cancels it; the public operation's 30s budget is NOT changed.
    const installedModule = (relative) =>
      import(
        pathToFileURL(
          join(cwd, "node_modules/@rehearsal-db/core/dist/src", relative),
        ).href
      );
    const [{ loadRuntimeTopology }, { verifyActiveBaseline }, transport] =
      await Promise.all([
        installedModule("runtime/topology.mjs"),
        installedModule("baseline/artifact.mjs"),
        installedModule("targets/migration_impact_runtime.mjs"),
      ]);
    const topology = await loadRuntimeTopology({ projectRoot: cwd });
    const target = topology.targets.find((entry) => entry.name === "primary");
    if (
      !target ||
      topology.targets.length !== 1 ||
      target.config.runtime.projectId !== projectId ||
      target.config.runtime.ports.database !== databasePort
    )
      fail();
    const baseline = await verifyActiveBaseline({
      artifactRoot: target.paths.artifactDirectory,
    });
    const serverDeadlines = {};
    for (const kind of ["statement", "transaction"]) {
      assertPinned();
      const application = `rehearsal-impact-deadline-${process.pid}-${kind}`;
      deadlineApplications.push(application);
      const runtime = await transport.openMigrationImpactRuntime({
        projectRoot: cwd,
        target,
        baseline,
        signal: AbortSignal.timeout(35000),
      });
      const started = performance.now();
      let reason;
      try {
        await runtime.runSql(buildImpactDeadlineProbe(kind, application));
      } catch (error) {
        if (error instanceof transport.MigrationImpactRuntimeError)
          reason = error.reason;
        else fail();
      }
      const elapsedMilliseconds = Math.round(performance.now() - started);
      if (reason !== `${kind}_timeout`) fail();
      const remaining = await observer.query(
        "select count(*)::integer as count from pg_stat_activity where datname = 'postgres' and application_name = $1;",
        [application],
      );
      if (remaining.rows[0]?.count !== 0) fail();
      // runSql rechecks receipt/engine/container before exposing a timeout.
      // Reusing its nearly spent signal for another duplicate inspection makes
      // slow WSL Docker round-trips look like a failed server deadline. Retain
      // the independent pinned-resource check and absent-backend proof below.
      assertPinned();
      serverDeadlines[kind] = {
        reason,
        elapsedMilliseconds,
        backendGone: true,
        postQueryIdentity: "verified-by-transport-before-timeout",
      };
    }
    const retained = JSON.parse(
      sql(
        `select pg_catalog.json_build_object('parent', (select pg_catalog.count(*) from ${SCHEMA}.parent), 'child', (select pg_catalog.count(*) from ${SCHEMA}.child), 'edited', (select payload = '${ROW_CANARY}' from ${SCHEMA}.parent where id = 1));`,
      ),
    );
    if (!isDeepStrictEqual(retained, { parent: 6, child: 5, edited: true }))
      fail();
    if (
      digest(sql(impactRowsSql)) !== fixtureRowsEdited ||
      digest(sql(ledgerSql)) !== ledgerBefore
    )
      fail();
    summary = {
      metricCounts: ["2", "4", "2", "2", "5", "6", "6"],
      currentRowCounts: ["1", "5"],
      candidateSha256: preview.candidateSha256,
      expressionIndexAndStatistics: "unknown-without-canary-output",
      concurrentIndexDdl: "unknown-without-canary-output",
      lockTimeout: "passed",
      lockLatencyMs,
      cancellation: "passed",
      backendGone: true,
      immutableInputsPreserved: true,
      runtimeIdentityPreserved: true,
      serverDeadlines,
      deadlineLimitation:
        "Fixed read-only sleep probes exercised the installed private transport's real 5-second statement and 30-second server transaction deadlines. Their fixture-only 35-second signal does not change or prove the public CLI's 30-second end-to-end budget or aggregate performance.",
    };
  } catch (error) {
    operationFailure = error;
  }
  const cleanupFailures = [];
  for (const application of deadlineApplications) {
    try {
      const pids = JSON.parse(
        sql(
          `select coalesce(json_agg(pid), '[]'::json) from pg_catalog.pg_stat_activity where datname = 'postgres' and application_name = '${application}';`,
        ),
      );
      if (
        !Array.isArray(pids) ||
        pids.length > 1 ||
        pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
      )
        fail();
      for (const pid of pids) {
        sql(
          `select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where pid = ${pid} and datname = 'postgres' and application_name = '${application}';`,
        );
        await waitGone(pid);
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (observer) {
    try {
      await observer.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  for (const client of clients)
    if (client.child.exitCode === null && client.child.signalCode === null) {
      client.stop();
      await client.completion;
    }
  for (const holder of holders)
    if (holder.pid) {
      try {
        if (!noBackend(holder.pid))
          sql(
            `select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where pid = ${holder.pid} and application_name = '${holder.application}';`,
          );
        await waitGone(holder.pid);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  try {
    if (fileCreated) {
      const bytes = await readFile(path, "utf8");
      if (
        ![
          IMPACT_FIXTURE_SQL,
          `${IMPACT_FIXTURE_SQL}-- changed reviewed bytes\n`,
        ].includes(bytes)
      )
        fail();
      await unlink(path);
    }
    if (
      schemaAttempted &&
      sql(`select pg_catalog.to_regnamespace('${SCHEMA}') is null;`) !== "t"
    ) {
      if (
        sql(
          `select pg_catalog.obj_description(pg_catalog.to_regnamespace('${SCHEMA}'), 'pg_namespace');`,
        ) !== nonce
      )
        fail();
      sql(`set lock_timeout = '1s'; drop schema ${SCHEMA} cascade;`);
    }
    assertPinned();
    if (
      (await protectedFingerprint(cwd, relative)) !== before ||
      digest(sql(originalRowsSql)) !== rowsBefore ||
      digest(sql(ledgerSql)) !== ledgerBefore ||
      (schemaAttempted &&
        sql(`select pg_catalog.to_regnamespace('${SCHEMA}') is null;`) !== "t")
    )
      fail();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      [...(operationFailure ? [operationFailure] : []), ...cleanupFailures],
      "The owned PostgreSQL impact fixture could not confirm cleanup; private output withheld.",
    );
  if (operationFailure) throw operationFailure;
  return { ...summary, cleanup: "passed" };
};
