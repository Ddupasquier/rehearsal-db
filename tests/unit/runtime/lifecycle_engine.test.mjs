import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertCandidateConfirmation,
  readMatchingRuntimeMarker,
  runRuntimeLifecycle,
  withOwnedRuntimeRollback,
  writeCandidateMigrationReceipt,
  writeRuntimeMarker,
} from "../../../dist/src/runtime/lifecycle_engine.mjs";

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-lifecycle-test-"));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const candidate = {
  version: "20260101000100",
  name: "add_widget_description",
  filename: "20260101000100_add_widget_description.sql",
  fileSha256: "a".repeat(64),
};
const plan = {
  currentFiles: [candidate],
  candidates: [candidate],
  candidateSha256: "b".repeat(64),
};

describe("shared runtime lifecycle engine", () => {
  const createOperations = (order) => {
    const operation = (name) => async () => {
      order.push(name);
    };
    return {
      reset: operation("reset"),
      start: operation("start"),
      status: operation("status"),
      candidates: operation("candidates"),
      migrate: operation("migrate"),
      verify: operation("verify"),
      stop: operation("stop"),
      discard: operation("discard"),
    };
  };

  it("dispatches every target-neutral action and fixes the complete run order", async () => {
    for (const action of [
      "reset",
      "start",
      "status",
      "candidates",
      "migrate",
      "verify",
      "stop",
      "discard",
    ]) {
      const order = [];
      await runRuntimeLifecycle({
        action,
        operations: createOperations(order),
      });
      expect(order).toEqual([action]);
    }

    const order = [];
    await runRuntimeLifecycle({
      action: "run",
      operations: createOperations(order),
    });
    expect(order).toEqual(["reset", "migrate", "verify"]);

    await expect(
      runRuntimeLifecycle({
        action: "unknown",
        operations: createOperations([]),
      }),
    ).rejects.toThrow("Unknown Rehearsal database action: unknown");
  });

  it("rolls back exactly once and preserves the original failure", async () => {
    const failure = new Error("restore failed");
    const rollback = vi.fn(async () => undefined);
    await expect(
      withOwnedRuntimeRollback({
        operation: async () => {
          throw failure;
        },
        rollback,
      }),
    ).rejects.toBe(failure);
    expect(rollback).toHaveBeenCalledOnce();

    rollback.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(
      withOwnedRuntimeRollback({
        operation: async () => {
          throw failure;
        },
        rollback,
      }),
    ).rejects.toBe(failure);
  });

  it("binds confirmation and the persisted receipt to the exact candidate digest", async () => {
    expect(() =>
      assertCandidateConfirmation({ plan, confirmation: plan.candidateSha256 }),
    ).not.toThrow();
    expect(() =>
      assertCandidateConfirmation({ plan, confirmation: "wrong" }),
    ).toThrow("exact SHA-256");

    const fixture = await createFixture();
    const path = join(fixture.root, "runtime", "candidate-receipt.json");
    await mkdir(join(fixture.root, "runtime"));
    await writeCandidateMigrationReceipt({
      path,
      target: "postgresql",
      baseline: { generationId: "baseline-1" },
      plan,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      formatVersion: 1,
      target: "postgresql",
      baselineGenerationId: "baseline-1",
      candidateSha256: plan.candidateSha256,
      candidates: [
        { filename: candidate.filename, sha256: candidate.fileSha256 },
      ],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await fixture.cleanup();
  });

  it("reads only a marker matching every target-owned field", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "marker.json");
    const marker = {
      target: "postgresql",
      generationId: "baseline-1",
      dataSha256: "c".repeat(64),
      secret: "preserved-but-not-compared",
    };
    await writeRuntimeMarker({ path, marker });
    await expect(
      readMatchingRuntimeMarker({
        path,
        expected: {
          target: "postgresql",
          generationId: "baseline-1",
          dataSha256: "c".repeat(64),
        },
        mismatchMessage: "reset required",
      }),
    ).resolves.toEqual(marker);
    await writeFile(path, "{}\n");
    await expect(
      readMatchingRuntimeMarker({
        path,
        expected: { target: "postgresql" },
        mismatchMessage: "reset required",
      }),
    ).rejects.toThrow("reset required");
    await fixture.cleanup();
  });
});
