import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MigrationImpactRuntimeError,
  openMigrationImpactRuntime,
} from "../../../dist/src/targets/migration_impact_runtime.mjs";

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const ID = "b".repeat(64),
  IMAGE = `sha256:${"c".repeat(64)}`;
const PRIVATE = "PRIVATE_IMPACT_TRANSPORT_CANARY";
const result = (stdout = "", status = 0, stderr = "") => ({
  status,
  signal: null,
  stdout,
  stderr,
  stdoutByteCount: Buffer.byteLength(stdout),
  stderrByteCount: Buffer.byteLength(stderr),
});
async function fixture(provider = "postgresql") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "impact-runtime-")));
  roots.push(root);
  const runtime = join(root, ".rehearsal/runtime");
  await mkdir(runtime, { recursive: true });
  const projectId = "impact-owned-rehearsal";
  const baseline = {
    formatVersion: 2,
    generationId: "20261022T120000Z-123456abcdef",
    files: { "sanitized-data.ndjson": { sha256: "a".repeat(64) } },
  };
  const target = {
    name: "primary",
    config: {
      runtime: { target: provider, projectId, ports: { database: 58322 } },
      ...(provider === "postgresql"
        ? {
            postgresql: {
              image: "postgres:17-alpine",
              database: "rehearsal",
              user: "postgres",
            },
          }
        : {}),
    },
    paths: { runtimeWorkdir: runtime },
  };
  const marker = {
    formatVersion: provider === "postgresql" ? 1 : 2,
    target: provider,
    generationId: baseline.generationId,
    dataSha256: baseline.files["sanitized-data.ndjson"].sha256,
    ...(provider === "postgresql"
      ? { image: "postgres:17-alpine", databasePassword: PRIVATE.repeat(2) }
      : { schemaSha256: null }),
  };
  const markerPath = join(runtime, "baseline.json");
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const settings = {
    endpoint: "unix:///synthetic/docker.sock",
    engine: "engine-id-1234",
    id: ID,
    name: `/${provider === "postgresql" ? `${projectId}-postgresql` : `supabase_db_${projectId}`}`,
    image: "postgres:17-alpine",
    imageId: IMAGE,
    running: true,
    labels: {
      [provider === "postgresql"
        ? "com.rehearsal-db.project"
        : "com.supabase.cli.project"]: projectId,
    },
    ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "58322" }] },
    sqlResult: result('"6"\n'),
    onSql: undefined,
    onInspect: undefined,
    onInfo: undefined,
  };
  const runner = vi.fn(async (request) => {
    const { args } = request;
    if (args[0] === "context")
      return result(
        args[1] === "show"
          ? "synthetic-local\n"
          : JSON.stringify(settings.endpoint),
      );
    if (args[0] === "info") {
      await settings.onInfo?.();
      return result(JSON.stringify(settings.engine));
    }
    if (args[0] === "container") {
      await settings.onInspect?.(request);
      return result(
        JSON.stringify({
          id: settings.id,
          name: settings.name,
          image: settings.image,
          imageId: settings.imageId,
          running: settings.running,
          labels: settings.labels,
          ports: settings.ports,
        }),
      );
    }
    if (args[0] === "exec") {
      await settings.onSql?.(request);
      return settings.sqlResult;
    }
    throw new Error(`${PRIVATE}: unexpected child`);
  });
  const options = {
    projectRoot: root,
    target,
    baseline,
    runProcessImplementation: runner,
  };
  return { root, runtime, marker, markerPath, settings, runner, options };
}
const refusal = (reason) => (error) => {
  expect(error).toBeInstanceOf(MigrationImpactRuntimeError);
  if (reason) expect(error.reason).toBe(reason);
  expect(error.message).toBe(
    "The selected local runtime could not complete bounded read-only inspection; private output withheld.",
  );
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain(PRIVATE);
  return true;
};

