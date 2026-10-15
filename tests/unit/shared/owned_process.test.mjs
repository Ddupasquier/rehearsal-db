import { spawn } from "node:child_process";
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

describe("owned-process output boundaries", () => {
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
