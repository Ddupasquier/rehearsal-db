import { describe, expect, it } from "vitest";
import {
  evaluateWorkloadCapacity,
  inspectWorkloadCapacity,
  parseLinuxAvailableMemory,
  parseMacosAvailableMemory,
  parseEngineAvailableMemory,
  parseStandingContainerMemory,
} from "../../../dist/src/runtime/workload_capacity.mjs";

const GiB = 1024 ** 3;
const id = "a".repeat(64);
const policy = {
  enabled: true,
  hostReserveBytes: GiB,
  engineReserveBytes: GiB,
  maximumRunningContainers: 30,
  targetMemoryBytes: {
    postgresql: GiB,
    supabaseApplication: 2 * GiB,
    supabaseFull: 4 * GiB,
  },
};
const target = (provider = "postgresql", profile) => ({
  config: {
    runtime: { target: provider },
    ...(provider === "supabase"
      ? { supabase: { serviceProfile: profile } }
      : {}),
  },
});
const snapshot = () => ({
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  host: {
    measuredAvailableBytes: 12 * GiB,
    measurement: "linux-memavailable",
    pressure: "not-measured",
  },
  engine: {
    context: "local",
    identity: "b".repeat(64),
    daemonId: "fixture-engine",
    totalBytes: 16 * GiB,
    measuredAvailableBytes: 12 * GiB,
    runningContainers: 2,
    standingContainerMemoryBytes: GiB,
    measurement: "colima-memavailable",
  },
});

describe("cooperative measured workload headroom", () => {
  it("includes the fixed isolated Knex worker in selected memory/container demand", () => {
    const selected = target();
    selected.config.postgresql = { migrationTool: { kind: "knex" } };
    expect(
      evaluateWorkloadCapacity({
        policy,
        targets: [selected],
        snapshot: snapshot(),
      }),
    ).toMatchObject({
      requiredMemoryBytes: GiB + 268435456,
      requiredContainers: 2,
    });
    const measured = snapshot();
    measured.engine.measuredAvailableBytes = 2 * GiB;
    expect(() =>
      evaluateWorkloadCapacity({
        policy,
        targets: [selected],
        snapshot: measured,
      }),
    ).toThrow(/reserve/);
  });
  it("adds selected demand to all standing workload usage without claiming a hard scheduler", () => {
    const result = evaluateWorkloadCapacity({
      policy,
      targets: [
        target(),
        target("supabase", "application"),
        target("supabase", "full"),
      ],
      snapshot: snapshot(),
    });
    expect(result).toMatchObject({
      decision: "admitted",
      scope: "cooperative-measured-headroom",
      requiredMemoryBytes: 7 * GiB,
      requiredContainers: 20,
    });
    expect(result.limitations.join(" ")).toContain("Unrelated tools");
  });
  it("refuses insufficient host, engine or standing-container headroom and missing measurements", () => {
    const base = snapshot();
    for (const sample of [
      { ...base, host: { ...base.host, measuredAvailableBytes: GiB } },
      { ...base, engine: { ...base.engine, measuredAvailableBytes: GiB } },
      { ...base, engine: { ...base.engine, runningContainers: 30 } },
      { ...base, engine: { ...base.engine, totalBytes: NaN } },
      { ...base, engine: { ...base.engine, measuredAvailableBytes: 17 * GiB } },
      {
        ...base,
        engine: { ...base.engine, standingContainerMemoryBytes: 17 * GiB },
      },
      { ...base, engine: { ...base.engine, runningContainers: null } },
      { ...base, host: { ...base.host, measuredAvailableBytes: null } },
      { ...base, engine: null },
      { ...base, measuredAt: "invalid" },
      { ...base, measuredAt: new Date(Date.now() - 60_000).toISOString() },
      {
        ...base,
        host: {
          ...base.host,
          measurement: "macos-free-speculative",
          pressure: "elevated",
        },
      },
    ])
      expect(() =>
        evaluateWorkloadCapacity({
          policy,
          targets: [target()],
          snapshot: sample,
        }),
      ).toThrow();
    expect(() =>
      evaluateWorkloadCapacity({
        policy,
        targets: [target("supabase", "unknown")],
        snapshot: base,
      }),
    ).toThrow("profile");
    expect(() =>
      evaluateWorkloadCapacity({ policy, targets: [], snapshot: base }),
    ).toThrow("empty");
  });
  it("accepts exact reserve boundaries and refuses missing reviewed budgets", () => {
    const sample = snapshot();
    sample.host.measuredAvailableBytes = 2 * GiB;
    sample.engine.measuredAvailableBytes = 2 * GiB;
    expect(
      evaluateWorkloadCapacity({
        policy,
        targets: [target()],
        snapshot: sample,
      }).decision,
    ).toBe("admitted");
    expect(() =>
      evaluateWorkloadCapacity({
        policy: { enabled: true },
        targets: [target()],
        snapshot: sample,
      }),
    ).toThrow("budgets");
  });
});