describe("non-starting migration impact runtime transport", () => {
  it("compiles a deadline-bound script only after final identity preflight and immediately before exec", async () => {
    const f = await fixture();
    const transport = await openMigrationImpactRuntime(f.options);
    const before = f.runner.mock.calls.length;
    const compile = vi.fn(() => {
      const calls = f.runner.mock.calls
        .slice(before)
        .map(([request]) => request);
      expect(calls.map((request) => request.args[0])).toEqual([
        "info",
        "container",
      ]);
      return "SELECT 1;";
    });
    await transport.runSql(compile);
    expect(compile).toHaveBeenCalledOnce();
    const calls = f.runner.mock.calls.slice(before).map(([request]) => request);
    expect(calls[2].args[0]).toBe("exec");
    expect(calls[2].input).toBe("SELECT 1;");
  });

  it.each(["postgresql", "supabase"])(
    "pins %s engine/container identity and submits SQL only on stdin",
    async (provider) => {
      const f = await fixture(provider),
        before = await readFile(f.markerPath);
      const transport = await openMigrationImpactRuntime(f.options);
      expect(transport.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
      const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT '${PRIVATE}'; ROLLBACK;`;
      expect(await transport.runSql(sql)).toBe('"6"\n');
      await transport.assertCurrent();
      const calls = f.runner.mock.calls.map(([call]) => call),
        query = calls.find((call) => call.args[0] === "exec");
      expect(query.args).toEqual([
        "exec",
        "--interactive",
        ID,
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
        provider === "postgresql" ? "postgres" : "supabase_admin",
        "--dbname",
        provider === "postgresql" ? "rehearsal" : "postgres",
      ]);
      expect(query.input).toBe(sql);
      expect(query.args.join(" ")).not.toContain(PRIVATE);
      for (const call of calls) {
        expect(call.command).toBe("docker");
        expect(call.stdin).toBe("ignore");
        expect(call.cancellationGraceMs).toBe(1000);
        expect(call.signal).toBeInstanceOf(AbortSignal);
        expect(call.cwd).toBe(f.root);
        expect(["context", "info", "container", "exec"]).toContain(
          call.args[0],
        );
        expect(call.args).not.toContain("start");
        expect(call.args).not.toContain("run");
        expect(call.maxOutputBytes).toBe(
          call.args[0] === "exec" ? 131072 : 65536,
        );
        expect(call.env.DOCKER_HOST).toBe(
          call.args[0] === "context" ? undefined : f.settings.endpoint,
        );
      }
      expect(await readFile(f.markerPath)).toEqual(before);
      expect(JSON.stringify(transport)).not.toContain(PRIVATE);
    },
  );
  it.each(["postgresql", "supabase"])(
    "clears inherited %s container PG settings and forces a noninteractive local socket",
    async (provider) => {
      const f = await fixture(provider);
      const hostileContainerEnvironment = {
        PGHOST: "remote.example.test",
        PGHOSTADDR: "203.0.113.5",
        PGPORT: "54321",
        PGSERVICE: PRIVATE,
        PGSERVICEFILE: `/private/${PRIVATE}`,
        PGOPTIONS: `-c search_path=${PRIVATE}`,
        PGPASSWORD: PRIVATE,
        PGPASSFILE: `/private/${PRIVATE}`,
        PGSSLMODE: "require",
      };
      f.settings.onSql = ({ args }) => {
        // Contract-only simulation: env -i discards container defaults before
        // the fixed assignments. Actual image/socket compatibility is separate.
        expect(args.slice(0, 5)).toEqual([
          "exec",
          "--interactive",
          ID,
          "/usr/bin/env",
          "-i",
        ]);
        const executable = args.indexOf("psql");
        const assignments = Object.fromEntries(
          args.slice(5, executable).map((entry) => {
            const separator = entry.indexOf("=");
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
        );
        expect(assignments).toEqual({
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          PGSSLMODE: "disable",
          PGPASSFILE: "/dev/null",
        });
        for (const [name, value] of Object.entries(hostileContainerEnvironment))
          expect(assignments[name]).not.toBe(value);
        expect(args).toContain("--host=/var/run/postgresql");
        expect(args).toContain("--port=5432");
        expect(args).toContain("--no-password");
        expect(args).not.toContain("--env");
        expect(args.join(" ")).not.toContain(PRIVATE);
      };
      const transport = await openMigrationImpactRuntime(f.options);
      await transport.runSql("SELECT 1;");
      expect(f.settings.onSql).toBeDefined();
      expect(
        f.runner.mock.calls.filter(([call]) => call.args[0] === "exec"),
      ).toHaveLength(1);
    },
  );
  it.each(["env", "psql", "socket"])(
    "fails closed when required %s support is absent, without a host or password fallback",
    async (missing) => {
      const f = await fixture(),
        transport = await openMigrationImpactRuntime(f.options);
      f.settings.sqlResult = result(
        "",
        missing === "socket" ? 2 : 127,
        PRIVATE,
      );
      await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
        refusal("query_failed"),
      );
      const executions = f.runner.mock.calls.filter(
        ([call]) => call.args[0] === "exec",
      );
      expect(executions).toHaveLength(1);
      expect(executions[0][0].args.slice(0, 5)).toEqual([
        "exec",
        "--interactive",
        ID,
        "/usr/bin/env",
        "-i",
      ]);
      expect(executions[0][0].args).toContain("--host=/var/run/postgresql");
      expect(executions[0][0].args).toContain("--no-password");
    },
  );
  it("strips ambient credentials and remote Docker selectors", async () => {
    for (const name of [
      "DATABASE_URL",
      "PGPASSWORD",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
      "SUPABASE_SERVICE_ROLE_KEY",
    ])
      vi.stubEnv(name, PRIVATE);
    const f = await fixture();
    await openMigrationImpactRuntime(f.options);
    for (const [{ env }] of f.runner.mock.calls) {
      for (const key of [
        "DATABASE_URL",
        "PGPASSWORD",
        "DOCKER_CONTEXT",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "SUPABASE_SERVICE_ROLE_KEY",
      ])
        expect(env[key]).toBeUndefined();
      expect(Object.values(env)).not.toContain(PRIVATE);
    }
  });
  it.each([
    "tcp://remote.example.test:2375",
    "https://example.test",
    "unix://host/private/socket",
    "tcp://user:secret@127.0.0.1:2375",
    "not-an-endpoint",
  ])(
    "refuses nonlocal/unsafe context before daemon contact: %s",
    async (endpoint) => {
      const f = await fixture();
      f.settings.endpoint = endpoint;
      await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
        refusal("ownership_mismatch"),
      );
      expect(
        f.runner.mock.calls.every(([call]) => call.args[0] === "context"),
      ).toBe(true);
    },
  );
  it.each([
    ["generationId", "foreign"],
    ["dataSha256", "d".repeat(64)],
    ["target", "supabase"],
    ["image", "other:image"],
    ["formatVersion", 2],
    ["databasePassword", "short"],
  ])("refuses mismatched marker %s before any child", async (key, value) => {
    const f = await fixture();
    f.marker[key] = value;
    await writeFile(f.markerPath, JSON.stringify(f.marker));
    await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
      refusal("stale_runtime"),
    );
    expect(f.runner).not.toHaveBeenCalled();
  });
  it.each([
    "missing",
    "symlink",
    "oversized",
    "invalid-utf8",
    "permissions",
    "directory",
  ])(
    "refuses unsafe %s receipt without following or repairing it",
    async (kind) => {
      const f = await fixture();
      if (kind === "missing") await rm(f.markerPath);
      if (kind === "symlink") {
        const sentinel = join(f.root, "sentinel.json");
        await writeFile(sentinel, JSON.stringify(f.marker), { mode: 0o600 });
        await rm(f.markerPath);
        await symlink(sentinel, f.markerPath);
      }
      if (kind === "oversized")
        await writeFile(f.markerPath, Buffer.alloc(65537, 32));
      if (kind === "invalid-utf8")
        await writeFile(f.markerPath, Buffer.from([0xff, 0xfe]));
      if (kind === "permissions") await chmod(f.markerPath, 0o644);
      if (kind === "directory") {
        await rm(f.markerPath);
        await mkdir(f.markerPath);
      }
      await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
        refusal("stale_runtime"),
      );
      expect(f.runner).not.toHaveBeenCalled();
    },
  );
  it("refuses a runtime directory symlink or escaped configured path before tools", async () => {
    const f = await fixture();
    const alias = join(f.root, "runtime-alias");
    await symlink(f.runtime, alias);
    f.options.target.paths.runtimeWorkdir = alias;
    await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
      refusal("ownership_mismatch"),
    );
    f.options.target.paths.runtimeWorkdir = join(f.root, "..");
    await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
      refusal("ownership_mismatch"),
    );
    expect(f.runner).not.toHaveBeenCalled();
  });
  it.each(["postgresql", "supabase"])(
    "refuses foreign/conflicting %s project ownership",
    async (provider) => {
      const f = await fixture(provider);
      f.settings.labels = {
        "com.rehearsal-db.project": "foreign",
        "com.supabase.cli.project": "foreign",
      };
      await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
        refusal("ownership_mismatch"),
      );
      f.settings.labels = {
        "com.rehearsal-db.project": "impact-owned-rehearsal",
        "com.supabase.cli.project": "foreign",
      };
      await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
        refusal("ownership_mismatch"),
      );
      expect(
        f.runner.mock.calls.some(([call]) => call.args[0] === "exec"),
      ).toBe(false);
    },
  );
  it.each(["running", "name", "image", "port", "host"])(
    "refuses wrong PostgreSQL %s without repair",
    async (field) => {
      const f = await fixture();
      if (field === "running") f.settings.running = false;
      if (field === "name") f.settings.name = "/foreign-postgresql";
      if (field === "image") f.settings.image = "foreign:image";
      if (field === "port") f.settings.ports["5432/tcp"][0].HostPort = "54321";
      if (field === "host") f.settings.ports["5432/tcp"][0].HostIp = "0.0.0.0";
      await expect(openMigrationImpactRuntime(f.options)).rejects.toSatisfy(
        refusal(),
      );
      expect(
        f.runner.mock.calls.some(([call]) => call.args[0] === "exec"),
      ).toBe(false);
    },
  );
  it.each(["receipt", "engine", "container", "image"])(
    "refuses changed %s identity before SQL",
    async (kind) => {
      const f = await fixture(),
        transport = await openMigrationImpactRuntime(f.options);
      if (kind === "receipt") await appendFile(f.markerPath, "\n");
      if (kind === "engine") f.settings.engine = "new-engine";
      if (kind === "container") f.settings.id = "d".repeat(64);
      if (kind === "image") f.settings.imageId = `sha256:${"d".repeat(64)}`;
      await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
        refusal("stale_runtime"),
      );
      expect(
        f.runner.mock.calls.some(([call]) => call.args[0] === "exec"),
      ).toBe(false);
    },
  );
  it("does not publish successful SQL output when the receipt changes mid-query", async () => {
    const f = await fixture(),
      transport = await openMigrationImpactRuntime(f.options);
    f.settings.onSql = () => appendFile(f.markerPath, "\n");
    await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
      refusal("stale_runtime"),
    );
  });
  it.each([
    ["55P03", "lock_timeout"],
    ["57014", "statement_timeout"],
    ["25P04", "transaction_timeout"],
    ["42601", "query_failed"],
  ])(
    "classifies only fixed SQLSTATE %s and withholds provider details",
    async (code, reason) => {
      const f = await fixture(),
        transport = await openMigrationImpactRuntime(f.options);
      f.settings.sqlResult = result(
        PRIVATE,
        3,
        `psql:<stdin>:1: ERROR: ${code}\n${PRIVATE}`,
      );
      await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
        refusal(reason),
      );
      expect(
        f.runner.mock.calls.filter(([call]) => call.args[0] === "info").length,
      ).toBeGreaterThan(2);
    },
  );
  it("ambiguous provider codes are generic query failure, not guessed timeouts", async () => {
    const f = await fixture(),
      transport = await openMigrationImpactRuntime(f.options);
    f.settings.sqlResult = result("", 3, "ERROR: 55P03\nERROR: 57014\n");
    await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
      refusal("query_failed"),
    );
  });
  it.each(["", "SELECT\0 1;", "x".repeat(262145)])(
    "bounds SQL input before dispatch",
    async (sql) => {
      const f = await fixture(),
        transport = await openMigrationImpactRuntime(f.options),
        count = f.runner.mock.calls.length;
      await expect(transport.runSql(sql)).rejects.toSatisfy(
        refusal("query_failed"),
      );
      expect(f.runner.mock.calls).toHaveLength(count);
    },
  );
  it("bounds inspection and SQL output without retaining child error causes", async () => {
    const f = await fixture();
    const huge = vi.fn(async () => result("x".repeat(65537)));
    await expect(
      openMigrationImpactRuntime({
        ...f.options,
        runProcessImplementation: huge,
      }),
    ).rejects.toSatisfy(refusal("runtime_unavailable"));
    const transport = await openMigrationImpactRuntime(f.options);
    f.settings.sqlResult = result("x".repeat(131073));
    await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
      refusal("query_failed"),
    );
  });
  it("bounds thrown transport errors and pre-aborted/during-query cancellation", async () => {
    const f = await fixture(),
      thrown = vi.fn(async () => {
        throw new Error(PRIVATE);
      });
    await expect(
      openMigrationImpactRuntime({
        ...f.options,
        runProcessImplementation: thrown,
      }),
    ).rejects.toSatisfy(refusal("runtime_unavailable"));
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE));
    await expect(
      openMigrationImpactRuntime({ ...f.options, signal: controller.signal }),
    ).rejects.toSatisfy(refusal("cancelled"));
    const active = new AbortController(),
      transport = await openMigrationImpactRuntime({
        ...f.options,
        signal: active.signal,
      });
    f.settings.onSql = () => active.abort(new Error(PRIVATE));
    await expect(transport.runSql("SELECT 1;")).rejects.toSatisfy(
      refusal("cancelled"),
    );
  });
});
