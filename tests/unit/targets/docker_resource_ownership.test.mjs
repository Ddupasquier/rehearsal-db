import { describe, expect, it, vi } from "vitest";
import {
  assertDockerResourceLabels,
  assertOwnedSupabaseResourceInspection,
  createPostgresqlResourceOwnership,
} from "../../../dist/src/targets/docker_resource_ownership.mjs";

describe("Docker resource ownership labels", () => {
  it("accepts only the exact expected provider/project ownership", () => {
    expect(() =>
      assertDockerResourceLabels({
        labels: {
          "com.supabase.cli.project": "safe",
          "unrelated.label": "value",
        },
        expectedLabel: "com.supabase.cli.project",
        projectId: "safe",
      }),
    ).not.toThrow();
    for (const labels of [
      null,
      [],
      {},
      { "com.supabase.cli.project": "foreign" },
      {
        "com.supabase.cli.project": "safe",
        "com.rehearsal-db.project": "foreign",
      },
    ]) {
      expect(() =>
        assertDockerResourceLabels({
          labels,
          expectedLabel: "com.supabase.cli.project",
          projectId: "safe",
        }),
      ).toThrow("ownership");
    }
  });
  it("refuses missing, truncated, malformed and conflicting inspection before mutation", () => {
    const output = JSON.stringify({ "com.supabase.cli.project": "safe" });
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output: `${output}\n${output}\n`,
        count: 2,
        projectId: "safe",
      }),
    ).not.toThrow();
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output,
        count: 2,
        projectId: "safe",
      }),
    ).toThrow("incomplete");
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output: "not-json",
        count: 1,
        projectId: "safe",
      }),
    ).toThrow("malformed");
    expect(() =>
      assertOwnedSupabaseResourceInspection({
        output: JSON.stringify({
          "com.supabase.cli.project": "safe",
          "com.rehearsal-db.project": "foreign",
        }),
        count: 1,
        projectId: "safe",
      }),
    ).toThrow("conflicting");
  });
});

const provider = () => {
  const projectId = "owned-project",
    container = projectId + "-postgresql",
    volume = container + "-data",
    calls = [],
    labels = { "com.rehearsal-db.project": projectId };
  const state = {
    identity: "bound-local-engine",
    error: null,
    failInspect: false,
    inventoryFailure: false,
    inventory: undefined,
    container: {
      name: "/" + container,
      id: "a".repeat(64),
      labels: { ...labels },
    },
    volume: {
      name: volume,
      createdAt: "2026-10-24T00:00:00Z",
      driver: "local",
      labels: { ...labels },
    },
    before: null,
    afterCreate: null,
  };
  const run = (args) => {
    calls.push([...args]);
    state.before?.(args);
    const kind = args[0],
      operation = args[1];
    if (operation === "inspect") {
      if (state.failInspect || !state[kind])
        return {
          status: 1,
          stdout: "PRIVATE_PROVIDER_OUTPUT",
          error: state.error,
        };
      return { status: 0, stdout: JSON.stringify(state[kind]) };
    }
    if (operation === "ls")
      return {
        status: state.inventoryFailure ? 1 : 0,
        stdout:
          state.inventory ??
          (kind === "volume"
            ? state.volume
              ? volume + "\n"
              : ""
            : state.container
              ? state.container.id + "\t" + container + "\n"
              : ""),
      };
    if (operation === "rm") {
      if (kind === "container") expect(args.at(-1)).toBe(state.container.id);
      else expect(args.at(-1)).toBe(volume);
      state[kind] = null;
      return { status: 0, stdout: args.at(-1) + "\n" };
    }
    if (kind === "volume" && operation === "create") {
      state.volume = {
        name: volume,
        createdAt: "2026-11-03T00:00:00Z",
        driver: "local",
        labels: { ...labels },
      };
      state.afterCreate?.();
      return { status: 0, stdout: volume + "\n" };
    }
    throw Error("Unexpected synthetic provider command");
  };
  return {
    container,
    volume,
    state,
    calls,
    ownership: createPostgresqlResourceOwnership({
      projectId,
      run,
      engineIdentity: () => state.identity,
    }),
  };
};

