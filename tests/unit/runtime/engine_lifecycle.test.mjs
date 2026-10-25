import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectEngineLifecycle,
  planEngineShutdown,
  shutdownEngine,
  parseEngineContainerImpact,
  ENGINE_CONTAINER_IMPACT_FORMAT,
} from "../../../dist/src/runtime/engine_lifecycle.mjs";
import {
  diskHolderPids,
  parseEngineProcessTable,
  qualifyColimaDefault,
  confirmColimaStopped,
  COLIMA_GUEST_DAEMON_ID_ARGUMENTS,
} from "../../../dist/src/runtime/engine_colima_backend.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const output = (status = 0, stdout = "", stderr = "") => ({
  status,
  stdout,
  stderr,
});
const id = "a".repeat(64),
  boot = "12345678-1234-1234-1234-123456789abc";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-explicit-"));
  roots.push(root);
  const colima = join(root, "c"),
    lima = join(colima, "_lima"),
    dockerConfig = join(root, "d");
  for (const p of [
    colima,
    join(colima, "default"),
    join(lima, "colima"),
    join(lima, "_disks/colima"),
    dockerConfig,
  ])
    await mkdir(p, { recursive: true, mode: 0o700 });
  const disks = [
    join(lima, "colima/disk"),
    join(lima, "_disks/colima/datadisk"),
  ];
  for (const p of disks) await writeFile(p, "synthetic-disk", { mode: 0o600 });
  await writeFile(join(lima, "colima/ha.pid"), "31001\n", { mode: 0o600 });
  await writeFile(join(colima, "default/colima.yaml"), "vmType: vz\n", {
    mode: 0o600,
  });
  await writeFile(
    join(lima, "colima/lima.yaml"),
    `portForwards:
    - guestSocket: /var/run/docker.sock
      hostSocket: ${colima}/default/docker.sock
    - guestSocket: /var/run/docker.sock
      hostSocket: ${colima}/docker.sock
`,
    { mode: 0o600 },
  );
  const stats = await Promise.all(disks.map((p) => lstat(p, { bigint: true })));
  const state = {
    running: true,
    vm: true,
    disksHeld: true,
    vmExecutable: "com.apple.Virtualization.VirtualMachine",
    selected: "colima",
    daemon: "fixture-engine-1",
    guestDaemon: "fixture-engine-1",
    infoCalls: 0,
    guestQueries: 0,
    extraContainer: false,
    onGuest: () => {},
    changeAtInfo: null,
    vmStart: "Sun Oct 25 16:19:21 2026",
    restartCount: 0,
    locks: [],
    queue: [],
    held: false,
    stops: 0,
    released: 0,
    calls: [],
    remote: false,
    missingProof: false,
    stderr: "",
    beforeStop: () => {},
  };
  const environment = {
    HOME: root,
    COLIMA_HOME: colima,
    LIMA_HOME: lima,
    DOCKER_CONFIG: dockerConfig,
    PATH: "/nonexistent",
  };
  const endpoint = `unix://${colima}/default/docker.sock`;
  const impact = () => ({
    id,
    name: "/shared-application",
    state: "running",
    restartCount: state.restartCount,
    startedAt: "2026-10-25T00:00:00.000000000Z",
    finishedAt: "0001-01-01T00:00:00Z",
  });
  const metadata = (command, args, env) => {
    state.calls.push({ command, args: [...args], env });
    if (command === "docker") {
      if (args[0] === "context" && args[1] === "show")
        return output(0, state.selected);
      if (args[0] === "context" && args[1] === "ls")
        return output(0, "colima\ndefault\n");
      if (args[0] === "context" && args[1] === "inspect")
        return output(
          0,
          args.includes("{{json .Endpoints.docker.Host}}")
            ? JSON.stringify(
                args.at(-1) === "default"
                  ? "unix:///var/run/docker.sock"
                  : state.remote
                    ? "ssh://foreign"
                    : endpoint,
              )
            : "false",
        );
      if (args[0] === "--host" && args[2] === "info") {
        state.infoCalls++;
        if (state.changeAtInfo === state.infoCalls)
          state.daemon = "late-other-daemon";
        return state.running ? output(0, state.daemon) : output(1);
      }
      if (args.includes("container") && args.includes("ls"))
        return output(
          0,
          id + "\n" + (state.extraContainer ? "b".repeat(64) + "\n" : ""),
        );
      if (
        args.includes("container") &&
        args.includes("inspect") &&
        args.includes(ENGINE_CONTAINER_IMPACT_FORMAT)
      )
        return output(
          0,
          JSON.stringify(impact()) +
            "\n" +
            (state.extraContainer
              ? JSON.stringify({
                  ...impact(),
                  id: "b".repeat(64),
                  name: "/late-unreviewed-container",
                }) + "\n"
              : ""),
        );
    }
    if (command === "colima") {
      if (
        JSON.stringify(args) ===
        JSON.stringify(COLIMA_GUEST_DAEMON_ID_ARGUMENTS)
      ) {
        state.guestQueries++;
        state.onGuest();
        return output(0, state.guestDaemon);
      }
      if (JSON.stringify(args) === JSON.stringify(["version"]))
        return output(0, "colima version 0.10.3");
      if (JSON.stringify(args) === JSON.stringify(["list", "--json"]))
        return output(
          0,
          JSON.stringify({
            name: "default",
            status: state.running ? "Running" : "Stopped",
          }),
        );
      if (
        JSON.stringify(args) ===
        JSON.stringify(["ssh", "--", "cat", "/proc/sys/kernel/random/boot_id"])
      )
        return output(0, boot);
    }
    if (command === "/bin/ps")
      return output(
        0,
        "31001 1 Sun Oct 25 16:19:20 2026 /opt/bin/limactl\n" +
          (state.vm
            ? `31002 1 ${state.vmStart} /System/${state.vmExecutable}\n`
            : ""),
      );
    if (command === "/usr/sbin/lsof") {
      if (state.missingProof) return output(1, "", "unavailable");
      if (!state.vm || !state.disksHeld) return output(1, "", state.stderr);
      return output(
        0,
        `p31002\ncVirtualMachine\nf4u\nD0x${stats[0].dev.toString(16)}\ni${stats[0].ino}\nn${disks[0]}\nf5u\nD0x${stats[1].dev.toString(16)}\ni${stats[1].ino}\nn${disks[1]}\n`,
      );
    }
    throw Error("Unexpected synthetic metadata command");
  };
  const dependencies = {
    metadata,
    platform: "darwin",
    architecture: "arm64",
    hostSupported: async () => true,
    operationLocks: async () => state.locks,
    workloads: async () => ({
      schemaVersion: 1,
      scope: "local-user-boot-process-namespace",
      capacity: "not-measured",
      recoveryDigest: null,
      entries: [
        ...state.queue,
        ...(state.held
          ? [
              {
                id: "owned-ticket",
                command: "engine-stop",
                pid: process.pid,
                phase: "held",
                owner: "alive",
                createdAt: "2026-10-25T00:00:00.000Z",
                recoveryRequired: false,
              },
            ]
          : []),
      ],
    }),
    acquire: async () => {
      state.held = true;
      return {
        release: async () => {
          state.held = false;
          state.released++;
        },
      };
    },
    stop: async (env, signal) => {
      expect(state.held).toBe(true);
      expect(env.COLIMA_HOME).toBe(colima);
      expect(env.LIMA_HOME).toBe(lima);
      expect(signal.aborted).toBe(false);
      state.beforeStop();
      state.stops++;
      state.running = false;
      state.vm = false;
      state.selected = "default";
      return { status: 0 };
    },
  };
  return {
    root,
    state,
    environment,
    endpoint,
    options: { cwd: root, inheritedEnvironment: environment, dependencies },
    backend: {
      environment,
      run: metadata,
      platform: "darwin",
      architecture: "arm64",
    },
    impact,
    disks,
    stats,
  };
};
describe("explicit engine lifecycle", () => {
  it("observes a manually-started qualified VM without creating a receipt and reviews all shared containers", async () => {
    const f = await fixture(),
      status = await inspectEngineLifecycle(f.options),
      plan = await planEngineShutdown(f.options);
    expect(status.selected.state).toBe("running");
    expect(status.colimaDefault.shutdownSupported).toBe(true);
    expect(plan.state).toBe("review-required");
    expect(plan.impact.runningCount).toBe(1);
    expect(plan.impact.containers[0].name).toBe("shared-application");
    expect(plan.engine.vmIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(f.state.stops).toBe(0);
  });
  it("holds the shared admission lease, gracefully stops and verifies profile plus the same VM disappearance", async () => {
    const f = await fixture(),
      plan = await planEngineShutdown(f.options),
      result = await shutdownEngine({
        ...f.options,
        confirmDigest: plan.consentDigest,
      });
    expect(result.status).toBe("stopped");
    expect(result.confirmed).toEqual({
      profileStopped: true,
      vmProcessAbsent: true,
    });
    expect(result.selectionAfter).toMatchObject({
      context: "default",
      state: "unavailable",
    });
    expect(result.safety).toEqual({
      globalContextSwitchRequested: false,
      dataDeletionRequested: false,
      forceRequested: false,
      enginesStarted: false,
    });
    expect(f.state.stops).toBe(1);
    expect(f.state.released).toBe(1);
    for (const p of f.disks) expect((await lstat(p)).size).toBe(14);
  });
  it("refuses changed container activity, daemon or VM identity instead of reusing old consent", async () => {
    for (const mutate of [
      (s) => s.restartCount++,
      (s) => {
        s.daemon = "another-daemon";
        s.guestDaemon = "another-daemon";
      },
      (s) => (s.vmStart = "Sun Oct 25 16:20:21 2026"),
    ]) {
      const f = await fixture(),
        plan = await planEngineShutdown(f.options);
      mutate(f.state);
      const result = await shutdownEngine({
        ...f.options,
        confirmDigest: plan.consentDigest,
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toBe("review-changed");
      expect(f.state.stops).toBe(0);
    }
  });
  it("keeps remote selectors, foreign homes, missing proof and known operations from dispatching shutdown", async () => {
    const f = await fixture();
    f.state.remote = true;
    expect((await planEngineShutdown(f.options)).reason).toBe(
      "selection-unverified",
    );
    expect(f.state.calls.some((c) => c.args.includes("info"))).toBe(false);
    f.state.remote = false;
    f.state.locks = ["known-operation"];
    expect((await planEngineShutdown(f.options)).reason).toBe(
      "coordination-active",
    );
    f.state.locks = [];
    f.state.missingProof = true;
    expect((await planEngineShutdown(f.options)).state).toBe("unsupported");
    f.state.missingProof = false;
    expect(
      (
        await planEngineShutdown({
          ...f.options,
          inheritedEnvironment: { ...f.environment, LIMA_HOME: f.root },
        })
      ).state,
    ).toBe("unsupported");
    expect(f.state.stops).toBe(0);
  });
  it("reports stopped profile separately after backend context removal, without inventing prior process-exit proof", async () => {
    const f = await fixture();
    f.state.running = false;
    f.state.vm = false;
    f.state.selected = "default";
    const status = await inspectEngineLifecycle(f.options);
    expect(status.selected).toMatchObject({
      context: "default",
      state: "unavailable",
    });
    expect(status.colimaDefault.state).toBe("stopped");
    const preview = await planEngineShutdown(f.options);
    expect(preview.reason).toBe("backend-unqualified");
    f.state.selected = "colima";
    const result = await shutdownEngine({
      ...f.options,
      confirmDigest: "a".repeat(64),
    });
    expect(result.status).toBe("already-stopped");
    expect(result.confirmed).toEqual({
      profileStopped: true,
      vmProcessAbsent: false,
    });
    expect(f.state.stops).toBe(0);
  });
  it("does not confuse profileStopped with lingering VM or unavailable lsof evidence", async () => {
    const f = await fixture(),
      proof = await qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon);
    f.state.running = false;
    expect(await confirmColimaStopped(f.backend, proof)).toEqual({
      profileStopped: true,
      vmProcessAbsent: false,
    });
    f.state.vm = false;
    f.state.stderr = "inspection unavailable";
    expect(await confirmColimaStopped(f.backend, proof)).toEqual({
      profileStopped: true,
      vmProcessAbsent: false,
    });
  });
  it("does not claim process exit when the same PID and birth remain under changed comm", async () => {
    const f = await fixture(),
      proof = await qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon);
    f.state.running = false;
    f.state.disksHeld = false;
    f.state.vmExecutable = "changed-process-name";
    expect(await confirmColimaStopped(f.backend, proof)).toEqual({
      profileStopped: true,
      vmProcessAbsent: false,
    });
  });
  it("binds the guest local Docker daemon to the selected host daemon and refuses a redirected socket", async () => {
    const f = await fixture();
    expect(
      (await qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon))
        .daemonId,
    ).toBe(f.state.daemon);
    f.state.guestDaemon = "different-guest-engine";
    await expect(
      qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon),
    ).rejects.toThrow();
    const plan = await planEngineShutdown(f.options);
    expect(plan.state).toBe("unsupported");
    expect(f.state.stops).toBe(0);
    expect(
      f.state.calls
        .filter(
          (call) => call.command === "colima" && call.args.includes("docker"),
        )
        .every(
          (call) =>
            JSON.stringify(call.args) ===
            JSON.stringify(COLIMA_GUEST_DAEMON_ID_ARGUMENTS),
        ),
    ).toBe(true);
  });
  it("refuses host daemon drift after container inspection and immediately before dispatch", async () => {
    const f = await fixture();
    f.state.changeAtInfo = 2;
    expect((await planEngineShutdown(f.options)).reason).toBe(
      "ownership-unverified",
    );
    expect(f.state.stops).toBe(0);
    f.state.daemon = f.state.guestDaemon;
    f.state.changeAtInfo = null;
    f.state.infoCalls = 0;
    const plan = await planEngineShutdown(f.options);
    f.state.infoCalls = 0;
    f.state.changeAtInfo = 5;
    const result = await shutdownEngine({
      ...f.options,
      confirmDigest: plan.consentDigest,
    });
    expect(result.status).toBe("refused");
    expect(result.reason).toBe("review-changed");
    expect(f.state.stops).toBe(0);
  });
  it("refuses a new container or restart introduced during the third late guest proof", async () => {
    for (const mutate of [
      (state) => (state.extraContainer = true),
      (state) => state.restartCount++,
    ]) {
      const f = await fixture(),
        plan = await planEngineShutdown(f.options);
      f.state.guestQueries = 0;
      f.state.onGuest = () => {
        if (f.state.guestQueries === 3) mutate(f.state);
      };
      const result = await shutdownEngine({
        ...f.options,
        confirmDigest: plan.consentDigest,
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toBe("review-changed");
      expect(f.state.stops).toBe(0);
    }
  });
  it("cancels before dispatch without touching metadata or coordination", async () => {
    const f = await fixture(),
      controller = new AbortController();
    controller.abort();
    const result = await shutdownEngine({
      ...f.options,
      signal: controller.signal,
      confirmDigest: "a".repeat(64),
    });
    expect(result.status).toBe("cancelled");
    expect(f.state.calls).toHaveLength(0);
    expect(f.state.stops).toBe(0);
  });
  it("keeps nonqualified backends visible for inspection but never stops them", async () => {
    const f = await fixture();
    const options = {
      ...f.options,
      dependencies: {
        ...f.options.dependencies,
        platform: "linux",
        architecture: "x64",
      },
    };
    expect((await inspectEngineLifecycle(options)).selected.state).toBe(
      "running",
    );
    expect((await planEngineShutdown(options)).reason).toBe(
      "backend-unqualified",
    );
    expect(f.state.stops).toBe(0);
  });
  it("validates complete exact activity snapshots and rejects unknown or partial values", async () => {
    const f = await fixture(),
      row = f.impact();
    expect(parseEngineContainerImpact(JSON.stringify(row), [id])[0].name).toBe(
      "shared-application",
    );
    for (const update of [
      { startedAt: "unknown" },
      { restartCount: -1 },
      { state: "unknown" },
      { id: "b".repeat(64) },
      { extra: "private" },
    ])
      expect(() =>
        parseEngineContainerImpact(JSON.stringify({ ...row, ...update }), [id]),
      ).toThrow();
    expect(() => parseEngineContainerImpact("", [id])).toThrow();
  });
  it("does not treat an unselected stopped Colima profile as the selected engine stop preview", async () => {
    const f = await fixture();
    f.state.running = false;
    f.state.vm = false;
    f.state.selected = "default";
    const plan = await planEngineShutdown(f.options);
    expect(plan.state).toBe("unsupported");
    expect(plan.reason).toBe("backend-unqualified");
    expect(plan.engine).toBeNull();
    expect(f.state.stops).toBe(0);
  });
  it("accepts the standard legacy socket alias but refuses duplicate primary and foreign mappings", async () => {
    const f = await fixture(),
      colima = f.environment.COLIMA_HOME,
      path = join(f.environment.LIMA_HOME, "colima/lima.yaml");
    expect(
      (await qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon))
        .endpoint,
    ).toBe(f.endpoint);
    const primary = `    - guestSocket: /var/run/docker.sock\n      hostSocket: ${colima}/default/docker.sock\n`;
    for (const extra of [
      primary,
      `    - guestSocket: /var/run/docker.sock\n      hostSocket: /foreign/docker.sock\n`,
    ]) {
      await writeFile(path, "portForwards:\n" + primary + extra, {
        mode: 0o600,
      });
      await expect(
        qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon),
      ).rejects.toThrow();
    }
    await writeFile(path, "portForwards:\n" + primary, { mode: 0o600 });
    expect(
      (await qualifyColimaDefault(f.backend, f.endpoint, f.state.daemon))
        .endpoint,
    ).toBe(f.endpoint);
  });
  it("does not dispatch when metadata and coordination consumed the stop verification budget", async () => {
    const f = await fixture();
    let now = 0,
      locks = 0;
    const dependencies = {
      ...f.options.dependencies,
      now: () => now,
      operationLocks: async () => {
        if (++locks === 3) now = 90000;
        return [];
      },
    };
    const options = { ...f.options, dependencies };
    const plan = await planEngineShutdown(options);
    locks = 0;
    const result = await shutdownEngine({
      ...options,
      confirmDigest: plan.consentDigest,
    });
    expect(result.status).toBe("refused");
    expect(result.reason).toBe("shutdown-unconfirmed");
    expect(f.state.stops).toBe(0);
    expect(f.state.released).toBe(1);
  });
  it("unsupported host does not invoke Docker or Colima metadata", async () => {
    const f = await fixture();
    const status = await inspectEngineLifecycle({
      ...f.options,
      dependencies: {
        ...f.options.dependencies,
        hostSupported: async () => false,
      },
    });
    expect(status.selected.state).toBe("unsupported-host");
    expect(status.colimaDefault.state).toBe("not-observed");
    expect(f.state.calls).toEqual([]);
  });
  it("binds the same process start and both disk dev/inode identities, never the executable name alone", () => {
    const disks = [
      { path: "/external/a", dev: "1", ino: "2", size: "3" },
      { path: "/external/b", dev: "1", ino: "4", size: "3" },
    ];
    const proof =
      "p31002\ncVM\nf4u\nD0x1\ni2\nn/external/a\nf5u\nD0x1\ni4\nn/external/b\n";
    expect(diskHolderPids(proof, disks)).toEqual([31002]);
    expect(() => diskHolderPids(proof.replace("i4", "i9"), disks)).toThrow();
    expect(
      parseEngineProcessTable(
        "31002 1 Sun Oct 25 16:19:21 2026 /System/com.apple.Virtualization.VirtualMachine\n",
      )[0].start,
    ).toBe("Sun Oct 25 16:19:21 2026");
  });
});
