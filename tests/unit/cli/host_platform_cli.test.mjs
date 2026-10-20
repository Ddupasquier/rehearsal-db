import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";

const cli = fileURLToPath(
  new URL("../../../dist/src/cli/rehearsal.mjs", import.meta.url),
);
let directory;
let preload;

// Injected platform evidence proves refusal boundaries, not native Windows support.
const invoke = (args) =>
  spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, cli, ...args],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 15_000,
      env: createCleanProcessEnvironment(),
    },
  );

describe("native Windows CLI refusal boundaries", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rehearsal-host-guard-"));
    preload = join(directory, "platform-preload.mjs");
    await writeFile(
      preload,
      `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      Object.defineProperty(process, "platform", { value: "win32" });
      for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
        childProcess[name] = () => { throw new Error("CHILD_PROCESS_STARTED"); };
      }
      syncBuiltinESMExports();
    `,
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "host-guard-fixture", private: true }),
    );
    await writeFile(
      join(directory, "rehearsal.config.mjs"),
      'throw new Error("PROJECT_CONFIG_EXECUTED");\n',
    );
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    "open",
    "run",
    "setup",
    "init",
    "baseline create",
    "privacy key",
    "source apply",
    "reset",
    "status",
    "stop",
    "discard",
  ])(
    "refuses %s before project code, operation locks, or children",
    async (command) => {
      const result = invoke([...command.split(" "), "--json"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(3);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        schemaVersion: 1,
        status: "error",
        error: {
          category: "unsafe_environment",
          code: "HOST_PLATFORM_UNSUPPORTED",
          actual: "windows",
        },
      });
      expect(report.error.suggestions.join(" ")).toContain(
        "wsl --install -d Ubuntu",
      );
      expect(result.stdout + result.stderr).not.toMatch(
        /PROJECT_CONFIG_EXECUTED|CHILD_PROCESS_STARTED/u,
      );
      expect(await readdir(directory)).not.toContain(".rehearsal");
    },
  );

  it("returns an actionable doctor NOT READY envelope before config or engine probes", () => {
    const result = invoke(["doctor", "--json"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: "doctor",
      status: "not_ready",
      data: {
        state: "NOT READY",
        checks: [{ id: "operating-system", status: "fail" }],
      },
    });
    expect(report.data.checks[0].remediation).toContain("Remote - WSL");
    expect(result.stdout + result.stderr).not.toMatch(
      /PROJECT_CONFIG_EXECUTED|CHILD_PROCESS_STARTED/u,
    );
  });

  it.each([
    { args: ["--version"] },
    { args: ["version", "--json"] },
    { args: ["--help"] },
    { args: ["run", "--help"] },
    { args: ["guide", "--version"] },
  ])("keeps read-only version/help functional: $args", ({ args }) => {
    const result = invoke(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe("");
    expect(result.stdout + result.stderr).not.toMatch(
      /HOST_PLATFORM_UNSUPPORTED|PROJECT_CONFIG_EXECUTED|CHILD_PROCESS_STARTED/u,
    );
  });

  it("keeps bounded metadata discovery functional without evaluating config", () => {
    const result = invoke(["discover", "--json"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ command: "discover", status: "success" });
    expect(result.stdout + result.stderr).not.toMatch(
      /HOST_PLATFORM_UNSUPPORTED|PROJECT_CONFIG_EXECUTED/u,
    );
  });
});
