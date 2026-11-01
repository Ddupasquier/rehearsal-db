import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  OWNED_COLIMA_SHUTDOWN_TIMEOUT_MS,
  runOwnedColimaStop,
  runContainerEngineOwnershipCommand,
  CONTAINER_ENGINE_RECEIPT_FILENAME,
  releaseOwnedColimaWhenIdle,
  writeContainerEngineStartReceipt,
} from "../../../../dist/src/runtime/engines/container_engine_ownership.mjs";
import { executeRuntimeTargetStack } from "../../../../dist/src/cli/runtime_stack_execution.mjs";
import { acquireProjectOperation } from "../../../../dist/src/shared/operation_guard.mjs";

const execute = promisify(execFile);
const roots = [];
const bootId = "29b0d91d-91a7-4a5b-95f7-fd2d5dbdd388";
const result = (status, stdout = "") => ({ status, stdout, stderr: "" });

const fixture = async () => {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "rehearsal-engine-lifecycle-"),
  );
  roots.push(projectRoot);
  const input = {
    path: join(projectRoot, ".rehearsal", CONTAINER_ENGINE_RECEIPT_FILENAME),
    projectRoot,
    projectId: "engine-owner-rehearsal",
    operationId: "operation-owner-one",
  };
  await mkdir(dirname(input.path), { mode: 0o700 });
  const target = {
    name: "primary",
    paths: { artifactDirectory: dirname(input.path) },
    config: {
      runtime: { projectId: input.projectId },
      containerRuntime: { stopOwnedColimaWhenIdle: true },
    },
  };
  return { input, target };
};

