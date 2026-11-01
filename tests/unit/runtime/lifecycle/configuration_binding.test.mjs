import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock(
  "../../../../dist/src/runtime/engines/local_docker_context.mjs",
  () => ({
    bindRuntimeDockerEnvironment: vi.fn(),
    runtimeDockerEnvironment: () => ({}),
  }),
);
import { bindRuntimeDockerEnvironment } from "../../../../dist/src/runtime/engines/local_docker_context.mjs";
import {
  assertRuntimeConfigurationBinding,
  runtimeConfigurationSha256,
} from "../../../../dist/src/runtime/lifecycle/configuration_binding.mjs";
import { guardRuntimeManagerAction } from "../../../../dist/src/runtime/lifecycle/runtime_manager_guards.mjs";

const config = {
  project: { name: "synthetic-project" },
  runtime: { projectId: "safe-rehearsal", target: "supabase" },
};
const originalBinding = process.env.REHEARSAL_CONFIGURATION_SHA256;
afterEach(() => {
  vi.clearAllMocks();
  if (originalBinding === undefined)
    delete process.env.REHEARSAL_CONFIGURATION_SHA256;
  else process.env.REHEARSAL_CONFIGURATION_SHA256 = originalBinding;
});

describe("parent/child runtime configuration binding", () => {
  it("accepts the exact normalized snapshot and supports ordinary direct invocation", () => {
    const expected = runtimeConfigurationSha256(config);
    expect(expected).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      assertRuntimeConfigurationBinding({
        config: JSON.parse(JSON.stringify(config)),
        expected,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeConfigurationBinding({ config, expected: undefined }),
    ).not.toThrow();
  });

  it("refuses changed target identities and malformed internal bindings without exposing settings", () => {
    const changed = {
      ...config,
      runtime: { ...config.runtime, projectId: "other-rehearsal" },
    };
    expect(() =>
      assertRuntimeConfigurationBinding({
        config: changed,
        expected: runtimeConfigurationSha256(config),
      }),
    ).toThrow("target was preserved");
    expect(() =>
      assertRuntimeConfigurationBinding({ config, expected: "../unknown" }),
    ).toThrow("configuration changed");
  });

  it("checks drift before even the read-only early return or a mutating engine call", async () => {
    process.env.REHEARSAL_CONFIGURATION_SHA256 = "f".repeat(64);
    const input = {
      projectRoot: "/synthetic/no-engine",
      configPath: "/synthetic/no-engine/rehearsal.config.mjs",
      config,
      paths: { rehearsalConfig: null },
    };
    await expect(guardRuntimeManagerAction(input, "status")).rejects.toThrow(
      "target was preserved",
    );
    await expect(guardRuntimeManagerAction(input, "stop")).rejects.toThrow(
      "target was preserved",
    );
    expect(bindRuntimeDockerEnvironment).not.toHaveBeenCalled();
    process.env.REHEARSAL_CONFIGURATION_SHA256 =
      runtimeConfigurationSha256(config);
    await expect(
      guardRuntimeManagerAction(input, "status"),
    ).resolves.toBeUndefined();
    expect(bindRuntimeDockerEnvironment).toHaveBeenCalledTimes(1);
  });
  it("refuses direct heavy capacity-enabled entry before any engine probe, while status remains available", async () => {
    delete process.env.REHEARSAL_CONFIGURATION_SHA256;
    const previous = process.env.REHEARSAL_DOCKER_DAEMON_ID;
    delete process.env.REHEARSAL_DOCKER_DAEMON_ID;
    try {
      const input = {
        projectRoot: "/synthetic/no-engine",
        configPath: "/synthetic/no-engine/config.mjs",
        config: {
          ...config,
          resources: { capacityAdmission: { enabled: true } },
        },
        paths: { rehearsalConfig: null },
      };
      for (const action of ["run", "start", "reset", "migrate"])
        await expect(guardRuntimeManagerAction(input, action)).rejects.toThrow(
          "require parent admission",
        );
      await expect(
        guardRuntimeManagerAction(input, "status"),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.REHEARSAL_DOCKER_DAEMON_ID;
      else process.env.REHEARSAL_DOCKER_DAEMON_ID = previous;
    }
  });
});
