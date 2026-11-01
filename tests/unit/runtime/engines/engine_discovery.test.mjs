import { describe, expect, it } from "vitest";
import { inspectContainerEngineOptions } from "../../../../dist/src/runtime/engines/engine_discovery.mjs";
import { DOCKER_CONTEXT_TLS_FORMAT } from "../../../../dist/src/runtime/engines/local_docker_context.mjs";

const host = (kind = "macos", supported = true) => ({
  kind,
  supported,
  detail: "fixture",
  remediation: "Use the supported host path.",
});
const fixture = ({
  context = "colima",
  endpoint = "unix:///fixture/engine.sock",
  info = true,
  names,
  environment = {},
} = {}) => {
  const calls = [];
  const runner = (_command, args, _cwd, env) => {
    calls.push({ args, env });
    let stdout;
    if (args.join(" ") === "context show") stdout = context;
    else if (args[0] === "context" && args[1] === "ls")
      stdout =
        args.at(-1) === "{{.Name}}"
          ? context
          : (
              names ?? [
                { Name: context, Endpoint: endpoint },
                { Name: "remote", Endpoint: "ssh://example.test" },
              ]
            )
              .map((x) => JSON.stringify(x))
              .join("\n");
    else if (args[0] === "context" && args[1] === "inspect")
      stdout =
        args[3] === DOCKER_CONTEXT_TLS_FORMAT
          ? "false"
          : JSON.stringify(endpoint);
    else if (
      args[0] === "--host" &&
      args[1] === endpoint &&
      args[2] === "info" &&
      info
    )
      stdout = JSON.stringify({
        ID: "fixture-daemon",
        ServerVersion: "28.0.0",
      });
    else return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout, stderr: "" };
  };
  return {
    calls,
    inspect: (options = {}) =>
      inspectContainerEngineOptions({
        projectRoot: "/fixture",
        inheritedEnvironment: environment,
        runner,
        hasTool: (tool) => tool === "docker",
        hostInspection: host(),
        ...options,
      }),
  };
};

describe("machine-aware engine discovery", () => {
  it("keeps the current local engine without probing alternatives or changing context", async () => {
    const f = fixture();
    const report = await f.inspect();
    expect(report).toMatchObject({
      schemaVersion: 1,
      state: "ready",
      selected: {
        context: "colima",
        provider: "colima",
        daemonId: "fixture-daemon",
      },
    });
    expect(
      report.options.find((x) => x.provider === "orbstack").platforms,
    ).toEqual(["macos"]);
    expect(report.options.flatMap((x) => x.contexts)).not.toContain("remote");
    expect(f.calls.filter((x) => x.args.includes("info"))).toHaveLength(1);
    expect(
      f.calls.find((x) => x.args.includes("info")).args.slice(0, 2),
    ).toEqual(["--host", "unix:///fixture/engine.sock"]);
    expect(
      f.calls.every(
        (x) =>
          !x.args.some((a) =>
            ["start", "stop", "use", "create", "rm"].includes(a),
          ),
      ),
    ).toBe(true);
  });
  it("honors an explicit context over the default and host selector", async () => {
    const f = fixture({
      context: "default",
      environment: {
        DOCKER_CONTEXT: "desktop-linux",
        DOCKER_HOST: "ssh://ignored.example.test",
      },
    });
    expect(await f.inspect()).toMatchObject({
      state: "ready",
      selected: { context: "desktop-linux", provider: "docker-desktop" },
    });
    expect(f.calls.some((x) => x.args.join(" ") === "context show")).toBe(
      false,
    );
  });
  it("refuses an explicit remote host before any daemon contact, without fallback", async () => {
    const f = fixture({
      environment: { DOCKER_HOST: "ssh://remote.example.test" },
    });
    expect(await f.inspect()).toMatchObject({
      state: "selection-required",
      selected: null,
    });
    expect(f.calls.some((x) => x.args.includes("info"))).toBe(false);
  });
  it("does not turn an unavailable selected engine into a different engine", async () => {
    const f = fixture({
      info: false,
      names: [
        { Name: "colima", Endpoint: "unix:///fixture/engine.sock" },
        { Name: "orbstack", Endpoint: "unix:///other.sock" },
      ],
    });
    expect(await f.inspect()).toMatchObject({
      state: "selection-required",
      selected: null,
    });
    expect(
      f.calls.filter((x) => x.args.includes("info")).map((x) => x.args[1]),
    ).toEqual(["unix:///fixture/engine.sock"]);
  });
  it.each(["linux", "wsl2"])(
    "offers portable choices on %s without a Mac-only default",
    async (kind) => {
      const f = fixture({ context: "default" });
      const result = await f.inspect({ hostInspection: host(kind) });
      expect(result.options.some((x) => x.provider === "orbstack")).toBe(false);
      expect(result.selected.provider).toBe("docker");
      expect(result.options.some((x) => x.provider === "docker-desktop")).toBe(
        true,
      );
    },
  );
  it("native Windows remains unsupported without any child-process probe", async () => {
    const f = fixture();
    const result = await f.inspect({ hostInspection: host("windows", false) });
    expect(result).toMatchObject({ state: "unsupported-host", selected: null });
    expect(f.calls.some((x) => x.args.includes("info"))).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it("pins the verified endpoint even if its named context becomes remote before info", async () => {
    const endpoint = "unix:///fixture/original.sock";
    let contextEndpoint = endpoint;
    let daemonArguments;
    const report = await inspectContainerEngineOptions({
      projectRoot: "/fixture",
      inheritedEnvironment: {},
      hostInspection: host(),
      hasTool: (tool) => tool === "docker",
      runner: (_command, args) => {
        let stdout;
        if (args[1] === "ls")
          stdout = JSON.stringify({ Name: "colima", Endpoint: endpoint });
        else if (args[1] === "show") stdout = "colima";
        else if (args.includes(DOCKER_CONTEXT_TLS_FORMAT)) {
          contextEndpoint = "ssh://remote.example.test";
          stdout = "false";
        } else if (args[1] === "inspect")
          stdout = JSON.stringify(contextEndpoint);
        else if (args[2] === "info") {
          daemonArguments = args;
          stdout = JSON.stringify({
            ID:
              args[0] === "--host" && args[1] === endpoint
                ? "original-daemon"
                : "remote-daemon",
            ServerVersion: "28.0.0",
          });
        } else return { status: 97, stdout: "" };
        return { status: 0, stdout };
      },
    });
    expect(contextEndpoint).toBe("ssh://remote.example.test");
    expect(report.selected.daemonId).toBe("original-daemon");
    expect(daemonArguments.slice(0, 2)).toEqual(["--host", endpoint]);
  });
  it("missing Docker requires no process or daemon probe", async () => {
    const f = fixture();
    expect(await f.inspect({ hasTool: () => false })).toMatchObject({
      state: "unavailable",
      selected: null,
    });
    expect(f.calls).toEqual([]);
  });
  it("malformed or unbounded context metadata is not a successful discovery", async () => {
    const f = fixture({
      names: Array.from({ length: 33 }, (_, i) => ({
        Name: `context-${i}`,
        Endpoint: "unix:///fixture.sock",
      })),
    });
    expect(await f.inspect()).toMatchObject({
      state: "selection-required",
      selected: null,
    });
    expect(f.calls.some((x) => x.args.includes("info"))).toBe(false);
  });
});
