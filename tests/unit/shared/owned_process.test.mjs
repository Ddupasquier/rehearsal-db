import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runOwnedProcess,
  signalOwnedProcessGroup,
} from "../../../dist/src/shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";

const gone = async (pid) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
};

// Event emitters preserve these exact chunk boundaries instead of relying on OS
// pipe buffering to split a multibyte sequence during a real child invocation.
const runChunkedProcess = (chunks, maxOutputBytes) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const running = runOwnedProcess({
    command: "injected-process",
    args: [],
    cwd: process.cwd(),
    env: {},
    stdin: "ignore",
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    spawnImplementation: () => child,
  });
  for (const [stream, chunk] of chunks) child[stream].emit("data", chunk);
  child.emit("close", 0, null);
  return running;
};

const characters = ["é", "€", "🌱"];
const splitCharacters = characters.flatMap((character) =>
  Array.from({ length: Buffer.byteLength(character) - 1 }, (_, index) => ({
    character,
    split: index + 1,
  })),
);

describe.each(["stdout", "stderr"])(
  "owned-process %s UTF-8 output",
  (stream) => {
    it.each(splitCharacters)(
      "preserves $character split after byte $split",
      async ({ character, split }) => {
        const bytes = Buffer.from(character);
        const result = await runChunkedProcess([
          [stream, Buffer.from("before ")],
          [stream, bytes.subarray(0, split)],
          [stream, bytes.subarray(split)],
          [stream, Buffer.from(" after")],
        ]);
        expect(result[stream]).toBe(`before ${character} after`);
        expect(result[`${stream}ByteCount`]).toBe(
          Buffer.byteLength(`before ${character} after`),
        );
      },
    );

    it.each(characters)(
      "preserves %s delivered one byte at a time",
      async (text) => {
        const bytes = Buffer.from(text);
        const result = await runChunkedProcess(
          [...bytes].map((byte) => [stream, Buffer.from([byte])]),
        );
        expect(result[stream]).toBe(text);
        expect(result[`${stream}ByteCount`]).toBe(bytes.length);
      },
    );

    it.each([
      { bytes: [0xc3] },
      { bytes: [0xe2, 0x82] },
      { bytes: [0xf0, 0x9f, 0x8c] },
    ])(
      "flushes the incomplete trailing bytes $bytes at close",
      async ({ bytes }) => {
        const result = await runChunkedProcess([
          [stream, Buffer.from("before ")],
          ...bytes.map((byte) => [stream, Buffer.from([byte])]),
        ]);
        expect(result[stream]).toBe("before �");
        expect(result[`${stream}ByteCount`]).toBe(7 + bytes.length);
      },
    );

    it("accepts the exact raw byte limit across multibyte chunks", async () => {
      const bytes = Buffer.from(characters.join(""));
      const result = await runChunkedProcess(
        [...bytes].map((byte) => [stream, Buffer.from([byte])]),
        bytes.length,
      );
      expect(result[stream]).toBe(characters.join(""));
      expect(result[`${stream}ByteCount`]).toBe(bytes.length);
    });

    it("refuses raw bytes above the limit even when decoded text would fit", async () => {
      const bytes = Buffer.from(characters.join(""));
      await expect(
        runChunkedProcess(
          [...bytes].map((byte) => [stream, Buffer.from([byte])]),
          bytes.length - 1,
        ),
      ).rejects.toThrow("Owned process output exceeded the safe byte limit.");
    });
  },
);

