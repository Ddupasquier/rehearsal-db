import { describe, it, expect } from "vitest";
import {
  isLocalDockerEndpoint,
  assertLocalDockerContext,
  bindRuntimeDockerEnvironment,
  runtimeDockerEnvironment,
} from "../../../dist/src/runtime/local_docker_context.mjs";
describe("local engine resource boundary", () => {
  it("accepts local sockets, local Windows pipes and loopback engines only", () => {
    for (const endpoint of [
      "unix:///var/run/docker.sock",
      "unix:///Users/example/.colima/default/docker.sock",
      "npipe:////./pipe/docker_engine",
      "tcp://127.0.0.1:2375",
      "tcp://[::1]:2375",
    ])
      expect(isLocalDockerEndpoint(endpoint)).toBe(true);
    for (const endpoint of [
      "ssh://production",
      "tcp://db.example.test:2376",
      "unix://remote/var/run/docker.sock",
      "npipe:////remote/pipe/docker_engine",
      "tcp://user:secret@localhost:2375",
      "tcp://localhost:2375?secret=key",
      undefined,
    ])
      expect(isLocalDockerEndpoint(endpoint)).toBe(false);
  });
  it("binds the cleanup engine identity to both context and endpoint and fails before any mutation", () => {
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, ...args]);
      return {
        status: 0,
        stdout:
          args[1] === "show"
            ? "colima\n"
            : JSON.stringify("unix:///tmp/local-docker.sock"),
      };
    };
    expect(assertLocalDockerContext({ runner })).toMatchObject({
      context: "colima",
      identity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(calls).toHaveLength(2);
    expect(() =>
      assertLocalDockerContext({
        runner: (_command, args) => ({
          status: 0,
          stdout:
            args[1] === "show" ? "remote" : JSON.stringify("ssh://production"),
        }),
      }),
    ).toThrow("Remote");
  });
  it("pins a reviewed endpoint explicitly instead of inheriting mutable context or hosted environment", () => {
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, ...args]);
      return {
        status: 0,
        stdout: JSON.stringify("unix:///tmp/pinned-docker.sock"),
      };
    };
    const identity = assertLocalDockerContext({
      runner,
      context: "reviewed-local",
    });
    const bound = bindRuntimeDockerEnvironment({
      runner,
      context: "reviewed-local",
      expectedIdentity: identity.identity,
    });
    expect(bound.endpoint).toBe("unix:///tmp/pinned-docker.sock");
    expect(runtimeDockerEnvironment()).toEqual({
      DOCKER_HOST: "unix:///tmp/pinned-docker.sock",
    });
    expect(calls.some(([, , action]) => action === "show")).toBe(false);
    expect(() =>
      bindRuntimeDockerEnvironment({
        runner,
        context: "reviewed-local",
        expectedIdentity: "a".repeat(64),
      }),
    ).toThrow("changed");
    expect(() =>
      bindRuntimeDockerEnvironment({
        runner: () => ({
          status: 0,
          stdout: JSON.stringify("unix:///tmp/changed-docker.sock"),
        }),
        context: "reviewed-local",
      }),
    ).toThrow("already bound");
  });
});
