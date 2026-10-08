/** Deterministic primitive, identifier-shape, URL, and path transformations. */

import { createHmac } from "node:crypto";
import type {
  BindingSubstituteRecipe,
  PrivacyPathMapping,
  PseudonymRecipe,
} from "./privacy_contract.mjs";
import {
  URL_PATH_PREFIX,
  URL_TOKEN_LENGTH,
  UUID,
} from "./privacy_validation_shared.mjs";

export const privacyDigest = (
  key: Uint8Array,
  namespace: string,
  value: unknown,
): Buffer => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Privacy input must be JSON-compatible.");
  }
  return createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(serialized)
    .digest();
};

const gtinCheckDigit = (payload: string): string => {
  const sum = [...payload]
    .reverse()
    .reduce(
      (total: number, digit: string, index: number) =>
        total + Number(digit) * (index % 2 === 0 ? 3 : 1),
      0,
    );
  return String((10 - (sum % 10)) % 10);
};

const isValidGtin = (value: unknown, length: number): value is string =>
  typeof value === "string" &&
  value.length === length &&
  /^\d+$/u.test(value) &&
  value.at(-1) === gtinCheckDigit(value.slice(0, -1));

export const pseudonymize = (
  key: Uint8Array,
  recipe: PseudonymRecipe,
  value: unknown,
): unknown => {
  if (value === null) return null;
  const bytes = privacyDigest(key, recipe.namespace, value);
  if (recipe.format === "uuid") {
    const copy = Buffer.from(bytes.subarray(0, 16));
    copy[6] = (copy[6]! & 0x0f) | 0x40;
    copy[8] = (copy[8]! & 0x3f) | 0x80;
    const hex = copy.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (recipe.format === "email") {
    return `rehearsal+${bytes.toString("hex").slice(0, 24)}@example.invalid`;
  }
  if (recipe.format === "integer") {
    return Number(bytes.readBigUInt64BE(0) % 9_007_199_254_740_991n) + 1;
  }
  if (recipe.format === "hex") {
    return bytes.toString("hex").slice(0, recipe.length);
  }
  if (recipe.format === "gtin") {
    const allowedLengths =
      recipe.allowedLengths ??
      (recipe.length === undefined ? [] : [recipe.length]);
    const sourceLength = typeof value === "string" ? value.length : null;
    if (
      sourceLength === null ||
      !allowedLengths.includes(sourceLength) ||
      !isValidGtin(value, sourceLength)
    ) {
      if (recipe.length !== undefined) {
        throw new Error(
          `A gtin pseudonym source must be a valid normalized GTIN-${recipe.length} string.`,
        );
      }
      throw new Error(
        `A gtin pseudonym source must be a valid normalized GTIN string with an allowed length (${allowedLengths.join(", ")}).`,
      );
    }
    const modulus = 10n ** BigInt(sourceLength - 1);
    const payload = (BigInt(`0x${bytes.toString("hex")}`) % modulus)
      .toString()
      .padStart(sourceLength - 1, "0");
    return `${payload}${gtinCheckDigit(payload)}`;
  }
  if (recipe.format === "url") {
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      /\s/u.test(value)
    ) {
      throw new Error("A url pseudonym source must be a valid HTTPS URL.");
    }
    let source: URL;
    try {
      source = new URL(value);
    } catch {
      throw new Error("A url pseudonym source must be a valid HTTPS URL.");
    }
    if (source.protocol !== "https:") {
      throw new Error("A url pseudonym source must be a valid HTTPS URL.");
    }
    const output = `${recipe.origin!}${URL_PATH_PREFIX}${bytes
      .toString("hex")
      .slice(0, URL_TOKEN_LENGTH)}`;
    if (output.length > recipe.maxLength!) {
      throw new Error("A url pseudonym exceeded its reviewed maximum length.");
    }
    return output;
  }
  const token = `rehearsal_${bytes.toString("hex")}`;
  return token.slice(0, recipe.maxLength!);
};

export const remapPrivacyPath = ({
  key,
  mapping,
  bindingValue,
  value,
  label,
}: {
  key: Uint8Array;
  mapping: PrivacyPathMapping;
  bindingValue: string | undefined;
  value: unknown;
  label: string;
}): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a Storage-style path string.`);
  }
  if (Buffer.byteLength(value) > mapping.maximumBytes) {
    throw new Error(`${label} exceeds its reviewed byte limit.`);
  }
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    segments.length > mapping.maximumSegments ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is not a safe bounded Storage path.`);
  }
  if (
    typeof bindingValue !== "string" ||
    !bindingValue ||
    bindingValue.includes("/") ||
    bindingValue === "." ||
    bindingValue === ".."
  ) {
    throw new Error(`${label} has an invalid reviewed identity binding.`);
  }
  if (segments[0] !== bindingValue) {
    throw new Error(
      `${label} does not begin with its exact reviewed identity.`,
    );
  }
  const destination = [
    String(pseudonymize(key, mapping, bindingValue)),
    ...segments.slice(1),
  ].join("/");
  if (Buffer.byteLength(destination) > mapping.maximumBytes) {
    throw new Error(`${label} destination exceeds its reviewed byte limit.`);
  }
  return destination;
};

export const substitutePrivacyBinding = ({
  key,
  recipe,
  bindingValue,
  value,
  label,
}: {
  key: Uint8Array;
  recipe: BindingSubstituteRecipe;
  bindingValue: string | undefined;
  value: unknown;
  label: string;
}): string | null => {
  if (typeof bindingValue !== "string" || !UUID.test(bindingValue)) {
    throw new Error(`${label} has an invalid reviewed UUID binding.`);
  }
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${label} must be text or null for binding substitution.`);
  }
  if (Buffer.byteLength(value) > recipe.maximumBytes) {
    throw new Error(`${label} exceeds its reviewed byte limit.`);
  }
  const replacement = String(pseudonymize(key, recipe, bindingValue));
  const destination = value.replaceAll(bindingValue, replacement);
  if (Buffer.byteLength(destination) > recipe.maximumBytes) {
    throw new Error(`${label} destination exceeds its reviewed byte limit.`);
  }
  return destination;
};
