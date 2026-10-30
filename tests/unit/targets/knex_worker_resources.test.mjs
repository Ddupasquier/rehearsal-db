import { expect, it } from "vitest";
import { assertKnexWorkerIsolation } from "../../../dist/src/targets/knex_worker_resources.mjs";
const expected = {
  fullId: "a".repeat(64),
  imageId: "sha256:" + "b".repeat(64),
  labels: {
    "com.rehearsal-db.project": "test",
    "com.rehearsal-db.worker": "knex",
    "com.rehearsal-db.worker-token": "owned",
  },
  mounts: ["inputs", "sdk", "runner"].map((x) => ({
    source: "/external/private/" + x,
    destination: "/" + x,
  })),
};
const fixture = () => ({
  Id: expected.fullId,
  Image: expected.imageId,
  Config: {
    User: "65532:65532",
    Tty: false,
    OpenStdin: true,
    Labels: { ...expected.labels },
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
  Mounts: expected.mounts.map((m) => ({
    Type: "bind",
    Source: m.source,
    Destination: m.destination,
    RW: false,
    Propagation: "rprivate",
  })),
  State: { Running: true, Status: "running" },
});
it("accepts only the observed exact owned readonly worker and optional Docker tmpfs projection", () => {
  const value = fixture();
  expect(assertKnexWorkerIsolation(value, expected).State.Running).toBe(true);
  value.Mounts.push({ Type: "tmpfs", Destination: "/tmp" });
  expect(() => assertKnexWorkerIsolation(value, expected)).not.toThrow();
});
it.each([
  ["NetworkMode", "bridge"],
  ["ReadonlyRootfs", false],
  ["Privileged", true],
  ["PublishAllPorts", true],
  ["PidMode", "host"],
  ["IpcMode", "host"],
  ["CgroupnsMode", "host"],
  ["Memory", 0],
  ["MemorySwap", 0],
  ["PidsLimit", 0],
  ["LogConfig", { Type: "json-file" }],
  ["CapAdd", ["SYS_ADMIN"]],
  ["Devices", [{}]],
  ["SecurityOpt", ["no-new-privileges", "seccomp=unconfined"]],
])("refuses actual isolation drift %s", (key, value) => {
  const f = fixture();
  f.HostConfig[key] = value;
  expect(() => assertKnexWorkerIsolation(f, expected)).toThrow(/unverified/);
});
it("refuses foreign image/token and writable/extra host mounts", () => {
  for (const mutate of [
    (f) => (f.Image = "foreign"),
    (f) => (f.Config.Labels["com.rehearsal-db.worker-token"] = "foreign"),
    (f) => (f.Mounts[0].RW = true),
    (f) =>
      f.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/docker.sock",
        RW: false,
        Propagation: "rprivate",
      }),
    (f) => (f.Config.User = "0"),
    (f) => (f.Config.Cmd = ["unknown"]),
  ]) {
    const f = fixture();
    mutate(f);
    expect(() => assertKnexWorkerIsolation(f, expected)).toThrow();
  }
});
