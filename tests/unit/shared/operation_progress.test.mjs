import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationCancelledError } from "../../../dist/src/shared/cancellation.mjs";
import { RehearsalError } from "../../../dist/src/shared/diagnostics.mjs";
import { migrationFailureDiagnostic } from "../../../dist/src/runtime/migration_failure.mjs";
import {
  acquireProjectOperation,
  inspectProjectOperationState,
} from "../../../dist/src/shared/operation_guard.mjs";
import {
  trackOperationStage,
  withOperationProgress,
} from "../../../dist/src/shared/operation_progress.mjs";
import {
  parseOperationProgressSnapshot,
  refreshLiveOperationProgress,
} from "../../../dist/src/shared/operation_progress_contract.mjs";

const roots = [];
const operations = new Set();
const ownedHistoryFiles = [];
const rootForTest = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-progress-test-"));
  roots.push(root);
  const projectHash = createHash("sha256")
    .update(await realpath(root))
    .digest("hex");
  ownedHistoryFiles.push(
    join(tmpdir(), "rehearsal-db-operation-activity", `${projectHash}.json`),
  );
  return root;
};
const acquire = async (root, command = "run") => {
  const operation = await acquireProjectOperation({
    projectRoot: root,
    command,
  });
  operations.add(operation);
  return operation;
};
const release = async (operation) => {
  await operation.release();
  operations.delete(operation);
};

