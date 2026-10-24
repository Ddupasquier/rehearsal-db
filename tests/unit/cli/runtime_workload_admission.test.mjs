import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRuntimeWorkloadAdmission } from "../../../dist/src/cli/runtime_workload_admission.mjs";
import { inspectWorkloads } from "../../../dist/src/runtime/workload_queue.mjs";

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of roots.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe.skipIf(process.platform === "win32")(
  "CLI lifecycle admission boundary",
  () => {
    it("holds admission for each heavy runtime phase and releases before returning", async () => {
      const directory = await mkdtemp(join(tmpdir(), "runtime-admission-"));
      roots.push(directory);
      vi.stubEnv("REHEARSAL_USER_STATE_DIRECTORY", directory);
      for (const command of ["start", "reset", "run", "migrate"]) {
        await expect(
          withRuntimeWorkloadAdmission({
            policy: { enabled: true, waitTimeoutSeconds: 0 },
            command,
            json: true,
            execute: async () => {
              const { entries } = await inspectWorkloads();
              expect(entries).toHaveLength(1);
              expect(entries[0]).toMatchObject({
                command,
                phase: "held",
                owner: "alive",
              });
              return command;
            },
          }),
        ).resolves.toBe(command);
        expect((await inspectWorkloads()).entries).toEqual([]);
      }
    });
    it("never queues stop, discard, read-only commands or an indefinite open session", async () => {
      vi.stubEnv("REHEARSAL_USER_STATE_DIRECTORY", "invalid-relative-state");
      for (const command of [
        "stop",
        "discard",
        "verify",
        "status",
        "open",
        "cleanup",
      ])
        await expect(
          withRuntimeWorkloadAdmission({
            policy: { enabled: true },
            command,
            json: true,
            execute: async () => command,
          }),
        ).resolves.toBe(command);
      for (const policy of [undefined, { enabled: false }])
        await expect(
          withRuntimeWorkloadAdmission({
            policy,
            command: "reset",
            json: true,
            execute: async () => "unchanged",
          }),
        ).resolves.toBe("unchanged");
    });
  },
);
