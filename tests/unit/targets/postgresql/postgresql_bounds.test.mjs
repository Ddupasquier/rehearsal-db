import { expect, it, vi } from "vitest";
import {
  runPostgresqlCommand,
  postgresqlPsqlArguments,
  POSTGRESQL_COMMAND_BUDGETS,
  runPostgresqlAdapterSql,
} from "../../../../dist/src/targets/postgresql/postgresql_process.mjs";
import { createPostgresqlResourceManagement } from "../../../../dist/src/targets/postgresql/postgresql_resources.mjs";
import { inspectPostgresqlRuntimeStatus } from "../../../../dist/src/targets/postgresql/postgresql_status.mjs";

it("does not interpret a missing transport as an allowed command failure", async () => {
  await expect(
    Promise.resolve().then(() =>
      runPostgresqlCommand("/rehearsal-nonexistent-command", [], {
        cwd: process.cwd(),
        allowFailure: true,
      }),
    ),
  ).rejects.toThrow();
});

const result = (change = {}) => ({
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutByteCount: 0,
  stderrByteCount: 0,
  ...change,
});
it.each([
  { error: Object.assign(Error("PRIVATE_TRANSPORT"), { code: "ETIMEDOUT" }) },
  { error: Object.assign(Error("PRIVATE_TRANSPORT"), { code: "ENOBUFS" }) },
  { signal: "SIGTERM", status: null },
  { status: null },
])(
  "refuses transport uncertainty even for allowFailure probes",
  async (change) => {
    await expect(
      runPostgresqlCommand("synthetic", [], {
        cwd: process.cwd(),
        allowFailure: true,
        runProcessImplementation: async () => result(change),
      }),
    ).rejects.toThrow("transport failed or was interrupted");
  },
);
it("allows a completed ordinary negative probe without leaking provider text on strict calls", async () => {
  const runProcessImplementation = async () =>
    result({ status: 1, stderr: "PRIVATE_SQL", stdout: "PRIVATE_ROW" });
  expect(
    (
      await runPostgresqlCommand("synthetic", [], {
        cwd: process.cwd(),
        allowFailure: true,
        runProcessImplementation,
      })
    ).status,
  ).toBe(1);
  await expect(
    runPostgresqlCommand("synthetic", [], {
      cwd: process.cwd(),
      runProcessImplementation,
    }),
  ).rejects.not.toThrow("PRIVATE_");
});
it("bounds and reaps a real TERM-resistant owned child", async () => {
  let pid;
  const running = runPostgresqlCommand(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)",
    ],
    {
      cwd: process.cwd(),
      allowFailure: true,
      timeoutMilliseconds: 150,
      runProcessImplementation: async (options) => {
        const { spawn } = await import("node:child_process");
        const { runOwnedProcess } =
          await import("../../../../dist/src/shared/owned_process.mjs");
        return runOwnedProcess({
          ...options,
          spawnImplementation: (...args) => {
            const child = spawn(...args);
            pid = child.pid;
            return child;
          },
        });
      },
    },
  );
  const started = Date.now();
  await expect(running).rejects.toThrow("transport failed or was interrupted");
  expect(Date.now() - started).toBeLessThan(3500);
  expect(() => process.kill(pid, 0)).toThrow();
});
it("preserves cancellation on metadata commands and never treats it as absence", async () => {
  const controller = new AbortController();
  const pending = runPostgresqlCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { cwd: process.cwd(), allowFailure: true, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 40);
  await expect(pending).rejects.toThrow("transport failed or was interrupted");
});
it("keeps server deadlines and psql startup files out of every built-in SQL lane", () => {
  for (const purpose of ["sql", "migration", "restore"]) {
    const args = postgresqlPsqlArguments({
      containerName: "owned",
      database: "postgres",
      databaseUser: "postgres",
      purpose,
    });
    expect(args).toContain("--no-psqlrc");
    expect(args).toContain("PGCONNECT_TIMEOUT=5");
    expect(args).toContain(
      `PGOPTIONS=-c statement_timeout=${POSTGRESQL_COMMAND_BUDGETS[purpose]} -c lock_timeout=10000 -c idle_in_transaction_session_timeout=120000`,
    );
  }
});
it("streams input through the existing owned runner without assembling the baseline", async () => {
  async function* input() {
    yield "first\n";
    await new Promise((done) => setTimeout(done, 10));
    yield "café 漢字\n";
  }
  const output = await runPostgresqlCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { cwd: process.cwd(), input: input() },
  );
  expect(output.stdout).toBe("first\ncafé 漢字\n");
});
it("does not accept success when the process exits before all streamed input", async () => {
  async function* input() {
    await new Promise((done) => setTimeout(done, 100));
    yield "not delivered";
  }
  await expect(
    runPostgresqlCommand(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      input: input(),
    }),
  ).rejects.toThrow("transport failed or was interrupted");
});

