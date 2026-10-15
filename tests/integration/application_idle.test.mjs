import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startApplicationSession,
  holdApplicationSession,
} from "../../dist/src/application/session.mjs";
import { waitForApplicationIdle } from "../../dist/src/application/activity_monitor.mjs";

const roots = [];
const sessions = [];
const servers = [];
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const fixture = async (launcher = false) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-idle-application-"));
  roots.push(root);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const environment = join(root, "runtime.env");
  await writeFile(environment, `APP_PORT=${port}\n`, { mode: 0o600 });
  await writeFile(
    join(root, "server.mjs"),
    `import {createServer} from 'node:http';
${launcher ? "process.on('SIGTERM',()=>undefined);" : ""}
createServer((request,response)=>{response.setHeader('content-type','application/json'); response.end(JSON.stringify(request.url==='/activity'?{schemaVersion:1,busy:false,activitySequence:0}:{ready:true}));}).listen(Number(process.env.PORT),'127.0.0.1');\n`,
  );
  if (launcher)
    await writeFile(
      join(root, "launcher.mjs"),
      `import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';spawn(process.execPath,['server.mjs'],{stdio:'ignore',env:process.env});setInterval(()=>{if(existsSync('release-launcher'))process.exit(0);},20);\n`,
    );
  const url = `http://127.0.0.1:${port}`;
  const session = await startApplicationSession({
    command: `node ${launcher ? "launcher" : "server"}.mjs`,
    cwd: root,
    files: { primary: environment },
    mappings: { PORT: "primary:APP_PORT" },
    readiness: { url: `${url}/health`, expectedStatus: 200, timeoutSeconds: 5 },
  });
  sessions.push(session);
  return { root, session, url };
};
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
  for (const server of servers.splice(0))
    await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("owned foreground idle application lifecycle", () => {
  it("reads a real activity route, reports idle-timeout and stops only its application", async () => {
    const unrelated = createServer((_request, response) =>
      response.end("preserved"),
    );
    servers.push(unrelated);
    const unrelatedPort = await listen(unrelated);
    const { session, url } = await fixture();
    const result = await holdApplicationSession({
      session,
      signalTarget: new EventEmitter(),
      input: null,
      activity: { url: `${url}/activity` },
      idleTimeoutSeconds: 30,
      idleMonitorImplementation: (options) =>
        waitForApplicationIdle({
          ...options,
          timeoutSeconds: 0.04,
          pollIntervalMs: 10,
          requestTimeoutMs: 200,
        }),
    });
    expect(result).toMatchObject({ reason: "idle-timeout", signal: null });
    expect(session.stop()).toBe(session.stop());
    await expect(
      fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    expect(
      await (await fetch(`http://127.0.0.1:${unrelatedPort}/`)).text(),
    ).toBe("preserved");
  });

  it.skipIf(process.platform === "win32")(
    "reaps a TERM-resistant owned descendant after its launcher exits",
    async () => {
      const unrelated = createServer((_request, response) =>
        response.end("preserved"),
      );
      servers.push(unrelated);
      const unrelatedPort = await listen(unrelated);
      const { root, session, url } = await fixture(true);
      const pending = holdApplicationSession({
        session,
        signalTarget: new EventEmitter(),
        input: null,
      });
      await writeFile(join(root, "release-launcher"), "exit\n");
      await expect(pending).rejects.toThrow(
        "Application exited before the sandbox was closed",
      );
      await expect(
        fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
      expect(
        await (await fetch(`http://127.0.0.1:${unrelatedPort}/`)).text(),
      ).toBe("preserved");
    },
  );
});
