import { describe, expect, it } from "vitest";
import {
  createFixtureSourceContainer,
  finishFixtureCleanup,
} from "../../../scripts/verification/scenarios/fixture_container.mjs";
import { spawnScenarioCommand } from "../../../scripts/verification/scenarios/process.mjs";

const ID = "a".repeat(64);
const VOLUME = "b".repeat(64);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const failed = () => ({ status: 1, stdout: "", stderr: "private-canary" });

// Docker inspect's template engine rejects a missing map key accessed with dot
// notation; index returns null. Exercise the actual requested whitelist against
// a Docker-shaped object rather than ignoring the production format argument.
const renderDockerWhitelist = (format, metadata) => {
  const lookup = (path) => {
    let value = metadata;
    for (const key of path.slice(1).split(".")) {
      if (!Object.hasOwn(value, key)) throw new Error("missing Docker map key");
      value = value[key];
    }
    return value;
  };
  const rendered = format.replace(
    /\{\{json (?:(\.[a-zA-Z.]+)|\(index (\.[a-zA-Z.]+) "([a-zA-Z]+)"\))\}\}/gu,
    (_, dottedPath, indexedPath, key) =>
      JSON.stringify(
        dottedPath ? lookup(dottedPath) : (lookup(indexedPath)[key] ?? null),
      ),
  );
  if (rendered.includes("{{")) throw new Error("unsupported Docker template");
  return rendered;
};

const fakeDocker = () => {
  const calls = [];
  const state = {
    context: "fixture-local",
    endpoint: "unix:///tmp/fixture-docker.sock",
    engine: "fixture-engine-1",
    present: false,
    volumePresent: false,
    fail: null,
    inspect: null,
    keepContainer: false,
    keepVolume: false,
    lookup: null,
    createOutput: `${ID}\n`,
    evaluateFormat: false,
  };
  const runner = (command, originalArgs, options) => {
    calls.push({ command, args: originalArgs, options });
    expect(command).toBe("docker");
    const args =
      originalArgs[0] === "--host" ? originalArgs.slice(2) : originalArgs;
    const action = args.slice(0, 2).join(" ");
    if (state.fail === action) return failed();
    if (action === "context show") return ok(`${state.context}\n`);
    if (action === "context inspect") return ok(JSON.stringify(state.endpoint));
    if (action === "info --format") return ok(state.engine);
    expect(originalArgs.slice(0, 2)).toEqual([
      "--host",
      "unix:///tmp/fixture-docker.sock",
    ]);
    if (action === "container create") {
      const name = args[args.indexOf("--name") + 1];
      const label = args[args.indexOf("--label") + 1].split("=");
      state.present = true;
      state.volumePresent = true;
      state.metadata = {
        Id: ID,
        Name: `/${name}`,
        Labels: { [label[0]]: label[1] },
        Binds: null,
        ExplicitMounts: null,
        VolumesFrom: null,
        ImageVolumes: { "/var/lib/postgresql/data": {} },
        Mounts: [
          {
            Type: "volume",
            Driver: "local",
            Name: VOLUME,
            Destination: "/var/lib/postgresql/data",
          },
        ],
      };
      return ok(state.createOutput);
    }
    if (action === "container inspect") {
      if (state.evaluateFormat && state.inspect === null) {
        const m = state.metadata;
        const dockerShape = {
          Id: m.Id,
          Name: m.Name,
          Config: { Labels: m.Labels, Volumes: m.ImageVolumes },
          HostConfig: {
            Binds: m.Binds,
            // Actual Docker omits Mounts for image-created anonymous volumes.
            ...(m.ExplicitMounts === null ? {} : { Mounts: m.ExplicitMounts }),
            VolumesFrom: m.VolumesFrom,
          },
          Mounts: m.Mounts,
        };
        try {
          return ok(
            renderDockerWhitelist(
              args[args.indexOf("--format") + 1],
              dockerShape,
            ),
          );
        } catch {
          return failed();
        }
      }
      return ok(state.inspect ?? JSON.stringify(state.metadata));
    }
    if (action === "container start") return ok(ID);
    if (action === "container ls") {
      return ok(state.lookup ?? (state.present ? `${ID}\n` : ""));
    }
    if (action === "container rm") {
      if (!state.keepContainer) state.present = false;
      if (!state.keepVolume) state.volumePresent = false;
      return ok(ID);
    }
    if (action === "volume ls") return ok(state.volumePresent ? VOLUME : "");
    throw new Error(`Unexpected fake Docker action: ${action}`);
  };
  const fixture = createFixtureSourceContainer({
    cwd: process.cwd(),
    port: 54329,
    password: "synthetic-only",
    runner,
  });
  const removals = () => calls.filter(({ args }) => args.includes("rm"));
  return { fixture, state, calls, removals };
};

