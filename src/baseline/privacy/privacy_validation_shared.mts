/** Redacted primitive validators and closed vocabulary for privacy policy v2. */

import type { PrivacyObject } from "./privacy_contract.mjs";

export const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
export const BINDING_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
export const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/u;
export const HEX_64 = /^[a-f0-9]{64}$/u;
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export const PORTABLE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
export const ACTIONS = new Set([
  "KEEP",
  "PSEUDONYMIZE",
  "REPLACE",
  "EXCLUDE",
  "DERIVE",
]);
export const PSEUDONYM_FORMATS = new Set([
  "uuid",
  "email",
  "text",
  "integer",
  "hex",
  "gtin",
  "url",
]);
export const HEX_LENGTHS = new Set([32, 64]);
export const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
export const DATE_REPRESENTATIONS = new Set([
  "iso-string",
  "epoch-milliseconds",
]);
export const DERIVATION_KINDS = new Set([
  "date-shift",
  "digest",
  "enum",
  "validated-string",
  "path-map",
  "json-object",
  "json-array",
  "json-union",
  "json-dictionary",
  "approved-owner",
  "binding-substitute",
]);
export const URL_PATH_PREFIX = "/rehearsal/";
export const URL_TOKEN_LENGTH = 32;
export const MAXIMUM_URL_LENGTH = 2_048;
export const MAXIMUM_TEXT_SUBSTITUTION_BYTES = 65_536;
export const LOOPBACK_HOSTNAMES = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);
export const DEFAULT_PATH_MAXIMUM_BYTES = 2_048;
export const DEFAULT_PATH_MAXIMUM_SEGMENTS = 32;
export const MAXIMUM_POLICY_DEPTH = 16;
export const MAXIMUM_ENUM_VALUES = 128;
export const MAXIMUM_ENUM_STRING_BYTES = 256;

export const isPrivacyObject = (value: unknown): value is PrivacyObject =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const assertKnownKeys = (
  value: PrivacyObject,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};

export const validateIdentifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
};

export const validateNonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

export const validatePositiveInteger = (
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
};

export const validateReviewedScalar = (
  value: unknown,
  label: string,
): string | number | boolean => {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAXIMUM_ENUM_STRING_BYTES) {
      throw new Error(
        `${label} must contain at most ${MAXIMUM_ENUM_STRING_BYTES} UTF-8 bytes.`,
      );
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  ) {
    return value;
  }
  throw new Error(`${label} must be a JSON string, finite number, or boolean.`);
};

export const validateHttpsLoopbackOrigin = (
  value: unknown,
  label: string,
): string => {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${label} must be a safe HTTPS loopback origin.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a safe HTTPS loopback origin.`);
  }
  if (
    parsed.protocol !== "https:" ||
    !LOOPBACK_HOSTNAMES.has(parsed.hostname) ||
    ![parsed.origin, `${parsed.origin}/`].includes(value) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a safe HTTPS loopback origin.`);
  }
  return parsed.origin;
};
