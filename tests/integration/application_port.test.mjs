import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertApplicationPortAvailable } from "../../dist/src/application/port_preflight.mjs";
import { startApplicationSession } from "../../dist/src/application/session.mjs";

const servers = [];
const roots = [];
const listen = async (server, host = "127.0.0.1") => {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
};
const sessionInput = async (url) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-port-startup-"));
  roots.push(root);
  const environment = join(root, "runtime.env");
  await writeFile(environment, "LOCAL_VALUE=synthetic\n", { mode: 0o600 });
  return {
    cwd: root,
    command: "node synthetic-app.mjs",
    files: { primary: environment },
    mappings: {},
    readiness: { url, expectedStatus: 200, timeoutSeconds: 1 },
  };
};
afterEach(async () => {
  for (const server of servers.splice(0))
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("real loopback application port protection", () => {
  it("refuses an existing app before spawn/readiness, keeps it available and sends no HTTP request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("existing-app");
    });
    const port = await listen(server);
    const spawn = vi.fn();
    const fetchReadiness = vi.fn(async () => ({ status: 200 }));
    await expect(
      startApplicationSession({
        ...(await sessionInput(
          `http://127.0.0.1:${port}/health?private=hidden`,
        )),
        spawnImplementation: spawn,
        fetchImplementation: fetchReadiness,
      }),
    ).rejects.toThrow("already in use");
    expect(spawn).not.toHaveBeenCalled();
    expect(fetchReadiness).not.toHaveBeenCalled();
    expect(requests).toBe(0);
    expect(server.listening).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
      "existing-app",
    );
  });

  it("accepts a demonstrably unoccupied local endpoint without leaving a probe socket", async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    await expect(
      assertApplicationPortAvailable({ url: `http://127.0.0.1:${port}/` }),
    ).resolves.toBeUndefined();
    const replacement = createServer();
    servers.push(replacement);
    await new Promise((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(port, "127.0.0.1", resolve);
    });
    expect(replacement.listening).toBe(true);
  });

  it("preserves explicitly injected mock spawn/readiness contracts", async () => {
    const preflight = vi.fn(async () => undefined);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: undefined,
    });
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const session = await startApplicationSession({
      ...(await sessionInput("http://127.0.0.1:5175/health")),
      portPreflight: preflight,
      spawnImplementation: spawn,
      fetchImplementation: async () => ({ status: 200 }),
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(session.ready.status).toBe(200);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await session.stop();
  });
});
