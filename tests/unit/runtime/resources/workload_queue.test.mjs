import { fork } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWorkload,
  inspectWorkloads,
  recoverWorkloads,
  withWorkloadAdmission,
} from "../../../../dist/src/runtime/resources/workload_queue.mjs";
import { workloadQueueDirectory } from "../../../../dist/src/runtime/resources/workload_queue_location.mjs";
import { WorkloadQueueStore } from "../../../../dist/src/runtime/resources/workload_queue_store.mjs";

const roots = [];
const children = new Set();
const leases = [];
const root = async () => {
  const value = await mkdtemp(join(tmpdir(), "workload-queue-"));
  roots.push(value);
  return value;
};
const acquire = async (stateDirectory, options = {}) => {
  const lease = await acquireWorkload({
    stateDirectory,
    command: "reset",
    waitTimeoutSeconds: 0,
    ...options,
  });
  leases.push(lease);
  return lease;
};
const worker = async (stateDirectory) => {
  const temporary = await root();
  const child = fork(
    fileURLToPath(
      new URL("../../../helpers/workload_queue_worker.mjs", import.meta.url),
    ),
    [],
    {
      env: {
        ...process.env,
        TMPDIR: temporary,
        REHEARSAL_USER_STATE_DIRECTORY: stateDirectory,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.add(child);
  const messages = [];
  const waiters = [];
  child.on("message", (message) => {
    messages.push(message);
    for (const notify of waiters.splice(0)) notify();
  });
  return {
    child,
    wait: async (state) => {
      const deadline = AbortSignal.timeout(5000);
      for (;;) {
        const found = messages.find((message) => message.state === state);
        if (found) return found;
        const error = messages.find((message) => message.state === "error");
        if (error) throw new Error(error.message);
        await new Promise((resolve, reject) => {
          const abort = () =>
            reject(new Error(`Worker did not reach ${state}.`));
          deadline.addEventListener("abort", abort, { once: true });
          waiters.push(() => {
            deadline.removeEventListener("abort", abort);
            resolve();
          });
        });
      }
    },
  };
};
const stop = async (child, signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (signal) child.kill(signal);
  else child.send("release");
  await exited;
  children.delete(child);
};

afterEach(async () => {
  for (const child of children) await stop(child, "SIGKILL");
  for (const lease of leases.splice(0)) await lease.release().catch(() => {});
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "local-user workload queue",
  () => {
    it("serializes explicit engine shutdown with participating startup in both directions", async () => {
      const stateDirectory = await root();
      const shutdown = await acquire(stateDirectory, {
        command: "engine-stop",
      });
      expect(
        (await inspectWorkloads({ stateDirectory })).entries[0].command,
      ).toBe("engine-stop");
      await expect(
        acquire(stateDirectory, { command: "start" }),
      ).rejects.toThrow("wait expired");
      await shutdown.release();
      const startup = await acquire(stateDirectory, { command: "start" });
      await expect(
        acquire(stateDirectory, { command: "engine-stop" }),
      ).rejects.toThrow("wait expired");
      expect((await inspectWorkloads({ stateDirectory })).entries).toHaveLength(
        1,
      );
      await startup.release();
      expect((await inspectWorkloads({ stateDirectory })).entries).toEqual([]);
    });
    it("admits only one of four simultaneous participants at a time", async () => {
      const stateDirectory = await root();
      const participants = await Promise.all(
        Array.from({ length: 4 }, () => worker(stateDirectory)),
      );
      const pending = new Set(participants);
      while (pending.size) {
        const holder = await Promise.any(
          [...pending].map(async (participant) => {
            await participant.wait("held");
            return participant;
          }),
        );
        const view = await inspectWorkloads({ stateDirectory });
        expect(
          view.entries.filter((entry) => entry.phase === "held"),
        ).toHaveLength(1);
        expect(view.entries.find((entry) => entry.phase === "held").pid).toBe(
          holder.child.pid,
        );
        await stop(holder.child);
        pending.delete(holder);
      }
      expect((await inspectWorkloads({ stateDirectory })).entries).toEqual([]);
    });
    it("is read-only when absent and ignores independent TMPDIRs", async () => {
      const stateDirectory = join(await root(), "absent");
      expect((await inspectWorkloads({ stateDirectory })).entries).toEqual([]);
      await expect(readdir(stateDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const first = await worker(stateDirectory);
      await first.wait("held");
      const second = await worker(stateDirectory);
      await second.wait("waiting");
      const view = await inspectWorkloads({ stateDirectory });
      expect(view.entries.map((entry) => entry.phase).sort()).toEqual([
        "held",
        "queued",
      ]);
      expect(view.capacity).toBe("not-measured");
      await stop(first.child);
      await second.wait("held");
      await stop(second.child);
      expect((await inspectWorkloads({ stateDirectory })).entries).toEqual([]);
    });

    it("bounds waits, removes the expired request and never expires a live holder", async () => {
      const stateDirectory = await root();
      const first = await acquire(stateDirectory);
      await expect(acquire(stateDirectory)).rejects.toThrow("wait expired");
      const view = await inspectWorkloads({ stateDirectory });
      expect(view.entries).toHaveLength(1);
      expect(view.entries[0]).toMatchObject({
        phase: "held",
        owner: "alive",
        recoveryRequired: false,
      });
      expect(view.recoveryDigest).toBeNull();
      await expect(
        recoverWorkloads("0".repeat(64), { stateDirectory }),
      ).rejects.toThrow("changed or is missing");
      await first.release();
      await acquire(stateDirectory);
    });

    it("cancels only a waiting request and preserves the exact holder", async () => {
      const stateDirectory = await root();
      await acquire(stateDirectory);
      const before = (await inspectWorkloads({ stateDirectory })).entries[0];
      const second = await worker(stateDirectory);
      await second.wait("waiting");
      const exited = once(second.child, "exit");
      second.child.send("cancel");
      expect((await second.wait("error")).message).toBe("queue cancelled");
      await exited;
      expect((await inspectWorkloads({ stateDirectory })).entries).toEqual([
        before,
      ]);
    });

    it("requires exact reviewed recovery of a dead holder instead of auto-stealing", async () => {
      const stateDirectory = await root();
      const first = await worker(stateDirectory);
      await first.wait("held");
      await stop(first.child, "SIGKILL");
      const stale = await inspectWorkloads({ stateDirectory });
      expect(stale.entries[0]).toMatchObject({
        phase: "held",
        owner: "dead",
        recoveryRequired: true,
      });
      await expect(acquire(stateDirectory)).rejects.toThrow("wait expired");
      expect((await inspectWorkloads({ stateDirectory })).recoveryDigest).toBe(
        stale.recoveryDigest,
      );
      await expect(
        recoverWorkloads("wrong", { stateDirectory }),
      ).rejects.toThrow("changed or is missing");
      expect(
        await recoverWorkloads(stale.recoveryDigest, { stateDirectory }),
      ).toEqual({ schemaVersion: 1, recovered: 1, databasesChanged: false });
      await expect(
        recoverWorkloads(stale.recoveryDigest, { stateDirectory }),
      ).rejects.toThrow();
      await acquire(stateDirectory);
    });

    it("reclaims dead never-started tickets, but not a held record changed after review", async () => {
      const stateDirectory = await root();
      const first = await worker(stateDirectory);
      await first.wait("held");
      await stop(first.child, "SIGKILL");
      const directory = await workloadQueueDirectory(stateDirectory);
      const file = join(
        directory,
        (await readdir(directory)).find((entry) => entry.startsWith("ticket-")),
      );
      const stale = await inspectWorkloads({ stateDirectory });
      const ticket = JSON.parse(await readFile(file, "utf8"));
      ticket.createdAt = new Date(
        Date.parse(ticket.createdAt) - 1000,
      ).toISOString();
      await writeFile(file, JSON.stringify(ticket));
      await expect(
        recoverWorkloads(stale.recoveryDigest, { stateDirectory }),
      ).rejects.toThrow("changed");
      ticket.phase = "queued";
      await writeFile(file, JSON.stringify(ticket));
      await acquire(stateDirectory);
      expect((await inspectWorkloads({ stateDirectory })).entries).toHaveLength(
        1,
      );
    });

    it("refuses malformed, oversized, symlinked and nonprivate records without deleting them", async () => {
      for (const kind of [
        "malformed",
        "timestamp",
        "oversized",
        "symlink",
        "public",
      ]) {
        const stateDirectory = await root();
        const directory = await workloadQueueDirectory(stateDirectory);
        const store = new WorkloadQueueStore(directory);
        await store.initialize(true);
        const file = join(
          directory,
          "ticket-11111111-1111-1111-1111-111111111111.json",
        );
        if (kind === "symlink")
          await symlink(join(stateDirectory, "absent"), file);
        else {
          await writeFile(
            file,
            kind === "timestamp"
              ? JSON.stringify({
                  schemaVersion: 1,
                  token: "11111111-1111-1111-1111-111111111111",
                  pid: process.pid,
                  command: "reset",
                  phase: "held",
                  number: 1,
                  createdAt:
                    "Sat, 24 Oct 2026 00:00:00 GMT (PRIVATE_INVALID_SENTINEL)",
                })
              : kind === "oversized"
                ? "X".repeat(4097)
                : "PRIVATE_INVALID_SENTINEL",
            { mode: 0o600 },
          );
          if (kind === "public") await chmod(file, 0o644);
        }
        await expect(acquire(stateDirectory)).rejects.toThrow();
        await expect(readdir(directory)).resolves.toContain(
          "ticket-11111111-1111-1111-1111-111111111111.json",
        );
        if (kind === "malformed" || kind === "timestamp")
          await expect(
            inspectWorkloads({ stateDirectory }),
          ).rejects.not.toThrow("PRIVATE_INVALID_SENTINEL");
      }
    });

    it("refuses a changed queue directory and unsafe configured waits", async () => {
      const directory = join(await root(), "queue");
      await mkdir(directory, { mode: 0o700 });
      const store = new WorkloadQueueStore(directory);
      await store.initialize(false);
      await chmod(directory, 0o755);
      await expect(store.list()).rejects.toThrow("changed");
      await expect(
        acquireWorkload({
          stateDirectory: await root(),
          command: "run",
          waitTimeoutSeconds: 301,
        }),
      ).rejects.toThrow("0 to 300");
    });

    it("releases admission after success or failure and does not inspect disabled state", async () => {
      const stateDirectory = await root();
      const options = {
        stateDirectory,
        command: "run",
        waitTimeoutSeconds: 0,
        enabled: true,
      };
      await expect(
        withWorkloadAdmission({ ...options, execute: async () => 42 }),
      ).resolves.toBe(42);
      await expect(
        withWorkloadAdmission({
          ...options,
          execute: async () => {
            throw new Error("owned task failed");
          },
        }),
      ).rejects.toThrow("owned task failed");
      expect((await inspectWorkloads({ stateDirectory })).entries).toEqual([]);
      await expect(
        withWorkloadAdmission({
          ...options,
          enabled: false,
          stateDirectory: "relative",
          execute: async () => "untouched",
        }),
      ).resolves.toBe("untouched");
    });
  },
);