describe("PostgreSQL owned-resource provider adapter", () => {
  it("refuses an unsupported resource kind without contacting its provider", () => {
    const p = provider();
    expect(() => p.ownership.inspect("image", "anything")).toThrow(
      /unverified/,
    );
    expect(p.calls).toEqual([]);
  });
  it.each(["bad-id", "duplicate-id", "malformed-inspect"])(
    "refuses %s provider metadata without copying provider text",
    (mode) => {
      const p = provider();
      if (mode === "malformed-inspect")
        p.state.volume.rawProvider = "PRIVATE_PROVIDER_OUTPUT";
      else {
        p.state.container = null;
        p.state.inventory =
          mode === "bad-id"
            ? "invalid-id\tother\n"
            : "a".repeat(64) + "\tother\n" + "a".repeat(64) + "\tthird\n";
      }
      let failure;
      try {
        p.ownership.inspect(
          mode === "malformed-inspect" ? "volume" : "container",
          mode === "malformed-inspect" ? p.volume : p.container,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeTruthy();
      expect(String(failure)).not.toContain("PRIVATE");
      expect(p.calls.some((args) => ["rm", "create"].includes(args[1]))).toBe(
        false,
      );
    },
  );
  it.each(["container", "volume"])(
    "does not turn failed %s inspection of a still-listed resource into absence",
    (kind) => {
      const p = provider();
      p.state.failInspect = true;
      expect(() => p.ownership.inspect(kind, p[kind])).toThrow(/unverified/);
      expect(p.calls.some((args) => ["rm", "create"].includes(args[1]))).toBe(
        false,
      );
    },
  );
  it.each(["container", "volume"])(
    "accepts %s absence only from a successful complete bounded listing",
    (kind) => {
      const p = provider();
      p.state[kind] = null;
      expect(p.ownership.inspect(kind, p[kind])).toBeNull();
      expect(p.calls.at(-1)[1]).toBe("ls");
    },
  );
  it.each([
    "failed",
    "malformed",
    "duplicates",
    "blank-row",
    "oversize",
    "too-many",
    "process-error",
  ])(
    "refuses %s inventory/inspection without mutation or private provider output",
    (mode) => {
      const p = provider();
      p.state.volume = null;
      if (mode === "failed") p.state.inventoryFailure = true;
      if (mode === "malformed") p.state.inventory = "unsafe/private/path\n";
      if (mode === "duplicates") p.state.inventory = "other\nother\n";
      if (mode === "blank-row") p.state.inventory = "other\n\nnext\n";
      if (mode === "oversize") p.state.inventory = "x".repeat(1024 * 1024 + 1);
      if (mode === "too-many")
        p.state.inventory = Array.from(
          { length: 10001 },
          (_, i) => "v" + i,
        ).join("\n");
      if (mode === "process-error")
        p.state.error = Error("PRIVATE_PROCESS_ERROR");
      let failure;
      try {
        p.ownership.inspect("volume", p.volume);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeTruthy();
      expect(String(failure)).not.toContain("PRIVATE");
      expect(p.calls.some((args) => ["rm", "create"].includes(args[1]))).toBe(
        false,
      );
    },
  );
  it.each(["foreign", "conflict", "malformed", "engine-change"])(
    "refuses %s ownership/engine evidence before removal",
    (mode) => {
      const p = provider(),
        owned = p.ownership.inspect("volume", p.volume);
      if (mode === "foreign")
        p.state.volume.labels = { "com.rehearsal-db.project": "other" };
      if (mode === "conflict")
        p.state.volume.labels["com.supabase.cli.project"] = "other";
      if (mode === "malformed") p.state.volume.labels = null;
      if (mode === "engine-change") p.state.identity = "replacement-engine";
      expect(() => p.ownership.remove(owned)).toThrow(/unverified/);
      expect(p.calls.some((args) => args[1] === "rm")).toBe(false);
    },
  );
  it("refuses changed engine during inspection rather than adopting a new empty inventory", () => {
    const p = provider();
    p.state.volume = null;
    p.state.before = (args) => {
      if (args[1] === "ls") p.state.identity = "replacement-engine";
    };
    expect(() => p.ownership.inspect("volume", p.volume)).toThrow(/unverified/);
  });
  it.each(["container", "volume"])(
    "refuses a replaced %s identity before removing it",
    (kind) => {
      const p = provider(),
        owned = p.ownership.inspect(kind, p[kind]);
      if (kind === "container") p.state.container.id = "b".repeat(64);
      else p.state.volume.createdAt = "2026-11-02T00:00:00Z";
      expect(() => p.ownership.remove(owned)).toThrow(/unverified/);
      expect(p.calls.some((args) => args[1] === "rm")).toBe(false);
    },
  );
  it("preserves explicit owned reset replacement and confirms removal before fresh creation", () => {
    const p = provider(),
      c = p.ownership.inspect("container", p.container),
      v = p.ownership.inspect("volume", p.volume);
    p.ownership.remove(c);
    p.ownership.remove(v);
    const fresh = p.ownership.createVolume(p.volume);
    p.ownership.assertUnchanged(fresh);
    expect(fresh.createdAt).toBe("2026-11-03T00:00:00Z");
    expect(
      p.calls.filter((args) => args[1] === "rm").map((args) => args[0]),
    ).toEqual(["container", "volume"]);
    expect(p.calls.filter((args) => args[1] === "create")).toHaveLength(1);
  });
  it.each([
    "foreign-create-race",
    "replacement-before-mount",
    "engine-before-mount",
    "preexisting-owned",
  ])("refuses %s before a caller can mount/reuse data", (mode) => {
    const p = provider(),
      mount = vi.fn();
    if (mode !== "preexisting-owned") p.state.volume = null;
    if (mode === "foreign-create-race")
      p.state.afterCreate = () => {
        p.state.volume.labels = { "com.rehearsal-db.project": "foreign" };
      };
    expect(() => {
      const fresh = p.ownership.createVolume(p.volume);
      if (mode === "replacement-before-mount")
        p.state.volume.createdAt = "2026-11-04T00:00:00Z";
      if (mode === "engine-before-mount")
        p.state.identity = "replacement-engine";
      p.ownership.assertUnchanged(fresh);
      mount();
    }).toThrow(/unverified/);
    expect(mount).not.toHaveBeenCalled();
    expect(p.calls.some((args) => args[1] === "rm")).toBe(false);
  });
});