// No real executables or sockets: deterministic observations of one shared engine.
const engine = () => {
  const state = {
    running: true,
    clock: 0,
    bootId,
    containers: new Set(),
    calls: [],
    scans: 0,
    beforeBoot: () => {},
    beforeScan: () => {},
    onStop: () => {},
  };
  state.run = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "docker" && args[0] === "info")
      return result(state.running ? 0 : 1, "synthetic-daemon");
    if (
      command === "docker" &&
      args[0] === "context" &&
      args.includes(
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
      )
    )
      return result(0, "false");
    if (command === "docker" && args[0] === "context")
      return args[1] === "show"
        ? result(0, "colima\n")
        : result(
            0,
            JSON.stringify("unix:///tmp/rehearsal-lifecycle-test.sock"),
          );
    if (command === "docker" && args[0] === "container") {
      state.scans += 1;
      const refusal = state.beforeScan();
      return refusal ?? result(0, [...state.containers].join("\n"));
    }
    if (command === "colima" && args[0] === "ssh") {
      state.beforeBoot();
      return result(state.running ? 0 : 1, `${state.bootId}\n`);
    }
    if (command === "colima" && args[0] === "stop") {
      state.running = false;
      state.onStop();
      return state.stopResult ?? result(0);
    }
    throw new Error(
      "An unexpected command must never fall back to a real engine.",
    );
  };
  state.confirm = async () => ({
    profileStopped: !state.running,
    vmProcessAbsent: !state.running,
  });
  state.qualify = async (_options, endpoint, daemonId) => ({
    endpoint,
    daemonId,
    bootId: state.bootId,
    environment: {},
  });
  state.release = ({ input, target }, targets = [target]) =>
    releaseOwnedColimaWhenIdle({
      projectRoot: input.projectRoot,
      targets,
      run: state.run,
      dependencies: {
        qualify: (...args) => state.qualify(...args),
        confirm: (...args) => state.confirm(...args),
        now: () => state.clock,
        wait: async () => {
          state.clock += 1000;
        },
      },
    });
  return state;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("guarded engine lifecycle interleavings", () => {
  it("allows only one concurrent project-operation owner and releases its own lock", async () => {
    const { input } = await fixture();
    const attempts = await Promise.allSettled(
      ["start", "stop"].map((command) =>
        acquireProjectOperation({ projectRoot: input.projectRoot, command }),
      ),
    );
    const owners = attempts.filter((attempt) => attempt.status === "fulfilled");
    try {
      expect(owners).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await Promise.all(owners.map((owner) => owner.value.release()));
    }
    const next = await acquireProjectOperation({
      projectRoot: input.projectRoot,
      command: "stop",
    });
    await next.release();
  });

  it("preserves another project's active workload and refuses a copied ownership receipt", async () => {
    const owner = await fixture();
    const other = await fixture();
    const shared = engine();
    writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
    shared.containers.add("another-project-running-container");
    expect((await shared.release(owner)).state).toBe("preserved");
    // A foreign project cannot use a different project's receipt to claim the boot.
    await writeFile(other.input.path, await readFile(owner.input.path), {
      mode: 0o600,
      flag: "wx",
    });
    shared.containers.clear();
    expect((await shared.release(other)).state).toBe("preserved");
    expect(shared.calls).not.toContainEqual(["colima", "stop"]);
    expect((await shared.release(owner)).state).toBe("stopped");
  });

  it.each(["new-workload", "inspection-failure"])(
    "rechecks shared containers after identity probes (%s)",
    async (interleaving) => {
      const owner = await fixture();
      const shared = engine();
      writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
      shared.beforeBoot = () => {
        if (shared.scans === 1 && interleaving === "new-workload")
          shared.containers.add("concurrent-project-workload");
      };
      shared.beforeScan = () =>
        shared.scans === 2 && interleaving === "inspection-failure"
          ? result(1)
          : undefined;
      expect(await shared.release(owner)).toMatchObject({
        state: "preserved",
        message: expect.stringContaining("during idle shutdown review"),
      });
      expect(shared.scans).toBe(2);
      expect(shared.calls).not.toContainEqual(["colima", "stop"]);
      expect(
        JSON.parse(await readFile(owner.input.path, "utf8")).operationId,
      ).toBe(owner.input.operationId);
    },
  );

  it("repeated stop never stops a later manually started boot", async () => {
    const owner = await fixture();
    const shared = engine();
    writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
    expect((await shared.release(owner)).state).toBe("stopped");
    expect((await shared.release(owner)).state).toBe("unknown");
    shared.running = true;
    shared.bootId = "11111111-1111-1111-1111-111111111111";
    expect((await shared.release(owner)).state).toBe("preserved");
    expect(
      shared.calls.filter(
        ([command, action]) => command === "colima" && action === "stop",
      ),
    ).toHaveLength(1);
  });

  it("does not remove a receipt replaced by a subsequent operation", async () => {
    const owner = await fixture();
    const shared = engine();
    writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
    shared.onStop = () => {
      shared.running = true;
      shared.bootId = "11111111-1111-1111-1111-111111111111";
      writeContainerEngineStartReceipt({
        input: { ...owner.input, operationId: "operation-owner-two" },
        run: shared.run,
      });
    };
    expect((await shared.release(owner)).state).toBe("unknown");
    expect(JSON.parse(await readFile(owner.input.path, "utf8"))).toMatchObject({
      bootId: shared.bootId,
      operationId: "operation-owner-two",
    });
  });

  it("keeps the engine until reverse-order cleanup has stopped all completed targets", async () => {
    const owner = await fixture();
    const shared = engine();
    writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
    const targets = ["primary", "publication", "unstarted"];
    const events = [];
    const failure = new Error(
      "startup interrupted before a third target receipt",
    );
    shared.onStop = () => events.push("engine-stop");
    await expect(
      executeRuntimeTargetStack({
        targets,
        cleanupOnFailure: true,
        execute: async (target) => {
          if (target === "unstarted") throw failure;
          shared.containers.add(target);
          events.push(`start:${target}`);
          return { target };
        },
        stop: async (target) => {
          events.push(`stop:${target}`);
          shared.containers.delete(target);
          const released = await shared.release(owner);
          expect(released.state).toBe(
            shared.containers.size ? "preserved" : "stopped",
          );
        },
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual([
      "start:primary",
      "start:publication",
      "stop:publication",
      "stop:primary",
      "engine-stop",
    ]);
  });
});

describe("interrupted engine startup does not grant shutdown ownership", () => {
  it.each(["signal", "daemon-unavailable", "boot-unavailable"])(
    "withholds the receipt after %s using only fake executables",
    async (failure) => {
      const owner = await fixture();
      const root = owner.input.projectRoot;
      const statePath = join(root, "fake-engine.json");
      const logPath = join(root, "fake-commands.jsonl");
      await writeFile(statePath, JSON.stringify({ running: false }));
      const fake = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify([command, ...args]) + "\\n");
let output = "", status = 0;
if (command === "docker" && args[0] === "context") output = args.includes('{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}') ? "false" : args[1] === "show" ? "colima" : JSON.stringify("unix:///tmp/rehearsal-interrupted-test.sock");
else if (command === "docker" && args[0] === "info") status = state.running && ${JSON.stringify(failure)} !== "daemon-unavailable" ? 0 : 1;
else if (command === "colima" && args[0] === "version") {}
else if (command === "colima" && args[0] === "list") output = JSON.stringify({ name: "default", status: state.running ? "Running" : "Stopped" });
else if (command === "colima" && args[0] === "start") {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ running: true }));
  if (${JSON.stringify(failure)} === "signal") process.kill(process.pid, "SIGTERM");
}
else if (command === "colima" && args[0] === "ssh") status = 1;
else status = 99;
if (output) console.log(output);
process.exitCode = status;
`;
      for (const name of ["docker", "colima"]) {
        const path = join(root, name);
        await writeFile(path, fake);
        await chmod(path, 0o755);
      }
      const modulePath = join(
        process.cwd(),
        "dist/src/targets/supabase_environment.mjs",
      );
      const source = `import { ensureLocalContainerRuntime } from ${JSON.stringify(modulePath)};
try { ensureLocalContainerRuntime({ cwd: ${JSON.stringify(root)}, autoStartColima: true, ownershipReceipt: ${JSON.stringify(owner.input)} }); process.exitCode = 99; }
catch { console.log("startup-refused"); }`;
      const child = await execute(
        process.execPath,
        ["--input-type=module", "--eval", source],
        {
          cwd: root,
          env: { PATH: `${root}${delimiter}${dirname(process.execPath)}` },
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        },
      );
      expect(child.stdout).toContain("startup-refused");
      await expect(readFile(owner.input.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.filter(
          ([command, action]) => command === "colima" && action === "start",
        ),
      ).toHaveLength(1);
      expect(calls).not.toContainEqual(["colima", "stop"]);
      // Even if the VM eventually becomes healthy, missing proof preserves it.
      const healthy = engine();
      expect((await healthy.release(owner)).state).toBe("preserved");
      expect(healthy.calls).not.toContainEqual(["colima", "stop"]);
    },
  );
});

describe("automatic owned shutdown result and independent confirmation", () => {
  it("allows only the exact graceful stop a longer deadline and supports a harmless delayed executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "owned-stop-deadline-"));
    roots.push(root);
    const path = join(root, "colima");
    await writeFile(
      path,
      `#!${process.execPath}\nif(process.argv[2]==='stop') setTimeout(()=>process.stdout.write('completed\\n'),10500); else process.stdout.write('metadata\\n');\n`,
      { mode: 0o700 },
    );
    expect(OWNED_COLIMA_SHUTDOWN_TIMEOUT_MS).toBe(60000);
    const metadata = runContainerEngineOwnershipCommand(
      "colima",
      ["list", "--json"],
      root,
      { PATH: root, HOME: root },
    );
    expect(metadata.status).toBe(0);
    const started = performance.now(),
      stopped = await runOwnedColimaStop(root, { PATH: root, HOME: root });
    expect(stopped.status).toBe(0);
    expect(stopped.error).toBeUndefined();
    expect(performance.now() - started).toBeGreaterThan(10000);
  }, 20000);

  it("bounds a harmless owned CLI timeout and refuses cancelled pre-dispatch work", async () => {
    const root = await mkdtemp(join(tmpdir(), "owned-stop-timeout-"));
    roots.push(root);
    await writeFile(
      join(root, "colima"),
      `#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); setInterval(()=>{},100);\n`,
      { mode: 0o700 },
    );
    const timedOut = await runOwnedColimaStop(
      root,
      { PATH: root, HOME: root },
      { timeoutMs: 100 },
    );
    expect(timedOut.error?.code).toBe("ETIMEDOUT");
    expect(timedOut.status).toBeNull();
    expect(["SIGTERM", "SIGKILL"]).toContain(timedOut.signal);
    const cancelled = new AbortController();
    cancelled.abort();
    const beforeDispatch = await runOwnedColimaStop(
      "/does-not-exist",
      {},
      { signal: cancelled.signal },
    );
    expect(beforeDispatch.error?.code).toBe("ABORT_ERR");
    expect(beforeDispatch.signal).toBeNull();
  });

  it.each([
    "partial",
    "observation-error",
    "command-failure",
    "caller-timeout",
  ])("retains the receipt without false success (%s)", async (scenario) => {
    const owner = await fixture(),
      shared = engine();
    writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
    if (scenario === "partial")
      shared.confirm = async () => ({
        profileStopped: true,
        vmProcessAbsent: false,
      });
    if (scenario === "observation-error")
      shared.confirm = async () => {
        throw Error("PRIVATE_PROVIDER_MESSAGE");
      };
    if (scenario === "command-failure" || scenario === "caller-timeout")
      shared.confirm = async () => ({
        profileStopped: false,
        vmProcessAbsent: false,
      });
    if (scenario === "command-failure")
      shared.stopResult = { ...result(1), stderr: "PRIVATE_PROVIDER_MESSAGE" };
    if (scenario === "caller-timeout")
      shared.stopResult = {
        ...result(null),
        signal: "SIGTERM",
        error: Object.assign(Error("PRIVATE_PROVIDER_MESSAGE"), {
          code: "ETIMEDOUT",
        }),
      };
    const release = await shared.release(owner);
    expect(release.state).toBe("unknown");
    expect(release.message).not.toContain("Stopped the Colima boot");
    expect(JSON.stringify(release)).not.toContain("PRIVATE");
    expect(
      JSON.parse(await readFile(owner.input.path, "utf8")).operationId,
    ).toBe(owner.input.operationId);
    if (scenario === "caller-timeout")
      expect(release.shutdown.command).toMatchObject({
        status: null,
        signal: "SIGTERM",
        errorCode: "ETIMEDOUT",
      });
  });

  it.each(["nonzero", "timeout"])(
    "reconciles independently confirmed VM-off with the original command warning (%s)",
    async (scenario) => {
      const owner = await fixture(),
        shared = engine();
      writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
      shared.stopResult =
        scenario === "nonzero"
          ? { ...result(1), stderr: "PRIVATE_PROVIDER_MESSAGE" }
          : {
              ...result(null),
              signal: "SIGTERM",
              error: Object.assign(Error("PRIVATE_PROVIDER_MESSAGE"), {
                code: "ETIMEDOUT",
              }),
            };
      const release = await shared.release(owner);
      expect(release).toMatchObject({
        state: "stopped",
        warning: "shutdown-command-failed",
        shutdown: {
          confirmed: { profileStopped: true, vmProcessAbsent: true },
        },
      });
      expect(release.shutdown.command.status).toBe(
        scenario === "nonzero" ? 1 : null,
      );
      expect(release.message).toContain(
        "Orderly provider shutdown was not established",
      );
      expect(JSON.stringify(release)).not.toContain("PRIVATE");
      await expect(readFile(owner.input.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("reports confirmed profile and exact captured VM exit before retiring an unchanged receipt", async () => {
    const owner = await fixture(),
      shared = engine();
    writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
    shared.onStop = () => {
      shared.clock += 11000;
    };
    const release = await shared.release(owner);
    expect(release).toMatchObject({
      state: "stopped",
      shutdown: {
        command: {
          status: 0,
          signal: null,
          errorCode: null,
          elapsedMilliseconds: 11000,
        },
        confirmed: { profileStopped: true, vmProcessAbsent: true },
      },
    });
    await expect(readFile(owner.input.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never dispatches when the captured backend proof is missing or belongs to another boot", async () => {
    for (const scenario of ["missing", "changed-boot"]) {
      const owner = await fixture(),
        shared = engine();
      writeContainerEngineStartReceipt({ input: owner.input, run: shared.run });
      const original = shared.qualify;
      shared.qualify =
        scenario === "missing"
          ? async () => {
              throw Error("unqualified");
            }
          : async (...args) => ({
              ...(await original(...args)),
              bootId: "11111111-1111-1111-1111-111111111111",
            });
      expect((await shared.release(owner)).state).toBe("preserved");
      expect(shared.calls).not.toContainEqual(["colima", "stop"]);
      expect(await readFile(owner.input.path, "utf8")).toContain(
        owner.input.operationId,
      );
    }
  });
});
