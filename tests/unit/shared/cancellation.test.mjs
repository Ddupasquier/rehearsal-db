import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getOperationCancellationSignal,
  runWithOperationCancellation,
  throwIfOperationCancelled,
  withOperationCancellationShield,
} from "../../../dist/src/shared/cancellation.mjs";
import { runOwnedProcess } from "../../../dist/src/shared/owned_process.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const waitForPath = async (path) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}.`);
};

describe("mutating operation cancellation", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"])(
    "returns the stable cancellation contract for %s",
    async (requestedSignal) => {
      const signals = new EventEmitter();
      const operation = runWithOperationCancellation({
        signalTarget: signals,
        task: async () => {
          signals.emit(requestedSignal);
          throwIfOperationCancelled();
        },
      });
      await expect(operation).rejects.toMatchObject({
        category: "operation_cancelled",
        code: "OPERATION_CANCELLED",
        exitCode: 130,
        context: { signal: requestedSignal },
      });
    },
  );

  it("normalizes repeated supported signals and removes every listener", async () => {
    const signals = new EventEmitter();
    const operation = runWithOperationCancellation({
      signalTarget: signals,
      task: async (signal) => {
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        throwIfOperationCancelled();
      },
    });

    signals.emit("SIGINT");
    signals.emit("SIGINT");
    await expect(operation).rejects.toMatchObject({
      category: "operation_cancelled",
      code: "OPERATION_CANCELLED",
      exitCode: 130,
      context: { signal: "SIGINT" },
    });
    expect(signals.eventNames()).toEqual([]);
  });

  it("shields package-owned rollback from an already requested cancellation", async () => {
    const signals = new EventEmitter();
    let shieldedSignal;
    const operation = runWithOperationCancellation({
      signalTarget: signals,
      task: async () => {
        signals.emit("SIGTERM");
        await withOperationCancellationShield(async () => {
          shieldedSignal = getOperationCancellationSignal();
        });
        throwIfOperationCancelled();
      },
    });

    await expect(operation).rejects.toMatchObject({
      category: "operation_cancelled",
      context: { signal: "SIGTERM" },
    });
    expect(shieldedSignal).toBeUndefined();
  });

  it("does not mask a rollback failure with a clean cancellation result", async () => {
    const signals = new EventEmitter();
    const cleanupFailure = new AggregateError(
      [new Error("interrupted"), new Error("cleanup failed")],
      "rollback failed",
    );
    const operation = runWithOperationCancellation({
      signalTarget: signals,
      task: async () => {
        signals.emit("SIGTERM");
        throw cleanupFailure;
      },
    });

    await expect(operation).rejects.toBe(cleanupFailure);
  });

  it("forwards cancellation only to the owned detached process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-cancellation-"));
    roots.push(root);
    const managerPath = join(root, "manager.mjs");
    const workerPath = join(root, "worker.mjs");
    const managerStopped = join(root, "manager-stopped");
    const workerStopped = join(root, "worker-stopped");
    const ready = join(root, "ready");
    const workerReady = join(root, "worker-ready");
    await writeFile(
      workerPath,
      `import { writeFileSync } from "node:fs";
const stop = () => { writeFileSync(${JSON.stringify(workerStopped)}, "yes"); process.exit(0); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
writeFileSync(${JSON.stringify(workerReady)}, "yes");
setInterval(() => {}, 1000);
`,
    );
    await writeFile(
      managerPath,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(workerPath)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(ready)}, "yes");
const stop = () => { writeFileSync(${JSON.stringify(managerStopped)}, "yes"); setTimeout(() => process.exit(0), 25); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
setInterval(() => {}, 1000);
`,
    );
    const signals = new EventEmitter();
    const operation = runWithOperationCancellation({
      signalTarget: signals,
      task: async (signal) => {
        const running = runOwnedProcess({
          command: process.execPath,
          args: [managerPath],
          cwd: root,
          env: process.env,
          signal,
          cancellationGraceMs: 2_000,
        });
        await Promise.all([waitForPath(ready), waitForPath(workerReady)]);
        signals.emit("SIGINT");
        await running;
        throwIfOperationCancelled();
      },
    });

    await expect(operation).rejects.toMatchObject({
      category: "operation_cancelled",
    });
    await Promise.all([
      waitForPath(managerStopped),
      waitForPath(workerStopped),
    ]);
  });
});
