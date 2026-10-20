import { describe, expect, it, vi } from "vitest";
import {
  assertPostgresqlStartupResult,
  classifyPortStartupFailure,
  portStartupGuidance,
  runPostgresqlStartupCommand,
} from "../../../dist/src/targets/port_start_failure.mjs";

const windowsBindFailure =
  "ports are not available: exposing port TCP 127.0.0.1:59422 -> 127.0.0.1:0: listen tcp 127.0.0.1:59422: bind: An attempt was made to access a socket in a way forbidden by its access permissions.";

describe("safe database port startup evidence", () => {
  it.each([
    "Bind for 127.0.0.1:59422 failed: port is already allocated",
    "listen tcp 127.0.0.1:59422: bind: address already in use",
    "bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.",
    "\u001b[31maddress already in use\u001b[0m",
  ])("recognizes occupied binding evidence: %s", (output) => {
    expect(classifyPortStartupFailure(output)).toBe("port_in_use");
  });

  it.each([
    windowsBindFailure,
    "listen tcp 127.0.0.1:59422: bind: permission denied",
    "bind: WSAEACCES (10013)",
    "listen tcp 127.0.0.1:59422: bind: cannot assign requested address",
    "ports are not available",
  ])(
    "recognizes unavailable binding without proving a reservation: %s",
    (output) => {
      expect(classifyPortStartupFailure(output)).toBe("port_unavailable");
      const guidance = portStartupGuidance("port_unavailable", "postgresql");
      expect(guidance).toContain("does not prove an existing listener");
      expect(guidance).toContain("runtime.databasePort");
      expect(guidance).toContain(
        "netsh interface ipv4 show excludedportrange protocol=tcp",
      );
      expect(guidance).toContain("read-only");
      expect(guidance).not.toMatch(
        /delete excludedport|stop-process|taskkill/iu,
      );
    },
  );

  it.each([
    "pull access denied for private-image",
    "permission denied while trying to connect to the Docker daemon socket",
    "cannot connect to Docker daemon socket: permission denied",
    "open /private/file: permission denied",
    "authentication failed: forbidden by its access permissions",
    "container is unhealthy",
    "out of memory",
    "10013",
    "",
  ])("keeps unrelated or insufficient evidence unknown: %s", (output) => {
    expect(classifyPortStartupFailure(output)).toBeNull();
  });

  it("gives explicit occupied evidence priority over generic unavailable evidence", () => {
    expect(
      classifyPortStartupFailure(
        "ports are not available: listen tcp: address already in use",
      ),
    ).toBe("port_in_use");
  });

  it("bounds provider evidence to the head and tail", () => {
    const padding = "x".repeat(70 * 1024);
    expect(
      classifyPortStartupFailure(`${padding}address already in use${padding}`),
    ).toBeNull();
    expect(
      classifyPortStartupFailure(`${padding}${padding}${windowsBindFailure}`),
    ).toBe("port_unavailable");
  });
});

describe("PostgreSQL startup failure boundary", () => {
  it("retains fixed evidence and reviewed-port advice without private provider data", () => {
    const runCommand = vi.fn(() => ({
      status: 1,
      stdout: "docker run --env POSTGRES_PASSWORD=private-password",
      stderr: `${windowsBindFailure}\n/private/canary postgresql://owner:private-password@private-host/private-db`,
    }));
    let failure;
    try {
      runPostgresqlStartupCommand(runCommand, [
        "run",
        "--env",
        "POSTGRES_PASSWORD=private-password",
      ]);
    } catch (error) {
      failure = error;
    }
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(
      "docker",
      ["run", "--env", "POSTGRES_PASSWORD=private-password"],
      { capture: true, allowFailure: true },
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("PostgreSQL startup failed (exit 1)");
    expect(failure.message).toContain(
      "Reported startup evidence: port_unavailable",
    );
    expect(failure.message).toContain("Port guidance:");
    expect(failure.message).toContain("runtime.databasePort");
    expect(failure.message).not.toMatch(/memory|migration/iu);
    for (const canary of [
      "59422",
      "POSTGRES_PASSWORD",
      "private-password",
      "/private/canary",
      "private-host",
      "private-db",
    ])
      expect(failure.message).not.toContain(canary);
  });

  it("does not reinterpret success or swallow runner cancellation", () => {
    expect(() =>
      assertPostgresqlStartupResult({
        status: 0,
        stdout: "address already in use in a successful command's output",
        stderr: "",
      }),
    ).not.toThrow();
    const cancellation = new Error("owned operation cancelled");
    const runCommand = vi.fn(() => {
      throw cancellation;
    });
    let failure;
    try {
      runPostgresqlStartupCommand(runCommand, ["start", "owned-container"]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(cancellation);
  });

  it.each([
    ["ENOENT", "docker_unavailable"],
    ["ETIMEDOUT", "process_timeout"],
    ["ENOBUFS", "provider_output_limit"],
    [
      "private-error-code",
      "unknown; provider supplied no recognized safe failure detail",
    ],
  ])("only emits known process codes: %s", (code, evidence) => {
    const error = Object.assign(new Error("private-process-message"), { code });
    let failure;
    try {
      assertPostgresqlStartupResult({
        status: null,
        stdout: "private-provider-canary",
        stderr: "",
        error,
      });
    } catch (caught) {
      failure = caught;
    }
    expect(failure.message).toContain(`Reported startup evidence: ${evidence}`);
    expect(failure.message).not.toContain("private-");
    expect(failure.message).not.toContain("Port guidance:");
  });
});
