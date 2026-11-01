import { readKnexFailure } from "../../../dist/src/runtime/migrations/knex_failure_diagnostic.mjs";
/** Owned tiny attachment/metadata fakes: no Docker, SDK, SQL or service execution. */
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";
const state = vi.hoisted(() => ({
  env: {},
  docker: null,
  fake: false,
  onSpawn: null,
  foreign: false,
  operations: [],
  record: null,
  stdout: null,
  brokerFailure: null,
  pendingWrite: false,
  writeCallback: null,
  stderr: null,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original();
  return {
    ...actual,
    spawn: (...args) => {
      if (!state.fake) return actual.spawn(...args);
      const child = new EventEmitter();
      child.stdin = new Writable({
        write(_b, _e, cb) {
          if (state.pendingWrite) state.writeCallback = cb;
          else cb();
        },
      });
      child.stdout = Readable.from(
        state.stdout ?? [Buffer.from([88, 0, 0, 0, 1, 0])],
      );
      child.stderr = Readable.from(state.stderr ?? []);
      child.kill = () => true;
      queueMicrotask(() => state.onSpawn?.(child));
      return child;
    },
  };
});
vi.mock("../../../dist/src/targets/knex_worker_engine.mjs", () => ({
  inspectKnexWorkerEngine: () => ({
    selection: {
      context: "private",
      endpoint: "unix:///external/private.sock",
    },
    env: state.env,
    daemon: "owned-daemon",
    imageId: "sha256:" + "b".repeat(64),
    docker: (args) => state.docker(args),
    revalidate: () => {},
  }),
}));
vi.mock(
  "../../../dist/src/runtime/migrations/knex_pg_broker.mjs",
  async (original) => {
    const actual = await original();
    return {
      ...actual,
      createKnexPgBroker: (...args) =>
        state.brokerFailure
          ? {
              accept: async () => {
                if (state.brokerFailure === "accept")
                  throw Error("PRIVATE_BROKER_CANARY");
              },
              assertHealthy: () => {
                if (state.brokerFailure === "health")
                  throw Error("PRIVATE_BROKER_CANARY");
              },
              close: async () => {
                if (state.brokerFailure === "cleanup")
                  throw Error("PRIVATE_BROKER_CANARY");
              },
            }
          : actual.createKnexPgBroker(...args),
    };
  },
);
import { KNEX_WORKER_PROGRAMS } from "../../../dist/src/targets/knex_worker_programs.mjs";
import { runKnexWorker } from "../../../dist/src/targets/knex_worker_process.mjs";
const roots = [];
it("parses the exact three worker programs without executing SDK modules or opening sockets", () => {
  for (const [name, text] of KNEX_WORKER_PROGRAMS) {
    const checked = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      {
        input: text,
        env: createCleanProcessEnvironment(),
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(checked.status, name).toBe(0);
    expect(checked.error).toBeUndefined();
  }
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  state.fake = state.foreign = false;
  state.operations = [];
  state.onSpawn = null;
  state.stdout =
    state.brokerFailure =
    state.stderr =
    state.writeCallback =
      null;
  state.pendingWrite = false;
});
const fixture = async (mode = "complete") => {
  const root = await mkdtemp(join(tmpdir(), "knex-worker-process-"));
  roots.push(root);
  const workspace = join(root, "workspace"),
    bin = join(root, "bin");
  await mkdir(workspace);
  await mkdir(bin);
  for (const name of ["inputs", "sdk", "runner"])
    await mkdir(join(workspace, name));
  for (const [name, text] of KNEX_WORKER_PROGRAMS)
    await writeFile(join(workspace, "runner", name), text, { mode: 0o444 });
  const script = join(bin, "docker");
  await writeFile(
    script,
    `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!==${JSON.stringify("--host unix:///external/private.sock start --attach --interactive " + "a".repeat(64))})process.exit(98);process.stdin.once('data',()=>{${mode === "complete" ? "process.stdout.write(Buffer.from([88,0,0,0,1,0]),()=>process.exit(0));" : `process.on('SIGTERM',()=>{});import('node:fs').then(({writeFileSync})=>{writeFileSync(${JSON.stringify(join(root, "ready"))},String(process.pid));setInterval(()=>{},1000);});`}});`,
  );
  await chmod(script, 0o700);
  state.env = { PATH: bin };
  state.docker = (args) => {
    state.operations.push(args);
    if (args[0] === "create") {
      const labels = {},
        mounts = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--label") {
          const at = args[i + 1].indexOf("=");
          labels[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1);
        }
        if (args[i] === "--mount") {
          const fields = Object.fromEntries(
            args[i + 1]
              .split(",")
              .filter((x) => x.includes("="))
              .map((x) => x.split("=")),
          );
          mounts.push({
            Type: "bind",
            Source: fields.src,
            Destination: fields.dst,
            RW: false,
            Propagation: "rprivate",
          });
        }
      }
      state.record = {
        Id: "a".repeat(64),
        Image: "sha256:" + "b".repeat(64),
        Config: {
          User: "65532:65532",
          Tty: false,
          OpenStdin: true,
          Labels: labels,
          Entrypoint: ["/usr/local/bin/node"],
          Cmd: ["/runner/bootstrap.mjs"],
        },
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          Privileged: false,
          PublishAllPorts: false,
          PidMode: "",
          IpcMode: "private",
          CgroupnsMode: "private",
          Memory: 268435456,
          MemorySwap: 268435456,
          NanoCpus: 1000000000,
          PidsLimit: 32,
          LogConfig: { Type: "none" },
          RestartPolicy: { Name: "no" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PortBindings: {},
          Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=67108864,mode=1777" },
        },
        Mounts: mounts,
        State: { Running: false, Status: "created" },
      };
      return state.record.Id;
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const r = structuredClone(state.record);
      if (state.foreign)
        r.Config.Labels["com.rehearsal-db.worker-token"] = "foreign";
      return JSON.stringify([r]);
    }
    if (args[0] === "stop") {
      state.record.State = { Running: false, Status: "exited" };
      return state.record.Id;
    }
    if (args[0] === "rm") return state.record.Id;
    if (args[0] === "ps") return "";
    throw Error("Unallowlisted fake metadata command");
  };
  const controller = new AbortController();
  return {
    root,
    workspace,
    controller,
    options: {
      projectRoot: root,
      workspace,
      projectId: "test-project",
      knexDirectory: "/sdk/node_modules/knex",
      credentials: {
        user: "rehearsal_knex_0123456789abcdef",
        password: "PRIVATE_EPHEMERAL_CANARY",
        database: "postgres",
      },
      port: 59422,
      signal: controller.signal,
      assertOwnedTarget: () => "c".repeat(64),
      assertBackendGone: async () => {
        throw Error("NO_BACKEND_EXPECTED");
      },
    },
  };
};
it.skipIf(process.platform === "win32")(
  "reaps a genuine tiny owned attachment and removes only its verified disposable shell",
  async () => {
    const f = await fixture(),
      result = await runKnexWorker(f.options);
    expect(result).toMatchObject({
      status: "completed",
      fullId: "a".repeat(64),
      workerRemoved: true,
      dataDeletionRequested: false,
    });
    expect(state.operations.filter((x) => x[0] === "rm")).toEqual([
      ["rm", "a".repeat(64)],
    ]);
    expect(state.operations.flat()).not.toContain("-v");
    expect(
      await readFile(join(f.workspace, "worker-recovery.json"), "utf8"),
    ).not.toContain("PRIVATE_EPHEMERAL_CANARY");
  },
);
it("an un-reaped attachment remains an uncertainty error even when exact container removal succeeds", async () => {
  const f = await fixture();
  state.fake = true;
  state.onSpawn = () => f.controller.abort();
  let error;
  try {
    await runKnexWorker(f.options);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AggregateError);
  expect(String(error)).toMatch(/cleanup is unconfirmed/);
  expect(readKnexFailure(error)).toMatchObject({
    primary: {
      phase: "worker",
      stage: "worker-parent-abort",
      reason: "execution-unconfirmed",
    },
    cleanup: {
      phase: "worker",
      stage: "cleanup",
      reason: "cleanup-unconfirmed",
    },
  });
  expect(String(error)).not.toContain("PRIVATE_EPHEMERAL_CANARY");
  expect(state.operations.some((x) => x[0] === "rm")).toBe(true);
  expect(
    JSON.parse(
      await readFile(join(f.workspace, "worker-recovery.json"), "utf8"),
    ).fullId,
  ).toBe("a".repeat(64));
});
it("foreign worker identity during cleanup refuses all stop/removal instead of adopting it", async () => {
  const f = await fixture();
  state.fake = true;
  state.onSpawn = () => {
    state.foreign = true;
    f.controller.abort();
  };
  await expect(runKnexWorker(f.options)).rejects.toBeInstanceOf(AggregateError);
  expect(
    state.operations.some((x) => ["rm", "stop", "kill"].includes(x[0])),
  ).toBe(false);
});
it("ambiguous creation retains a private intent and never treats returned junk as a container selector", async () => {
  const f = await fixture();
  const normal = state.docker;
  state.docker = (args) =>
    args[0] === "create" ? "--PRIVATE_BAD_ID" : normal(args);
  await expect(runKnexWorker(f.options)).rejects.toBeInstanceOf(AggregateError);
  expect(
    state.operations.some((x) => ["rm", "stop", "kill"].includes(x[0])),
  ).toBe(false);
  expect(
    JSON.parse(await readFile(join(f.workspace, "worker-intent.json"), "utf8"))
      .kind,
  ).toBe("knex-worker-intent");
});
it("refuses a changed trusted runner copy before spawning an attachment", async () => {
  const f = await fixture(),
    file = join(f.workspace, "runner/child.mjs");
  await chmod(file, 0o600);
  await writeFile(file, "PRIVATE_CHANGED_PROGRAM");
  await expect(runKnexWorker(f.options)).rejects.toThrow(/withheld/);
  expect(state.operations.filter((x) => x[0] === "rm")).toHaveLength(1);
});

