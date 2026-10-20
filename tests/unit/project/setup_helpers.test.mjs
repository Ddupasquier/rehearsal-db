import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSetupHost,
  CORE_VERSION,
  EXTENSION_ID,
  parseSetupArguments,
  planCoreInstallation,
  runSetup,
  WSL_POSIX_FILESYSTEM_TYPES,
} from "../../../installers/shared/setup.mjs";
import {
  buildSetupBundles,
  deterministicZip,
} from "../../../installers/build-bundles.mjs";

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async (manifest = {}) => {
  const root = await mkdtemp(resolve("test-results", "setup helpers ü "));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", ...manifest }),
  );
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  return {
    root,
    run,
    injected: {
      platform: "linux",
      kernelRelease: "6.8.0-generic",
      nodeVersion: "24.21.0",
      home: root,
      run,
    },
  };
};

describe("OS-specific source setup helpers", () => {
  it("keeps the standalone pre-install filesystem contract aligned with core", async () => {
    const source = await readFile(
      resolve("src/shared/host_platform.mts"),
      "utf8",
    );
    const declaration =
      /WSL_POSIX_FILESYSTEM_TYPES = new Set\(\[([\s\S]*?)\]\)/u.exec(
        source,
      )?.[1];
    expect(declaration).toBeTypeOf("string");
    expect([...WSL_POSIX_FILESYSTEM_TYPES]).toEqual(
      [...declaration.matchAll(/0x[0-9a-f]+/gu)].map(([hex]) => Number(hex)),
    );
  });
  it.each(["--install", "--install-extension"])(
    "refuses WSL %s before any npm or editor operation, even with an IPC variable",
    async (flag) => {
      const f = await fixture();
      vi.stubEnv("VSCODE_IPC_HOOK_CLI", "synthetic-not-host-proof");
      await expect(
        runSetup(parseSetupArguments([f.root, flag]), {
          ...f.injected,
          kernelRelease: "6.6-microsoft-standard-WSL2",
          inspectFilesystem: async () => ({ type: 0xef53 }),
        }),
      ).rejects.toThrow(/Extensions view/u);
      expect(f.run).not.toHaveBeenCalled();
      expect(await readdir(f.root)).toEqual(["package.json"]);
    },
  );
  it.each([0x53464846, 0x9fa0, undefined])(
    "refuses a Windows-backed or unknown filesystem beneath WSL home: %s",
    async (type) => {
      const f = await fixture();
      await expect(
        runSetup(parseSetupArguments([f.root, "--install-cli"]), {
          ...f.injected,
          kernelRelease: "6.6-microsoft-standard-WSL2",
          inspectFilesystem: async () => ({ type }),
        }),
      ).rejects.toThrow(/proven Linux filesystem/u);
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it.skipIf(
    !["darwin", "linux"].includes(process.platform) ||
      ![24, 26].includes(Number(process.versions.node.split(".")[0])),
  )(
    "runs the real current-OS check wrapper without changing the disposable project",
    async () => {
      const f = await fixture();
      const wrapper =
        process.platform === "darwin"
          ? "macos/setup.command"
          : "linux/setup.sh";
      const result = await promisify(execFile)(
        "/bin/sh",
        [resolve("installers", wrapper), f.root],
        {
          env: {
            ...process.env,
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          },
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const report = JSON.parse(result.stdout);
      expect(report.coreTarget).toBe(CORE_VERSION);
      expect(report.notes.join(" ")).toContain(
        "no engine, container or database was started",
      );
      expect(await readdir(f.root)).toEqual(["package.json"]);
    },
  );
  it("defaults to checks, preserving spaces and Unicode without mutating the application", async () => {
    const f = await fixture();
    const before = await readFile(join(f.root, "package.json"), "utf8");
    const result = await runSetup(parseSetupArguments([f.root]), f.injected);
    expect(result.checks).toEqual({ npm: true, code: true, docker: true });
    expect(f.run.mock.calls).toEqual([
      ["npm", ["--version"]],
      ["code", ["--version"]],
      ["docker", ["--version"]],
    ]);
    expect(await readdir(f.root)).toEqual(["package.json"]);
    expect(await readFile(join(f.root, "package.json"), "utf8")).toBe(before);
  });
  it.each(["dependencies", "devDependencies", "optionalDependencies"])(
    "preserves %s and requests only exact script-disabled core installation",
    async (group) => {
      const plan = planCoreInstallation({
        [group]: { "@rehearsal-db/core": "1.0.0" },
      });
      expect(plan.arguments).toEqual([
        "install",
        group === "dependencies"
          ? "--save-prod"
          : group === "optionalDependencies"
            ? "--save-optional"
            : "--save-dev",
        "--save-exact",
        `@rehearsal-db/core@${CORE_VERSION}`,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        "--@rehearsal-db:registry=https://registry.npmjs.org",
      ]);
    },
  );
  it("uses devDependencies for a new declaration, reuses compatible versions and refuses downgrades/sources", () => {
    expect(planCoreInstallation({}).arguments).toContain("--save-dev");
    expect(
      planCoreInstallation(
        { dependencies: { "@rehearsal-db/core": "^1.0.0" } },
        "1.1.0",
      ).arguments,
    ).toBeNull();
    for (const declaration of [
      "2.0.0",
      "file:../core",
      "git+https://example.invalid/core.git",
      "1.2.0",
    ])
      expect(() =>
        planCoreInstallation({
          dependencies: { "@rehearsal-db/core": declaration },
        }),
      ).toThrow();
    expect(() =>
      planCoreInstallation({ packageManager: "pnpm@10.0.0" }),
    ).toThrow(/package manager/u);
    expect(() =>
      planCoreInstallation({
        dependencies: { "@rehearsal-db/core": "1.0.0" },
        devDependencies: { "@rehearsal-db/core": "1.0.0" },
      }),
    ).toThrow(/Multiple/u);
  });
  it("verifies the installed core without running its bin, scaffolding or any database command", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (command, args) => {
      if (command === "npm" && args[0] === "install") {
        const installed = join(f.root, "node_modules/@rehearsal-db/core");
        await mkdir(installed, { recursive: true });
        await writeFile(
          join(installed, "package.json"),
          JSON.stringify({ name: "@rehearsal-db/core", version: CORE_VERSION }),
        );
      }
      return { stdout: "", stderr: "" };
    });
    const result = await runSetup(
      parseSetupArguments([f.root, "--install-cli"]),
      f.injected,
    );
    expect(
      result.notes.some((note) =>
        note.includes(`Verified installed core ${CORE_VERSION}`),
      ),
    ).toBe(true);
    expect(
      f.run.mock.calls.every(([command]) =>
        ["npm", "code", "docker"].includes(command),
      ),
    ).toBe(true);
    expect(await readdir(f.root)).toEqual(["node_modules", "package.json"]);
  });
  it("does not retry a failed package command or pretend installation succeeded", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (_command, args) => {
      if (args[0] === "install") throw new Error("Package command failed");
      return { stdout: "" };
    });
    await expect(
      runSetup(parseSetupArguments([f.root, "--install-cli"]), f.injected),
    ).rejects.toThrow("Package command failed");
    expect(
      f.run.mock.calls.filter(([, args]) => args[0] === "install"),
    ).toHaveLength(1);
  });
  it("refuses mismatched installed package identity rather than reusing its version", async () => {
    const f = await fixture({
      devDependencies: { "@rehearsal-db/core": CORE_VERSION },
    });
    const installed = join(f.root, "node_modules/@rehearsal-db/core");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: "other-package", version: CORE_VERSION }),
    );
    await expect(
      runSetup(parseSetupArguments([f.root, "--install-cli"]), f.injected),
    ).rejects.toThrow(/unexpected identity/u);
    expect(f.run.mock.calls.some(([, args]) => args[0] === "install")).toBe(
      false,
    );
  });
  it("refuses foreign locks before invoking npm install", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "yarn.lock"), "");
    await expect(
      runSetup(parseSetupArguments([f.root, "--install-cli"]), f.injected),
    ).rejects.toThrow(/manual package-manager/u);
    expect(f.run.mock.calls.some(([, args]) => args[0] === "install")).toBe(
      false,
    );
  });
  it("refuses a legacy extension without uninstalling it or forcing another installation", async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ stdout: "rehearsal-db.rehearsal\n" });
    await expect(
      runSetup(
        parseSetupArguments([f.root, "--install-extension"]),
        f.injected,
      ),
    ).rejects.toThrow(/legacy/u);
    expect(
      f.run.mock.calls.some(([, args]) => args[0] === "--install-extension"),
    ).toBe(false);
  });
  it("uses only the canonical extension ID in the current code host", async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ stdout: `${EXTENSION_ID}\n` });
    await runSetup(
      parseSetupArguments([f.root, "--install-extension"]),
      f.injected,
    );
    expect(f.run).toHaveBeenCalledWith("code", [
      "--install-extension",
      EXTENSION_ID,
    ]);
    expect(f.run.mock.calls.flat(2)).not.toContain("--force");
  });
  it.each([
    {
      platform: "win32",
      kernelRelease: "10.0",
      project: "/home/user/app",
      home: "/home/user",
    },
    {
      platform: "linux",
      kernelRelease: "4.4.0-Microsoft",
      project: "/home/user/app",
      home: "/home/user",
    },
    {
      platform: "linux",
      kernelRelease: "6.6-microsoft-standard-WSL2",
      project: "/mnt/c/app",
      home: "/home/user",
    },
    {
      platform: "linux",
      kernelRelease: "6.6-microsoft-standard-WSL2",
      project: "/home/other/app",
      home: "/home/user",
    },
  ])(
    "refuses unsupported native/WSL setup before commands: $kernelRelease $project",
    (host) => {
      expect(() =>
        assertSetupHost({ ...host, nodeVersion: "24.21.0" }),
      ).toThrow();
    },
  );
  it("accepts WSL2 only with Linux-home execution and rejects unknown flags/old Node", () => {
    const host = {
      platform: "linux",
      kernelRelease: "6.6-microsoft-standard-WSL2",
      project: "/home/user/my app",
      home: "/home/user",
      requestedPlatform: "windows-wsl",
    };
    expect(() =>
      assertSetupHost({ ...host, nodeVersion: "24.21.0" }),
    ).not.toThrow();
    expect(() => assertSetupHost({ ...host, nodeVersion: "22.0.0" })).toThrow(
      /Node.js/u,
    );
    expect(() => parseSetupArguments(["--project"])).toThrow();
    expect(() => parseSetupArguments(["--silent-global"])).toThrow();
  });
  it("creates identical allowlisted OS ZIPs without building or overwriting output", async () => {
    const f = await fixture();
    const first = join(f.root, "first"),
      second = join(f.root, "second");
    const a = await buildSetupBundles(first),
      b = await buildSetupBundles(second);
    expect(a).toEqual(b);
    expect(a.map(({ platform }) => platform)).toEqual([
      "windows",
      "macos",
      "linux",
    ]);
    for (const result of a)
      expect(await readFile(join(first, result.filename))).toEqual(
        await readFile(join(second, result.filename)),
      );
    await expect(buildSetupBundles(first)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(() =>
      deterministicZip([{ name: "../escape", bytes: "unsafe" }]),
    ).toThrow(/Unsafe/u);
  });
});
