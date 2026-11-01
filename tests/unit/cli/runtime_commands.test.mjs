import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeRehearsalError } from "../../../dist/src/shared/diagnostics.mjs";
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
      `if(process.env.REHEARSAL_DOCKER_CONTEXT !== 'fixture-local' || process.env.REHEARSAL_DOCKER_IDENTITY !== '${"a".repeat(64)}' || process.env.DOCKER_CONFIG !== ${JSON.stringify(directory)})process.exit(43);\nconsole.log(JSON.stringify({
        schemaVersion: 1,
        state: "running",
        reason: null,
        runtimeTarget: "supabase",
        projectId: "fixture-rehearsal",
        verifiedRuntimeAvailable: true,
        endpoint: { kind: "http", url: "http://127.0.0.1:54321" },
        baselineGenerationId: "baseline-example",
        candidateSha256: "${"a".repeat(64)}",
        candidates: []
      }));\n`,
    );

    try {
      await copyFile(
        join(
          process.cwd(),
          "tests/fixtures/rehearsal-project/rehearsal.config.mjs",
        ),
        join(directory, "rehearsal.config.mjs"),
      );
      const commands = createRuntimeCommands({
        packageRoot: directory,
        projectRoot: directory,
        managerPath,
        getActivePackageFingerprint: () => null,
        resolveEngineSelection: () => ({
          context: "fixture-local",
          endpoint: "unix:///fixture.sock",
          identity: "a".repeat(64),
          selectionSource: "default-context",
          dockerConfig: directory,
        }),
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
      `if (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(42);\nconsole.log(JSON.stringify({ schemaVersion: 1, state: "stopped", reason: "runtime_not_running", runtimeTarget: "postgresql", projectId: "fixture-rehearsal", verifiedRuntimeAvailable: true, endpoint: null, baselineGenerationId: "20261010T120000Z-example", candidateSha256: "${"a".repeat(64)}", candidates: [] }));\n`,
    );

    try {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      await copyFile(
        join(
          process.cwd(),
          "tests/fixtures/rehearsal-project/rehearsal.config.mjs",
        ),
        join(directory, "rehearsal.config.mjs"),
      );
      const commands = createRuntimeCommands({
        packageRoot: directory,
        projectRoot: directory,
        managerPath,
        getActivePackageFingerprint: () => null,
        resolveEngineSelection: () => ({
          context: "fixture-local",
          endpoint: "unix:///fixture.sock",
          identity: "a".repeat(64),
          selectionSource: "default-context",
        }),
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
    expect(
      classifyManagerFailure({
        action: "start",
        output:
          "Error: Supabase startup failed (exit 1).\nReported startup evidence: unknown.",
        inferredCategory: "migration_candidate_failure",
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

  it.each([
    ["health", "supabase_studio_fixture container is not ready: starting"],
    [
      "port",
      "Error: PostgreSQL startup failed (exit 1).\nReported startup evidence: port_unavailable.",
    ],
  ])(
    "returns actionable %s diagnostics for a failed container startup",
    async (kind, output) => {
      const directory = await mkdtemp(join(tmpdir(), "rehearsal-diagnostics-"));
      const managerPath = join(directory, "manager.mjs");
      await writeFile(
        managerPath,
        `console.error(${JSON.stringify(output)});\nprocess.exit(1);\n`,
      );

      try {
        await copyFile(
          join(
            process.cwd(),
            "tests/fixtures/rehearsal-project/rehearsal.config.mjs",
          ),
          join(directory, "rehearsal.config.mjs"),
        );
        const commands = createRuntimeCommands({
          packageRoot: directory,
          projectRoot: directory,
          managerPath,
          getActivePackageFingerprint: () => null,
          resolveEngineSelection: () => ({
            context: "fixture-local",
            endpoint: "unix:///fixture.sock",
            identity: "a".repeat(64),
            selectionSource: "default-context",
          }),
          inspectEngineCapacity: (reviewed) => {
            expect(reviewed).toMatchObject({
              context: "fixture-local",
              endpoint: "unix:///fixture.sock",
              identity: "a".repeat(64),
            });
            return undefined;
          },
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
        if (kind === "health") {
          expect(failure?.suggestions.join(" ")).toContain(
            "If startup evidence confirms a resource shortage",
          );
        } else {
          expect(failure?.suggestions.join(" ")).toContain(
            "runtime.databasePort",
          );
          expect(failure?.suggestions.join(" ")).toContain(
            "netsh interface ipv4 show excludedportrange protocol=tcp",
          );
          expect(failure?.suggestions.join(" ")).not.toMatch(
            /increase.*capacity|docker stats|memory/iu,
          );
          expect(failure?.context).not.toHaveProperty("engineCapacity");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

it("preserves closed host native origin through manager aggregation/serialization without exposing the frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rehearsal-native-failure-"));
  const managerPath = join(directory, "manager.mjs");
  const moduleUrl = pathToFileURL(
    join(
      process.cwd(),
      "dist/src/runtime/migrations/knex_failure_diagnostic.mjs",
    ),
  ).href;
  await writeFile(
    managerPath,
    `import {markKnexFailure,renderKnexFailureFrame} from ${JSON.stringify(moduleUrl)};
const original=markKnexFailure(new Error('PRIVATE_SQL_PASSWORD_PATH'),{phase:'application',stage:'sql',reason:'execution-unconfirmed'});
const wrapped=markKnexFailure(new AggregateError([original]),{phase:'application',stage:'cleanup',reason:'cleanup-unconfirmed'});
console.error(renderKnexFailureFrame(wrapped,process.env.REHEARSAL_NATIVE_FAILURE_NONCE));
console.error('Error: The runtime operation failed and its owned runtime could not be removed automatically.');process.exitCode=1;`,
  );
  try {
    await copyFile(
      join(
        process.cwd(),
        "tests/fixtures/rehearsal-project/rehearsal.config.mjs",
      ),
      join(directory, "rehearsal.config.mjs"),
    );
    const commands = createRuntimeCommands({
      packageRoot: directory,
      projectRoot: directory,
      managerPath,
      getActivePackageFingerprint: () => null,
      resolveEngineSelection: () => ({
        context: "fixture-local",
        endpoint: "unix:///fixture.sock",
        identity: "a".repeat(64),
        selectionSource: "default-context",
        dockerConfig: directory,
      }),
    });
    let failure;
    try {
      await commands.runManager({
        action: "migrate",
        flags: { json: true, plain: true },
        configPath: "rehearsal.config.mjs",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const serialized = serializeRehearsalError(failure);
    expect(failure.exitCode).toBe(6);
    expect(serialized.error).toMatchObject({
      category: "migration_candidate_failure",
      code: "MANAGER_MIGRATE_FAILED",
      context: {
        action: "migrate",
        nativeFailure: {
          schemaVersion: 1,
          kind: "knex-native-failure",
          primary: {
            phase: "application",
            stage: "sql",
            reason: "execution-unconfirmed",
          },
          cleanup: {
            phase: "application",
            stage: "cleanup",
            reason: "cleanup-unconfirmed",
          },
        },
      },
    });
    expect(serialized.error.actual).toContain(
      "original cause could not be safely summarized",
    );
    expect(JSON.stringify(serialized)).not.toMatch(
      /PRIVATE_SQL_PASSWORD_PATH|Rehearsal native failure:|"nonce"/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