const resourceFixture = (failure) => {
  const calls = [],
    id = "a".repeat(64);
  let container = true,
    volume = true;
  const runCommand = vi.fn(async (_command, args) => {
    calls.push([...args]);
    if (failure?.(args)) throw Error("transport unconfirmed");
    if (args[0] === "info") return result();
    if (args[1] === "ls")
      return result({
        stdout:
          args[0] === "container"
            ? container
              ? id
              : ""
            : volume
              ? "owned-postgresql-data"
              : "",
      });
    if (args[1] === "inspect")
      return result({
        stdout: JSON.stringify(
          args[0] === "volume" && args[3].includes("createdAt")
            ? {
                name: "owned-postgresql-data",
                createdAt: "2026-10-24T00:00:00.123456789Z",
                driver: "local",
                labels: { "com.rehearsal-db.project": "owned" },
              }
            : { "com.rehearsal-db.project": "owned" },
        ),
      });
    if (args[1] === "rm") {
      if (args[0] === "container") container = false;
      else volume = false;
      return result();
    }
    throw Error("Unexpected command");
  });
  const resources = createPostgresqlResourceManagement({
    runCommand,
    containerName: "owned-postgresql",
    volumeName: "owned-postgresql-data",
    projectId: "owned",
  });
  return { resources, calls, runCommand, id };
};
it("proves exact absence after both removals before permitting recovery deletion", async () => {
  const f = resourceFixture();
  await f.resources.removeResources();
  expect(f.calls.filter((args) => args[1] === "rm")).toEqual([
    ["container", "rm", "--force", f.id],
    ["volume", "rm", "--force", "owned-postgresql-data"],
  ]);
  expect(f.calls.at(-1).slice(0, 2)).toEqual(["volume", "ls"]);
});
it.each(["engine", "initial-list", "after-container-remove"])(
  "retains recovery and avoids further deletion on %s uncertainty",
  async (mode) => {
    let removed = false;
    const f = resourceFixture((args) => {
      if (args[0] === "container" && args[1] === "rm") removed = true;
      return mode === "engine"
        ? args[0] === "info"
        : mode === "initial-list"
          ? args[1] === "ls"
          : removed && args[0] === "container" && args[1] === "ls";
    });
    await expect(f.resources.removeResources()).rejects.toThrow();
    expect(
      f.calls.some((args) => args[0] === "volume" && args[1] === "rm"),
    ).toBe(false);
  },
);

it("keeps the event loop responsive while a built-in command is running", async () => {
  let ticked = false;
  const tick = setTimeout(() => {
    ticked = true;
  }, 10);
  try {
    const pending = runPostgresqlCommand(
      process.execPath,
      ["-e", "setTimeout(()=>process.stdout.write('done'),100)"],
      { cwd: process.cwd(), capture: true },
    );
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).stdout).toBe("done");
    expect(ticked).toBe(true);
  } finally {
    clearTimeout(tick);
  }
});

