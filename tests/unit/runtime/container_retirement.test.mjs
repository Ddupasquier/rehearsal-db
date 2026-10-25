import { describe, expect, it, vi } from "vitest";
import {
  planContainerRetirement,
  retireContainers,
} from "../../../dist/src/runtime/container_retirement.mjs";
const id = "a".repeat(64),
  foreign = "f".repeat(64);
const binding = {
  context: "owned",
  endpoint: "unix:///synthetic/docker.sock",
  daemonId: "owned-daemon",
};
const claim = {
  fullId: id,
  expectedLabels: { "com.rehearsal-db.project": "completed-fixture" },
  completedDisposable: true,
};
const fixture = () => {
  const containers = new Map([
    [
      id,
      {
        id,
        labels: { ...claim.expectedLabels },
        state: "exited",
        running: false,
        paused: false,
        restarting: false,
        startedAt: "2026-10-24T00:00:00.123456789Z",
        finishedAt: "2026-10-24T00:01:00.123456789Z",
        restartCount: 0,
        image: `sha256:${"b".repeat(64)}`,
        mounts: [
          {
            Type: "volume",
            Name: "retained-data",
            Destination: "/data",
            RW: true,
          },
        ],
      },
    ],
    [
      foreign,
      {
        id: foreign,
        labels: { "com.rehearsal-db.project": "foreign" },
        state: "running",
        running: true,
      },
    ],
  ]);
  const volumes = new Map([
    [
      "retained-data",
      {
        name: "retained-data",
        createdAt: "2026-10-24T00:00:00Z",
        driver: "local",
      },
    ],
  ]);
  const calls = [];
  const environments = [];
  let daemon = binding.daemonId,
    onRemove = () => undefined;
  const runner = (_command, args, environment) => {
    environments.push(environment);
    expect(environment.DOCKER_CONTEXT).toBeUndefined();
    expect(environment.DOCKER_TLS_VERIFY).toBeUndefined();
    if (args[0] !== "context")
      expect(environment.DOCKER_HOST).toBe(binding.endpoint);
    calls.push([...args]);
    const a = args[0] === "--host" ? args.slice(2) : args;
    const result = { status: 0, stdout: "", stderr: "" };
    if (a[0] === "context")
      result.stdout = a.includes(
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
      )
        ? "false"
        : JSON.stringify(binding.endpoint);
    else if (a[0] === "info") result.stdout = daemon;
    else if (a[0] === "container" && a[1] === "inspect") {
      const value = containers.get(a.at(-1));
      if (!value) result.status = 1;
      else result.stdout = JSON.stringify(value);
    } else if (a[0] === "volume" && a[1] === "inspect") {
      const value = volumes.get(a.at(-1));
      if (!value) result.status = 1;
      else result.stdout = JSON.stringify(value);
    } else if (a[0] === "container" && a[1] === "ls") {
      const target = a.find((x) => x.startsWith("id=")).slice(3);
      result.stdout = containers.has(target) ? target : "";
    } else if (a[0] === "container" && a[1] === "rm") {
      onRemove(result);
      const c = containers.get(a[2]);
      if (c?.running) result.status = 1;
      else if (result.status === 0) containers.delete(a[2]);
    } else throw new Error("Unexpected fixture command");
    return result;
  };
  return {
    containers,
    volumes,
    calls,
    environments,
    runner,
    setDaemon: (v) => {
      daemon = v;
    },
    onRemove: (fn) => {
      onRemove = fn;
    },
  };
};
const plan = (f) =>
  planContainerRetirement({ binding, claims: [claim], runner: f.runner });
const retire = (f, p, consent = { kind: "manual", digest: p.consentDigest }) =>
  retireContainers({ plan: p, consent, runner: f.runner });
