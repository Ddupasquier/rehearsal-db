import { describe, expect, it } from "vitest";
import {
  executePublicCli,
  publicCliFailureSummary,
} from "../../helpers/public_cli.mjs";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";

const canary = "PRIVATE_CHILD_CANARY_196";
const refusal = (message) =>
  JSON.stringify({
    schemaVersion: 1,
    status: "error",
    error: {
      category: "runtime_dependency_failure",
      code: "RUNTIME_DEPENDENCY_FAILURE",
      message,
      context: { password: canary },
    },
  });

describe("public CLI test failure diagnostics", () => {
  it("retains fixed category/exit/port-race evidence without child text", () => {
    const summary = publicCliFailureSummary({
      code: 9,
      stdout: refusal(
        "Rehearsal setup ports became occupied after the preview (58320, 58321); rerun setup to choose another local port block.",
      ),
      stderr: canary,
      message: canary,
    });
    expect(summary).toMatchObject({
      exitCode: 9,
      category: "runtime_dependency_failure",
      code: "RUNTIME_DEPENDENCY_FAILURE",
      reason: "setup_port_race",
      stderrBytes: Buffer.byteLength(canary),
    });
    expect(JSON.stringify(summary)).not.toContain(canary);
  });

  it("preserves the fixed drift classification without logging paths or output", () => {
    expect(
      publicCliFailureSummary({
        stdout: refusal(
          ".gitignore changed after the setup preview; rerun rehearsal setup before writing.",
        ),
      }).reason,
    ).toBe("setup_source_drift");
  });

  it.each([
    canary,
    `${canary}${"é".repeat(32768)}`,
    JSON.stringify({
      schemaVersion: 1,
      status: "error",
      error: { category: canary, code: canary },
    }),
    JSON.stringify({
      schemaVersion: 1,
      status: "error",
      error: { category: { toString: null }, code: canary },
    }),
    refusal(canary),
  ])(
    "withholds malformed, oversized and unrecognized output (%#)",
    (stdout) => {
      const summary = publicCliFailureSummary({
        code: 1,
        signal: canary,
        stderr: canary,
        stdout,
      });
      expect(summary.stdoutBytes).toBe(Buffer.byteLength(stdout));
      expect(summary.reason).toBe("unclassified");
      expect(JSON.stringify(summary)).not.toContain(canary);
    },
  );

  it("keeps only known spawn/signal values and validates numeric exits", () => {
    expect(publicCliFailureSummary({ code: "ENOENT" })).toMatchObject({
      exitCode: null,
      spawnCode: "ENOENT",
    });
    expect(
      publicCliFailureSummary({ code: -1, signal: "SIGTERM", killed: true }),
    ).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      killed: true,
    });
  });

  it("returns real successful child output unchanged", async () => {
    const result = await executePublicCli(
      process.execPath,
      ["-e", 'console.log("expected output")'],
      { env: createCleanProcessEnvironment() },
    );
    expect(result.stdout).toBe("expected output\n");
  });

  it("replaces a real failing child error without argv, output or cause", async () => {
    let observed;
    try {
      await executePublicCli(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(refusal(canary))}); process.stderr.write(${JSON.stringify(canary)}); process.exitCode=9;`,
        ],
        { env: createCleanProcessEnvironment() },
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect(observed.message).toContain('"exitCode":9');
    expect(observed.message).toContain(
      '"category":"runtime_dependency_failure"',
    );
    expect(observed.message).not.toContain(canary);
    expect(observed.cause).toBeUndefined();
    expect(observed.stdout).toBeUndefined();
    expect(observed.stderr).toBeUndefined();
    expect(observed.cmd).toBeUndefined();
  });

  it("bounds real child output without forwarding its contents", async () => {
    await expect(
      executePublicCli(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(canary)} + "x".repeat(100000));`,
        ],
        { env: createCleanProcessEnvironment() },
      ),
    ).rejects.toThrow('"spawnCode":"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"');
  });
});