describe("exact-owned standalone source fixture", () => {
  it("supports Docker's omitted HostConfig Mounts key while retaining the safe inspection whitelist", () => {
    const { fixture, state, removals } = fakeDocker();
    state.evaluateFormat = true;
    expect(fixture.create()).toBe(ID);
    fixture.cleanup();
    expect(removals()).toHaveLength(1);
    expect(state.volumePresent).toBe(false);
  });

  it("creates before starting, pins the local engine and removes only its immutable ID with anonymous volumes", () => {
    const { fixture, calls, state, removals } = fakeDocker();
    expect(fixture.create()).toBe(ID);
    expect(fixture.id).toBe(ID);
    expect(fixture.name).toMatch(/^rehearsal-source-[a-f0-9-]{36}$/u);
    expect(calls.some(({ args }) => args.includes("start"))).toBe(false);
    const creation = calls.find(({ args }) => args.includes("create")).args;
    expect(creation).toContain("--pull=never");
    expect(creation).toContain("127.0.0.1:54329:5432");
    expect(creation).not.toContain("--volume");
    expect(creation).not.toContain("--mount");
    expect(state.metadata.Labels["com.rehearsal-db.fixture"]).toBe(
      fixture.name.slice("rehearsal-source-".length),
    );
    fixture.start();
    fixture.cleanup();
    expect(removals().map(({ args }) => args)).toEqual([
      ["--host", state.endpoint, "container", "rm", "--force", "--volumes", ID],
    ]);
    expect(state.present).toBe(false);
    expect(state.volumePresent).toBe(false);
    expect(
      calls.every(
        ({ options }) =>
          options.timeout === 15_000 && options.maxBuffer === 65_536,
      ),
    ).toBe(true);
    expect(calls.some(({ args }) => args.includes("prune"))).toBe(false);
    fixture.cleanup();
    expect(removals()).toHaveLength(1);
    expect(() => fixture.start()).toThrow(/no active owned container/u);
    expect(() => fixture.create()).toThrow(/already attempted/u);
  });

  it("generates different names and nonce ownership for concurrent fixtures", () => {
    const first = fakeDocker();
    const second = fakeDocker();
    first.fixture.create();
    second.fixture.create();
    expect(first.fixture.name).not.toBe(second.fixture.name);
    expect(first.state.metadata.Labels).not.toEqual(
      second.state.metadata.Labels,
    );
  });

  it("does not remove a foreign same-name container after failed creation", () => {
    const { fixture, state, removals } = fakeDocker();
    state.fail = "container create";
    state.present = true;
    expect(() => fixture.create()).toThrow(/command failed/u);
    expect(fixture.id).toBeUndefined();
    expect(() => fixture.cleanup()).toThrow(
      /creation ownership was not established/u,
    );
    expect(removals()).toHaveLength(0);
    expect(state.present).toBe(true);
  });

  for (const output of [
    "",
    ID.slice(0, 12),
    `${ID}\n${ID}`,
    "private-canary",
  ]) {
    it(`refuses unproven creation output (${output.length} bytes) without a name-based fallback`, () => {
      const { fixture, state, removals } = fakeDocker();
      state.createOutput = output;
      expect(() => fixture.create()).toThrow(/one immutable ID/u);
      expect(() => fixture.cleanup()).toThrow(
        /creation ownership was not established/u,
      );
      expect(removals()).toHaveLength(0);
      expect(state.present).toBe(true);
    });
  }

  it("retains the creation ID when initial ownership inspection fails, then requires a valid fresh inspection for cleanup", () => {
    const { fixture, state, removals } = fakeDocker();
    state.inspect = "{";
    expect(() => fixture.create()).toThrow(/ownership inspection failed/u);
    expect(fixture.id).toBe(ID);
    expect(() => fixture.cleanup()).toThrow(/ownership inspection failed/u);
    expect(removals()).toHaveLength(0);
    state.inspect = null;
    fixture.cleanup();
    expect(removals()).toHaveLength(1);
    expect(state.volumePresent).toBe(false);
  });

  it("retains exact ownership through a failed startup so cleanup still runs", () => {
    const { fixture, state, removals } = fakeDocker();
    fixture.create();
    state.fail = "container start";
    expect(() => fixture.start()).toThrow(/command failed/u);
    fixture.cleanup();
    expect(removals()).toHaveLength(1);
    expect(state.volumePresent).toBe(false);
  });

  it("accepts an already removed helper only after checking its recorded volume is also absent", () => {
    const { fixture, state, calls, removals } = fakeDocker();
    fixture.create();
    state.present = false;
    state.volumePresent = false;
    fixture.cleanup();
    expect(removals()).toHaveLength(0);
    expect(calls.some(({ args }) => args.includes(`name=${VOLUME}`))).toBe(
      true,
    );
  });

  it("reports a leaked volume even when the exact container has already disappeared", () => {
    const { fixture, state, removals } = fakeDocker();
    fixture.create();
    state.present = false;
    expect(() => fixture.cleanup()).toThrow(/anonymous volume remains/u);
    expect(removals()).toHaveLength(0);
    expect(state.volumePresent).toBe(true);
  });

  for (const action of [
    "container rm",
    "container ls",
    "info --format",
    "context inspect",
  ]) {
    it(`surfaces ${action} failure without treating it as absence`, () => {
      const { fixture, state } = fakeDocker();
      fixture.create();
      state.fail = action;
      expect(() => fixture.cleanup()).toThrow();
      expect(state.present).toBe(true);
      expect(state.volumePresent).toBe(true);
    });
  }

  for (const property of ["keepContainer", "keepVolume"]) {
    it(`does not report success when Docker leaves ${property} behind`, () => {
      const { fixture, state } = fakeDocker();
      fixture.create();
      state[property] = true;
      expect(() => fixture.cleanup()).toThrow(/remains/u);
    });
  }

  for (const [label, mutate] of [
    [
      "different ID",
      (m) => {
        m.Id = "c".repeat(64);
      },
    ],
    [
      "renamed container",
      (m) => {
        m.Name = "/foreign";
      },
    ],
    [
      "foreign nonce",
      (m) => {
        m.Labels["com.rehearsal-db.fixture"] = "foreign";
      },
    ],
    [
      "persistent project",
      (m) => {
        m.Labels["com.rehearsal-db.project"] = "persistent";
      },
    ],
    [
      "Supabase project",
      (m) => {
        m.Labels["com.supabase.cli.project"] = "persistent";
      },
    ],
    [
      "bind mount",
      (m) => {
        m.Binds = ["/user/data:/data"];
      },
    ],
    [
      "named explicit mount",
      (m) => {
        m.ExplicitMounts = [{ Type: "volume", Source: "user-data" }];
      },
    ],
    [
      "inherited volume",
      (m) => {
        m.VolumesFrom = ["foreign"];
      },
    ],
    [
      "missing mount provenance",
      (m) => {
        delete m.Binds;
      },
    ],
    [
      "named mount",
      (m) => {
        m.Mounts[0].Name = "persistent-user-data";
      },
    ],
    [
      "undeclared image destination",
      (m) => {
        m.Mounts[0].Destination = "/foreign";
      },
    ],
    [
      "unknown mount driver",
      (m) => {
        m.Mounts[0].Driver = "remote";
      },
    ],
    [
      "unexpected mount type",
      (m) => {
        m.Mounts[0].Type = "bind";
      },
    ],
    [
      "changed anonymous volume",
      (m) => {
        m.Mounts[0].Name = "c".repeat(64);
      },
    ],
    [
      "missing image volume declaration",
      (m) => {
        m.ImageVolumes = null;
      },
    ],
    [
      "duplicate mount",
      (m) => {
        m.Mounts.push({ ...m.Mounts[0] });
      },
    ],
  ]) {
    it(`refuses deletion for ${label}`, () => {
      const { fixture, state, removals } = fakeDocker();
      fixture.create();
      mutate(state.metadata);
      expect(() => fixture.cleanup()).toThrow();
      expect(removals()).toHaveLength(0);
      expect(state.present).toBe(true);
    });
  }

  for (const value of ["null", "[]", "{", "x".repeat(65_537)]) {
    it(`fails closed on malformed or excessive inspect output (${value.length} bytes)`, () => {
      const { fixture, state, removals } = fakeDocker();
      fixture.create();
      state.inspect = value;
      expect(() => fixture.cleanup()).toThrow(/inspection|ownership/u);
      expect(removals()).toHaveLength(0);
    });
  }

  it("refuses ambiguous exact-ID listing without inspecting or deleting by name", () => {
    const { fixture, state, removals } = fakeDocker();
    fixture.create();
    state.lookup = `${ID}\n${"c".repeat(64)}`;
    expect(() => fixture.cleanup()).toThrow(/ambiguous/u);
    expect(removals()).toHaveLength(0);
  });

  for (const [property, value] of [
    ["engine", "different-engine"],
    ["endpoint", "unix:///tmp/different-engine.sock"],
  ]) {
    it(`refuses ${property} drift before start or deletion`, () => {
      const { fixture, state, removals } = fakeDocker();
      fixture.create();
      state[property] = value;
      expect(() => fixture.start()).toThrow(/engine identity changed/u);
      expect(() => fixture.cleanup()).toThrow(/engine identity changed/u);
      expect(removals()).toHaveLength(0);
    });
  }

  it("refuses a remote engine without creating any workload", () => {
    const { fixture, state, calls } = fakeDocker();
    state.endpoint = "tcp://remote.example:2375";
    expect(() => fixture.create()).toThrow(/local Docker endpoint/u);
    fixture.cleanup();
    expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
  });

  it("preserves the original failure and surfaces cleanup failures without raw command output", () => {
    const original = new Error("original fixture failure");
    const { fixture, state } = fakeDocker();
    fixture.create();
    state.fail = "container rm";
    let cleanup;
    try {
      fixture.cleanup();
    } catch (error) {
      cleanup = error;
    }
    expect(cleanup.message).not.toContain("private-canary");
    try {
      finishFixtureCleanup(original, [cleanup]);
      expect.unreachable("Cleanup failure must prevent success");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([original, cleanup]);
      expect(error.message).toContain("scratch workspace was retained");
    }
    expect(() => finishFixtureCleanup(original, [])).toThrow(original);
    expect(() => finishFixtureCleanup(undefined, [])).not.toThrow();
  });
});

describe("optional scenario process bounds", () => {
  it("actually terminates a timed-out owned child", () => {
    const result = spawnScenarioCommand(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      { timeout: 50, maxBuffer: 1024 },
    );
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGKILL");
  });

  it("actually enforces the requested output bound", () => {
    const result = spawnScenarioCommand(
      process.execPath,
      ["--eval", "process.stdout.write('x'.repeat(8192))"],
      { timeout: 5000, maxBuffer: 64 },
    );
    expect(result.error?.code).toBe("ENOBUFS");
  });

  for (const options of [
    { timeout: 0 },
    { timeout: -1 },
    { timeout: Infinity },
    { timeout: 300_001 },
    { timeout: 1.5 },
    { maxBuffer: 0 },
    { maxBuffer: 16 * 1024 * 1024 + 1 },
    { maxBuffer: NaN },
  ]) {
    it(`rejects invalid bounds ${JSON.stringify(options)} before spawning`, () => {
      expect(() => spawnScenarioCommand("must-not-run", [], options)).toThrow(
        /positive bounded integers/u,
      );
    });
  }
});
