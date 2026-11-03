import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
