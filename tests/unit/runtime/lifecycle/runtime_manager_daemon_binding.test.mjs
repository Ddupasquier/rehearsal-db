import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock(
  "../../../../dist/src/runtime/engines/local_docker_context.mjs",
  () => ({
    bindRuntimeDockerEnvironment: vi.fn(),
    runtimeDockerEnvironment: vi.fn(() => ({})),
  }),
);
import {
  bindRuntimeDockerEnvironment,
  runtimeDockerEnvironment,
} from "../../../../dist/src/runtime/engines/local_docker_context.mjs";
import {
  guardRuntimeManagerAction,
  createRuntimeManagerEnvironment,
} from "../../../../dist/src/runtime/lifecycle/runtime_manager_guards.mjs";
const saved = {
  daemon: process.env.REHEARSAL_DOCKER_DAEMON_ID,
  config: process.env.REHEARSAL_CONFIGURATION_SHA256,
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  runtimeDockerEnvironment.mockReturnValue({});
  for (const [key, value] of [
    ["REHEARSAL_DOCKER_DAEMON_ID", saved.daemon],
    ["REHEARSAL_CONFIGURATION_SHA256", saved.config],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
describe("capacity parent binding across target policies", () => {
  it("pins read-only status to the selected context/config while candidates remain offline", async () => {
    delete process.env.REHEARSAL_CONFIGURATION_SHA256;
    vi.stubEnv("REHEARSAL_DOCKER_CONTEXT", "selected-local");
    vi.stubEnv("REHEARSAL_DOCKER_IDENTITY", "a".repeat(64));
    runtimeDockerEnvironment.mockReturnValue({
      DOCKER_CONFIG: "/selected/client",
      DOCKER_HOST: "unix:///selected.sock",
    });
    const input = {
      projectRoot: "/synthetic/no-engine",
      configPath: "/synthetic/no-engine/config.mjs",
      config: {},
      paths: { rehearsalConfig: null },
    };
    await guardRuntimeManagerAction(input, "status");
    expect(bindRuntimeDockerEnvironment).toHaveBeenCalledWith({
      cwd: input.projectRoot,
      context: "selected-local",
      expectedIdentity: "a".repeat(64),
    });
    expect(createRuntimeManagerEnvironment()).toMatchObject({
      DOCKER_CONFIG: "/selected/client",
      DOCKER_HOST: "unix:///selected.sock",
    });
    vi.clearAllMocks();
    await guardRuntimeManagerAction(input, "candidates");
    expect(bindRuntimeDockerEnvironment).not.toHaveBeenCalled();
  });
  it("checks a supplied parent daemon even when the selected child policy is disabled", async () => {
    delete process.env.REHEARSAL_CONFIGURATION_SHA256;
    process.env.REHEARSAL_DOCKER_DAEMON_ID = "parent-admitted-daemon";
    const input = {
      projectRoot: "/synthetic/no-engine",
      configPath: "/synthetic/no-engine/config.mjs",
      config: {
        resources: {
          maximumBytes: null,
          capacityAdmission: { enabled: false },
        },
      },
      paths: { rehearsalConfig: null },
    };
    await guardRuntimeManagerAction(input, "start");
    expect(bindRuntimeDockerEnvironment).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedDaemonId: "parent-admitted-daemon" }),
    );
    await guardRuntimeManagerAction(input, "stop");
    expect(bindRuntimeDockerEnvironment).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ expectedDaemonId: expect.anything() }),
    );
    delete process.env.REHEARSAL_DOCKER_DAEMON_ID;
    await guardRuntimeManagerAction(input, "start");
    expect(bindRuntimeDockerEnvironment).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ expectedDaemonId: expect.anything() }),
    );
  });
});
