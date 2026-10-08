import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectRehearsalSupportReport } from "../../../dist/src/project/support_report.mjs";

const execute = promisify(execFile);
const roots = [];
const cliPath = join(process.cwd(), "dist/src/cli/rehearsal.mjs");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("support report", () => {
  it("contains useful versions and check status without diagnostic details", async () => {
    const sensitivePath = "/private/customer/project";
    const secret = "sb_secret_value-that-must-not-appear";
    const result = await collectRehearsalSupportReport(
      { projectRoot: sensitivePath },
      {
        system: {
          platform: "darwin",
          release: "25.0.0",
          architecture: "arm64",
          node: "24.21.0",
        },
        runCommand: (command, args) => ({
          status: command === "docker" && args[0] === "info" ? 1 : 0,
          stdout:
            command === "npm"
              ? "11.6.0\n"
              : command === "supabase"
                ? "2.50.0\n"
                : "Docker version 28.4.0\n",
          stderr: secret,
        }),
        runDoctor: async () => ({
          state: "NOT READY",
          checks: [
            {
              id: "configuration",
              label: "Versioned configuration",
              status: "fail",
              detail: `${sensitivePath}: ${secret}`,
              remediation: "Create a valid configuration.",
            },
          ],
          ambientHostedVariables: {
            presentButQuarantined: ["SUPABASE_ACCESS_TOKEN"],
          },
        }),
      },
    );

    expect(result).toMatchObject({
      system: { platform: "darwin", architecture: "arm64", node: "24.21.0" },
      tools: {
        npm: { status: "available", version: "11.6.0" },
        supabase: { status: "available", version: "2.50.0" },
        dockerServer: { status: "unavailable" },
      },
      readiness: {
        state: "NOT READY",
        quarantinedHostedVariableCount: 1,
        checks: [
          {
            id: "configuration",
            label: "Versioned configuration",
            status: "fail",
            remediation: "Create a valid configuration.",
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(sensitivePath);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("SUPABASE_ACCESS_TOKEN");
  });

  it("works before setup and preserves the versioned JSON contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-support-test-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "private-project-name" })}\n`,
    );

    const output = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "support", "--json"], {
          cwd: root,
        })
      ).stdout,
    );

    expect(output).toMatchObject({
      schemaVersion: 1,
      command: "support",
      status: "success",
      data: {
        readiness: { state: "NOT READY" },
        privacy: {
          omits: [
            "row values",
            "credentials",
            "project paths",
            "migration SQL",
            "baseline identifiers",
          ],
        },
      },
    });
    expect(JSON.stringify(output)).not.toContain(root);
    expect(JSON.stringify(output)).not.toContain("private-project-name");
  }, 15_000);
});
