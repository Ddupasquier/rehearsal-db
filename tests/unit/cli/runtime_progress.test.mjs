import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeCommands } from "../../../dist/src/cli/runtime_commands.mjs";
import { withOperationProgress } from "../../../dist/src/shared/operation_progress.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async (source) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-manager-progress-"));
  roots.push(root);
  const managerPath = join(root, "manager.mjs");
  await writeFile(managerPath, source);
  await copyFile(
    join(
      process.cwd(),
      "tests/fixtures/rehearsal-project/rehearsal.config.mjs",
    ),
    join(root, "rehearsal.config.mjs"),
  );
  const snapshots = [];
  const operation = {
    id: "a".repeat(64),
    startedAt: new Date().toISOString(),
    writeProgress: async (value) => {
      snapshots.push(value);
    },
  };
  return {
    operation,
    snapshots,
    commands: createRuntimeCommands({
      packageRoot: root,
      projectRoot: root,
      managerPath,
      getActivePackageFingerprint: () => undefined,
    }),
  };
};

describe("runtime CLI stage integration", () => {
  it("measures the actual manager boundary without guessing separate restore/migration phases", async () => {
    const { operation, snapshots, commands } = await fixture(
      'console.log("private-project-command-output");\n',
    );
    await withOperationProgress({
      operation,
      task: () =>
        commands.runManager({
          action: "run",
          targetName: "publication",
          flags: { json: true, plain: true },
        }),
    });
    expect(snapshots.at(-1)).toMatchObject({
      state: "completed",
      completedStages: [
        {
          phase: "runtime-lifecycle",
          target: "publication",
          state: "completed",
        },
      ],
    });
    expect(snapshots.at(-1).completedStages).toHaveLength(1);
    expect(JSON.stringify(snapshots)).not.toContain(
      "private-project-command-output",
    );
  });

  it("reports an actual manager verification failure rather than a completed stage", async () => {
    const { operation, snapshots, commands } = await fixture(
      'console.error("synthetic-manager-refusal"); process.exit(7);\n',
    );
    await expect(
      withOperationProgress({
        operation,
        task: () =>
          commands.runManager({
            action: "verify",
            flags: { json: true, plain: true },
          }),
      }),
    ).rejects.toMatchObject({ code: "MANAGER_VERIFY_FAILED" });
    expect(snapshots.at(-1)).toMatchObject({
      state: "failed",
      currentStage: {
        phase: "runtime-verification",
        target: "primary",
        state: "failed",
      },
      completedStages: [],
    });
    expect(JSON.stringify(snapshots)).not.toContain(
      "synthetic-manager-refusal",
    );
  });

  it("does not relabel a read-only status response as runtime verification", async () => {
    const status = {
      schemaVersion: 1,
      state: "stopped",
      reason: "runtime_not_running",
      runtimeTarget: "postgresql",
      projectId: "fixture-rehearsal",
      verifiedRuntimeAvailable: false,
      endpoint: null,
      baselineGenerationId: "20261013T120000Z-example",
      candidateSha256: "b".repeat(64),
      candidates: [],
    };
    const { operation, snapshots, commands } = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(status))});\n`,
    );
    await withOperationProgress({
      operation,
      task: () =>
        commands.runManager({
          action: "status",
          flags: { json: true, plain: true },
        }),
    });
    expect(snapshots.at(-1).completedStages).toEqual([]);
    expect(snapshots.at(-1).events.map((event) => event.code)).toEqual([
      "operation.started",
      "operation.completed",
    ]);
  });
});
