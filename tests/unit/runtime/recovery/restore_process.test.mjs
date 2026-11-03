import { expect, it, vi } from "vitest";
import { runOwnedRestore } from "../../../../dist/src/runtime/recovery/restore_process.mjs";
import {
  buildRestoreSqlPrefix,
  buildRestoreSqlSuffix,
} from "../../../../dist/src/runtime/recovery/restore.mjs";
import { runOwnedProcess } from "../../../../dist/src/shared/owned_process.mjs";
import { createCleanProcessEnvironment } from "../../../../dist/src/shared/process_environment.mjs";
import { runWithOperationCancellation } from "../../../../dist/src/shared/cancellation.mjs";
import { EventEmitter } from "node:events";

const outcome = (change = {}) => ({
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutByteCount: 0,
  stderrByteCount: 0,
  ...change,
});
const options = (change = {}) => ({
  args: ["synthetic-owned-restore"],
  cwd: process.cwd(),
  environment: {},
  input: async function* () {
    yield "private restore bytes";
  },
  ...change,
});

it.each(["postgresql", "supabase"])(
  "streams the existing %s prefix, encoded rows and provider-specific suffix unchanged",
  async (target) => {
    const prefix = buildRestoreSqlPrefix();
    const manifest = {
      tables: [
        {
          name: "profiles",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "user_id",
              action: "PSEUDONYMIZE",
              generated: "NEVER",
              identity: "NO",
              foreignKey: { schema: "auth", table: "users", column: "id" },
            },
          ],
        },
      ],
    };
    const suffix = buildRestoreSqlSuffix({
      manifest,
      tableCounts: { profiles: 1 },
      restoreSupabaseAuth: target === "supabase",
    });
    const chunks = [prefix, "public\tcanary\te30=\n", suffix];
    let received = "";
    const runProcessImplementation = async (supplied) => {
      expect(supplied).toMatchObject({
        command: "docker",
        args: ["synthetic-owned-restore"],
        cancellationGraceMs: 1000,
        closeTimeoutMilliseconds: 1000,
      });
      for await (const chunk of supplied.input) received += chunk;
      return outcome();
    };
    await runOwnedRestore(
      options({
        input: async function* () {
          yield* chunks;
        },
        runProcessImplementation,
      }),
    );
    expect(received).toBe(chunks.join(""));
    expect(suffix.includes("insert into auth.users")).toBe(
      target === "supabase",
    );
  },
);
it.each([
  { status: 1, stderr: "PRIVATE_PROVIDER_ERROR" },
  { signal: "SIGTERM", status: null },
  { error: Error("PRIVATE_TRANSPORT_ERROR") },
])(
  "refuses failed or uncertain restore transport with redacted diagnostics",
  async (change) => {
    await expect(
      runOwnedRestore(
        options({ runProcessImplementation: async () => outcome(change) }),
      ),
    ).rejects.toThrow("local Rehearsal restore failed");
    await expect(
      runOwnedRestore(
        options({ runProcessImplementation: async () => outcome(change) }),
      ),
    ).rejects.not.toThrow("PRIVATE_");
  },
);
it("enforces a real owned-stream deadline and aborts the input producer", async () => {
  let boundSignal;
  const start = Date.now();
  await expect(
    runOwnedRestore(
      options({
        timeoutMilliseconds: 80,
        input: (signal) => {
          boundSignal = signal;
          return (async function* () {
            while (!signal.aborted) {
              yield "x";
              await new Promise((done) => setTimeout(done, 10));
            }
          })();
        },
        runProcessImplementation: (supplied) =>
          runOwnedProcess({
            ...supplied,
            command: process.execPath,
            args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
            env: createCleanProcessEnvironment(),
          }),
      }),
    ),
  ).rejects.toThrow();
  expect(boundSignal.aborted).toBe(true);
  expect(Date.now() - start).toBeLessThan(3000);
});
it("does not let operation cancellation erase unconfirmed restore cleanup", async () => {
  const signals = new EventEmitter();
  let failure;
  try {
    await runWithOperationCancellation({
      signalTarget: signals,
      input: null,
      task: () =>
        runOwnedRestore(
          options({
            runProcessImplementation: async () => {
              signals.emit("SIGINT");
              throw Error("PRIVATE_UNCONFIRMED");
            },
          }),
        ),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.message).toContain("unconfirmed");
  expect(failure.message).not.toContain("PRIVATE_");
});