describe("capacity measurement parsers", () => {
  it("uses MemAvailable on Linux and only free plus speculative macOS pages", () => {
    expect(
      parseLinuxAvailableMemory("MemFree: 10 kB\nMemAvailable: 200 kB\n"),
    ).toBe(204800);
    expect(parseLinuxAvailableMemory("MemFree: 100 kB\n")).toBeNull();
    expect(
      parseLinuxAvailableMemory("MemAvailable: 10 kB\nMemAvailable: 20 kB\n"),
    ).toBeNull();
    expect(
      parseMacosAvailableMemory(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages speculative: 20.\nPages inactive: 999999.\nPages occupied by compressor: 999999.\n",
      ),
    ).toBe(120 * 16384);
    expect(parseMacosAvailableMemory("Pages free: 100.\n")).toBeNull();
  });
  it("requires a real available column and a finite complete per-container sample", () => {
    expect(
      parseEngineAvailableMemory(
        " total used free shared buff/cache available\nMem: 1000 100 100 0 800 900\n",
      ),
    ).toEqual({ totalBytes: 1000, measuredAvailableBytes: 900 });
    expect(
      parseEngineAvailableMemory("Mem: 1000 100 100 0 800 900\n"),
    ).toBeNull();
    expect(
      parseEngineAvailableMemory(
        "total available\nMem: 1000 100 100 0 800 1001\n",
      ),
    ).toBeNull();
    expect(
      parseStandingContainerMemory(
        JSON.stringify({ id, memory: "1.5MiB / 2GiB" }),
        [id],
      ),
    ).toBe(1.5 * 1024 ** 2);
    expect(parseStandingContainerMemory("", [])).toBe(0);
    for (const [text, ids] of [
      ["", [id]],
      [JSON.stringify({ id: "b".repeat(64), memory: "1MiB / 2GiB" }), [id]],
      [JSON.stringify({ id, memory: "unknown / 2GiB" }), [id]],
      [JSON.stringify({ id, memory: "3GiB / 2GiB" }), [id]],
      [JSON.stringify({ id, memory: "1MiB / 2GiB" }), [id, id]],
    ])
      expect(parseStandingContainerMemory(text, ids)).toBeNull();
  });
});

const probes = ({
  platform = "linux",
  context = "colima",
  endpoint = "unix:///fixture-home/.colima/default/docker.sock",
  kernel = "fixture-kernel",
  count = 1,
  mutate = () => undefined,
} = {}) => {
  const calls = [];
  const info = {
    id: "fixture-engine",
    memoryBytes: 16 * GiB,
    runningContainers: count,
    kernel,
  };
  const runner = (command, args) => {
    calls.push({ command, args });
    const result = { status: 0, stdout: "", stderr: "" };
    if (command === "/usr/sbin/sysctl") result.stdout = "1\n";
    else if (command === "/usr/bin/vm_stat")
      result.stdout =
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 2000000.\nPages speculative: 1000000.\n";
    else if (command === "colima" && args.includes("docker"))
      result.stdout = info.id + "\n";
    else if (command === "colima")
      result.stdout = `total used free shared buff/cache available\nMem: ${16 * GiB} ${GiB} ${GiB} 0 ${14 * GiB} ${12 * GiB}\n`;
    else if (args[0] === "context" && args[1] === "show")
      result.stdout = context;
    else if (args[0] === "context" && args[1] === "inspect")
      result.stdout = args.includes(
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
      )
        ? "false"
        : JSON.stringify(endpoint);
    else if (args.includes("info")) result.stdout = JSON.stringify(info);
    else if (args.includes("stats"))
      result.stdout = JSON.stringify({ id, memory: "1GiB / 16GiB" });
    else if (args.includes("ps")) result.stdout = count === 0 ? "" : id + "\n";
    else throw new Error("Unexpected probe");
    mutate(command, args, result, calls);
    return result;
  };
  return {
    calls,
    options: {
      projectRoot: "/fixture",
      runner,
      platform,
      kernelRelease: "fixture-kernel",
      home: "/fixture-home",
      readText: async () => `MemAvailable: ${(12 * GiB) / 1024} kB\n`,
    },
  };
};