it.skipIf(process.platform === "win32")(
  "cancels and reaps only a real owned attachment that ignores TERM",
  async () => {
    const f = await fixture("hang"),
      outcome = runKnexWorker(f.options).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    let pid = null;
    try {
      for (let i = 0; i < 200; i++) {
        try {
          pid = Number(await readFile(join(f.root, "ready"), "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      f.controller.abort();
    }
    const result = await outcome;
    expect(pid).toBeGreaterThan(0);
    expect(result.error).toBeTruthy();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(state.operations.filter((x) => x[0] === "rm")).toEqual([
      ["rm", "a".repeat(64)],
    ]);
  },
);

const frame = (kind, value) =>
  Buffer.from([kind.charCodeAt(0), 0, 0, 0, value.length, ...value]);
it.each([
  ["reported failure", [frame("X", [1])], 1, null, "worker-result-nonzero"],
  ["missing completion", [], 0, null, "worker-result-missing"],
  ["invalid completion", [frame("X", [2])], 0, null, "worker-result-invalid"],
  ["invalid frame", [frame("Z", [0])], 0, null, "worker-frame"],
  [
    "broker acceptance",
    [frame("O", [0, 0, 0, 1])],
    0,
    "accept",
    "worker-broker-accept",
  ],
  ["broker health", [frame("X", [0])], 0, "health", "worker-broker-health"],
  ["attachment exit", [frame("X", [0])], 1, null, "worker-exit"],
  [
    "reported failure before cleanup",
    [frame("X", [1])],
    1,
    "cleanup",
    "worker-result-nonzero",
  ],
])(
  "retains the host-observed %s branch without provider data",
  async (_name, stdout, code, brokerFailure, stage) => {
    const f = await fixture();
    state.fake = true;
    state.stdout = stdout;
    state.brokerFailure = brokerFailure;
    state.onSpawn = (child) =>
      setImmediate(() => child.emit("close", code, null));
    let error;
    try {
      await runKnexWorker(f.options);
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
    const diagnostic = readKnexFailure(error);
    expect(diagnostic.primary).toEqual({
      phase: "worker",
      stage,
      reason: "execution-unconfirmed",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /PRIVATE|CANARY|postgres|59422/,
    );
    if (brokerFailure === "cleanup")
      expect(diagnostic.cleanup).toMatchObject({
        stage: "cleanup",
        reason: "cleanup-unconfirmed",
      });
  },
);

it.each([
  ["spawn", "worker-spawn"],
  ["stdin", "worker-stdin"],
  ["abort", "worker-parent-abort"],
])(
  "retains a fixed %s observation without exposing the event error",
  async (kind, stage) => {
    const f = await fixture();
    state.fake = true;
    state.onSpawn = (child) => {
      if (kind === "spawn") child.emit("error", Error("PRIVATE_EVENT_CANARY"));
      else if (kind === "stdin")
        child.stdin.emit("error", Error("PRIVATE_EVENT_CANARY"));
      else f.controller.abort();
      setImmediate(() => child.emit("close", 1, null));
    };
    let error;
    try {
      await runKnexWorker(f.options);
    } catch (e) {
      error = e;
    }
    expect(readKnexFailure(error).primary.stage).toBe(stage);
    expect(JSON.stringify(readKnexFailure(error))).not.toContain("PRIVATE");
  },
);
it("keeps an earlier reported failure through a later stdin error", async () => {
  const f = await fixture();
  state.fake = true;
  state.stdout = [frame("X", [1])];
  state.onSpawn = (child) =>
    setImmediate(() => {
      child.stdin.emit("error", Error("PRIVATE_EPIPE"));
      child.emit("close", 1, null);
    });
  let error;
  try {
    await runKnexWorker(f.options);
  } catch (e) {
    error = e;
  }
  expect(readKnexFailure(error).primary.stage).toBe("worker-result-nonzero");
});

it("retains X1 across a direct pending initialization write rejection", async () => {
  const f = await fixture();
  state.fake = true;
  state.pendingWrite = true;
  state.stdout = [frame("X", [1])];
  state.onSpawn = (child) =>
    setImmediate(() => {
      state.writeCallback(Error("PRIVATE_EPIPE"));
      setImmediate(() => child.emit("close", 1, null));
    });
  let error;
  try {
    await runKnexWorker(f.options);
  } catch (e) {
    error = e;
  }
  expect(readKnexFailure(error).primary.stage).toBe("worker-result-nonzero");
});
it.each([false, true])(
  "enforces the cumulative log boundary (overflow=%s)",
  async (overflow) => {
    const f = await fixture();
    state.fake = true;
    const log = Buffer.alloc(65541);
    log[0] = 76;
    log.writeUInt32BE(65536, 1);
    state.stdout = [
      ...Array.from({ length: 16 }, () => log),
      ...(overflow ? [frame("L", [0])] : []),
      frame("X", [0]),
    ];
    state.onSpawn = (child) => setImmediate(() => child.emit("close", 0, null));
    if (overflow) {
      let error;
      try {
        await runKnexWorker(f.options);
      } catch (e) {
        error = e;
      }
      expect(readKnexFailure(error).primary.stage).toBe("worker-output-limit");
    } else expect((await runKnexWorker(f.options)).status).toBe("completed");
  },
);
it("classifies stderr overflow without retaining stderr bytes", async () => {
  const f = await fixture();
  state.fake = true;
  state.stderr = [Buffer.alloc(1024 * 1024 + 1, 65)];
  state.onSpawn = (child) => setImmediate(() => child.emit("close", 0, null));
  let error;
  try {
    await runKnexWorker(f.options);
  } catch (e) {
    error = e;
  }
  expect(readKnexFailure(error).primary.stage).toBe("worker-output-limit");
  expect(JSON.stringify(readKnexFailure(error))).not.toContain("AAAA");
});
it("classifies a signalled attachment despite a successful result frame", async () => {
  const f = await fixture();
  state.fake = true;
  state.onSpawn = (child) =>
    setImmediate(() => child.emit("close", null, "SIGTERM"));
  let error;
  try {
    await runKnexWorker(f.options);
  } catch (e) {
    error = e;
  }
  expect(readKnexFailure(error).primary.stage).toBe("worker-exit");
});
