import { afterEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execute,
}));

import { probeContainerEngineWithoutStarting } from "../../../dist/src/project/project_discovery_metadata.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
  execute.mockReset();
});

describe("bounded discovery container probe", () => {
  it("keeps intentional Docker configuration but quarantines hosted credentials", async () => {
    vi.stubEnv("DOCKER_CONFIG", "/fixture/docker-config");
    vi.stubEnv("DOCKER_CONTEXT", "fixture-context");
    vi.stubEnv("DOCKER_HOST", "unix:///fixture/docker.sock");
    vi.stubEnv("COLIMA_HOME", "/fixture/colima");
    vi.stubEnv("DATABASE_URL", "ambient-not-inherited");
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "ambient-not-inherited");
    vi.stubEnv("DOCKER_AUTH_CONFIG", "ambient-not-inherited");
    vi.stubEnv("NODE_OPTIONS", "ambient-not-inherited");
    execute.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "27.0.0", "");
    });

    expect(await probeContainerEngineWithoutStarting()).toBe("running");
    expect(execute).toHaveBeenCalledTimes(1);
    const [command, args, options] = execute.mock.calls[0];
    expect(command).toBe("docker");
    expect(args).toEqual(["info", "--format", "{{.ServerVersion}}"]);
    expect(options).toMatchObject({
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      env: {
        DOCKER_CONFIG: "/fixture/docker-config",
        DOCKER_CONTEXT: "fixture-context",
        DOCKER_HOST: "unix:///fixture/docker.sock",
        COLIMA_HOME: "/fixture/colima",
      },
    });
    for (const key of [
      "DATABASE_URL",
      "SUPABASE_ACCESS_TOKEN",
      "DOCKER_AUTH_CONFIG",
      "NODE_OPTIONS",
    ]) {
      expect(options.env).not.toHaveProperty(key);
    }
  });

  it.each([
    { code: "ENOENT", expected: "unavailable" },
    { code: "ECONNREFUSED", expected: "stopped" },
  ])(
    "reports $expected without starting an engine",
    async ({ code, expected }) => {
      execute.mockImplementation((_command, _args, _options, callback) => {
        callback(Object.assign(new Error("bounded probe failed"), { code }));
      });
      expect(await probeContainerEngineWithoutStarting()).toBe(expected);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]).toEqual([
        "info",
        "--format",
        "{{.ServerVersion}}",
      ]);
    },
  );
});
