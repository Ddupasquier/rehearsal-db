import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";
import {
  parseArguments,
  commandMutatesProject,
} from "../../../dist/src/cli/arguments.mjs";
const cli = fileURLToPath(
  new URL("../../../dist/src/cli/rehearsal.mjs", import.meta.url),
);
let root, preload;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "Rehearsal spaces Ü capabilities-"));
  preload = join(root, "canary.mjs");
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    'throw Error("PRIVATE_CONFIG_EXECUTED");',
  );
  await writeFile(
    preload,
    `import cp from 'node:child_process';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';Object.defineProperty(process,'platform',{value:'win32'});for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[name]=()=>{throw Error('PRIVATE_CHILD_STARTED')};net.connect=net.createConnection=()=>{throw Error('PRIVATE_SOCKET_STARTED')};syncBuiltinESMExports();`,
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const invoke = (args) =>
  spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, cli, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: createCleanProcessEnvironment(),
    },
  );
describe("additive capabilities CLI boundary", () => {
  it("works with Windows-injected refusal evidence without config, child, network or lock operations", async () => {
    const before = await readdir(root),
      result = invoke(["inspect", "capabilities", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "inspect capabilities",
      status: "success",
      data: {
        schemaVersion: 1,
        assurance: "inspection",
        receipt: { state: "not-requested" },
      },
    });
    expect(result.stdout + result.stderr).not.toMatch(
      /PRIVATE_|HOST_PLATFORM_UNSUPPORTED/,
    );
    expect(await readdir(root)).toEqual(before);
  });
  it("explains the operation requirements in human output without claiming live readiness", () => {
    const result = invoke(["inspect", "capabilities"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Requires: supported node");
    expect(result.stdout).toContain("supabase cli only for supabase");
    expect(result.stdout).toContain("Runtime availability was not observed");
  });
  it("reports unsupported Windows receipt proof without opening the supplied path", () => {
    const result = invoke([
      "inspect",
      "capabilities",
      "--receipt=PRIVATE.json",
      "--json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.receipt).toMatchObject({
      state: "refused",
      reason: "host_filesystem_unqualified",
    });
    expect(result.stdout + result.stderr).not.toContain("PRIVATE");
  });
  it.each([
    ["inspect", "capabilities", "--config=PRIVATE"],
    ["inspect", "capabilities", "--write"],
    ["inspect", "capabilities", "--confirm-engine-stop=PRIVATE"],
    ["inspect", "capabilities", "--receipt=x", "--receipt=y"],
    ["run", "--receipt=PRIVATE"],
  ])(
    "rejects inappropriate options without echoing private input %#",
    (args) => {
      const result = invoke([...args, "--json"]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain("PRIVATE");
    },
  );
  it("retains the existing live-runtime refusal before project imports or children", () => {
    const result = invoke(["run", "--json"]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe(
      "HOST_PLATFORM_UNSUPPORTED",
    );
    expect(result.stdout + result.stderr).not.toContain("PRIVATE");
  });
  it("classifies the endpoint as nonmutating", () => {
    const { flags } = parseArguments(["inspect", "capabilities", "--json"]);
    expect(
      commandMutatesProject({
        command: "inspect capabilities",
        flags,
        guided: false,
      }),
    ).toBe(false);
  });
});
