import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildApplicationEnvironment,
  holdApplicationSession,
  runHttpProofs,
  startApplicationSession,
  summarizeProjectCommandFailure,
} from "../../../dist/src/application/session.mjs";
import { runApplicationSessionTask } from "../../../dist/src/application/interactive_task.mjs";

const roots = [];
const servers = [];

const availablePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("package-owned application sessions", () => {
  it("reports exit status and byte counts without echoing project output", () => {
    const summary = summarizeProjectCommandFailure({
      status: 7,
      stdout: "private stdout failure",
      stderr: "",
    });
    expect(summary).toBe(
      "exit 7; stdout 22 bytes; stderr 0 bytes; output withheld",
    );
    expect(summary).not.toContain("private stdout");
  });

  it("maps only declared local runtime values and owns the launched process", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-application-"));
    roots.push(root);
    const port = await availablePort();
    const environmentPath = join(root, "runtime.env");
    await writeFile(
      environmentPath,
      `DATABASE_URL=postgresql://local:local@127.0.0.1:55432/app\nAPP_PORT=${port}\n`,
      { mode: 0o600 },
    );
    await chmod(environmentPath, 0o600);
    await writeFile(
      join(root, "server.mjs"),
      `import { createServer } from "node:http";
if (process.env.LEAK_ME || !process.env.APP_DATABASE_URL) process.exit(9);
createServer((_request, response) => { response.end("ready"); })
  .listen(Number(process.env.PORT), "127.0.0.1");
`,
    );
    const session = await startApplicationSession({
      command: "node server.mjs",
      cwd: root,
      files: { primary: environmentPath },
      mappings: {
        APP_DATABASE_URL: "primary:DATABASE_URL",
        PORT: "primary:APP_PORT",
      },
      readiness: {
        url: `http://127.0.0.1:${port}`,
        expectedStatus: 200,
        timeoutSeconds: 5,
      },
      inheritedEnvironment: { ...process.env, LEAK_ME: "hosted-secret" },
    });
    expect(session.ready.status).toBe(200);
    await session.stop();
  });

  it("holds a ready session until interruption and then stops only its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-application-"));
    roots.push(root);
    const port = await availablePort();
    const environmentPath = join(root, "runtime.env");
    await writeFile(environmentPath, `APP_PORT=${port}\n`, { mode: 0o600 });
    await writeFile(
      join(root, "server.mjs"),
      `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((_request, response) => response.end("ready"));
process.on("SIGTERM", () => server.close(() => {
  writeFileSync("stopped.txt", "yes");
  process.exit(0);
}));
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
    );
    const session = await startApplicationSession({
      command: "node server.mjs",
      cwd: root,
      files: { primary: environmentPath },
      mappings: { PORT: "primary:APP_PORT" },
      readiness: {
        url: `http://127.0.0.1:${port}`,
        expectedStatus: 200,
        timeoutSeconds: 5,
      },
    });
    const signals = new EventEmitter();
    const held = holdApplicationSession({
      session,
      signalTarget: signals,
      input: null,
    });
    signals.emit("SIGINT");
    await expect(held).resolves.toMatchObject({ signal: "SIGINT" });
    expect(await readFile(join(root, "stopped.txt"), "utf8")).toBe("yes");
    await expect(
      fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow();
  });

  it("keeps interruption handlers active until application shutdown completes", async () => {
    const signals = new EventEmitter();
    let finishStop;
    const stopPending = new Promise((resolve) => {
      finishStop = resolve;
    });
    const session = {
      ready: { url: "http://127.0.0.1:5175", status: 200 },
      wait: () => new Promise(() => undefined),
      stop: vi.fn(async () => stopPending),
      diagnostics: () => ({ stdoutBytes: 0, stderrBytes: 0 }),
    };

    const held = holdApplicationSession({
      session,
      signalTarget: signals,
      input: null,
    });
    signals.emit("SIGINT");
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce());

    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(() => signals.emit("SIGINT")).not.toThrow();

    finishStop();
    await expect(held).resolves.toMatchObject({ signal: "SIGINT" });
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("runs identity discovery while the application stays available", async () => {
    const signals = new EventEmitter();
    const stop = vi.fn(async () => undefined);
    const session = {
      ready: { url: "http://127.0.0.1:5175", status: 200 },
      wait: () => new Promise(() => undefined),
      stop,
      diagnostics: () => ({ stdoutBytes: 0, stderrBytes: 0 }),
    };
    const task = vi.fn(async (signal) => {
      expect(signal.aborted).toBe(false);
      return { provider: "google" };
    });

    await expect(
      runApplicationSessionTask({
        session,
        task,
        signalTarget: signals,
        input: null,
      }),
    ).resolves.toMatchObject({
      completed: true,
      value: { provider: "google" },
    });
    expect(stop).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it.each([
    ["SIGINT", "SIGINT"],
    ["SIGTSTP", "SIGTSTP"],
  ])(
    "aborts identity discovery and stops the app on %s",
    async (event, signal) => {
      const signals = new EventEmitter();
      let observedSignal;
      const session = {
        ready: { url: "http://127.0.0.1:5175", status: 200 },
        wait: () => new Promise(() => undefined),
        stop: vi.fn(async () => undefined),
        diagnostics: () => ({ stdoutBytes: 0, stderrBytes: 0 }),
      };
      const task = (signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      const running = runApplicationSessionTask({
        session,
        task,
        signalTarget: signals,
        input: null,
      });
      signals.emit(event);

      await expect(running).resolves.toMatchObject({
        completed: false,
        signal,
      });
      expect(observedSignal.aborted).toBe(true);
      expect(session.stop).toHaveBeenCalledOnce();
      expect(signals.listenerCount(event)).toBe(0);
    },
  );

  it("reports an application that exits during an open session without leaking output", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-application-"));
    roots.push(root);
    const port = await availablePort();
    const environmentPath = join(root, "runtime.env");
    await writeFile(environmentPath, `APP_PORT=${port}\n`, { mode: 0o600 });
    await writeFile(
      join(root, "server.mjs"),
      `import { createServer } from "node:http";
const server = createServer((_request, response) => response.end("ready"));
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  setTimeout(() => {
    console.error("private application output");
    process.exit(7);
  }, 600);
});
`,
    );
    const session = await startApplicationSession({
      command: "node server.mjs",
      cwd: root,
      files: { primary: environmentPath },
      mappings: { PORT: "primary:APP_PORT" },
      readiness: {
        url: `http://127.0.0.1:${port}`,
        expectedStatus: 200,
        timeoutSeconds: 5,
      },
    });
    const result = holdApplicationSession({
      session,
      signalTarget: new EventEmitter(),
      input: null,
    });
    await expect(result).rejects.toThrow(
      "Application exited before the sandbox was closed (exit 7;",
    );
    await expect(result).rejects.not.toThrow("private application output");
  });

  it("requires meaningful positive and negative HTTP results", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/known") {
        response.end(JSON.stringify({ items: [{ id: 1 }] }));
      } else if (request.url === "/empty") {
        response.end(JSON.stringify({ items: [] }));
      } else if (request.url === "/wrong") {
        response.end(JSON.stringify({ items: [{ id: 999 }] }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const results = await runHttpProofs({
      checks: [
        {
          name: "known record",
          kind: "positive",
          url: `http://127.0.0.1:${port}/known`,
          expectedStatus: 200,
          json: { path: ["items"], minimumItems: 1 },
        },
        {
          name: "missing record",
          kind: "negative",
          url: `http://127.0.0.1:${port}/missing`,
          expectedStatus: 404,
          json: { path: ["error"], equals: "not found" },
        },
      ],
    });
    expect(results).toHaveLength(2);
    for (const [path, assertion, message] of [
      ["empty", { path: ["items"], minimumItems: 1 }, "too few"],
      ["wrong", { path: ["items", "0", "id"], equals: 1 }, "required value"],
    ]) {
      await expect(
        runHttpProofs({
          checks: [
            {
              name: `${path} positive`,
              kind: "positive",
              url: `http://127.0.0.1:${port}/${path}`,
              expectedStatus: 200,
              json: assertion,
            },
            {
              name: "missing record",
              kind: "negative",
              url: `http://127.0.0.1:${port}/missing`,
              expectedStatus: 404,
              json: { path: ["error"], equals: "not found" },
            },
          ],
        }),
      ).rejects.toThrow(message);
    }
    await expect(
      runHttpProofs({
        checks: [
          {
            name: "empty false positive",
            kind: "positive",
            url: `http://127.0.0.1:${port}/missing`,
            expectedStatus: 404,
          },
        ],
      }),
    ).rejects.toThrow("positive and negative");
  });

  it("refuses hosted mapped endpoints and broad environment files", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-application-"));
    roots.push(root);
    const path = join(root, "runtime.env");
    await writeFile(
      path,
      "DATABASE_URL=postgresql://user:pass@hosted.example.com/db\n",
      {
        mode: 0o600,
      },
    );
    await expect(
      buildApplicationEnvironment({
        files: { primary: path },
        mappings: { APP_DATABASE_URL: "primary:DATABASE_URL" },
      }),
    ).rejects.toThrow("not local");

    await writeFile(path, "APP_URL=ftp://localhost/private\n", {
      mode: 0o600,
    });
    await expect(
      buildApplicationEnvironment({
        files: { primary: path },
        mappings: { APP_URL: "primary:APP_URL" },
      }),
    ).rejects.toThrow("not local");
  });

  it("reports early exit and stops an owned child after readiness timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-application-"));
    roots.push(root);
    const port = await availablePort();
    const environmentPath = join(root, "runtime.env");
    await writeFile(environmentPath, "LOCAL_VALUE=ready\n", { mode: 0o600 });
    await writeFile(join(root, "exit.mjs"), "process.exit(7);\n");
    await expect(
      startApplicationSession({
        command: "node exit.mjs",
        cwd: root,
        files: { primary: environmentPath },
        mappings: {},
        readiness: {
          url: `http://127.0.0.1:${port}`,
          expectedStatus: 200,
          timeoutSeconds: 1,
        },
      }),
    ).rejects.toThrow("exited before becoming ready");

    await writeFile(
      join(root, "wait.mjs"),
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync("stopped.txt", "yes"); process.exit(0); });
setInterval(() => {}, 1000);
`,
    );
    await expect(
      startApplicationSession({
        command: "node wait.mjs",
        cwd: root,
        files: { primary: environmentPath },
        mappings: {},
        readiness: {
          url: `http://127.0.0.1:${port}`,
          expectedStatus: 200,
          timeoutSeconds: 0.2,
        },
      }),
    ).rejects.toThrow("timed out");
    expect(await readFile(join(root, "stopped.txt"), "utf8")).toBe("yes");
  });

  it("stops the owned child when application startup is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-application-"));
    roots.push(root);
    const port = await availablePort();
    const environmentPath = join(root, "runtime.env");
    await writeFile(environmentPath, "LOCAL_VALUE=ready\n", { mode: 0o600 });
    await writeFile(
      join(root, "wait.mjs"),
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync("interrupted.txt", "yes"); process.exit(0); });
setInterval(() => {}, 1000);
`,
    );
    const signals = new EventEmitter();
    const starting = startApplicationSession({
      command: "node wait.mjs",
      cwd: root,
      files: { primary: environmentPath },
      mappings: {},
      readiness: {
        url: `http://127.0.0.1:${port}`,
        expectedStatus: 200,
        timeoutSeconds: 5,
      },
      signalTarget: signals,
    });
    setTimeout(() => signals.emit("SIGINT"), 100);
    await expect(starting).rejects.toThrow(
      "Application startup was interrupted by SIGINT",
    );
    expect(await readFile(join(root, "interrupted.txt"), "utf8")).toBe("yes");
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
