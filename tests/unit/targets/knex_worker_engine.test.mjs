import { expect, it, vi, afterEach } from "vitest";
const state = vi.hoisted(() => ({
  calls: [],
  selections: [],
  missing: false,
  worker: false,
  remote: false,
  capabilities: null,
}));
vi.mock("../../../dist/src/runtime/local_docker_context.mjs", () => ({
  assertLocalDockerContext: (options) => {
    state.selections.push(options);
    if (state.remote) throw Error("Remote refused");
    return {
      context: "private",
      endpoint: "unix:///external/owned/docker.sock",
      dockerConfig: "/external/owned/docker-config",
    };
  },
  runtimeDockerEnvironment: () => ({
    DOCKER_CONFIG: "/external/owned/docker-config",
    DOCKER_HOST: "unix:///external/owned/docker.sock",
  }),
  runtimeDockerContext: () => "private",
  scopedDockerEnvironment: () => ({
    DOCKER_CONFIG: "/external/owned/docker-config",
    DOCKER_HOST: "unix:///external/owned/docker.sock",
  }),
}));
vi.mock("node:child_process", () => ({
  spawnSync: (command, args, options) => {
    state.calls.push({ command, args, env: options.env });
    let stdout = "",
      status = 0;
    const tail = args.slice(2);
    if (tail.join(" ") === "info --format {{.ID}}") stdout = "owned-daemon";
    else if (tail.join(" ") === "info --format {{json .}}")
      stdout = JSON.stringify(
        state.capabilities ?? {
          ID: "owned-daemon",
          OSType: "linux",
          Architecture: "aarch64",
          MemoryLimit: true,
          SwapLimit: true,
          PidsLimit: true,
          CpuCfsQuota: true,
          SecurityOptions: ["name=seccomp,profile=builtin"],
        },
      );
    else if (tail[0] === "ps") stdout = state.worker ? "a".repeat(64) : "";
    else if (tail[0] === "image" && tail[1] === "inspect") {
      status = state.missing ? 1 : 0;
      stdout = JSON.stringify([
        {
          Architecture: "arm64",
          Os: "linux",
          Id: "sha256:683727a317323c89635f1c9584c722c91dbfa0741cbfb9e2468162867aaf31f7",
          Config: { Env: ["NODE_VERSION=24.21.0"] },
        },
      ]);
    } else throw Error("Unallowlisted Docker call");
    return {
      status,
      stdout,
      stderr: "PRIVATE_PROVIDER_CANARY",
      error: undefined,
    };
  },
}));
import { inspectKnexWorkerEngine } from "../../../dist/src/targets/knex_worker_engine.mjs";
afterEach(() => {
  state.calls = [];
  state.selections = [];
  state.missing = state.worker = state.remote = false;
  state.capabilities = null;
});
it("pins all preflight probes to exact local endpoint/config and makes no mutation", () => {
  const result = inspectKnexWorkerEngine({
    cwd: "/external/project",
    projectId: "test-project",
  });
  expect(result.imageId).toBe(
    "sha256:683727a317323c89635f1c9584c722c91dbfa0741cbfb9e2468162867aaf31f7",
  );
  expect(
    state.selections.every(
      (s) =>
        s.context === "private" &&
        s.inheritedEnvironment.DOCKER_CONFIG ===
          "/external/owned/docker-config",
    ),
  ).toBe(true);
  for (const call of state.calls) {
    expect(call.args.slice(0, 2)).toEqual([
      "--host",
      "unix:///external/owned/docker.sock",
    ]);
    expect(call.env.DOCKER_CONFIG).toBe("/external/owned/docker-config");
    expect(["info", "ps", "image"]).toContain(call.args[2]);
  }
});
it("missing image and existing owned worker refuse without role/data/container mutations", () => {
  state.missing = true;
  expect(() =>
    inspectKnexWorkerEngine({
      cwd: "/external/project",
      projectId: "test-project",
    }),
  ).toThrow(/no runtime data/);
  expect(JSON.stringify(state.calls)).not.toContain("PRIVATE_PROVIDER_CANARY");
  state.missing = false;
  state.worker = true;
  expect(() =>
    inspectKnexWorkerEngine({
      cwd: "/external/project",
      projectId: "test-project",
    }),
  ).toThrow(/prior project Knex worker/);
  expect(
    state.calls.every(
      (c) =>
        !["create", "run", "start", "rm", "pull", "exec"].includes(c.args[2]),
    ),
  ).toBe(true);
});
it("remote selection refuses before daemon/image calls", () => {
  state.remote = true;
  expect(() => inspectKnexWorkerEngine({ cwd: "/external/project" })).toThrow(
    /Remote/,
  );
  expect(state.calls).toEqual([]);
});
it("unknown enforcement or unsupported daemon refuses instead of executing on host", () => {
  state.capabilities = {
    ID: "owned-daemon",
    OSType: "windows",
    Architecture: "aarch64",
    MemoryLimit: true,
  };
  expect(() => inspectKnexWorkerEngine({ cwd: "/external/project" })).toThrow();
  expect(state.calls.every((c) => c.args[2] === "info")).toBe(true);
});
