import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyManagerFailure,
  createRuntimeCommands,
  parseColimaMemory,
  parseDockerCapacity,
} from "../../../dist/src/cli/runtime_commands.mjs";

describe("runtime command diagnostics", () => {
  it("returns validated structured runtime state without parsing human prose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehearsal-status-"));
    const managerPath = join(directory, "manager.mjs");
    await writeFile(
      managerPath,
      `console.log(JSON.stringify({
        schemaVersion: 1,
        state: "running",
        reason: null,
        runtimeTarget: "supabase",
        projectId: "fixture-rehearsal",
        endpoint: { kind: "http", url: "http://127.0.0.1:54321" },
        baselineGenerationId: "baseline-example",
        candidateSha256: "${"a".repeat(64)}",
        candidates: []
      }));\n`,
    );

    try {
      const commands = createRuntimeCommands({
        packageRoot: directory,
        projectRoot: directory,
        managerPath,
        getActivePackageFingerprint: () => null,
      });
      const receipt = await commands.runManager({
        action: "status",
        flags: { json: true, plain: true },
        configPath: "rehearsal.config.mjs",
      });

      expect(receipt.runtimeStatus).toMatchObject({
        state: "running",
        runtimeTarget: "supabase",
        endpoint: { kind: "http", url: "http://127.0.0.1:54321" },
      });
      expect(receipt.output).toContain(
        "Local Rehearsal Supabase: running at http://127.0.0.1:54321",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves Electron Node mode for its nested runtime manager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehearsal-electron-node-"));
    const managerPath = join(directory, "manager.mjs");
    const previousElectronMode = process.env.ELECTRON_RUN_AS_NODE;
    await writeFile(
      managerPath,
      `if (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(42);\nconsole.log(JSON.stringify({ schemaVersion: 1, state: "stopped", reason: "runtime_not_running", runtimeTarget: "postgresql", projectId: "fixture-rehearsal", endpoint: null, baselineGenerationId: "20261010T120000Z-example", candidateSha256: "${"a".repeat(64)}", candidates: [] }));\n`,
    );

    try {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      const commands = createRuntimeCommands({
        packageRoot: directory,
        projectRoot: directory,
        managerPath,
        getActivePackageFingerprint: () => null,
      });
      const receipt = await commands.runManager({
        action: "status",
        flags: { json: true, plain: true },
        configPath: "rehearsal.config.mjs",
      });

      expect(receipt.runtimeStatus).toMatchObject({
        state: "stopped",
        runtimeTarget: "postgresql",
      });
    } finally {
      if (previousElectronMode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previousElectronMode;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies container startup failures as runtime dependencies before migrations", () => {
    expect(
      classifyManagerFailure({
        action: "run",
        output:
          "migration reset failed: supabase_studio_fixture container is not ready: starting",
        inferredCategory: "migration_verification_failure",
      }),
    ).toBe("runtime_dependency_failure");
  });

  it("keeps genuine candidate failures in the migration category", () => {
    expect(
      classifyManagerFailure({
        action: "run",
        output: "applyMigration failed for candidate migration",
        inferredCategory: "internal_failure",
      }),
    ).toBe("migration_candidate_failure");
    expect(
      classifyManagerFailure({
        action: "run",
        output:
          "at applyMigration (...)\nat async migrateRuntimeOperation (...)\nat async withOwnedRuntimeRollback (...)",
        inferredCategory: "baseline_invalid",
      }),
    ).toBe("migration_candidate_failure");
  });

  it("parses safe Docker and Colima capacity summaries", () => {
    expect(parseDockerCapacity("4 4094013440 28 35\n")).toEqual({
      cpus: 4,
      memoryBytes: 4094013440,
      runningContainers: 28,
      containers: 35,
    });
    expect(
      parseColimaMemory(`
        total used free shared buff/cache available
Mem: 4094013440 3504373760 147013632 336617472 970944512 589639680
Swap: 0 0 0
      `),
    ).toEqual({
      totalBytes: 4094013440,
      availableBytes: 589639680,
    });
  });

  it("returns actionable runtime diagnostics for a failed container startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehearsal-diagnostics-"));
    const managerPath = join(directory, "manager.mjs");
    await writeFile(
      managerPath,
      `console.error("supabase_studio_fixture container is not ready: starting");\nprocess.exit(1);\n`,
    );

    try {
      const commands = createRuntimeCommands({
        packageRoot: directory,
        projectRoot: directory,
        managerPath,
        getActivePackageFingerprint: () => null,
      });
      let failure;
      try {
        await commands.runManager({
          action: "run",
          flags: { json: true, plain: true },
          configPath: "rehearsal.config.mjs",
        });
      } catch (error) {
        failure = error;
      }

      expect(failure?.category).toBe("runtime_dependency_failure");
      expect(failure?.code).toBe("MANAGER_RUN_FAILED");
      expect(failure?.suggestions.join(" ")).toContain(
        "Stop unrelated local stacks",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
