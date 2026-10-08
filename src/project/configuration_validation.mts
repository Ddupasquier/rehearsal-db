/**
 * Purpose: Provide the reusable, side-effect-free validators used by the
 * Rehearsal configuration schema and normalizer.
 */

import { isAbsolute } from "node:path";

export type PlainObject = Record<string, unknown>;

const SAFE_COMMAND_PATTERN = /^[^\n\r\0]+$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const DATABASE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const POSTGRES_IMAGE_PATTERN = /^postgres:\d+(?:\.\d+)?-alpine$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const ENVIRONMENT_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9-]*:[A-Z][A-Z0-9_]*$/u;

export const isPlainObject = (value: unknown): value is PlainObject =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const assertPlainObject = (
  value: unknown,
  path: string,
): PlainObject => {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  return value;
};

export const assertKnownKeys = (
  value: PlainObject,
  keys: readonly string[],
  path: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(
        `Unknown Rehearsal configuration property: ${path}.${key}.`,
      );
    }
  }
};

export const assertNonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
};

export const assertRelativePath = (value: unknown, path: string): string => {
  const normalized = assertNonEmptyString(value, path);
  if (isAbsolute(normalized) || normalized.split(/[\\/]/u).includes("..")) {
    throw new Error(`${path} must stay inside the project root.`);
  }
  return normalized;
};

export const assertCommand = (value: unknown, path: string): string => {
  const command = assertNonEmptyString(value, path);
  if (!SAFE_COMMAND_PATTERN.test(command)) {
    throw new Error(`${path} contains an unsafe control character.`);
  }
  return command;
};

export const assertIdentifier = (value: unknown, path: string): string => {
  const identifier = assertNonEmptyString(value, path);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `${path} must contain only lowercase letters, digits, and hyphens.`,
    );
  }
  return identifier;
};

export const assertDatabaseIdentifier = (
  value: unknown,
  path: string,
): string => {
  const identifier = assertNonEmptyString(value, path);
  if (!DATABASE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`${path} must be a safe lowercase PostgreSQL identifier.`);
  }
  return identifier;
};

export const assertPostgresImage = (value: unknown, path: string): string => {
  const image = assertNonEmptyString(value, path);
  if (!POSTGRES_IMAGE_PATTERN.test(image)) {
    throw new Error(
      `${path} must name an official versioned Alpine PostgreSQL image, such as postgres:17-alpine.`,
    );
  }
  return image;
};

export const assertEnvironmentKey = (value: unknown, path: string): string => {
  const key = assertNonEmptyString(value, path);
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
    throw new Error(`${path} must be a safe environment variable name.`);
  }
  return key;
};

export const assertEnvironmentReference = (
  value: unknown,
  path: string,
): string => {
  if (typeof value !== "string" || !ENVIRONMENT_REFERENCE_PATTERN.test(value)) {
    throw new Error(
      `${path} must reference target:VARIABLE, such as primary:DATABASE_URL.`,
    );
  }
  return value;
};

export const assertPort = (value: unknown, path: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1024 ||
    value > 65_535
  ) {
    throw new Error(`${path} must be a non-privileged TCP port.`);
  }
  return value;
};

export const assertBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be true or false.`);
  }
  return value;
};

export const assertPositiveInteger = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
};

export const assertHttpStatus = (value: unknown, path: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 100 ||
    value > 599
  ) {
    throw new Error(`${path} must be an HTTP status.`);
  }
  return value;
};

export const assertStringArray = (value: unknown, path: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${path} must be a non-empty string array.`);
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
};

export const assertLoopbackUrl = (
  value: unknown,
  path: string,
  allowedHosts: readonly string[],
  supportedHosts: ReadonlySet<string>,
): string => {
  let parsed: URL;
  try {
    parsed = new URL(assertNonEmptyString(value, path));
  } catch {
    throw new Error(`${path} must be a valid loopback URL.`);
  }
  if (
    !allowedHosts.includes(parsed.hostname) ||
    !supportedHosts.has(parsed.hostname)
  ) {
    throw new Error(`${path} must use an explicitly allowed loopback host.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${path} must use HTTP or HTTPS.`);
  }
  return parsed.toString().replace(/\/$/u, "");
};