it("retains the synchronous custom-adapter SQL callback with a hard client kill budget and redaction", () => {
  const runner = vi.fn(() => ({
    status: 0,
    signal: null,
    stdout: "42\n",
    stderr: "",
  }));
  const output = runPostgresqlAdapterSql(
    ["synthetic"],
    "PRIVATE_SQL",
    process.cwd(),
    runner,
  );
  expect(output).toBe("42\n");
  expect(output).not.toBeInstanceOf(Promise);
  expect(runner.mock.calls[0][1]).not.toContain("PRIVATE_SQL");
  expect(runner.mock.calls[0][2]).toMatchObject({
    timeout: 120000,
    killSignal: "SIGKILL",
    input: "PRIVATE_SQL",
  });
  const failed = () => ({
    status: null,
    signal: "SIGKILL",
    stdout: "PRIVATE_ROW",
    stderr: "PRIVATE_SQL",
  });
  expect(() =>
    runPostgresqlAdapterSql([], "PRIVATE_SQL", process.cwd(), failed),
  ).toThrow("transport failed or was interrupted");
});

it("does not turn an ordinary nonzero Docker client result into backend absence", async () => {
  const f = resourceFixture();
  f.runCommand.mockResolvedValue(result({ status: 1 }));
  await expect(f.resources.removeResources()).rejects.toThrow("unconfirmed");
  expect(f.runCommand.mock.calls).toHaveLength(1);
});

it.each([
  "listing-failed",
  "inspection-failed",
  "inspection-malformed",
  "absent",
])("keeps runtime status honest for %s metadata", async (mode) => {
  const input = {
    containerName: "fixture-postgresql",
    databaseUser: "postgres",
    database: "postgres",
    databasePort: 55432,
    projectId: "fixture-rehearsal",
    runtimeMarkerPath: "/rehearsal-intentionally-missing-marker",
    baselineDataSha256: "b".repeat(64),
    image: "postgres:17-alpine",
    baselineGenerationId: "20261009T120000Z-example",
    candidateSha256: "a".repeat(64),
    candidates: [],
    runCommand: async (_command, args) =>
      args[0] === "info"
        ? result()
        : args[0] === "container"
          ? result({
              status: mode === "listing-failed" ? 1 : 0,
              stdout: mode === "absent" ? "" : "a".repeat(64),
            })
          : result({
              status: mode === "inspection-failed" ? 1 : 0,
              stdout: "unconfirmed",
            }),
  };
  if (mode === "absent")
    expect((await inspectPostgresqlRuntimeStatus(input)).state).toBe("stopped");
  else
    await expect(inspectPostgresqlRuntimeStatus(input)).rejects.toThrow(
      "unconfirmed",
    );
});

it.each(["createdAt", "driver", "labels"])(
  "preserves a same-name volume whose %s changes during awaited container cleanup",
  async (field) => {
    const f = resourceFixture();
    const original = f.runCommand.getMockImplementation();
    let replaced = false;
    f.runCommand.mockImplementation(async (...args) => {
      const commands = args[1];
      const value = await original(...args);
      if (commands[0] === "container" && commands[1] === "rm") replaced = true;
      if (replaced && commands[0] === "volume" && commands[1] === "inspect") {
        const replacement = {
          name: "owned-postgresql-data",
          createdAt: "2026-10-24T00:00:00.123456789Z",
          driver: "local",
          labels: { "com.rehearsal-db.project": "owned" },
        };
        if (field === "createdAt")
          replacement.createdAt = "2026-10-24T00:00:00.123456790Z";
        if (field === "driver") replacement.driver = "different-local";
        if (field === "labels")
          replacement.labels = { "com.rehearsal-db.project": "foreign" };
        return result({ stdout: JSON.stringify(replacement) });
      }
      return value;
    });
    await expect(f.resources.removeResources()).rejects.toThrow();
    expect(
      f.runCommand.mock.calls.some(
        ([, args]) => args[0] === "volume" && args[1] === "rm",
      ),
    ).toBe(false);
  },
);
