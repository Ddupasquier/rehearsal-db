import { describe, expect, it, vi } from "vitest";
import {
  assertSupportedHostPlatform,
  inspectHostPlatform,
  NATIVE_WINDOWS_REMEDIATION,
} from "../../../dist/src/shared/host_platform.mjs";

const linuxFacts = {
  platform: "linux",
  kernelRelease: "6.8.0-generic",
  readKernelRelease: async () => "6.8.0-generic",
};

describe("host platform capability evidence", () => {
  it.each(["darwin", "linux"])(
    "keeps %s supported without filesystem probes",
    async (platform) => {
      const inspectFilesystem = vi.fn();
      const result = await inspectHostPlatform({
        ...linuxFacts,
        platform,
        inspectFilesystem,
      });
      expect(result).toMatchObject({
        kind: platform === "darwin" ? "macos" : "linux",
        supported: true,
      });
      expect(inspectFilesystem).not.toHaveBeenCalled();
    },
  );

  it("refuses native Windows with a concrete WSL2 setup route and no probes", async () => {
    const readKernelRelease = vi.fn();
    const inspectFilesystem = vi.fn();
    const result = await inspectHostPlatform({
      platform: "win32",
      readKernelRelease,
      inspectFilesystem,
    });
    expect(result).toMatchObject({ kind: "windows", supported: false });
    expect(result.remediation).toContain("wsl --install -d Ubuntu");
    expect(result.remediation).toContain("WSL integration");
    expect(result.remediation).toContain("not /mnt/c");
    expect(result.remediation).toContain("Remote - WSL");
    expect(readKernelRelease).not.toHaveBeenCalled();
    expect(inspectFilesystem).not.toHaveBeenCalled();
  });

  it.each(["freebsd", "openbsd", "aix", "sunos"])(
    "does not overclaim support for %s",
    async (platform) => {
      expect(await inspectHostPlatform({ platform })).toMatchObject({
        kind: "other",
        supported: false,
      });
    },
  );

  it.each([
    "5.15.167.4-microsoft-standard-WSL2",
    "5.15.90.1-microsoft-standard",
    "6.6.0-WSL2",
  ])(
    "recognizes kernel evidence %s and requires a Linux filesystem",
    async (kernelRelease) => {
      const inspectFilesystem = vi.fn(async () => 0xef53);
      expect(
        await inspectHostPlatform({
          ...linuxFacts,
          kernelRelease,
          projectRoot: "/home/fixture/project",
          inspectFilesystem,
        }),
      ).toMatchObject({ kind: "wsl2", supported: true });
      expect(inspectFilesystem).toHaveBeenCalledWith("/home/fixture/project");
    },
  );

  it("can use fixed proc kernel evidence when the release query lacks a WSL marker", async () => {
    expect(
      await inspectHostPlatform({
        ...linuxFacts,
        readKernelRelease: async () => "6.6.87.2-microsoft-standard-WSL2",
        inspectFilesystem: async () => 0xef53,
      }),
    ).toMatchObject({ kind: "wsl2", supported: true });
  });

  it("retains release evidence when procfs is unreadable", async () => {
    expect(
      await inspectHostPlatform({
        ...linuxFacts,
        kernelRelease: "6.6.0-microsoft-standard-WSL2",
        readKernelRelease: async () => {
          throw new Error("unavailable");
        },
        inspectFilesystem: async () => 0xef53,
      }),
    ).toMatchObject({ kind: "wsl2", supported: true });
  });

  it("does not mistake inherited WSL environment hints for kernel evidence", async () => {
    const previous = process.env.WSL_DISTRO_NAME;
    try {
      process.env.WSL_DISTRO_NAME = "Ubuntu";
      expect(await inspectHostPlatform(linuxFacts)).toMatchObject({
        kind: "linux",
        supported: true,
      });
      expect(await inspectHostPlatform({ platform: "win32" })).toMatchObject({
        kind: "windows",
        supported: false,
      });
    } finally {
      if (previous === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previous;
    }
  });

  it("refuses WSL1 or unverified WSL without probing its filesystem", async () => {
    const inspectFilesystem = vi.fn();
    expect(
      await inspectHostPlatform({
        ...linuxFacts,
        kernelRelease: "4.4.0-19041-Microsoft",
        inspectFilesystem,
      }),
    ).toMatchObject({ kind: "wsl-unverified", supported: false });
    expect(inspectFilesystem).not.toHaveBeenCalled();
  });

  it.each([0x01021997, 0x5346544e, 0x517b, 0, Number.NaN])(
    "refuses Windows or unknown WSL mount type %s even under a Linux-looking path",
    async (filesystemType) => {
      expect(
        await inspectHostPlatform({
          ...linuxFacts,
          kernelRelease: "6.6.0-microsoft-standard-WSL2",
          projectRoot: "/home/looks-local",
          inspectFilesystem: async () => filesystemType,
        }),
      ).toMatchObject({ kind: "wsl2", supported: false });
    },
  );

  it("fails closed on an unreadable WSL project filesystem", async () => {
    const result = await inspectHostPlatform({
      ...linuxFacts,
      kernelRelease: "6.6.0-microsoft-standard-WSL2",
      inspectFilesystem: async () => {
        throw new Error("private path omitted");
      },
    });
    expect(result).toMatchObject({ kind: "wsl2", supported: false });
    expect(result.detail).not.toContain("private path omitted");
  });

  it.each([0xef53, 0x58465342, 0x9123683e])(
    "accepts proven Linux WSL filesystem type %s",
    async (filesystemType) => {
      expect(
        await inspectHostPlatform({
          ...linuxFacts,
          kernelRelease: "6.6.0-microsoft-standard-WSL2",
          inspectFilesystem: async () => filesystemType,
        }),
      ).toMatchObject({ kind: "wsl2", supported: true });
    },
  );

  it("uses the existing unsafe-environment error contract for refused operations", async () => {
    await expect(
      assertSupportedHostPlatform({ platform: "win32" }),
    ).rejects.toMatchObject({
      category: "unsafe_environment",
      code: "HOST_PLATFORM_UNSUPPORTED",
      exitCode: 3,
      suggestions: [NATIVE_WINDOWS_REMEDIATION],
    });
    await expect(
      assertSupportedHostPlatform(linuxFacts),
    ).resolves.toBeUndefined();
  });
});