describe("owned-process output boundaries", () => {
  it("projects a signalling EPERM into controlled uncertainty rather than an unhandled callback", async () => {
    const child = new EventEmitter();
    child.pid = 987654;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end() {},
      write: () => true,
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(Error("PRIVATE_KILL"), { code: "EPERM" });
    });
    try {
      async function* input() {
        throw Error("PRIVATE_INPUT");
      }
      const pending = runOwnedProcess({
        command: "injected",
        args: [],
        cwd: process.cwd(),
        env: {},
        input: input(),
        spawnImplementation: () => child,
      });
      await new Promise((done) => setImmediate(done));
      child.emit("close", 0, null);
      const result = await pending;
      expect(result.error).toBeInstanceOf(AggregateError);
      expect(result.error.message).toContain("signalling is unconfirmed");
      expect(result.error.message).not.toContain("PRIVATE_");
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
    }
  });
  it("does not send a numeric signal after a proven direct-child exit", async () => {
    const child = new EventEmitter();
    child.pid = 987654;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const controller = new AbortController(),
      kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const pending = runOwnedProcess({
        command: "injected",
        args: [],
        cwd: process.cwd(),
        env: {},
        signal: controller.signal,
        cancellationGraceMs: 1,
        spawnImplementation: () => child,
      });
      child.emit("exit", 0, null);
      controller.abort();
      await new Promise((done) => setTimeout(done, 10));
      child.emit("close", 0, null);
      await pending;
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
  it("bounds default legacy closure without signalling an exited leader or escaped pipe holder", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-escaped-pipe-"));
    const stop = join(root, "stop"),
      pidFile = join(root, "worker.pid");
    const worker = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send('ready');const interval=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(interval);process.exit(0)}},10);setTimeout(()=>process.exit(0),10000).unref();`;
    const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:['ignore',1,2,'ipc']});child.once('message',()=>{child.disconnect();child.unref();process.exit(0)});`;
    let workerPid;
    try {
      const started = Date.now();
      await expect(
        runOwnedProcess({
          command: process.execPath,
          args: ["-e", source],
          cwd: root,
          env: createCleanProcessEnvironment(),
          stdin: "ignore",
          // No cancellation/closure options: unchanged public callers receive the finite uncertainty result.
        }),
      ).rejects.toThrow("closure is unconfirmed");
      expect(Date.now() - started).toBeLessThan(4000);
      workerPid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(workerPid, 0)).not.toThrow();
    } finally {
      // This exact synthetic child exits itself; no unknown numeric PID is signalled.
      await writeFile(stop, "done");
      if (!workerPid) workerPid = Number(await readFile(pidFile, "utf8"));
      expect(await gone(workerPid)).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("does not hang on a producer whose pending next never resolves", async () => {
    const controller = new AbortController();
    const input = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => ({ done: true }),
      }),
    };
    const pending = runOwnedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: createCleanProcessEnvironment(),
      input,
      signal: controller.signal,
      cancellationGraceMs: 20,
    });
    setTimeout(() => controller.abort(), 50);
    const outcome = await pending;
    expect(outcome.status).not.toBe(0);
  });

  it("preserves an input failure privately while returning a fixed public message", async () => {
    const original = Error("PRIVATE_INPUT_CANARY");
    async function* input() {
      throw original;
    }
    const result = await runOwnedProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: createCleanProcessEnvironment(),
      input: input(),
      cancellationGraceMs: 20,
    });
    expect(result.error.message).toBe(
      "Owned process input failed; private input is withheld.",
    );
    expect(result.error.cause).toBe(original);
    expect(result.error.message).not.toContain("PRIVATE_INPUT");
  });
  it("keeps interleaved stream decoders and byte limits independent", async () => {
    const result = await runChunkedProcess(
      [
        ["stdout", Buffer.from([0xe2])],
        ["stderr", Buffer.from([0xf0, 0x9f])],
        ["stdout", Buffer.from([0x82])],
        ["stderr", Buffer.from([0x8c])],
        ["stdout", Buffer.from([0xac])],
        ["stderr", Buffer.from([0xb1])],
      ],
      4,
    );
    expect(result).toMatchObject({
      status: 0,
      signal: null,
      stdout: "€",
      stderr: "🌱",
      stdoutByteCount: 3,
      stderrByteCount: 4,
    });
  });

  it.each(["stdout", "stderr"])(
    "reaps a TERM-ignoring owned group after a %s flood",
    async (stream) => {
      const root = await mkdtemp(join(tmpdir(), "rehearsal-output-bound-"));
      let child;
      const workerPath = join(root, "worker.pid");
      const source = `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
process.on('SIGTERM', () => {});
const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {stdio:['ignore','ignore','ignore','ipc']});
worker.once('message', () => { writeFileSync(${JSON.stringify(workerPath)},String(worker.pid));process.${stream}.write('x'.repeat(4096)); });
setInterval(()=>{},1000);
`;
      try {
        const started = Date.now();
        const running = runOwnedProcess({
          command: process.execPath,
          args: ["--input-type=module", "-e", source],
          cwd: root,
          env: createCleanProcessEnvironment(),
          stdin: "ignore",
          maxOutputBytes: 128,
          spawnImplementation: (...args) => {
            child = spawn(...args);
            return child;
          },
        });
        await expect(running).rejects.toThrow(
          "Owned process output exceeded the safe byte limit.",
        );
        expect(Date.now() - started).toBeLessThan(5000);
        const workerPid = Number(await readFile(workerPath, "utf8"));
        expect(await gone(child.pid)).toBe(true);
        expect(await gone(workerPid)).toBe(true);
      } finally {
        if (child) signalOwnedProcessGroup(child, "SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
  it("preserves successful output and does not terminate a normal completion", async () => {
    const result = await runOwnedProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('safe');process.stderr.write('diagnostic')",
      ],
      cwd: process.cwd(),
      env: createCleanProcessEnvironment(),
      stdin: "ignore",
      maxOutputBytes: 128,
    });
    expect(result).toMatchObject({
      status: 0,
      signal: null,
      stdout: "safe",
      stderr: "diagnostic",
    });
  });
});
