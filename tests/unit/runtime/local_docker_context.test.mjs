import { describe, it, expect } from "vitest";
import {
  isLocalDockerEndpoint,
  assertLocalDockerContext,
  bindRuntimeDockerEnvironment,
  runtimeDockerEnvironment,
  scopedDockerEnvironment,
  DOCKER_CONTEXT_TLS_FORMAT,
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
        stdout: args.includes(DOCKER_CONTEXT_TLS_FORMAT)
          ? "false"
          : args[1] === "show"
            ? "colima\n"
            : JSON.stringify("unix:///tmp/local-docker.sock"),
      };
    };
    expect(
      assertLocalDockerContext({ runner, inheritedEnvironment: {} }),
    ).toMatchObject({
      context: "colima",
      identity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(calls).toHaveLength(3);
    expect(() =>
      assertLocalDockerContext({
        inheritedEnvironment: {},
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
        stdout: args.includes(DOCKER_CONTEXT_TLS_FORMAT)
          ? "false"
          : JSON.stringify("unix:///tmp/pinned-docker.sock"),
      };
    };
    const identity = assertLocalDockerContext({
      runner,
      inheritedEnvironment: {},
      context: "reviewed-local",
    });
    const bound = bindRuntimeDockerEnvironment({
      runner,
      inheritedEnvironment: {},
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
        inheritedEnvironment: {},
        context: "reviewed-local",
        expectedIdentity: "a".repeat(64),
      }),
    ).toThrow("changed");
    expect(() =>
      bindRuntimeDockerEnvironment({
        inheritedEnvironment: {},
        runner: (_command, args) => ({
          status: 0,
          stdout: args.includes(DOCKER_CONTEXT_TLS_FORMAT)
            ? "false"
            : JSON.stringify("unix:///tmp/changed-docker.sock"),
        }),
        context: "reviewed-local",
      }),
    ).toThrow("already bound");
  });
  it("refuses a replacement daemon at the same admitted context and socket", () => {
    const calls = [];
    let daemonId = "admitted-daemon";
    const runner = (_command, args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: args.includes(DOCKER_CONTEXT_TLS_FORMAT)
          ? "false"
          : JSON.stringify(
              args.includes("info")
                ? daemonId
                : "unix:///tmp/pinned-docker.sock",
            ),
      };
    };
    const local = assertLocalDockerContext({
      runner,
      inheritedEnvironment: {},
      context: "reviewed-local",
    });
    expect(() =>
      bindRuntimeDockerEnvironment({
        runner,
        inheritedEnvironment: {},
        context: "reviewed-local",
        expectedIdentity: local.identity,
        expectedDaemonId: daemonId,
      }),
    ).not.toThrow();
    daemonId = "replacement-daemon";
    expect(() =>
      bindRuntimeDockerEnvironment({
        runner,
        inheritedEnvironment: {},
        context: "reviewed-local",
        expectedIdentity: local.identity,
        expectedDaemonId: "admitted-daemon",
      }),
    ).toThrow("capacity-admitted Docker daemon changed");
    expect(calls.filter((args) => args.includes("info"))).toHaveLength(2);
    expect(
      calls.every(
        (args) =>
          !args.some((arg) => ["start", "run", "stop", "rm"].includes(arg)),
      ),
    ).toBe(true);
    expect(() =>
      bindRuntimeDockerEnvironment({
        runner,
        inheritedEnvironment: {},
        context: "reviewed-local",
        expectedDaemonId: "bad\nidentity",
      }),
    ).toThrow("identity is invalid");
  });
});

const metadataRunner =
  (contexts, calls = []) =>
  (_command, args, _cwd, env) => {
    calls.push({ args, env });
    if (args[1] === "show") return { status: 0, stdout: "default" };
    if (args[1] === "ls")
      return { status: 0, stdout: Object.keys(contexts).join("\n") };
    if (args.includes(DOCKER_CONTEXT_TLS_FORMAT))
      return { status: 0, stdout: "false" };
    return { status: 0, stdout: JSON.stringify(contexts[args.at(-1)]) };
  };