describe("bounded local capacity probes", () => {
  it("refuses native Linux despite matching kernel and ample host memory", async () => {
    for (const count of [0, 1]) {
      const p = probes({
        count,
        context: "local",
        endpoint: "unix:///var/run/docker.sock",
      });
      await expect(inspectWorkloadCapacity(p.options)).rejects.toThrow(
        "namespace/cgroup memory domain",
      );
      expect(p.calls.some((c) => c.command === "colima")).toBe(false);
      expect(
        p.calls.every(
          (c) =>
            !c.args.some((a) =>
              ["run", "start", "stop", "rm", "exec"].includes(a),
            ),
        ),
      ).toBe(true);
    }
  });
  it("uses Linux host memory only alongside the independently selected Colima profile", async () => {
    const p = probes();
    const value = await inspectWorkloadCapacity(p.options);
    expect(value.host.measurement).toBe("linux-memavailable");
    expect(value.engine).toMatchObject({
      daemonId: "fixture-engine",
      measurement: "colima-memavailable",
    });
    expect(p.calls.some((c) => c.command === "colima")).toBe(true);
  });
  it("binds macOS measurement to the exact Colima profile socket and real VM available bytes", async () => {
    const p = probes({
      platform: "darwin",
      context: "colima-owned",
      endpoint: "unix:///fixture-home/.colima/owned/docker.sock",
      kernel: "virtual-kernel",
    });
    const value = await inspectWorkloadCapacity(p.options);
    expect(value.host.measurement).toBe("macos-free-speculative");
    expect(value.engine.measurement).toBe("colima-memavailable");
    expect(
      p.calls.find((c) => c.command === "colima" && c.args.includes("free"))
        .args,
    ).toEqual(["--profile", "owned", "ssh", "--", "free", "-b"]);
  });
  it("requires the exact guest daemon before and after memory measurement", async () => {
    const good = probes();
    await inspectWorkloadCapacity(good.options);
    expect(
      good.calls.filter(
        (c) => c.command === "colima" && c.args.includes("docker"),
      ),
    ).toHaveLength(2);
    for (const scenario of [
      "wrong",
      "missing",
      "failed",
      "changed-after-free",
    ]) {
      let reads = 0;
      const p = probes({
        mutate: (command, args, result) => {
          if (command !== "colima" || !args.includes("docker")) return;
          reads++;
          if (
            scenario === "wrong" ||
            (scenario === "changed-after-free" && reads === 2)
          )
            result.stdout = "other-daemon\n";
          if (scenario === "missing") result.stdout = "";
          if (scenario === "failed") result.status = 1;
        },
      });
      await expect(inspectWorkloadCapacity(p.options)).rejects.toThrow();
      expect(
        p.calls.every(
          (c) =>
            !c.args.some((a) =>
              ["run", "start", "stop", "rm", "exec"].includes(a),
            ),
        ),
      ).toBe(true);
    }
  });
  it("refuses unsupported or unverifiable engine/host measurements without leaking probe output", async () => {
    for (const options of [
      {
        kernel: "different-kernel",
        context: "local",
        endpoint: "unix:///var/run/docker.sock",
      },
      {
        platform: "darwin",
        context: "colima",
        endpoint: "unix:///wrong/docker.sock",
      },
      {
        mutate: (command, args, r) => {
          if (args.includes("stats")) r.stdout = "";
        },
      },
      {
        mutate: (command, args, r) => {
          if (args.includes("stats")) r.stdout = "SECRET_CANARY";
        },
      },
      {
        mutate: (command, args, r) => {
          if (args.includes("info"))
            r.stdout = JSON.stringify({ memoryBytes: 1, runningContainers: 0 });
        },
      },
      {
        platform: "darwin",
        mutate: (command, args, r) => {
          if (command === "/usr/sbin/sysctl") r.stdout = "2";
        },
      },
    ]) {
      const p = probes(options);
      await expect(inspectWorkloadCapacity(p.options)).rejects.toThrow();
      await expect(inspectWorkloadCapacity(p.options)).rejects.not.toThrow(
        "SECRET_CANARY",
      );
    }
  });
  it("refuses a changing running-container inventory instead of admitting on a stale sample", async () => {
    let seen = 0;
    const p = probes({
      mutate: (command, args, r) => {
        if (args.includes("ps") && ++seen > 1) r.stdout = "b".repeat(64) + "\n";
      },
    });
    await expect(inspectWorkloadCapacity(p.options)).rejects.toThrow("changed");
  });
  it("refuses a changed endpoint before any runtime action can start", async () => {
    let inspections = 0;
    const p = probes({
      mutate: (command, args, result) => {
        if (
          args[0] === "context" &&
          args[1] === "inspect" &&
          !args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          ) &&
          ++inspections > 1
        )
          result.stdout = JSON.stringify("unix:///changed/docker.sock");
      },
    });
    await expect(inspectWorkloadCapacity(p.options)).rejects.toThrow("changed");
    expect(
      p.calls.every(
        (call) =>
          !call.args.some((arg) =>
            ["run", "start", "stop", "rm", "exec"].includes(arg),
          ),
      ),
    ).toBe(true);
  });
});
