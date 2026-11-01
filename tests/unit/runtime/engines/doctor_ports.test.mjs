import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  load: vi.fn(),
  discovery: vi.fn(),
  service: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  spawnSync: boundary.spawn,
}));
vi.mock("node:net", async (original) => ({
  ...(await original()),
  createConnection: () => {
    const socket = {
      unref() {},
      setTimeout() {},
      destroy() {},
      once(event, callback) {
        if (event === "connect") queueMicrotask(callback);
        return socket;
      },
    };
    return socket;
  },
}));
vi.mock("../../../../dist/src/shared/host_platform.mjs", () => ({
  inspectHostPlatform: async () => ({
    supported: true,
    detail: "synthetic Linux",
  }),
}));
vi.mock("../../../../dist/src/runtime/engines/engine_discovery.mjs", () => ({
  inspectContainerEngineOptions: boundary.discovery,
}));
vi.mock("../../../../dist/src/project/configuration.mjs", async (original) => ({
  ...(await original()),
  loadRehearsalConfig: boundary.load,
}));
vi.mock(
  "../../../../dist/src/runtime/lifecycle/service_environment.mjs",
  () => ({
    readRehearsalServiceEnvironment: boundary.service,
  }),
);
import { runRehearsalDoctor } from "../../../../dist/src/runtime/lifecycle/plan.mjs";

const endpoint = "unix:///external/private/docker.sock";
const context = "private-engine";
const identity = (value = endpoint) =>
  createHash("sha256")
    .update(JSON.stringify({ context, endpoint: value }))
    .digest("hex");
let root;
let actualEndpoint;
let tls;
let statusOutput;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctor-ports-"));
  actualEndpoint = endpoint;
  tls = "false";
  statusOutput = 'API_URL="http://127.0.0.1:58321"';
  vi.stubEnv("DOCKER_CONFIG", root);
  vi.stubEnv("DOCKER_CONTEXT", context);
  vi.stubEnv("DOCKER_HOST", "");
  vi.stubEnv("DOCKER_TLS_VERIFY", "");
  vi.stubEnv("DOCKER_TLS", "");
  vi.stubEnv("DOCKER_CERT_PATH", "");
  vi.stubEnv("PRIVATE_HOSTED_SECRET", "must-not-leak");
  boundary.discovery.mockResolvedValue({
    selected: { context, endpointIdentity: identity(), serverVersion: "test" },
  });
  boundary.service.mockResolvedValue({
    LOCAL_SERVICE_SECRET: "explicit-allowlist",
  });
  boundary.load.mockResolvedValue({
    projectRoot: root,
    paths: {
      artifactDirectory: root,
      migrationDirectory: root,
      sanitizationPolicy: join(root, "absent"),
      runtimeWorkdir: root,
      serviceEnvironment: join(root, "service"),
    },
    config: {
      runtime: {
        target: "supabase",
        projectId: "private-project",
        ports: { api: 58321, database: 58322 },
      },
      supabase: { serviceEnvironmentVariables: ["LOCAL_SERVICE_SECRET"] },
      application: { startCommand: "npm run dev", proofCommand: "npm test" },
      safety: {
        blockedEnvironmentVariables: ["PRIVATE_HOSTED_SECRET"],
        hostedAccess: "disabled",
        outboundNetwork: "deny",
        authenticationProviders: [],
      },
    },
  });
  boundary.spawn.mockImplementation((command, args) => {
    let stdout = "synthetic-version";
    if (command === "docker" && args[0] === "context") {
      if (args[1] === "show" || args[1] === "ls") stdout = context;
      else
        stdout = args.includes("{{json .Endpoints.docker.Host}}")
          ? JSON.stringify(actualEndpoint)
          : tls;
    } else if (command === "supabase" && args[0] === "status")
      stdout = statusOutput;
    else if (command === "docker" && args.includes("ps")) stdout = statusOutput;
    return { status: 0, stdout, stderr: "", error: undefined };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});
const ports = async () =>
  (await runRehearsalDoctor({ projectRoot: root })).checks.find(
    ({ id }) => id === "runtime-ports",
  );
const probes = () =>
  boundary.spawn.mock.calls.filter(
    ([command, args]) =>
      (command === "supabase" && args[0] === "status") ||
      (command === "docker" && args.includes("ps")),
  );

it("pins Supabase occupied-port inspection to the selected config/endpoint with only allowlisted credentials", async () => {
  expect(await ports()).toMatchObject({ status: "pass" });
  const [command, args, options] = probes()[0];
  expect(command).toBe("supabase");
  expect(args).toEqual(["status", "-o", "env", "--workdir", root]);
  expect(options.env).toMatchObject({
    DOCKER_CONFIG: root,
    DOCKER_HOST: endpoint,
    LOCAL_SERVICE_SECRET: "explicit-allowlist",
  });
  expect(options.env).not.toHaveProperty("DOCKER_CONTEXT");
  expect(options.env).not.toHaveProperty("PRIVATE_HOSTED_SECRET");
  expect(options.timeout).toBe(10000);
});
it("pins PostgreSQL ports and image inspection to the same explicit local host", async () => {
  const loaded = await boundary.load();
  loaded.config.runtime.target = "postgresql";
  loaded.config.postgresql = { image: "postgres:17-alpine" };
  statusOutput = "127.0.0.1:58322->5432/tcp";
  expect(await ports()).toMatchObject({ status: "pass" });
  for (const [, args, options] of boundary.spawn.mock.calls.filter(
    ([command, args]) =>
      command === "docker" && (args.includes("ps") || args.includes("image")),
  )) {
    expect(args.slice(0, 2)).toEqual(["--host", endpoint]);
    expect(options.env).toMatchObject({
      DOCKER_CONFIG: root,
      DOCKER_HOST: endpoint,
    });
  }
});
it("honors an explicit host without replacing it with the discovered context", async () => {
  vi.stubEnv("DOCKER_CONTEXT", "");
  vi.stubEnv("DOCKER_HOST", endpoint);
  expect(await ports()).toMatchObject({ status: "pass" });
  expect(
    boundary.spawn.mock.calls.some(
      ([, args]) => args[0] === "context" && args[1] === "ls",
    ),
  ).toBe(true);
  expect(probes()[0][2].env.DOCKER_HOST).toBe(endpoint);
});
it.each([
  "remote",
  "tls",
  "endpoint-drift",
  "explicit-foreign-host",
  "ambient-tls",
])("refuses %s before occupied-port probes", async (scenario) => {
  if (scenario === "remote") actualEndpoint = "ssh://foreign.example";
  if (scenario === "tls") tls = "true";
  if (scenario === "endpoint-drift")
    actualEndpoint = "unix:///external/other.sock";
  if (scenario === "explicit-foreign-host") {
    vi.stubEnv("DOCKER_CONTEXT", "");
    vi.stubEnv("DOCKER_HOST", "tcp://foreign.example:2375");
  }
  if (scenario === "ambient-tls") vi.stubEnv("DOCKER_TLS_VERIFY", "1");
  expect(await ports()).toMatchObject({ status: "fail" });
  expect(probes()).toEqual([]);
});
it("keeps rejecting an unrelated process on the selected engine", async () => {
  statusOutput = 'API_URL="http://127.0.0.1:9999"';
  expect(await ports()).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("unverified process"),
  });
});