afterEach(async () => {
  for (const operation of operations)
    await operation.release().catch(() => undefined);
  operations.clear();
  for (const path of ownedHistoryFiles.splice(0))
    await rm(path, { force: true });
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("bounded owned operation progress", () => {
  it("passes through read-only work without creating synthetic telemetry", async () => {
    const root = await rootForTest();
    await expect(
      withOperationProgress({
        operation: null,
        task: () =>
          trackOperationStage({ phase: "application-proof" }, async () => 7),
      }),
    ).resolves.toBe(7);
    await expect(
      inspectProjectOperationState({ projectRoot: root }),
    ).resolves.toMatchObject({ state: "idle", operation: null, recent: [] });
  });

  it("reports real current and completed stages, archives private safe history after release", async () => {
    const root = await rootForTest();
    const operation = await acquire(root);
    const secret = "private-output-must-never-be-captured";
    await expect(
      withOperationProgress({
        operation,
        task: async () => {
          await trackOperationStage(
            { phase: "runtime-lifecycle", target: "primary" },
            async () => {
              const activity = await inspectProjectOperationState({
                projectRoot: root,
              });
              expect(activity.operation.progress).toMatchObject({
                state: "running",
                currentStage: {
                  phase: "runtime-lifecycle",
                  target: "primary",
                  state: "running",
                },
                completedStages: [],
              });
              expect(
                activity.operation.progress.currentStage.durationMilliseconds,
              ).toBeGreaterThanOrEqual(0);
              return secret;
            },
          );
          return 42;
        },
      }),
    ).resolves.toBe(42);
    const active = await inspectProjectOperationState({ projectRoot: root });
    expect(active.operation.progress).toMatchObject({
      state: "completed",
      currentStage: null,
      completedStages: [{ phase: "runtime-lifecycle", state: "completed" }],
    });
    expect(active.operation.progress.events.map((event) => event.code)).toEqual(
      [
        "operation.started",
        "stage.started",
        "stage.completed",
        "operation.completed",
      ],
    );
    expect(JSON.stringify(active)).not.toContain(secret);
    expect(active.operation).not.toHaveProperty("pid");
    expect(active.operation).not.toHaveProperty("token");
    await release(operation);
    const finished = await inspectProjectOperationState({ projectRoot: root });
    expect(finished).toMatchObject({
      state: "idle",
      operation: null,
      recent: [
        {
          kind: "run",
          progress: { operationId: operation.id, state: "completed" },
        },
      ],
    });
    expect((await lstat(ownedHistoryFiles.at(-1))).mode & 0o077).toBe(0);
    expect(JSON.stringify(finished)).not.toContain(secret);
  });

  it("retains safe failed and cancelled stages without capturing exception text", async () => {
    for (const [error, state] of [
      [new Error("secret://credential@example.invalid"), "failed"],
      [createOperationCancelledError("SIGINT"), "cancelled"],
    ]) {
      const root = await rootForTest();
      const operation = await acquire(root);
      await expect(
        withOperationProgress({
          operation,
          task: () =>
            trackOperationStage({ phase: "application-proof" }, async () => {
              throw error;
            }),
        }),
      ).rejects.toBe(error);
      const active = await inspectProjectOperationState({ projectRoot: root });
      expect(active.operation.progress).toMatchObject({
        state,
        currentStage: { phase: "application-proof", state },
        completedStages: [],
      });
      expect(JSON.stringify(active)).not.toContain("credential");
      expect(active.operation.progress.events.at(-1).code).toBe(
        `operation.${state}`,
      );
      await release(operation);
      expect(
        (await inspectProjectOperationState({ projectRoot: root })).recent[0]
          .progress.state,
      ).toBe(state);
    }
  });

  it("keeps concurrent project contexts separate and refuses same-context replacement", async () => {
    const firstRoot = await rootForTest();
    const secondRoot = await rootForTest();
    const first = await acquire(firstRoot);
    const second = await acquire(secondRoot);
    await Promise.all(
      [
        [first, firstRoot, "primary"],
        [second, secondRoot, "publication"],
      ].map(([operation, root, target]) =>
        withOperationProgress({
          operation,
          task: () =>
            trackOperationStage(
              { phase: "runtime-verification", target },
              async () => {
                expect(
                  (await inspectProjectOperationState({ projectRoot: root }))
                    .operation.progress.currentStage.target,
                ).toBe(target);
                await expect(
                  withOperationProgress({ operation, task: async () => null }),
                ).rejects.toThrow("already active");
              },
            ),
        }),
      ),
    );
    expect(
      (await inspectProjectOperationState({ projectRoot: firstRoot })).operation
        .progress.completedStages[0].target,
    ).toBe("primary");
    expect(
      (await inspectProjectOperationState({ projectRoot: secondRoot }))
        .operation.progress.completedStages[0].target,
    ).toBe("publication");
    await release(first);
    await release(second);
  });

  it("archives only fixed migration diagnosis separately from legacy progress receipt keys", async () => {
    const root = await rootForTest();
    const diagnostic = migrationFailureDiagnostic({
      provider: "postgresql",
      sqlState: "23514",
    });
    const operation = await acquire(root);
    const failure = new RehearsalError({
      category: "migration_candidate_failure",
      code: "migration_execution_failed",
      message: "SECRET_SQL_AND_ROWS",
      context: { migrationFailure: diagnostic },
    });
    await expect(
      withOperationProgress({
        operation,
        task: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    const otherRoot = await rootForTest();
    const other = await acquire(otherRoot);
    const active = await inspectProjectOperationState({ projectRoot: root });
    await expect(
      other.writeProgress(active.operation.progress, diagnostic),
    ).rejects.toThrow();
    await release(other);
    expect(
      (await inspectProjectOperationState({ projectRoot: otherRoot }))
        .recentFailures,
    ).toEqual([]);
    await release(operation);
    const activity = await inspectProjectOperationState({ projectRoot: root });
    expect(activity.recentFailures).toEqual([
      { operationId: operation.id, diagnostic },
    ]);
    expect(Object.keys(activity.recent[0]).sort()).toEqual([
      "kind",
      "progress",
      "rehearsalVersion",
    ]);
    expect(activity.recent[0].progress).not.toHaveProperty("migrationFailure");
    expect(JSON.stringify(activity)).not.toContain("SECRET_SQL_AND_ROWS");
    const next = await acquire(root);
    await withOperationProgress({ operation: next, task: async () => null });
    await release(next);
    expect(
      (await inspectProjectOperationState({ projectRoot: root }))
        .recentFailures,
    ).toEqual(activity.recentFailures);
  });

  it("does not retain arbitrary or malformed error context or lend another project its diagnosis", async () => {
    const diagnostic = migrationFailureDiagnostic({
      provider: "supabase",
      sqlState: "42601",
    });
    for (const failure of [
      Object.assign(new Error("SECRET"), {
        context: { migrationFailure: diagnostic },
      }),
      new RehearsalError({
        category: "migration_candidate_failure",
        code: "invalid_context",
        message: "SECRET",
        context: { migrationFailure: { ...diagnostic, summary: "SECRET" } },
      }),
      new RehearsalError({
        category: "migration_candidate_failure",
        code: "invalid_context",
        message: "SECRET",
        context: { migrationFailure: { ...diagnostic, sql: "SECRET" } },
      }),
      new RehearsalError({
        category: "operation_cancelled",
        code: "operation_cancelled",
        message: "Cancelled",
        context: { migrationFailure: diagnostic },
      }),
    ]) {
      const root = await rootForTest();
      const operation = await acquire(root);
      await expect(
        withOperationProgress({
          operation,
          task: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      await release(operation);
      const activity = await inspectProjectOperationState({
        projectRoot: root,
      });
      expect(activity.recentFailures).toEqual([]);
      expect(JSON.stringify(activity)).not.toContain("SECRET");
    }
    expect(
      (await inspectProjectOperationState({ projectRoot: await rootForTest() }))
        .recentFailures,
    ).toEqual([]);
  });

  it("retains diagnosis from only the bounded original-error branch of cleanup aggregates", async () => {
    const diagnostic = migrationFailureDiagnostic({
      provider: "postgresql",
      sqlState: "23514",
    });
    const original = new RehearsalError({
      category: "migration_candidate_failure",
      code: "migration_execution_failed",
      message: "SECRET_ORIGINAL",
      context: { migrationFailure: diagnostic },
    });
    const wrap = (error, depth) => {
      for (let index = 0; index < depth; index += 1)
        error = new AggregateError(
          [error, new Error("SECRET_CLEANUP")],
          "Cleanup incomplete",
        );
      return error;
    };
    const cancelled = new RehearsalError({
      category: "operation_cancelled",
      code: "OPERATION_CANCELLED",
      message: "Cancelled",
      context: { migrationFailure: diagnostic },
    });
    for (const [error, retained] of [
      [wrap(original, 1), true],
      [wrap(original, 4), true],
      [wrap(original, 5), false],
      [
        new AggregateError(
          [new Error("SECRET_UNKNOWN"), original],
          "Cleanup failed",
        ),
        false,
      ],
      [new AggregateError([], "Missing original"), false],
      [
        new AggregateError(
          [new Error("Unknown", { cause: original })],
          "Unknown cause",
        ),
        false,
      ],
      [wrap(cancelled, 1), false],
    ]) {
      const root = await rootForTest();
      const operation = await acquire(root);
      await expect(
        withOperationProgress({
          operation,
          task: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      await release(operation);
      const activity = await inspectProjectOperationState({
        projectRoot: root,
      });
      expect(activity.recent[0].progress.state).toBe("failed");
      expect(activity.recentFailures).toEqual(
        retained ? [{ operationId: operation.id, diagnostic }] : [],
      );
      expect(JSON.stringify(activity)).not.toContain("SECRET");
    }
  });

  it("refuses corrupted private diagnosis without replacing its history", async () => {
    const root = await rootForTest();
    const operation = await acquire(root);
    await withOperationProgress({ operation, task: async () => null });
    await release(operation);
    const path = ownedHistoryFiles.at(-1);
    const history = JSON.parse(await readFile(path, "utf8"));
    history.recent[0].migrationFailure = migrationFailureDiagnostic({
      provider: "postgresql",
      sqlState: "42601",
    });
    const bytes = JSON.stringify(history);
    await writeFile(path, bytes, { mode: 0o600 });
    const activity = await inspectProjectOperationState({ projectRoot: root });
    expect(activity.recent).toBeNull();
    expect(activity.recentFailures).toBeNull();
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("bounds stage/event history and rejects arbitrary metadata before executing a stage", async () => {
    const root = await rootForTest();
    const operation = await acquire(root);
    let unsafeTaskRan = false;
    await withOperationProgress({
      operation,
      task: async () => {
        await expect(
          trackOperationStage(
            { phase: "raw-private-error", target: "primary" },
            async () => {
              unsafeTaskRan = true;
            },
          ),
        ).rejects.toThrow("unsafe");
        await expect(
          trackOperationStage(
            { phase: "application-proof", target: "postgres://private" },
            async () => {
              unsafeTaskRan = true;
            },
          ),
        ).rejects.toThrow("unsafe");
        for (let index = 0; index < 25; index += 1)
          await trackOperationStage(
            { phase: "http-proof", target: "primary" },
            async () => null,
          );
      },
    });
    expect(unsafeTaskRan).toBe(false);
    const progress = (await inspectProjectOperationState({ projectRoot: root }))
      .operation.progress;
    expect(progress.completedStages).toHaveLength(20);
    expect(progress.events).toHaveLength(40);
    expect(progress.truncated).toEqual({ stages: true, events: true });
    expect(progress.completedStages[0].id).toBe(6);
    await release(operation);
  });

  it("rejects raw fields and contradictory static events, and refreshes only live durations", async () => {
    const root = await rootForTest();
    const operation = await acquire(root);
    let live;
    await withOperationProgress({
      operation,
      task: () =>
        trackOperationStage({ phase: "interactive-session" }, async () => {
          live = (await inspectProjectOperationState({ projectRoot: root }))
            .operation.progress;
        }),
    });
    expect(() =>
      parseOperationProgressSnapshot({ ...live, rawOutput: "secret" }),
    ).toThrow("safe schema");
    expect(() =>
      parseOperationProgressSnapshot({
        ...live,
        events: [{ ...live.events[0], phase: "application-start" }],
      }),
    ).toThrow("safe schema");
    expect(() =>
      parseOperationProgressSnapshot({ ...live, state: "failed" }),
    ).toThrow("contradictory");
    const refreshed = refreshLiveOperationProgress(
      live,
      Date.parse(live.startedAt) + 5000,
    );
    expect(refreshed.elapsedMilliseconds).toBeGreaterThanOrEqual(5000);
    expect(refreshed.updatedAt).toBe(live.updatedAt);
    const finished = (await inspectProjectOperationState({ projectRoot: root }))
      .operation.progress;
    expect(refreshLiveOperationProgress(finished)).toBe(finished);
    await release(operation);
  });

  it("reports unavailable history instead of trusting another project or public file", async () => {
    const root = await rootForTest();
    const operation = await acquire(root);
    await withOperationProgress({ operation, task: async () => null });
    await release(operation);
    const history = ownedHistoryFiles.at(-1);
    const original = await readFile(history, "utf8");
    const changed = JSON.parse(original);
    changed.projectHash = "f".repeat(64);
    await writeFile(history, JSON.stringify(changed), { mode: 0o600 });
    expect(
      (await inspectProjectOperationState({ projectRoot: root })).recent,
    ).toBeNull();
    await writeFile(history, original);
    await chmod(history, 0o644);
    expect(
      (await inspectProjectOperationState({ projectRoot: root })).recent,
    ).toBeNull();
    await chmod(history, 0o600);
    expect(
      (await inspectProjectOperationState({ projectRoot: root })).recent,
    ).toHaveLength(1);
  });

  it("does not manufacture completed history for an uninstrumented or synchronous release", async () => {
    const root = await rootForTest();
    const operation = await acquire(root, "open");
    operation.releaseSync();
    operations.delete(operation);
    expect(
      (await inspectProjectOperationState({ projectRoot: root })).recent,
    ).toEqual([]);
  });

  it("retains at most twenty actually completed operations for one project", async () => {
    const root = await rootForTest();
    const ids = [];
    for (let index = 0; index < 22; index += 1) {
      const operation = await acquire(root);
      ids.push(operation.id);
      if (index === 0) {
        await expect(
          withOperationProgress({
            operation,
            task: async () => {
              throw new RehearsalError({
                category: "migration_candidate_failure",
                code: "migration_failed",
                message: "Failed",
                context: {
                  migrationFailure: migrationFailureDiagnostic({
                    provider: "postgresql",
                    sqlState: "42601",
                  }),
                },
              });
            },
          }),
        ).rejects.toBeInstanceOf(RehearsalError);
      } else await withOperationProgress({ operation, task: async () => null });
      await release(operation);
    }
    const recent = (await inspectProjectOperationState({ projectRoot: root }))
      .recent;
    expect(recent).toHaveLength(20);
    expect(recent.map((entry) => entry.progress.operationId)).toEqual(
      ids.slice(-20),
    );
    expect(
      (await inspectProjectOperationState({ projectRoot: root }))
        .recentFailures,
    ).toEqual([]);
  });
});
