import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import packageMetadata from "../../../package.json" with { type: "json" };

const impact = vi.hoisted(() => ({
  inspectMigrationImpact: vi.fn(),
  measureMigrationImpact: vi.fn(),
  renderMigrationImpact: vi.fn(() => "CURRENT SNAPSHOT — NOT A SAFETY VERDICT"),
}));
vi.mock(
  "../../../dist/src/runtime/migrations/migration_impact.mjs",
  () => impact,
);

import { parseArguments } from "../../../dist/src/cli/arguments.mjs";
import { createCliSessionState } from "../../../dist/src/cli/command_contract.mjs";
import { createCommandEmitter } from "../../../dist/src/cli/command_output.mjs";
import { createCommandRegistry } from "../../../dist/src/cli/command_registry.mjs";
import { createEditorCommandHandlers } from "../../../dist/src/cli/editor_command_handlers.mjs";
import { supportsOperationCancellation } from "../../../dist/src/shared/cancellation.mjs";
import { RehearsalError } from "../../../dist/src/shared/diagnostics.mjs";
import {
  acquireProjectOperation,
  inspectProjectOperationState,
} from "../../../dist/src/shared/operation_guard.mjs";

const wholePlanSha256 = "a".repeat(64);
const context = (command, arguments_ = []) => ({
  command,
  flags: parseArguments(arguments_).flags,
  planOptions: {
    projectRoot: "/tmp/rehearsal-impact-command-test",
    configPath: "reviewed.config.mjs",
  },
  guided: false,
  state: createCliSessionState(),
});
const report = (measurementStatus, mode = "measurement") => ({
  schemaVersion: 1,
  mode,
  measurementStatus,
  candidateSha256: wholePlanSha256,
  target: { name: "publication", candidateSha256: "b".repeat(64) },
  entries: [
    {
      filename: "20260101000100_change.sql",
      sha256: "c".repeat(64),
      coverage: "incomplete",
      unknownReasons: ["unsupported_sql"],
      measurements: [
        { metric: "rows", count: "9007199254740993" },
        { metric: "nulls", count: null, unknownReason: "query_failed" },
      ],
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("migration impact CLI dispatch", () => {
  it("advertises its additive metadata capability", () => {
    expect(packageMetadata.rehearsalContracts.migrationImpact).toBe(1);
  });

  it("forwards the exact selected config and explicit target for offline preview", async () => {
    const data = report("planned", "preview");
    impact.inspectMigrationImpact.mockResolvedValueOnce(data);
    const registry = createCommandRegistry(createEditorCommandHandlers());
    const request = context("inspect impact", ["--target=publication"]);
    const result = await registry.execute(request);

    expect(impact.inspectMigrationImpact).toHaveBeenCalledExactlyOnceWith(
      request.planOptions,
      "publication",
    );
    expect(impact.measureMigrationImpact).not.toHaveBeenCalled();
    expect(result.data).toBe(data);
    expect(result.status).toBe("success");
    expect(result.exitCode).toBeUndefined();
    expect(result.render("normal")).toBe(
      "CURRENT SNAPSHOT — NOT A SAFETY VERDICT",
    );
    expect(impact.renderMigrationImpact).toHaveBeenCalledExactlyOnceWith(
      data,
      "normal",
    );
  });

  it("forwards whole-plan consent without replacing it with the target digest", async () => {
    const data = report("measured");
    impact.measureMigrationImpact.mockResolvedValueOnce(data);
    const registry = createCommandRegistry(createEditorCommandHandlers());
    const request = context("measure impact", [
      "--target=publication",
      `--confirm-candidates=${wholePlanSha256}`,
    ]);
    const result = await registry.execute(request);

    expect(impact.measureMigrationImpact).toHaveBeenCalledExactlyOnceWith({
      options: request.planOptions,
      targetName: "publication",
      confirmation: wholePlanSha256,
    });
    expect(impact.inspectMigrationImpact).not.toHaveBeenCalled();
    expect(result.data).toBe(data);
    expect(result.status).toBe("success");
    expect(result.exitCode).toBeUndefined();
  });

  it.each(["partial", "unknown"])(
    "emits not_ready and exit 1 for %s measurement without coercing count strings or unknowns",
    async (measurementStatus) => {
      const data = report(measurementStatus);
      impact.measureMigrationImpact.mockResolvedValueOnce(data);
      const registry = createCommandRegistry(createEditorCommandHandlers());
      const request = context("measure impact", [
        "--target=publication",
        `--confirm-candidates=${wholePlanSha256}`,
        "--json",
      ]);
      const result = await registry.execute(request);
      const lines = [];
      const emit = createCommandEmitter({
        startedAt: new Date("2026-10-22T12:00:00.000Z"),
        startedMs: performance.now(),
        write: (line) => lines.push(line),
      });

      expect(emit({ ...request, result })).toBe(1);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        schemaVersion: 1,
        command: "measure impact",
        status: "not_ready",
        data,
      });
      expect(impact.renderMigrationImpact).not.toHaveBeenCalled();
    },
  );

  it("keeps a not-required measurement successful without inventing measured counts", async () => {
    const data = { ...report("not_required"), entries: [] };
    impact.measureMigrationImpact.mockResolvedValueOnce(data);
    const result = await createCommandRegistry(
      createEditorCommandHandlers(),
    ).execute(
      context("measure impact", [
        "--target=primary",
        `--confirm-candidates=${wholePlanSha256}`,
      ]),
    );

    expect(result.data).toBe(data);
    expect(result.status).toBe("success");
    expect(result.exitCode).toBeUndefined();
  });

  it.each(["inspect impact", "measure impact"])(
    "does not invent a primary target or confirmation for %s",
    async (command) => {
      const refusal = new RehearsalError({
        category: "configuration_invalid",
        code: "CONFIGURATION_INVALID",
        message: "An explicit target and reviewed confirmation are required.",
      });
      const owner =
        command === "inspect impact"
          ? impact.inspectMigrationImpact
          : impact.measureMigrationImpact;
      owner.mockRejectedValueOnce(refusal);
      const request = context(command);
      await expect(
        createCommandRegistry(createEditorCommandHandlers()).execute(request),
      ).rejects.toBe(refusal);
      if (command === "inspect impact") {
        expect(owner).toHaveBeenCalledExactlyOnceWith(
          request.planOptions,
          undefined,
        );
        expect(impact.measureMigrationImpact).not.toHaveBeenCalled();
      } else {
        expect(owner).toHaveBeenCalledExactlyOnceWith({
          options: request.planOptions,
          targetName: undefined,
          confirmation: undefined,
        });
        expect(impact.inspectMigrationImpact).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps unsupported command names out of the registry", async () => {
    const registry = createCommandRegistry(createEditorCommandHandlers());
    expect(await registry.execute(context("impact"))).toBeNull();
    expect(await registry.execute(context("measure impact now"))).toBeNull();
    expect(impact.inspectMigrationImpact).not.toHaveBeenCalled();
    expect(impact.measureMigrationImpact).not.toHaveBeenCalled();
  });

  it("uses package-owned cancellation only for the lock-bearing measurement", () => {
    expect(supportsOperationCancellation("measure impact")).toBe(true);
    expect(supportsOperationCancellation("inspect impact")).toBe(false);
  });

  it("registers measurement as an owned operation and blocks conflicting mutations until release", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-impact-lock-"));
    let operation;
    try {
      operation = await acquireProjectOperation({
        projectRoot: root,
        command: "measure impact",
      });
      expect(
        await inspectProjectOperationState({ projectRoot: root }),
      ).toMatchObject({
        schemaVersion: 1,
        state: "busy",
        operation: { kind: "measure impact" },
      });
      await expect(
        acquireProjectOperation({ projectRoot: root, command: "reset" }),
      ).rejects.toThrow("already running");
      await operation.release();
      operation = undefined;
      expect(
        await inspectProjectOperationState({ projectRoot: root }),
      ).toMatchObject({
        state: "idle",
        operation: null,
      });
    } finally {
      await operation?.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
