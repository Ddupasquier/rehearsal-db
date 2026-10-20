/** Read-only host capability checks; never substitute environment hints for proof. */
import { open, statfs } from "node:fs/promises";
import { release } from "node:os";
import { RehearsalError } from "./diagnostics.mjs";

export const NATIVE_WINDOWS_REMEDIATION =
  "Use WSL2, not a native Windows terminal: run wsl --install -d Ubuntu in PowerShell and confirm version 2 with wsl --list --verbose (upgrade with wsl --set-version Ubuntu 2 if needed). Enable Docker Desktop Settings > Resources > WSL integration for that distribution. Keep the project in its Linux home filesystem (for example ~/projects, not /mnt/c), install a supported Linux Node.js version and project tools there, open it with VS Code Remote - WSL, then rerun rehearsal doctor inside WSL2.";

export interface HostPlatformInspection {
  readonly kind:
    "macos" | "linux" | "wsl2" | "wsl-unverified" | "windows" | "other";
  readonly supported: boolean;
  readonly detail: string;
  readonly remediation: string;
}

export interface HostPlatformOptions {
  readonly projectRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly kernelRelease?: string;
  readonly readKernelRelease?: () => Promise<string>;
  readonly inspectFilesystem?: (path: string) => Promise<number>;
}

const readProcKernelRelease = async (): Promise<string> => {
  const file = await open("/proc/sys/kernel/osrelease", "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};

// WSL's Windows drive mounts do not provide the private modes and atomic symlink
// contract used by baselines. Accept proven Linux filesystem types, not paths.
const WSL_POSIX_FILESYSTEM_TYPES = new Set([
  0xef53, // ext2/ext3/ext4 (WSL2 distribution filesystem)
  0x58465342, // XFS
  0x9123683e, // Btrfs
]);

export const inspectHostPlatform = async ({
  projectRoot = process.cwd(),
  platform = process.platform,
  kernelRelease = release(),
  readKernelRelease = readProcKernelRelease,
  inspectFilesystem = async (path) => (await statfs(path)).type,
}: HostPlatformOptions = {}): Promise<HostPlatformInspection> => {
  if (platform === "darwin") {
    return {
      kind: "macos",
      supported: true,
      detail:
        "macOS is in the supported host matrix; project readiness checks still apply.",
      remediation: "Resolve the remaining project readiness checks on macOS.",
    };
  }
  if (platform === "win32") {
    return {
      kind: "windows",
      supported: false,
      detail:
        "Native Windows runtime and preparation operations are unsupported: POSIX private-file, process-group, and atomic baseline-pointer guarantees have not been established.",
      remediation: NATIVE_WINDOWS_REMEDIATION,
    };
  }
  if (platform !== "linux") {
    return {
      kind: "other",
      supported: false,
      detail:
        "This operating system is outside the verified macOS/Linux runtime contract.",
      remediation:
        "Use a supported macOS or Linux environment. Windows users should use WSL2 with the project on its Linux home filesystem and Docker Desktop WSL integration.",
    };
  }
  let procRelease = "";
  try {
    procRelease = (await readKernelRelease()).slice(0, 512);
  } catch {
    // os.release() is independent kernel evidence when procfs is unavailable.
  }
  const evidence = `${kernelRelease.slice(0, 512)}\n${procRelease}`;
  if (!/microsoft|\bwsl2?\b/iu.test(evidence)) {
    return {
      kind: "linux",
      supported: true,
      detail:
        "Linux is in the supported host matrix; project readiness checks still apply.",
      remediation: "Resolve the remaining project readiness checks on Linux.",
    };
  }
  if (!/microsoft-standard|\bwsl2\b/iu.test(evidence)) {
    return {
      kind: "wsl-unverified",
      supported: false,
      detail:
        "A WSL kernel was detected, but WSL2 kernel capabilities were not proven. WSL1 is unsupported.",
      remediation: NATIVE_WINDOWS_REMEDIATION,
    };
  }
  let filesystemType: number | null = null;
  try {
    filesystemType = await inspectFilesystem(projectRoot);
  } catch {
    // Unknown filesystem evidence must not be interpreted as POSIX capability.
  }
  if (
    filesystemType === null ||
    !WSL_POSIX_FILESYSTEM_TYPES.has(filesystemType)
  ) {
    return {
      kind: "wsl2",
      supported: false,
      detail:
        "WSL2 was detected, but this project is not on a proven Linux filesystem. Windows drive mounts and unknown filesystem types are unsupported for private baseline data.",
      remediation: NATIVE_WINDOWS_REMEDIATION,
    };
  }
  return {
    kind: "wsl2",
    supported: true,
    detail:
      "WSL2 kernel and a Linux project filesystem were detected. Run in VS Code Remote - WSL with Linux tools and Docker Desktop WSL integration; the remaining readiness and private-file checks still apply.",
    remediation: NATIVE_WINDOWS_REMEDIATION,
  };
};

export const assertSupportedHostPlatform = async (
  options: HostPlatformOptions = {},
): Promise<void> => {
  const inspection = await inspectHostPlatform(options);
  if (inspection.supported) return;
  throw new RehearsalError({
    category: "unsafe_environment",
    code: "HOST_PLATFORM_UNSUPPORTED",
    message: inspection.detail,
    expected:
      "A supported macOS/Linux runtime with its existing safety guarantees.",
    actual: inspection.kind,
    refused:
      "No project configuration, child process, or runtime operation was started.",
    suggestions: [inspection.remediation],
  });
};
