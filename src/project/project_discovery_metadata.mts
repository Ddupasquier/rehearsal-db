/**
 * Bounded metadata access and the non-starting container-engine probe used by
 * project discovery. Project modules and environment files are never loaded.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILENAMES } from "./configuration_discovery.mjs";
import { inspectContainerEngineOptions } from "../runtime/engines/engine_discovery.mjs";
import type { ContainerEngineProbe } from "./project_discovery_contract.mjs";

const MAX_METADATA_BYTES = 1024 * 1024;

const inside = (root: string, path: string): boolean => {
  const local = relative(root, path);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`));
};

export const metadataKind = async (
  root: string,
  localPath: string,
): Promise<"file" | "directory" | "symlink" | null> => {
  const path = resolve(root, localPath);
  if (!inside(root, path)) return null;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isFile()) return "file";
    if (metadata.isDirectory()) return "directory";
    return null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
};

export const readBoundedProjectFile = async (
  root: string,
  localPath: string,
): Promise<string | null> => {
  if ((await metadataKind(root, localPath)) !== "file") return null;
  const path = resolve(root, localPath);
  const metadata = await lstat(path);
  if (metadata.size > MAX_METADATA_BYTES) {
    throw new Error(`${localPath} is too large for safe project discovery.`);
  }
  return readFile(path, "utf8");
};

export const normalizedProjectName = (value: unknown, root: string): string => {
  const source =
    typeof value === "string" && value.trim() ? value : basename(root);
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 52)
      .replace(/-$/u, "") || "rehearsal-project"
  );
};

export const discoverRootConfigPaths = async (
  root: string,
): Promise<string[]> => {
  const paths = new Set<string>();
  for (const path of CONFIG_FILENAMES) {
    if ((await metadataKind(root, path)) === "file") paths.add(path);
  }
  for (const directory of [".", join("infrastructure", "rehearsal")]) {
    if ((await metadataKind(root, directory)) !== "directory") continue;
    const entries = await readdir(resolve(root, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        /^rehearsal(?:\.[a-z0-9_-]+)?\.config\.(?:mjs|js|ts)$/iu.test(
          entry.name,
        )
      ) {
        paths.add(directory === "." ? entry.name : join(directory, entry.name));
      }
    }
  }
  return [...paths].sort((left, right) => {
    const leftIndex = CONFIG_FILENAMES.indexOf(left);
    const rightIndex = CONFIG_FILENAMES.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    }
    return left.localeCompare(right);
  });
};

export const localConfigHints = (
  source: string,
): { applicationUrl: string | null; apiPort: number | null } => {
  const urlMatch =
    /\bapplicationUrl\s*:\s*["'](https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:\/[^"'\s]*)?)["']/u.exec(
      source,
    );
  let applicationUrl: string | null = null;
  if (urlMatch?.[1]) {
    try {
      const url = new URL(urlMatch[1]);
      applicationUrl =
        Number(url.port) >= 1 && Number(url.port) <= 65_535
          ? url.toString().replace(/\/$/u, "")
          : null;
    } catch {
      applicationUrl = null;
    }
  }
  const portMatch = /\bapiPort\s*:\s*(\d{1,5})(?:\D|$)/u.exec(source);
  const port = portMatch?.[1] ? Number(portMatch[1]) : Number.NaN;
  return {
    applicationUrl,
    apiPort:
      Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null,
  };
};

export const probeContainerEngineWithoutStarting: ContainerEngineProbe =
  async () => {
    const result = await inspectContainerEngineOptions();
    return result.state === "ready"
      ? "running"
      : result.state === "unavailable"
        ? "unavailable"
        : "stopped";
  };
