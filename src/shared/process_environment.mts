/**
 * Purpose: Build minimal child-process environments and validate loopback URLs for
 * the project-neutral Rehearsal runtime. Do not run directly; this module is reusable
 * script infrastructure.
 */

const SAFE_SYSTEM_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
]);

// Windows resolves environment names case-insensitively. Keep only infrastructure
// needed to locate executables and user configuration, never ambient credentials.
const SAFE_WINDOWS_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export type ProcessEnvironment = Record<string, string | undefined>;

export interface CleanProcessEnvironmentOptions {
  inheritedEnvironment?: ProcessEnvironment;
  overrides?: ProcessEnvironment;
  passthroughKeys?: readonly string[];
  platform?: NodeJS.Platform;
}

export const isLoopbackUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
};

export const assertLoopbackUrl = (label: string, value: string): void => {
  if (!value || !isLoopbackUrl(value)) {
    throw new Error(
      `${label} must use a loopback URL; received a non-local target.`,
    );
  }
};

export const pickEnvironmentVariables = (
  source: ProcessEnvironment,
  keys: readonly string[],
): Record<string, string> =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );

const pickWindowsEnvironmentVariables = (
  source: ProcessEnvironment,
  keys: readonly string[],
): Record<string, string> => {
  const selected: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of keys) {
    const normalized = key.toUpperCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const sourceKey =
      source[key] !== undefined
        ? key
        : Object.keys(source).find(
            (candidate) =>
              candidate.toUpperCase() === normalized &&
              source[candidate] !== undefined,
          );
    if (sourceKey !== undefined) selected[key] = source[sourceKey]!;
  }
  return selected;
};

export const createCleanProcessEnvironment = ({
  inheritedEnvironment = process.env,
  overrides = {},
  passthroughKeys = [],
  platform = process.platform,
}: CleanProcessEnvironmentOptions = {}): Record<string, string> => {
  const keys = [
    ...SAFE_SYSTEM_ENVIRONMENT_KEYS,
    ...(platform === "win32" ? SAFE_WINDOWS_ENVIRONMENT_KEYS : []),
    ...passthroughKeys,
  ];
  if (platform !== "win32") {
    return {
      ...pickEnvironmentVariables(inheritedEnvironment, keys),
      ...pickEnvironmentVariables(overrides, Object.keys(overrides)),
    };
  }
  const environment = pickWindowsEnvironmentVariables(
    inheritedEnvironment,
    keys,
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const existing = Object.keys(environment).find(
      (candidate) => candidate.toUpperCase() === key.toUpperCase(),
    );
    environment[existing ?? key] = value;
  }
  return environment;
};
