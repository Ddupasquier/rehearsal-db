#!/usr/bin/env node
/** Shared setup owner. No database commands, OS installs or project scaffolding. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import { homedir, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const CORE_VERSION = "1.1.0";
export const EXTENSION_ID = "rehearsal-db.rehearsal-db";
// Standalone pre-install projection of src/shared/host_platform.mts's contract.
// The focused contract test keeps these values aligned without importing core.
export const WSL_POSIX_FILESYSTEM_TYPES = new Set([
  0xef53, 0x58465342, 0x9123683e,
]);
const execute = promisify(execFile);
const groups = {
  dependencies: "--save-prod",
  devDependencies: "--save-dev",
  optionalDependencies: "--save-optional",
};
const versionParts = (value) =>
  typeof value === "string" && /^(\d+)\.(\d+)\.(\d+)$/u.test(value)
    ? value.split(".").map(Number)
    : null;
const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};
const inside = (root, path) => {
  const local = relative(root, path);
  return (
    local === "" ||
    (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))
  );
};
const metadata = async (path, optional = false) => {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Linked package metadata needs manual review.");
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error(
      "Setup requires bounded regular package metadata, without symbolic-link redirects.",
    );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const held = await handle.stat();
    if (
      !held.isFile() ||
      held.size > 1024 * 1024 ||
      held.dev !== stat.dev ||
      held.ino !== stat.ino
    )
      throw new Error(
        "Package metadata changed. Review the project before retrying.",
      );
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024)
      throw new Error("Package metadata exceeds the setup limit.");
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid package metadata.");
    return value;
  } finally {
    await handle.close();
  }
};

export const parseSetupArguments = (args) => {
  const result = {
    platform: undefined,
    project: undefined,
    installCli: false,
    installExtension: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--install") result.installCli = result.installExtension = true;
    else if (arg === "--install-cli") result.installCli = true;
    else if (arg === "--install-extension") result.installExtension = true;
    else if (arg === "--help") result.help = true;
    else if (arg.startsWith("--platform=")) result.platform = arg.slice(11);
    else if (arg === "--project") {
      const project = args[++index];
      if (!project || project.startsWith("--"))
        throw new Error("--project needs an existing application folder.");
      result.project = project;
    } else if (!arg.startsWith("-") && result.project === undefined)
      result.project = arg;
    else throw new Error(`Unknown setup argument: ${arg}`);
  }
  return result;
};

export const planCoreInstallation = (manifest, installedVersion) => {
  if (
    manifest.packageManager !== undefined &&
    !/^npm@\d+\./u.test(manifest.packageManager)
  )
    throw new Error(
      "This helper installs through npm only. Keep the project's existing package manager and install Rehearsal manually instead.",
    );
  const declared = Object.keys(groups).filter((group) =>
    Object.hasOwn(manifest[group] ?? {}, "@rehearsal-db/core"),
  );
  if (declared.length > 1)
    throw new Error(
      "Multiple Rehearsal dependency declarations need manual review.",
    );
  const group = declared[0] ?? "devDependencies";
  const declaration = manifest[group]?.["@rehearsal-db/core"];
  if (
    declaration !== undefined &&
    declaration !== "latest" &&
    !/^[~^]?1\.\d+\.\d+$/u.test(declaration)
  )
    throw new Error(
      "The existing Rehearsal source or compatibility series needs manual review; setup will not replace it.",
    );
  const installed = versionParts(installedVersion);
  if (
    installedVersion !== undefined &&
    (!installed || installed[0] !== 1 || !declared.length)
  )
    throw new Error(
      "The installed Rehearsal package cannot be safely adopted or downgraded by this helper.",
    );
  const target = versionParts(CORE_VERSION);
  if (installed && compareVersions(installed, target) >= 0)
    return {
      arguments: null,
      reason: `Preserving installed compatible Rehearsal ${installedVersion}.`,
    };
  if (declaration && declaration !== "latest") {
    const minimum = versionParts(declaration.replace(/^[~^]/u, ""));
    if (minimum && compareVersions(minimum, target) > 0)
      throw new Error(
        "The declared Rehearsal version is newer than this helper; no downgrade will be attempted.",
      );
  }
  return {
    arguments: [
      "install",
      groups[group],
      "--save-exact",
      `@rehearsal-db/core@${CORE_VERSION}`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      "--@rehearsal-db:registry=https://registry.npmjs.org",
    ],
    reason: `Install exact core ${CORE_VERSION} in ${group}; npm may update package.json, package-lock.json and node_modules.`,
  };
};

export const assertSetupHost = ({
  platform,
  kernelRelease,
  nodeVersion,
  requestedPlatform,
  project,
  home,
}) => {
  const major = Number(nodeVersion.split(".")[0]);
  if (![22, 24, 26].includes(major))
    throw new Error(
      "Use Node.js 22, 24 or 26 (24 LTS recommended). See https://nodejs.org/en/download . This helper never installs Node or changes your OS.",
    );
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(
      "Native Windows setup is not supported. Use the Windows PowerShell helper with a WSL 2 Linux-home project.",
    );
  if (requestedPlatform === "macos" && platform !== "darwin")
    throw new Error("The macOS helper must run on macOS.");
  if (requestedPlatform === "linux" && platform !== "linux")
    throw new Error("The Linux helper must run on Linux.");
  if (
    requestedPlatform &&
    !["macos", "linux", "windows-wsl"].includes(requestedPlatform)
  )
    throw new Error("Unknown setup platform.");
  const wsl = /microsoft|wsl/iu.test(kernelRelease);
  if (
    requestedPlatform === "windows-wsl" &&
    (!wsl || !/wsl2/iu.test(kernelRelease))
  )
    throw new Error("The Windows helper requires a WSL 2 Linux kernel.");
  if (
    wsl &&
    (!/wsl2/iu.test(kernelRelease) ||
      !inside(home, project) ||
      /^\/mnt\//u.test(project))
  )
    throw new Error(
      "WSL setup requires WSL 2 and a project inside the distribution's Linux home directory, not /mnt/c or another Windows share.",
    );
};

export const runSetup = async (options, injected = {}) => {
  const project = await realpath(resolve(options.project ?? process.cwd()));
  const home = await realpath(injected.home ?? homedir());
  const platform = injected.platform ?? process.platform;
  const kernelRelease = injected.kernelRelease ?? release();
  assertSetupHost({
    platform,
    kernelRelease,
    nodeVersion: injected.nodeVersion ?? process.versions.node,
    requestedPlatform: options.platform,
    project,
    home,
  });
  const wsl = /microsoft|wsl/iu.test(kernelRelease);
  if (wsl) {
    let type;
    try {
      type = (await (injected.inspectFilesystem ?? statfs)(project)).type;
    } catch {
      /* Unknown filesystem evidence fails closed below. */
    }
    if (!WSL_POSIX_FILESYSTEM_TYPES.has(type))
      throw new Error(
        "WSL setup requires a proven Linux filesystem (ext4, XFS or Btrfs). Windows-backed or unknown filesystems, including bind mounts beneath home, are refused.",
      );
    if (options.installExtension)
      throw new Error(
        "No installation was started. This helper cannot prove the VS Code host for WSL extension installation. Open the project with Remote - WSL and install Rehearsal DB (rehearsal-db.rehearsal-db) from that window's Extensions view. Use --install-cli separately for the CLI; --install is not supported in WSL.",
      );
  }
  const manifestPath = join(project, "package.json");
  const manifest = await metadata(manifestPath).catch(() => {
    throw new Error(
      "Choose an existing application folder with a regular package.json. No project files were created.",
    );
  });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_AGENT_FOLDER",
        "WSL_DISTRO_NAME",
        "WSL_INTEROP",
      ].includes(key),
    ),
  );
  environment.PATH = `${dirname(process.execPath)}:${environment.PATH ?? ""}`;
  const run =
    injected.run ??
    ((command, args) =>
      execute(command, args, {
        cwd: project,
        env: environment,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      }));
  const checks = {};
  for (const command of ["npm", "code", "docker"]) {
    try {
      await run(command, ["--version"]);
      checks[command] = true;
    } catch {
      checks[command] = false;
    }
  }
  const notes = [
    "Check mode is read-only unless an explicit install flag was supplied.",
    "Docker availability is a CLI check only; no engine, container or database was started.",
  ];
  if (options.installCli) {
    if (!checks.npm)
      throw new Error(
        "npm is unavailable in this execution environment; install it manually before requesting --install-cli.",
      );
    for (const lock of [
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "npm-shrinkwrap.json",
    ]) {
      try {
        await lstat(join(project, lock));
        throw new Error(
          `Existing ${lock} needs manual package-manager review; no dependency install was started.`,
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const installed = await metadata(
      join(project, "node_modules/@rehearsal-db/core/package.json"),
      true,
    );
    if (installed && installed.name !== "@rehearsal-db/core")
      throw new Error(
        "The installed package has an unexpected identity; no dependency install was started.",
      );
    const plan = planCoreInstallation(manifest, installed?.version);
    notes.push(plan.reason);
    if (plan.arguments) {
      await run("npm", plan.arguments);
      const after = await metadata(
        join(project, "node_modules/@rehearsal-db/core/package.json"),
      );
      if (after.name !== "@rehearsal-db/core" || after.version !== CORE_VERSION)
        throw new Error(
          "npm finished without the expected exact Rehearsal package. Review package.json and the lockfile; no rollback or retry was attempted.",
        );
      notes.push(
        `Verified installed core ${CORE_VERSION}. Install scripts were disabled; run Rehearsal's guided setup separately when ready.`,
      );
    }
  }
  if (options.installExtension) {
    if (!checks.code)
      throw new Error(
        "The current host's code command is unavailable. Install Rehearsal DB from VS Code's Extensions view instead.",
      );
    const installed = await run("code", ["--list-extensions"]);
    if (
      (installed.stdout ?? "")
        .split(/\r?\n/u)
        .some((id) => id.trim().toLowerCase() === "rehearsal-db.rehearsal")
    )
      throw new Error(
        "Finish/save work, explicitly uninstall legacy rehearsal-db.rehearsal and reload VS Code before installing Rehearsal DB. No extension was silently removed.",
      );
    await run("code", ["--install-extension", EXTENSION_ID]);
    const listing = await run("code", ["--list-extensions"]);
    if (
      !(listing.stdout ?? "")
        .split(/\r?\n/u)
        .some((id) => id.trim().toLowerCase() === EXTENSION_ID)
    )
      throw new Error(
        "The current VS Code host did not report the canonical extension. Installation is unverified; no retry was attempted.",
      );
    notes.push(
      `Verified extension identity ${EXTENSION_ID} in the current code host; review Workspace Trust and open the dashboard yourself.`,
    );
  }
  return {
    project,
    coreTarget: CORE_VERSION,
    extensionId: EXTENSION_ID,
    checks,
    notes,
  };
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseSetupArguments(process.argv.slice(2));
    if (options.help)
      console.log(
        "Usage: setup [existing-project-folder] [--install-cli] [--install-extension] [--install]\nDefault: check only. No Node/WSL/Docker installation, runtime startup, configuration overwrite or database operation.",
      );
    else console.log(JSON.stringify(await runSetup(options), null, 2));
  } catch (error) {
    console.error(`Rehearsal setup stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
