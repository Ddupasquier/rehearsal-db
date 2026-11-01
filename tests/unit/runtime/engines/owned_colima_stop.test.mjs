import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runOwnedColimaStop } from "../../../../dist/src/runtime/engines/owned_colima_stop.mjs";

afterEach(() => vi.useRealTimers());
const controlledChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
  });
describe("bounded Colima stop subprocess retirement", () => {
  it("retires held pipes without ever signalling a leader after known exit", async () => {
    vi.useFakeTimers();
    const child = controlledChild(),
      signals = [];
    const result = runOwnedColimaStop(
      "/unused",
      {},
      {
        spawnImplementation: () => child,
        signalImplementation: (_child, signal) => signals.push(signal),
        timeoutMs: 2000,
      },
    );
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({
      status: 0,
      exitObserved: true,
      closeObserved: false,
      retired: true,
      error: { code: "ECLOSE_UNCONFIRMED" },
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(signals).toEqual([]);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a pending escalation when TERM is followed by exit but not close", async () => {
    vi.useFakeTimers();
    const child = controlledChild(),
      signals = [];
    const result = runOwnedColimaStop(
      "/unused",
      {},
      {
        spawnImplementation: () => child,
        signalImplementation: (_child, signal) => {
          signals.push(signal);
          child.emit("exit", null, signal);
        },
        timeoutMs: 50,
      },
    );
    await vi.advanceTimersByTimeAsync(1050);
    expect(await result).toMatchObject({
      exitObserved: true,
      closeObserved: false,
      error: { code: "ETIMEDOUT" },
    });
    expect(signals).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("caps retained output and preserves a clean close separately from command failure", async () => {
    vi.useFakeTimers();
    const child = controlledChild();
    const result = runOwnedColimaStop(
      "/unused",
      {},
      {
        spawnImplementation: () => child,
        signalImplementation: () => {},
        timeoutMs: 2000,
      },
    );
    child.stdout.write("x".repeat(65537));
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    const observed = await result;
    expect(observed.stdout.length).toBeLessThanOrEqual(65536);
    expect(observed.stdoutByteCount).toBe(65537);
    expect(observed).toMatchObject({
      status: 1,
      exitObserved: true,
      closeObserved: true,
      retired: false,
      error: { code: "ENOBUFS" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.skipIf(process.platform === "win32")(
    "bounds a real detached pipe holder and leaves only the exact test-owned holder for witnessed cleanup",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "colima-pipe-holder-")),
        token = randomUUID(),
        ready = join(root, "owned-holder.json");
      const holder = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,token:${JSON.stringify(token)}}),{mode:0o600}); setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000).unref();`;
      const source = `#!${process.execPath}
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['--input-type=commonjs','--eval',${JSON.stringify(holder)}],{detached:true,stdio:['ignore',process.stdout,process.stderr]});
child.unref();
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0)}},10);
`;
      try {
        // Unit scratch is below the Core type:module package; this fake CLI explicitly owns CJS semantics.
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ private: true, type: "commonjs" }),
          { mode: 0o600 },
        );
        await writeFile(join(root, "colima"), source, { mode: 0o700 });
        const started = performance.now();
        const result = await runOwnedColimaStop(
          root,
          { PATH: root, HOME: root },
          { timeoutMs: 5000 },
        );
        expect(performance.now() - started).toBeLessThan(8000);
        expect(result).toMatchObject({
          status: 0,
          exitObserved: true,
          closeObserved: false,
          retired: true,
          error: { code: "ECLOSE_UNCONFIRMED" },
        });
        const receipt = JSON.parse(await readFile(ready, "utf8"));
        expect(receipt.token).toBe(token);
        expect(Number.isSafeInteger(receipt.pid)).toBe(true);
      } finally {
        const details = await lstat(ready).catch(() => null);
        if (details) {
          expect(
            details.isFile() &&
              !details.isSymbolicLink() &&
              (details.mode & 0o077) === 0,
          ).toBe(true);
          const receipt = JSON.parse(await readFile(ready, "utf8"));
          expect(receipt.token).toBe(token);
          expect(Number.isSafeInteger(receipt.pid) && receipt.pid > 1).toBe(
            true,
          );
          let args = "";
          try {
            args = execFileSync(
              "/bin/ps",
              ["-ww", "-p", String(receipt.pid), "-o", "args="],
              { encoding: "utf8", timeout: 1000 },
            );
          } catch {}
          if (args) {
            expect(args.includes(token) && args.includes(ready)).toBe(true);
            process.kill(receipt.pid, "SIGKILL");
          }
          let gone = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              process.kill(receipt.pid, 0);
              const state = execFileSync(
                "/bin/ps",
                ["-p", String(receipt.pid), "-o", "stat="],
                { encoding: "utf8", timeout: 1000 },
              );
              if (state.trim().startsWith("Z")) {
                gone = true;
                break;
              }
            } catch {
              gone = true;
              break;
            }
            await new Promise((done) => setTimeout(done, 10));
          }
          expect(gone).toBe(true);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});
