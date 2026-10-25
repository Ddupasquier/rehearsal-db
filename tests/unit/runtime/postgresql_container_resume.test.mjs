import { EventEmitter } from "node:events";
import { withRuntimeStartupCleanup } from "../../../dist/src/runtime/runtime_startup_ownership.mjs";
import {
  getOperationCancellationSignal,
  runWithOperationCancellation,
  throwIfOperationCancelled,
} from "../../../dist/src/shared/cancellation.mjs";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresqlContainerLifecycle,
  retainedPostgresqlCreateArguments,
  resumeRetainedPostgresqlContainer,
} from "../../../dist/src/targets/postgresql_container_resume.mjs";
const receipt = {
  schemaVersion: 1,
  projectId: "owned-project",
  containerName: "owned-project-postgresql",
  volumeName: "owned-project-postgresql-data",
  volumeCreatedAt: "2026-10-24T00:00:00.000Z",
  volumeDriver: "local",
  image: "postgres:17-alpine",
  imageId: "sha256:" + "a".repeat(64),
  engineIdentity: "b".repeat(64),
  generationId: "generation-1",
  dataSha256: "c".repeat(64),
};
const marker = {
  target: "postgresql",
  generationId: receipt.generationId,
  dataSha256: receipt.dataSha256,
  image: receipt.image,
  databasePassword: "synthetic-password-".repeat(3),
};
const absent = () => ({
  engineIdentity: receipt.engineIdentity,
  image: { state: "present", id: receipt.imageId, reference: receipt.image },
  volume: {
    state: "present",
    name: receipt.volumeName,
    createdAt: receipt.volumeCreatedAt,
    driver: receipt.volumeDriver,
    labels: { "com.rehearsal-db.project": receipt.projectId },
  },
  container: { state: "absent" },
});
const present = () => ({
  ...absent(),
  container: {
    state: "present",
    id: "d".repeat(64),
    name: receipt.containerName,
    imageId: receipt.imageId,
    labels: { "com.rehearsal-db.project": receipt.projectId },
    running: true,
    mounts: [
      {
        type: "volume",
        name: receipt.volumeName,
        destination: "/var/lib/postgresql/data",
        writable: true,
      },
    ],
  },
});
const input = (snapshots = [absent(), absent(), present(), present()]) => {
  let index = 0;
  return {
    receipt,
    marker,
    port: 54321,
    user: "postgres",
    database: "postgres",
    adapter: {
      inspect: vi.fn(async () => snapshots[index++]),
      create: vi.fn(async () => {}),
      waitUntilReady: vi.fn(async () => {}),
    },
  };
};
describe("retained PostgreSQL container reconstruction", () => {
  it("creates exactly one container by immutable image ID on the existing volume and retains baseline bindings", async () => {
    const test = input();
    const result = await resumeRetainedPostgresqlContainer(test);
    expect(result).toMatchObject({
      state: "resumed",
      volumeName: receipt.volumeName,
      volumeCreatedAt: receipt.volumeCreatedAt,
      dataSha256: receipt.dataSha256,
      dataPreserved: true,
    });
    expect(test.adapter.create).toHaveBeenCalledTimes(1);
    const [args, budget] = test.adapter.create.mock.calls[0];
    expect(args).toContain("--pull=never");
    expect(args).toContain(receipt.volumeName + ":/var/lib/postgresql/data");
    expect(args.at(-1)).toBe(receipt.imageId);
    expect(args).not.toContain("create");
    expect(budget.timeoutMilliseconds).toBe(120000);
  });
  it.each(["absent", "unknown"])(
    "refuses %s retained volume without creation or reset",
    async (state) => {
      const snapshot = absent();
      snapshot.volume = { state };
      const test = input([snapshot]);
      await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow(
        /Preserve its volume/u,
      );
      expect(test.adapter.create).not.toHaveBeenCalled();
    },
  );
  it.each(["unknown", "present"])(
    "refuses %s container observation without reconstruction",
    async (state) => {
      const snapshot =
        state === "present" ? present() : { ...absent(), container: { state } };
      const test = input([snapshot]);
      await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow();
      expect(test.adapter.create).not.toHaveBeenCalled();
    },
  );
  it("rechecks ownership and volume creation identity before the only write", async () => {
    const changed = absent();
    changed.volume.createdAt = "2026-10-25T00:00:00.000Z";
    const test = input([absent(), changed]);
    await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it.each(["engine", "image", "label", "conflict"])(
    "refuses changed %s binding",
    async (field) => {
      const snapshot = absent();
      if (field === "engine") snapshot.engineIdentity = "e".repeat(64);
      if (field === "image") snapshot.image.id = "sha256:" + "f".repeat(64);
      if (field === "label") snapshot.volume.labels = {};
      if (field === "conflict")
        snapshot.volume.labels["com.supabase.cli.project"] = "foreign";
      const test = input([snapshot]);
      await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow();
      expect(test.adapter.create).not.toHaveBeenCalled();
    },
  );
  it("preserves recovery state on readiness failure and withholds secret/error details", async () => {
    const test = input();
    test.adapter.waitUntilReady.mockRejectedValue(
      new Error(marker.databasePassword),
    );
    await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow(
      /no baseline reset/u,
    );
    try {
      await resumeRetainedPostgresqlContainer(input([]));
    } catch (error) {
      expect(error.message).not.toContain(marker.databasePassword);
    }
    expect(Object.keys(test.adapter)).toEqual([
      "inspect",
      "create",
      "waitUntilReady",
    ]);
  });
  it("refuses drifted marker and invalid ports before observations", async () => {
    const test = input();
    test.marker = { ...marker, dataSha256: "f".repeat(64) };
    await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow();
    expect(test.adapter.inspect).not.toHaveBeenCalled();
    expect(() =>
      retainedPostgresqlCreateArguments({
        receipt,
        password: marker.databasePassword,
        port: 80,
        user: "postgres",
        database: "postgres",
      }),
    ).toThrow();
  });
  it("refuses pre-cancelled reconstruction before any observation", async () => {
    const test = input();
    const c = new AbortController();
    c.abort();
    await expect(
      resumeRetainedPostgresqlContainer({ ...test, signal: c.signal }),
    ).rejects.toThrow();
    expect(test.adapter.inspect).not.toHaveBeenCalled();
  });
  it("rejects a foreign mount or replacement after creation without data-deleting rollback", async () => {
    const replaced = present();
    replaced.container.mounts[0].name = "foreign";
    const test = input([absent(), absent(), replaced]);
    await expect(resumeRetainedPostgresqlContainer(test)).rejects.toThrow();
    expect(test.adapter.create).toHaveBeenCalledTimes(1);
    expect(test.adapter.waitUntilReady).not.toHaveBeenCalled();
  });
});

describe("PostgreSQL stop factory no-action boundaries", () => {
  const factory = (
    run,
    local = {
      context: "colima",
      endpoint: "unix:///external/owned/docker.sock",
      identity: "b".repeat(64),
    },
  ) => {
    const diagnostic = vi.fn();
    return {
      diagnostic,
      lifecycle: createPostgresqlContainerLifecycle({
        cwd: "/synthetic",
        runtimeWorkdir: "/nonexistent-private-runtime",
        markerPath: "/nonexistent-private-runtime/baseline.json",
        projectId: receipt.projectId,
        image: receipt.image,
        port: 54321,
        user: "postgres",
        database: "postgres",
        waitUntilReady: async () => {},
        dependencies: { run, localContext: () => local, diagnostic },
      }),
    };
  };
  it("reports exact absence without reading a nonexistent marker or making a volume claim", async () => {
    const run = vi.fn((args) => ({
      status: 0,
      stdout: args.includes("info") ? "owned-daemon\n" : "",
    }));
    const { lifecycle, diagnostic } = factory(run);
    await expect(lifecycle.retireStopped()).resolves.toEqual({
      state: "no-action",
      reason: "container-absent",
      volumesPreserved: null,
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("not inspected"),
    );
    expect(
      run.mock.calls.every(
        ([args]) => args.includes("info") || args.includes("ls"),
      ),
    ).toBe(true);
  });
  it("reports unavailable engine idempotently without probing marker, containers or volumes", async () => {
    const run = vi.fn(() => ({ status: 1, stdout: "" }));
    const { lifecycle, diagnostic } = factory(run);
    for (let i = 0; i < 2; i++)
      await expect(lifecycle.retireStopped()).resolves.toMatchObject({
        state: "no-action",
        reason: "engine-unavailable",
        volumesPreserved: null,
      });
    expect(run).toHaveBeenCalledTimes(2);
    expect(diagnostic).toHaveBeenCalledTimes(2);
  });
  it("refuses remote or malformed context before treating an engine as unavailable", async () => {
    const run = vi.fn(() => ({ status: 1, stdout: "" }));
    const { lifecycle } = factory(run, {
      context: "foreign",
      endpoint: "ssh://remote.invalid",
      identity: "b".repeat(64),
    });
    await expect(lifecycle.retireStopped()).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("requires a private marker before stopping a present container", async () => {
    const run = vi.fn((args) => ({
      status: 0,
      stdout: args.includes("info") ? "owned-daemon\n" : "d".repeat(64) + "\n",
    }));
    const { lifecycle } = factory(run);
    await expect(lifecycle.retireStopped()).rejects.toThrow();
    expect(
      run.mock.calls.some(
        ([args]) => args.includes("stop") || args.includes("rm"),
      ),
    ).toBe(false);
  });
});

it("factory retires a stopped shell with private receipts and resumes its original image despite tag drift", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, realpath, rm } =
    await import("node:fs/promises");
  const { readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rehearsal-retained-factory-")),
  );
  const runtime = join(directory, "runtime"),
    markerPath = join(runtime, "baseline.json"),
    receiptPath = join(runtime, "container-retirement.json");
  await mkdir(runtime, { mode: 0o700 });
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const local = {
    context: "owned",
    endpoint: "unix:///synthetic/docker.sock",
    identity: receipt.engineIdentity,
  };
  const oldId = "d".repeat(64),
    newId = "e".repeat(64),
    tagReplacement = "sha256:" + "f".repeat(64);
  const labels = { "com.rehearsal-db.project": receipt.projectId };
  const volume = {
    name: receipt.volumeName,
    createdAt: receipt.volumeCreatedAt,
    driver: receipt.volumeDriver,
    labels,
  };
  const mounts = [
    {
      Type: "volume",
      Name: receipt.volumeName,
      Destination: "/var/lib/postgresql/data",
      RW: true,
    },
  ];
  let container = { id: oldId, running: true, image: receipt.imageId };
  let preparedObserved = false;
  let tag = receipt.imageId;
  const calls = [];
  const run = (args) => {
    calls.push([...args]);
    const a = args[0] === "--host" ? args.slice(2) : args;
    const ok = (value = "") => ({
      status: 0,
      stdout: typeof value === "string" ? value : JSON.stringify(value),
    });
    if (a[0] === "context")
      return ok(
        a.includes(
          "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        )
          ? "false"
          : JSON.stringify(local.endpoint),
      );
    if (a[0] === "info") return ok("owned-daemon");
    if (a[0] === "volume" && a[1] === "inspect") {
      expect(a.at(-1)).toBe(volume.name);
      return ok(volume);
    }
    if (a[0] === "image" && a[1] === "inspect") {
      // Mutable tag changes are deliberately not an input to retained-volume reconstruction.
      expect(a.at(-1)).toBe(receipt.imageId);
      expect(tag).toMatch(/^sha256:/);
      return ok(receipt.imageId);
    }
    if (a[0] === "container" && a[1] === "ls") {
      const idFilter = a.find((x) => x.startsWith("id="));
      return ok(
        container && (!idFilter || idFilter.slice(3) === container.id)
          ? container.id
          : "",
      );
    }
    if (a[0] === "container" && a[1] === "inspect") {
      expect(container).toBeDefined();
      expect(a.at(-1)).toBe(container.id);
      const format = a[a.indexOf("--format") + 1];
      if (format === "{{json .Config.Labels}}") return ok(labels);
      if (format.includes('"restarting"'))
        return ok({
          id: container.id,
          labels,
          state: container.running ? "running" : "exited",
          running: container.running,
          paused: false,
          restarting: false,
          startedAt: "2026-10-24T00:00:00.123456789Z",
          finishedAt: "2026-10-24T00:01:00.123456789Z",
          restartCount: 0,
          image: container.image,
          mounts,
        });
      return ok({
        id: container.id,
        name: "/" + receipt.containerName,
        imageId: container.image,
        labels,
        running: container.running,
        mounts,
      });
    }
    if (a[0] === "stop") {
      expect(a.at(-1)).toBe(oldId);
      container.running = false;
      return ok();
    }
    if (a[0] === "container" && a[1] === "rm") {
      expect(a).toEqual(["container", "rm", oldId]);
      expect(container.running).toBe(false);
      const prepared = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(prepared.state).toBe("prepared");
      const protectedRaw = JSON.parse(readFileSync(markerPath, "utf8"));
      expect(protectedRaw.target).toBe("postgresql-retired");
      expect(protectedRaw.containerRetirementProtocol).toBe(1);
      expect(protectedRaw.target === "postgresql").toBe(false);
      expect(
        readFileSync(join(runtime, "baseline.pre-retirement.json"), "utf8"),
      ).toBe(JSON.stringify(marker));
      expect(prepared.receipt.volumeName).toBe(volume.name);
      preparedObserved = true;
      container = undefined;
      return ok();
    }
    if (a[0] === "run") {
      expect(container).toBeUndefined();
      expect(a.at(-1)).toBe(receipt.imageId);
      expect(a).toContain("--pull=never");
      expect(a).toContain(volume.name + ":/var/lib/postgresql/data");
      container = { id: newId, running: true, image: receipt.imageId };
      return ok(newId);
    }
    if (a[0] === "exec") {
      expect(a).toContain("pg_isready");
      expect(a).toContain(receipt.containerName);
      return ok();
    }
    throw new Error("Unexpected stateful factory command");
  };
  const lifecycle = createPostgresqlContainerLifecycle({
    cwd: directory,
    runtimeWorkdir: runtime,
    markerPath,
    projectId: receipt.projectId,
    image: receipt.image,
    port: 54321,
    user: "postgres",
    database: "postgres",
    dependencies: { run, localContext: () => local, diagnostic: vi.fn() },
  });
  try {
    await lifecycle.retireStopped();
    expect(preparedObserved).toBe(true);
    expect(container).toBeUndefined();
    const completed = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(completed.state).toBe("completed");
    expect(completed.receipt).toMatchObject({
      imageId: receipt.imageId,
      volumeCreatedAt: volume.createdAt,
      volumeDriver: volume.driver,
    });
    expect(completed.markerSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(completed.plan.snapshots[0].startedAt).toBe(
      "2026-10-24T00:00:00.123456789Z",
    );
    const { readMatchingRuntimeMarker, hasMatchingRuntimeMarker } =
      await import("../../../dist/src/runtime/lifecycle_engine.mjs");
    const logical = await readMatchingRuntimeMarker({
      path: markerPath,
      expected: marker,
      mismatchMessage: "mismatch",
    });
    expect(logical.target).toBe("postgresql");
    expect(logical.containerRetirementProtocol).toBe(1);
    expect(
      await hasMatchingRuntimeMarker({
        path: markerPath,
        expected: { target: "postgresql", generationId: marker.generationId },
      }),
    ).toBe(true);
    const originalBytes = JSON.stringify(marker),
      backupPath = join(runtime, "baseline.pre-retirement.json");
    expect(await readFile(backupPath, "utf8")).toBe(originalBytes);
    // Simulate an older765 receipt and its still-normal marker on an already-retired volume.
    const { createHash } = await import("node:crypto");
    const legacy = {
      ...completed,
      markerSha256: createHash("sha256").update(originalBytes).digest("hex"),
    };
    delete legacy.markerProtectionProtocol;
    delete legacy.priorMarkerSha256;
    await writeFile(markerPath, originalBytes, { mode: 0o600 });
    await writeFile(receiptPath, JSON.stringify(legacy), { mode: 0o600 });
    await writeFile(backupPath, '{"foreign":true}', { mode: 0o600 });
    await expect(lifecycle.retireStopped()).rejects.toThrow();
    expect(await readFile(backupPath, "utf8")).toBe('{"foreign":true}');
    await writeFile(backupPath, originalBytes, { mode: 0o600 });
    // Interrupted preparation binds future protected bytes while current raw bytes remain normal.
    const interrupted = {
      ...completed,
      state: "prepared",
      priorMarkerSha256: legacy.markerSha256,
    };
    await writeFile(receiptPath, JSON.stringify(interrupted), { mode: 0o600 });
    await expect(lifecycle.resumeIfMissing(marker)).rejects.toThrow();
    expect(container).toBeUndefined();
    expect(JSON.parse(await readFile(markerPath, "utf8")).target).toBe(
      "postgresql",
    );
    await writeFile(receiptPath, JSON.stringify(legacy), { mode: 0o600 });
    const upgradeCallIndex = calls.length;
    expect(await lifecycle.retireStopped()).toMatchObject({
      state: "protected-retained-runtime",
      containerRemoved: false,
      volumesPreserved: true,
    });
    expect(
      calls
        .slice(upgradeCallIndex)
        .some(
          (a) => a.includes("run") || a.includes("stop") || a.includes("rm"),
        ),
    ).toBe(false);
    expect(await readFile(backupPath, "utf8")).toBe(originalBytes);
    const guarded = JSON.parse(await readFile(markerPath, "utf8"));
    expect(guarded.target).toBe("postgresql-retired");
    expect(guarded.containerRetirementProtocol).toBe(1);
    tag = tagReplacement;
    await lifecycle.resumeIfMissing(
      await readMatchingRuntimeMarker({
        path: markerPath,
        expected: marker,
        mismatchMessage: "mismatch",
      }),
    );
    expect(container).toEqual({
      id: newId,
      running: true,
      image: receipt.imageId,
    });
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
      ...marker,
      target: "postgresql-retired",
      containerRetirementProtocol: 1,
    });
    expect(await readFile(backupPath, "utf8")).toBe(originalBytes);
    expect(volume).toEqual({
      name: receipt.volumeName,
      createdAt: receipt.volumeCreatedAt,
      driver: receipt.volumeDriver,
      labels,
    });
    expect(calls.filter((a) => a.includes("rm"))).toEqual([
      ["--host", local.endpoint, "container", "rm", oldId],
    ]);
    expect(
      calls.some(
        (a) =>
          a.includes("--force") ||
          a.includes("--volumes") ||
          a.includes("prune"),
      ),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("retained resume startup failure cleanup", () => {
  it.each(["readiness", "cancellation"])(
    "stops only its newly created shell after %s failure",
    async (failure) => {
      const signals = new EventEmitter();
      const ownerId = "e".repeat(64);
      const engine = {
        context: "owned",
        endpoint: "unix:///synthetic/resume.sock",
        identity: receipt.engineIdentity,
      };
      const config = {
        runtime: { projectId: receipt.projectId, target: "postgresql" },
        lifecycle: { run: "stop-after-run" },
      };
      const retainedVolume = { ...absent().volume };
      const foreign = {
        id: "f".repeat(64),
        running: true,
        volume: "foreign-data",
      };
      let shell = null;
      const commands = [];
      const test = input();
      test.adapter.inspect = vi.fn(async () =>
        shell
          ? {
              ...present(),
              container: { ...present().container, running: shell.running },
            }
          : absent(),
      );
      test.adapter.create = vi.fn(async (args) => {
        expect(commands.some((args) => args.includes("ls"))).toBe(true);
        expect(args.at(-1)).toBe(receipt.imageId);
        expect(args).toContain(
          receipt.volumeName + ":/var/lib/postgresql/data",
        );
        shell = {
          ...present().container,
          startedAt: "2026-10-25T00:00:00.000000000Z",
        };
      });
      test.adapter.waitUntilReady = vi.fn(async () => {
        if (failure === "cancellation") {
          signals.emit("SIGINT");
          expect(getOperationCancellationSignal()?.aborted).toBe(true);
          throwIfOperationCancelled();
        }
        throw new Error("synthetic readiness failure");
      });
      const run = vi.fn((_command, args) => {
        commands.push([...args]);
        const ids = shell ? [shell.id] : [];
        if (args.includes("ls")) return { status: 0, stdout: ids.join("\n") };
        expect(args).toContain("inspect");
        expect(args.at(-1)).toBe(shell.id);
        return {
          status: 0,
          stdout: [
            shell.id,
            "/" + shell.name,
            shell.running,
            shell.startedAt,
            shell.labels,
          ]
            .map(JSON.stringify)
            .join("\t"),
        };
      });
      const executeStop = vi.fn(async ({ args, env }) => {
        commands.push([...args]);
        expect(args).toEqual([
          "--host",
          engine.endpoint,
          "container",
          "stop",
          "--time",
          "5",
          shell.id,
        ]);
        expect(env.DOCKER_HOST).toBe(engine.endpoint);
        expect(getOperationCancellationSignal()).toBeUndefined();
        shell.running = false;
        return { status: 0, stdout: "", stderr: "" };
      });
      const operation = () =>
        withRuntimeStartupCleanup({
          projectRoot: "/synthetic",
          configPath: "rehearsal.config.mjs",
          config,
          action: "start",
          ownerOperationId: ownerId,
          task: () =>
            resumeRetainedPostgresqlContainer({
              ...test,
              signal: getOperationCancellationSignal(),
            }),
          run,
          executeStop,
          inspectEngine: () => engine,
          loadConfiguration: async () => ({ config }),
          inspectOwner: async () => ({
            state: "busy",
            operation: { progress: { operationId: ownerId } },
          }),
        });
      await expect(
        runWithOperationCancellation({
          signalTarget: signals,
          task: operation,
        }),
      ).rejects.toThrow();
      expect(test.adapter.create).toHaveBeenCalledOnce();
      expect(executeStop).toHaveBeenCalledOnce();
      expect(shell.running).toBe(false);
      expect(retainedVolume).toEqual(absent().volume);
      expect(foreign).toEqual({
        id: "f".repeat(64),
        running: true,
        volume: "foreign-data",
      });
      expect(
        commands.every(
          (args) =>
            !args.some((arg) =>
              ["rm", "prune", "reset", "volume"].includes(arg),
            ),
        ),
      ).toBe(true);
    },
  );
});