describe("explicit Docker selection", () => {
  const contexts = {
    default: "unix:///tmp/default.sock",
    personal: "unix:///tmp/personal.sock",
  };
  it("honors context over host without leaking selectors or credentials", () => {
    const calls = [];
    const result = assertLocalDockerContext({
      runner: metadataRunner(contexts, calls),
      inheritedEnvironment: {
        DOCKER_CONTEXT: "personal",
        DOCKER_HOST: "ssh://ignored",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    });
    expect(result).toMatchObject({
      context: "personal",
      selectionSource: "explicit-context",
    });
    expect(
      calls.every(
        ({ args, env }) =>
          !args.includes("show") &&
          !env.DOCKER_CONTEXT &&
          !env.DOCKER_HOST &&
          !env.AWS_SECRET_ACCESS_KEY,
      ),
    ).toBe(true);
  });
  it("maps a local explicit host to exactly one actual named context", () => {
    expect(
      assertLocalDockerContext({
        runner: metadataRunner(contexts),
        inheritedEnvironment: { DOCKER_HOST: contexts.personal },
      }),
    ).toMatchObject({ context: "personal", selectionSource: "explicit-host" });
    for (const choices of [
      contexts,
      { ...contexts, duplicate: contexts.personal },
    ])
      expect(() =>
        assertLocalDockerContext({
          runner: metadataRunner(choices),
          inheritedEnvironment: {
            DOCKER_HOST: choices.duplicate
              ? contexts.personal
              : "unix:///tmp/unmapped.sock",
          },
        }),
      ).toThrow("unsupported or ambiguous");
  });
  it("refuses remote, malformed and TLS selectors before any metadata or daemon command", () => {
    for (const env of [
      { DOCKER_HOST: "ssh://remote" },
      { DOCKER_HOST: "https://localhost:2376" },
      { DOCKER_CONTEXT: "bad\ncontext" },
      { DOCKER_TLS_VERIFY: "1" },
      { DOCKER_CONFIG: "relative" },
    ]) {
      const calls = [];
      expect(() =>
        assertLocalDockerContext({
          runner: metadataRunner(contexts, calls),
          inheritedEnvironment: env,
        }),
      ).toThrow();
      expect(calls).toHaveLength(0);
    }
  });
  it("retains an existing scoped config directory in every clean metadata child", () => {
    const calls = [];
    const result = assertLocalDockerContext({
      runner: metadataRunner(contexts, calls),
      inheritedEnvironment: { DOCKER_CONFIG: process.cwd() },
    });
    expect(result.dockerConfig).toBeTruthy();
    expect(
      calls.every(({ env }) => env.DOCKER_CONFIG === result.dockerConfig),
    ).toBe(true);
    expect(
      scopedDockerEnvironment({
        inheritedEnvironment: { DOCKER_CONFIG: process.cwd() },
        endpoint: contexts.personal,
      }),
    ).toMatchObject({
      DOCKER_CONFIG: result.dockerConfig,
      DOCKER_HOST: contexts.personal,
    });
  });
  it("refuses TLS and unknown TLS metadata without daemon contact", () => {
    for (const tls of ["true", "unknown", ""]) {
      const calls = [];
      const base = metadataRunner(contexts, calls);
      expect(() =>
        assertLocalDockerContext({
          inheritedEnvironment: {},
          runner: (...args) =>
            args[1].includes(DOCKER_CONTEXT_TLS_FORMAT)
              ? { status: 0, stdout: tls }
              : base(...args),
        }),
      ).toThrow("TLS-backed or unknown");
      expect(calls.every(({ args }) => !args.includes("info"))).toBe(true);
    }
  });
  it("refuses reviewed context drift instead of falling back", () => {
    const calls = [];
    expect(() =>
      assertLocalDockerContext({
        context: "default",
        inheritedEnvironment: { DOCKER_CONTEXT: "personal" },
        runner: metadataRunner(contexts, calls),
      }),
    ).toThrow();
    expect(calls).toHaveLength(0);
  });
});