describe("explicit completed disposable container retirement", () => {
  it("accepts reordered equivalent Docker mounts but refuses changed mount facts", () => {
    const f = fixture();
    f.containers.get(id).mounts.push(
      {
        Type: "bind",
        Destination: "/docker-entrypoint-initdb.d/010_schema.sql",
        RW: false,
      },
      {
        Type: "bind",
        Destination: "/docker-entrypoint-initdb.d/020_seed.sql",
        RW: false,
      },
    );
    const p = plan(f);
    f.containers.get(id).mounts.reverse();
    expect(retire(f, p).status).toBe("completed");
    expect(f.volumes.has("retained-data")).toBe(true);
    const changed = fixture(),
      old = plan(changed);
    changed.containers.get(id).mounts[0].Destination = "/different-data";
    expect(retire(changed, old).status).toBe("refused");
    expect(changed.containers.has(id)).toBe(true);
    expect(changed.volumes.has("retained-data")).toBe(true);
  });
  it("removes only the exact stopped claim and preserves all volumes and foreign canaries", () => {
    const f = fixture(),
      p = plan(f);
    expect(retire(f, p)).toMatchObject({
      status: "completed",
      outcomes: [
        { status: "removed", containerRemoved: true, volumesPreserved: true },
      ],
    });
    expect(f.containers.has(id)).toBe(false);
    expect(f.containers.has(foreign)).toBe(true);
    expect(f.volumes.has("retained-data")).toBe(true);
    const removals = f.calls.filter((a) => a.includes("rm"));
    expect(removals).toEqual([
      ["--host", binding.endpoint, "container", "rm", id],
    ]);
  });
  it("supports trusted completion hooks but requires exact manual consent", () => {
    const f = fixture(),
      p = plan(f);
    expect(() => retire(f, p, { kind: "manual", digest: "wrong" })).toThrow(
      /refused/,
    );
    expect(retire(f, p, { kind: "trusted-completion-hook" }).status).toBe(
      "completed",
    );
  });
  it("refuses malformed claims and conflicting or unclaimed known owners", () => {
    const f = fixture();
    for (const changed of [
      { ...claim, fullId: "short" },
      { ...claim, completedDisposable: false },
      { ...claim, expectedLabels: {} },
    ])
      expect(() =>
        planContainerRetirement({
          binding,
          claims: [changed],
          runner: f.runner,
        }),
      ).toThrow(/refused/);
    f.containers.get(id).labels["com.supabase.cli.project"] = "foreign";
    expect(() => plan(f)).toThrow(/refused/);
    expect(f.containers.has(id)).toBe(true);
  });
  it("refuses all non-stopped/unknown state and stale exact snapshots", () => {
    for (const state of [
      "running",
      "restarting",
      "paused",
      "dead",
      "removing",
      "unknown",
    ]) {
      const f = fixture();
      f.containers.get(id).state = state;
      expect(() => plan(f)).toThrow(/refused/);
    }
    const f = fixture(),
      p = plan(f);
    f.containers.get(id).image = `sha256:${"c".repeat(64)}`;
    expect(retire(f, p).status).toBe("refused");
    expect(f.containers.has(id)).toBe(true);
  });
  it("refuses changed engine and running races without force-removing anything", () => {
    const f = fixture(),
      p = plan(f);
    f.setDaemon("replacement");
    expect(retire(f, p).outcomes[0]).toMatchObject({
      status: "refused",
      containerRemoved: false,
    });
    expect(f.containers.has(id)).toBe(true);
    const race = fixture(),
      q = plan(race);
    race.onRemove(() => {
      race.containers.get(id).running = true;
    });
    expect(retire(race, q)).toMatchObject({
      status: "failed",
      outcomes: [
        { status: "failed", containerRemoved: false, volumesPreserved: true },
      ],
    });
  });
  it("detects replacement volume identity and preserves the container", () => {
    const f = fixture(),
      p = plan(f);
    f.volumes.get("retained-data").createdAt = "2026-10-25T00:00:00Z";
    expect(retire(f, p).status).toBe("refused");
    expect(f.containers.has(id)).toBe(true);
  });
  it("reports partial failure when rm errors after removal, retaining volume evidence", () => {
    const f = fixture(),
      p = plan(f);
    f.onRemove((result) => {
      f.containers.delete(id);
      result.status = 1;
    });
    expect(retire(f, p)).toMatchObject({
      status: "partial",
      outcomes: [
        { status: "failed", containerRemoved: true, volumesPreserved: true },
      ],
    });
    expect(f.containers.has(foreign)).toBe(true);
  });
  it("never claims cleanup when post-removal engine identity becomes unknown", () => {
    const f = fixture(),
      p = plan(f);
    f.onRemove(() => f.setDaemon("replacement"));
    expect(retire(f, p)).toMatchObject({
      status: "failed",
      outcomes: [
        { status: "failed", containerRemoved: null, volumesPreserved: null },
      ],
    });
  });
  it("refuses old manual consent after the same stopped container starts and stops again", () => {
    const f = fixture(),
      p = plan(f),
      beforeVolume = { ...f.volumes.get("retained-data") };
    const sameContainer = f.containers.get(id);
    sameContainer.startedAt = "2026-10-24T00:02:00.123456789Z";
    sameContainer.finishedAt = "2026-10-24T00:03:00.123456789Z";
    sameContainer.restartCount = 1;
    expect(retire(f, p)).toMatchObject({
      status: "refused",
      outcomes: [
        { status: "refused", containerRemoved: false, volumesPreserved: null },
      ],
    });
    expect(f.containers.get(id)).toBe(sameContainer);
    expect(f.volumes.get("retained-data")).toEqual(beforeVolume);
    expect(f.calls.some((args) => args.includes("rm"))).toBe(false);
    expect(plan(f).consentDigest).not.toBe(p.consentDigest);
  });
  it.each(["startedAt", "finishedAt", "restartCount"])(
    "binds exact %s independently to consent",
    (field) => {
      const f = fixture(),
        p = plan(f);
      f.containers.get(id)[field] =
        field === "restartCount" ? 1 : "2026-10-24T00:01:00.123456788Z";
      expect(retire(f, p).status).toBe("refused");
      expect(f.containers.has(id)).toBe(true);
      expect(f.calls.some((args) => args.includes("rm"))).toBe(false);
    },
  );
  it("accepts Docker unstarted timestamps exactly without treating age as completion", () => {
    const f = fixture(),
      c = f.containers.get(id);
    c.state = "created";
    c.startedAt = "0001-01-01T00:00:00Z";
    c.finishedAt = "0001-01-01T00:00:00Z";
    const p = plan(f);
    expect(p.snapshots[0]).toMatchObject({
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      restartCount: 0,
    });
    expect(retire(f, p).status).toBe("completed");
  });
  it.each([
    undefined,
    null,
    "",
    42,
    "unknown",
    "2026-02-30T00:00:00Z",
    "2026-10-24T24:00:00Z",
    "2026-10-24T00:00:00.1234567890Z",
    "x".repeat(1024),
  ])("refuses unknown or invalid lifecycle timestamp %s", (value) => {
    for (const field of ["startedAt", "finishedAt"]) {
      const f = fixture();
      f.containers.get(id)[field] = value;
      expect(() => plan(f)).toThrow(/refused/u);
      expect(f.calls.some((args) => args.includes("rm"))).toBe(false);
    }
  });
  it.each([undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"])(
    "refuses unknown or unsafe restart count %s",
    (value) => {
      const f = fixture();
      f.containers.get(id).restartCount = value;
      expect(() => plan(f)).toThrow(/refused/u);
      expect(f.containers.has(id)).toBe(true);
    },
  );
});

describe("retirement scoped Docker client", () => {
  it("keeps an explicit existing config directory for every metadata and mutation probe", () => {
    vi.stubEnv("DOCKER_CONFIG", process.cwd());
    try {
      const f = fixture();
      const p = plan(f);
      expect(retire(f, p).status).toBe("completed");
      expect(f.environments.length).toBeGreaterThan(0);
      expect(
        f.environments.every(
          (env) =>
            env.DOCKER_CONFIG && !env.DOCKER_CONTEXT && !env.DOCKER_TLS_VERIFY,
        ),
      ).toBe(true);
      expect(new Set(f.environments.map((env) => env.DOCKER_CONFIG)).size).toBe(
        1,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
