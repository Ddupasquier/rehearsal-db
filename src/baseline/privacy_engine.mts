/**
 * Execute reviewed privacy policy version 2 without project-owned callbacks.
 * The engine is intentionally small and fail-closed: unsupported shapes and
 * recipes must be reviewed and added here instead of evaluated as code.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  STRUCTURED_JSON_KINDS,
  executeStructuredJsonDeclaration,
  structuredJsonDeclarations,
  validateStructuredJsonRecipe,
} from "./privacy_structured_json.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const BINDING_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const PORTABLE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ACTIONS = new Set([
  "KEEP",
  "PSEUDONYMIZE",
  "REPLACE",
  "EXCLUDE",
  "DERIVE",
]);
const PSEUDONYM_FORMATS = new Set([
  "uuid",
  "email",
  "text",
  "integer",
  "hex",
  "gtin",
  "url",
]);
const HEX_LENGTHS = new Set([32, 64]);
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const DATE_REPRESENTATIONS = new Set(["iso-string", "epoch-milliseconds"]);
const DERIVATION_KINDS = new Set([
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
const KEY_BYTES = 32;
const URL_PATH_PREFIX = "/rehearsal/";
const URL_TOKEN_LENGTH = 32;
const MAXIMUM_URL_LENGTH = 2_048;
const MAXIMUM_TEXT_SUBSTITUTION_BYTES = 65_536;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const DEFAULT_PATH_MAXIMUM_BYTES = 2_048;
const DEFAULT_PATH_MAXIMUM_SEGMENTS = 32;
const MAXIMUM_POLICY_DEPTH = 16;
const MAXIMUM_ENUM_VALUES = 128;
const MAXIMUM_ENUM_STRING_BYTES = 256;

type PrivacyAction = "KEEP" | "PSEUDONYMIZE" | "REPLACE" | "EXCLUDE" | "DERIVE";
type PrivacyObject = Record<string, unknown>;

interface PseudonymRecipe {
  format: "uuid" | "email" | "text" | "integer" | "hex" | "gtin" | "url";
  namespace: string;
  maxLength?: number;
  length?: number;
  allowedLengths?: readonly number[];
  origin?: string;
}

interface ConstantRecipe {
  kind: "constant";
  value: unknown;
}

interface DateShiftRecipe {
  kind: "date-shift";
  days: number;
  representation: "iso-string" | "epoch-milliseconds";
  group?: string;
}

interface EnumRecipe {
  kind: "enum";
  allowNull: boolean;
  values: readonly (string | number | boolean)[];
}

interface ValidatedStringRecipe {
  kind: "validated-string";
  format: "portable-code";
  maximumBytes: number;
  allowNull: boolean;
}

interface DigestRecipe {
  kind: "digest";
  format: "hex";
  length: number;
  namespace: string;
  inputs: readonly string[];
}

interface BindingSubstituteRecipe {
  kind: "binding-substitute";
  binding: string;
  format: "uuid";
  namespace: string;
  maximumBytes: number;
}

interface PathMapRecipe {
  kind: "path-map";
  mapping: string;
}

interface ApprovedOwnerRecipe {
  kind: "approved-owner";
  approved: NormalizedDeclaration;
  otherwise: NormalizedDeclaration;
}

interface JsonArrayRecipe {
  kind: "json-array";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  maximumItems: number;
  items: NormalizedDeclaration;
}

interface JsonObjectRecipe {
  kind: "json-object";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  fields: Readonly<Record<string, NormalizedDeclaration>>;
}

interface JsonUnionRecipe {
  kind: "json-union";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  maximumItems: number;
  variants: Readonly<Record<string, NormalizedDeclaration>>;
}

interface JsonDictionaryRecipe {
  kind: "json-dictionary";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  maximumItems: number;
  keys: Readonly<Record<string, unknown>>;
  values: NormalizedDeclaration;
}

type DerivationRecipe =
  | DateShiftRecipe
  | EnumRecipe
  | ValidatedStringRecipe
  | DigestRecipe
  | BindingSubstituteRecipe
  | PathMapRecipe
  | ApprovedOwnerRecipe
  | JsonArrayRecipe
  | JsonObjectRecipe
  | JsonUnionRecipe
  | JsonDictionaryRecipe;
type NormalizedRecipe =
  PseudonymRecipe | ConstantRecipe | DerivationRecipe | null;

interface NormalizedDeclaration {
  action: PrivacyAction;
  recipe: NormalizedRecipe;
  required?: boolean;
}

interface PrivacyBinding {
  environmentVariable: string;
  approvedValueSha256: string;
}

interface PrivacyPathMapping extends PseudonymRecipe {
  binding: string;
  format: "uuid" | "text";
  maximumBytes: number;
  maximumSegments: number;
}

export interface PrivacyForeignKey {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

export interface PrivacyColumn extends NormalizedDeclaration {
  name: string;
  generated: "ALWAYS" | "NEVER";
  identity: "YES" | "NO";
  foreignKey: PrivacyForeignKey | null;
}

export interface PrivacyTable {
  schema: string;
  name: string;
  sourceRows: "STREAM AND SANITIZE" | "EXCLUDE";
  ownerBinding: Readonly<{
    binding: string;
    columns: readonly string[];
    match: "any";
    nullBehavior?: "otherwise";
  }> | null;
  columns: readonly PrivacyColumn[];
}

export interface ExecutablePrivacyPolicy {
  readonly policyVersion: 2;
  readonly migrationCutoff: string;
  readonly bindings: Readonly<Record<string, PrivacyBinding>>;
  readonly pathMappings: Readonly<Record<string, PrivacyPathMapping>>;
  readonly tables: readonly PrivacyTable[];
}

const isObject = (value: unknown): value is PrivacyObject =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const knownKeys = (
  value: PrivacyObject,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
};

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

const positiveInteger = (
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

const reviewedScalar = (
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

const httpsLoopbackOrigin = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${label} must be a safe HTTPS loopback origin.`);
  }
  let parsed;
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

const validateNestedDeclaration = (
  declaration: unknown,
  label: string,
  {
    allowRequired = false,
    depth = 0,
  }: { allowRequired?: boolean; depth?: number } = {},
): Readonly<NormalizedDeclaration> => {
  if (!isObject(declaration)) throw new Error(`${label} must be an object.`);
  knownKeys(
    declaration,
    allowRequired ? ["action", "recipe", "required"] : ["action", "recipe"],
    label,
  );
  if (
    allowRequired &&
    declaration.required !== undefined &&
    typeof declaration.required !== "boolean"
  ) {
    throw new Error(`${label}.required must be true or false.`);
  }
  const action = String(declaration.action ?? "").toUpperCase();
  if (!ACTIONS.has(action)) throw new Error(`${label}.action is unsupported.`);
  return Object.freeze({
    action: action as PrivacyAction,
    recipe: validateRecipe(
      action as PrivacyAction,
      declaration.recipe,
      label,
      depth + 1,
    ),
    ...(allowRequired ? { required: declaration.required !== false } : {}),
  });
};

const validateRecipe = (
  action: PrivacyAction,
  recipe: unknown,
  label: string,
  depth = 0,
): NormalizedRecipe => {
  if (depth > MAXIMUM_POLICY_DEPTH) {
    throw new Error(`${label}.recipe exceeds the supported nesting depth.`);
  }
  if (action === "KEEP" || action === "EXCLUDE") {
    if (recipe !== undefined && recipe !== null) {
      throw new Error(`${label}.recipe is not allowed for ${action}.`);
    }
    return null;
  }
  if (!isObject(recipe)) {
    throw new Error(`${label}.recipe is required for ${action}.`);
  }
  if (action === "PSEUDONYMIZE") {
    knownKeys(
      recipe,
      [
        "format",
        "namespace",
        "maxLength",
        "length",
        "allowedLengths",
        "origin",
      ],
      `${label}.recipe`,
    );
    if (
      typeof recipe.format !== "string" ||
      !PSEUDONYM_FORMATS.has(recipe.format)
    ) {
      throw new Error(`${label}.recipe.format is unsupported.`);
    }
    const normalized: PseudonymRecipe = {
      format: recipe.format as PseudonymRecipe["format"],
      namespace: nonEmpty(recipe.namespace, `${label}.recipe.namespace`),
    };
    if (recipe.format === "text") {
      normalized.maxLength = positiveInteger(
        recipe.maxLength,
        `${label}.recipe.maxLength`,
        1_024,
      );
    } else if (recipe.format === "url") {
      normalized.origin = httpsLoopbackOrigin(
        recipe.origin,
        `${label}.recipe.origin`,
      );
      normalized.maxLength = positiveInteger(
        recipe.maxLength,
        `${label}.recipe.maxLength`,
        MAXIMUM_URL_LENGTH,
      );
      const outputLength =
        normalized.origin.length + URL_PATH_PREFIX.length + URL_TOKEN_LENGTH;
      if (normalized.maxLength < outputLength) {
        throw new Error(
          `${label}.recipe.maxLength must allow the complete pseudonymous URL (${outputLength} characters).`,
        );
      }
    } else if (recipe.maxLength !== undefined) {
      throw new Error(
        `${label}.recipe.maxLength is supported only for text and url pseudonyms.`,
      );
    }
    if (recipe.format === "hex") {
      if (
        typeof recipe.length !== "number" ||
        !HEX_LENGTHS.has(recipe.length)
      ) {
        throw new Error(`${label}.recipe.length must be 32 or 64 for hex.`);
      }
      normalized.length = recipe.length;
    } else if (recipe.format === "gtin") {
      const hasLength = Object.hasOwn(recipe, "length");
      const hasAllowedLengths = Object.hasOwn(recipe, "allowedLengths");
      if (hasLength === hasAllowedLengths) {
        throw new Error(
          `${label}.recipe must declare exactly one of length or allowedLengths for gtin.`,
        );
      }
      if (hasLength) {
        if (
          typeof recipe.length !== "number" ||
          !GTIN_LENGTHS.has(recipe.length)
        ) {
          throw new Error(
            `${label}.recipe.length must be 8, 12, 13, or 14 for gtin.`,
          );
        }
        normalized.length = recipe.length;
      } else {
        if (
          !Array.isArray(recipe.allowedLengths) ||
          recipe.allowedLengths.length === 0
        ) {
          throw new Error(
            `${label}.recipe.allowedLengths must contain reviewed GTIN lengths 8, 12, 13, or 14.`,
          );
        }
        const allowedLengths = recipe.allowedLengths.map((length) => {
          if (typeof length !== "number" || !GTIN_LENGTHS.has(length)) {
            throw new Error(
              `${label}.recipe.allowedLengths must contain reviewed GTIN lengths 8, 12, 13, or 14.`,
            );
          }
          return length;
        });
        if (new Set(allowedLengths).size !== allowedLengths.length) {
          throw new Error(
            `${label}.recipe.allowedLengths must not contain duplicates.`,
          );
        }
        normalized.allowedLengths = Object.freeze(allowedLengths);
      }
    } else if (
      recipe.length !== undefined ||
      recipe.allowedLengths !== undefined ||
      (recipe.origin !== undefined && recipe.format !== "url")
    ) {
      throw new Error(
        `${label}.recipe shape controls do not match its pseudonym format.`,
      );
    }
    return Object.freeze(normalized);
  }
  if (action === "REPLACE") {
    knownKeys(recipe, ["kind", "value"], `${label}.recipe`);
    if (recipe.kind !== "constant" || !Object.hasOwn(recipe, "value")) {
      throw new Error(`${label}.recipe must be an explicit constant.`);
    }
    if (typeof recipe.value === "function" || recipe.value === undefined) {
      throw new Error(`${label}.recipe.value must be JSON-compatible.`);
    }
    JSON.stringify(recipe.value);
    return Object.freeze({ kind: "constant", value: recipe.value });
  }
  knownKeys(
    recipe,
    [
      "kind",
      "days",
      "group",
      "representation",
      "format",
      "length",
      "namespace",
      "inputs",
      "mapping",
      "binding",
      "fields",
      "items",
      "variants",
      "keys",
      "values",
      "approved",
      "otherwise",
      "allowNull",
      "maximumBytes",
      "maximumDepth",
      "maximumItems",
    ],
    `${label}.recipe`,
  );
  if (typeof recipe.kind !== "string" || !DERIVATION_KINDS.has(recipe.kind)) {
    throw new Error(`${label}.recipe.kind is unsupported.`);
  }
  if (recipe.kind === "enum") {
    if (
      Object.keys(recipe).some(
        (key) => !["kind", "values", "allowNull"].includes(key),
      )
    ) {
      throw new Error(`${label}.recipe contains fields not used by enum.`);
    }
    if (
      !Array.isArray(recipe.values) ||
      recipe.values.length === 0 ||
      recipe.values.length > MAXIMUM_ENUM_VALUES
    ) {
      throw new Error(
        `${label}.recipe.values must contain 1 through ${MAXIMUM_ENUM_VALUES} reviewed scalars.`,
      );
    }
    if (
      recipe.allowNull !== undefined &&
      typeof recipe.allowNull !== "boolean"
    ) {
      throw new Error(`${label}.recipe.allowNull must be true or false.`);
    }
    const values = Array.from(recipe.values, (value, index) =>
      reviewedScalar(value, `${label}.recipe.values[${index}]`),
    );
    const identities = values.map((value) =>
      JSON.stringify([typeof value, value]),
    );
    if (new Set(identities).size !== identities.length) {
      throw new Error(`${label}.recipe.values must not contain duplicates.`);
    }
    return Object.freeze({
      kind: "enum",
      allowNull: recipe.allowNull === true,
      values: Object.freeze(values),
    });
  }
  if (recipe.kind === "validated-string") {
    if (
      Object.keys(recipe).some(
        (key) => !["kind", "format", "maximumBytes", "allowNull"].includes(key),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by validated-string.`,
      );
    }
    if (recipe.format !== "portable-code") {
      throw new Error(
        `${label}.recipe.format must be portable-code for validated-string.`,
      );
    }
    const maximumBytes = positiveInteger(
      recipe.maximumBytes,
      `${label}.recipe.maximumBytes`,
      1_024,
    );
    if (
      recipe.allowNull !== undefined &&
      typeof recipe.allowNull !== "boolean"
    ) {
      throw new Error(`${label}.recipe.allowNull must be true or false.`);
    }
    return Object.freeze({
      kind: "validated-string",
      format: "portable-code",
      maximumBytes,
      allowNull: recipe.allowNull === true,
    });
  }
  if (recipe.kind === "digest") {
    if (
      Object.keys(recipe).some(
        (key) =>
          !["kind", "format", "length", "namespace", "inputs"].includes(key),
      )
    ) {
      throw new Error(`${label}.recipe contains fields not used by digest.`);
    }
    if (recipe.format !== "hex") {
      throw new Error(`${label}.recipe.format must be hex for digest.`);
    }
    if (typeof recipe.length !== "number" || !HEX_LENGTHS.has(recipe.length)) {
      throw new Error(`${label}.recipe.length must be 32 or 64 for digest.`);
    }
    if (
      !Array.isArray(recipe.inputs) ||
      recipe.inputs.length === 0 ||
      recipe.inputs.length > 32
    ) {
      throw new Error(
        `${label}.recipe.inputs must contain 1 through 32 columns.`,
      );
    }
    const inputs = recipe.inputs.map((input, index) =>
      identifier(input, `${label}.recipe.inputs[${index}]`),
    );
    if (new Set(inputs).size !== inputs.length) {
      throw new Error(`${label}.recipe.inputs must not contain duplicates.`);
    }
    return Object.freeze({
      kind: "digest",
      format: "hex",
      length: recipe.length,
      namespace: nonEmpty(recipe.namespace, `${label}.recipe.namespace`),
      inputs: Object.freeze(inputs),
    });
  }
  if (recipe.kind === "date-shift") {
    const days = positiveInteger(recipe.days, `${label}.recipe.days`, 3_650);
    if (
      Object.keys(recipe).some(
        (key) => !["kind", "days", "group", "representation"].includes(key),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by date-shift.`,
      );
    }
    if (
      recipe.group !== undefined &&
      (typeof recipe.group !== "string" || !BINDING_NAME.test(recipe.group))
    ) {
      throw new Error(`${label}.recipe.group is invalid.`);
    }
    const representation =
      recipe.representation === undefined
        ? "iso-string"
        : recipe.representation;
    if (
      typeof representation !== "string" ||
      !DATE_REPRESENTATIONS.has(representation)
    ) {
      throw new Error(
        `${label}.recipe.representation must be iso-string or epoch-milliseconds.`,
      );
    }
    return Object.freeze({
      kind: "date-shift",
      days,
      representation: representation as DateShiftRecipe["representation"],
      ...(recipe.group === undefined ? {} : { group: recipe.group }),
    });
  }
  if (recipe.kind === "path-map") {
    if (Object.keys(recipe).some((key) => !["kind", "mapping"].includes(key))) {
      throw new Error(`${label}.recipe contains fields not used by path-map.`);
    }
    if (
      typeof recipe.mapping !== "string" ||
      !BINDING_NAME.test(recipe.mapping)
    ) {
      throw new Error(`${label}.recipe.mapping is invalid.`);
    }
    return Object.freeze({ kind: "path-map", mapping: recipe.mapping });
  }
  if (recipe.kind === "binding-substitute") {
    if (
      Object.keys(recipe).some(
        (key) =>
          !["kind", "binding", "format", "namespace", "maximumBytes"].includes(
            key,
          ),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by binding-substitute.`,
      );
    }
    if (
      typeof recipe.binding !== "string" ||
      !BINDING_NAME.test(recipe.binding)
    ) {
      throw new Error(`${label}.recipe.binding is invalid.`);
    }
    if (recipe.format !== "uuid") {
      throw new Error(`${label}.recipe.format must be uuid.`);
    }
    return Object.freeze({
      kind: "binding-substitute",
      binding: recipe.binding,
      format: "uuid",
      namespace: nonEmpty(recipe.namespace, `${label}.recipe.namespace`),
      maximumBytes: positiveInteger(
        recipe.maximumBytes,
        `${label}.recipe.maximumBytes`,
        MAXIMUM_TEXT_SUBSTITUTION_BYTES,
      ),
    });
  }
  if (recipe.kind === "approved-owner") {
    if (
      Object.keys(recipe).some(
        (key) => !["kind", "approved", "otherwise"].includes(key),
      )
    ) {
      throw new Error(
        `${label}.recipe contains fields not used by approved-owner.`,
      );
    }
    return Object.freeze({
      kind: "approved-owner",
      approved: validateNestedDeclaration(
        recipe.approved,
        `${label}.recipe.approved`,
        { depth },
      ),
      otherwise: validateNestedDeclaration(
        recipe.otherwise,
        `${label}.recipe.otherwise`,
        { depth },
      ),
    });
  }
  return validateStructuredJsonRecipe({
    recipe,
    label,
    depth,
    maximumPolicyDepth: MAXIMUM_POLICY_DEPTH,
    validateDeclaration: validateNestedDeclaration,
    validatePseudonymRecipe: (
      nestedRecipe: unknown,
      nestedLabel: string,
      nestedDepth: number,
    ) => validateRecipe("PSEUDONYMIZE", nestedRecipe, nestedLabel, nestedDepth),
  }) as NormalizedRecipe;
};

export const validateExecutablePrivacyPolicy = (
  policy: unknown,
): ExecutablePrivacyPolicy => {
  if (!isObject(policy)) throw new Error("Privacy policy must be an object.");
  knownKeys(
    policy,
    [
      "policyVersion",
      "draft",
      "migrationCutoff",
      "bindings",
      "pathMappings",
      "tables",
    ],
    "policy",
  );
  if (policy.policyVersion !== 2) {
    throw new Error("Executable privacy policies must use policyVersion 2.");
  }
  if (policy.draft === true) {
    throw new Error("The privacy policy is still a REVIEW REQUIRED draft.");
  }
  if (
    typeof policy.migrationCutoff !== "string" ||
    !/^\d{14}$/u.test(policy.migrationCutoff)
  ) {
    throw new Error(
      "Privacy policy migrationCutoff must be a timestamp version.",
    );
  }
  if (!Array.isArray(policy.tables) || policy.tables.length === 0) {
    throw new Error("Privacy policy must classify at least one table.");
  }
  if (policy.bindings !== undefined && !isObject(policy.bindings)) {
    throw new Error("policy.bindings must be an object.");
  }
  const bindings = Object.fromEntries(
    Object.entries(policy.bindings ?? {}).map(([name, binding]) => {
      if (!BINDING_NAME.test(name) || !isObject(binding)) {
        throw new Error("policy.bindings contains an invalid binding.");
      }
      knownKeys(
        binding,
        ["environmentVariable", "approvedValueSha256"],
        `policy.bindings.${name}`,
      );
      if (
        typeof binding.environmentVariable !== "string" ||
        !ENVIRONMENT_KEY.test(binding.environmentVariable)
      ) {
        throw new Error(
          `policy.bindings.${name}.environmentVariable is invalid.`,
        );
      }
      if (
        typeof binding.approvedValueSha256 !== "string" ||
        !HEX_64.test(binding.approvedValueSha256)
      ) {
        throw new Error(
          `policy.bindings.${name}.approvedValueSha256 must be a lowercase SHA-256 receipt.`,
        );
      }
      return [
        name,
        Object.freeze({
          environmentVariable: binding.environmentVariable,
          approvedValueSha256: binding.approvedValueSha256,
        }),
      ];
    }),
  ) as Record<string, PrivacyBinding>;
  if (policy.pathMappings !== undefined && !isObject(policy.pathMappings)) {
    throw new Error("policy.pathMappings must be an object.");
  }
  const pathMappings = Object.fromEntries(
    Object.entries(policy.pathMappings ?? {}).map(([name, mapping]) => {
      const label = `policy.pathMappings.${name}`;
      if (!BINDING_NAME.test(name) || !isObject(mapping)) {
        throw new Error("policy.pathMappings contains an invalid mapping.");
      }
      knownKeys(
        mapping,
        [
          "binding",
          "format",
          "namespace",
          "maxLength",
          "maximumBytes",
          "maximumSegments",
        ],
        label,
      );
      if (
        typeof mapping.binding !== "string" ||
        !Object.hasOwn(bindings, mapping.binding)
      ) {
        throw new Error(`${label}.binding references an unknown binding.`);
      }
      if (
        typeof mapping.format !== "string" ||
        !["uuid", "text"].includes(mapping.format)
      ) {
        throw new Error(`${label}.format must be uuid or text.`);
      }
      const normalized = {
        binding: mapping.binding,
        format: mapping.format as PrivacyPathMapping["format"],
        namespace: nonEmpty(mapping.namespace, `${label}.namespace`),
        maximumBytes: positiveInteger(
          mapping.maximumBytes ?? DEFAULT_PATH_MAXIMUM_BYTES,
          `${label}.maximumBytes`,
          16_384,
        ),
        maximumSegments: positiveInteger(
          mapping.maximumSegments ?? DEFAULT_PATH_MAXIMUM_SEGMENTS,
          `${label}.maximumSegments`,
          256,
        ),
      };
      if (mapping.format === "text") {
        return [
          name,
          Object.freeze({
            ...normalized,
            maxLength: positiveInteger(
              mapping.maxLength,
              `${label}.maxLength`,
              1_024,
            ),
          }),
        ];
      } else if (mapping.maxLength !== undefined) {
        throw new Error(`${label}.maxLength is supported only for text.`);
      }
      return [name, Object.freeze(normalized)];
    }),
  ) as Record<string, PrivacyPathMapping>;
  const names = new Set<string>();
  const tables = policy.tables.map((table: unknown, tableIndex: number) => {
    const label = `policy.tables[${tableIndex}]`;
    if (!isObject(table)) throw new Error(`${label} must be an object.`);
    knownKeys(
      table,
      ["schema", "name", "sourceRows", "ownerBinding", "columns"],
      label,
    );
    const schema = identifier(table.schema ?? "public", `${label}.schema`);
    const name = identifier(table.name, `${label}.name`);
    const key = schema === "public" ? name : `${schema}.${name}`;
    if (names.has(key))
      throw new Error(`Privacy policy duplicates table ${key}.`);
    names.add(key);
    if (
      typeof table.sourceRows !== "string" ||
      !["STREAM AND SANITIZE", "EXCLUDE"].includes(table.sourceRows)
    ) {
      throw new Error(`${label}.sourceRows is unsupported.`);
    }
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      throw new Error(`${label}.columns must not be empty.`);
    }
    const sourceRows = table.sourceRows as PrivacyTable["sourceRows"];
    const columnNames = new Set<string>();
    const columns: PrivacyColumn[] = table.columns.map(
      (column: unknown, columnIndex: number) => {
        const columnLabel = `${label}.columns[${columnIndex}]`;
        if (!isObject(column))
          throw new Error(`${columnLabel} must be an object.`);
        knownKeys(
          column,
          ["name", "action", "recipe", "generated", "identity", "foreignKey"],
          columnLabel,
        );
        const columnName = identifier(column.name, `${columnLabel}.name`);
        if (columnNames.has(columnName)) {
          throw new Error(
            `Privacy policy duplicates column ${name}.${columnName}.`,
          );
        }
        columnNames.add(columnName);
        const action = String(column.action ?? "").toUpperCase();
        if (!ACTIONS.has(action))
          throw new Error(`${columnLabel}.action is unsupported.`);
        if (
          typeof column.generated !== "string" ||
          !["ALWAYS", "NEVER"].includes(column.generated)
        ) {
          throw new Error(`${columnLabel}.generated must be ALWAYS or NEVER.`);
        }
        if (
          typeof column.identity !== "string" ||
          !["YES", "NO"].includes(column.identity)
        ) {
          throw new Error(`${columnLabel}.identity must be YES or NO.`);
        }
        if (column.foreignKey !== null) {
          if (!isObject(column.foreignKey)) {
            throw new Error(
              `${columnLabel}.foreignKey must be null or an object.`,
            );
          }
          knownKeys(
            column.foreignKey,
            ["schema", "table", "column"],
            `${columnLabel}.foreignKey`,
          );
          identifier(
            column.foreignKey.schema,
            `${columnLabel}.foreignKey.schema`,
          );
          identifier(
            column.foreignKey.table,
            `${columnLabel}.foreignKey.table`,
          );
          identifier(
            column.foreignKey.column,
            `${columnLabel}.foreignKey.column`,
          );
        }
        return Object.freeze({
          ...column,
          name: columnName,
          action: action as PrivacyAction,
          recipe: validateRecipe(
            action as PrivacyAction,
            column.recipe,
            columnLabel,
          ),
          generated: column.generated as PrivacyColumn["generated"],
          identity: column.identity as PrivacyColumn["identity"],
          foreignKey: column.foreignKey,
        }) as PrivacyColumn;
      },
    );
    let ownerBinding: PrivacyTable["ownerBinding"] = null;
    if (table.ownerBinding !== undefined && table.ownerBinding !== null) {
      if (!isObject(table.ownerBinding)) {
        throw new Error(`${label}.ownerBinding must be an object.`);
      }
      knownKeys(
        table.ownerBinding,
        ["binding", "column", "columns", "match", "nullBehavior"],
        `${label}.ownerBinding`,
      );
      const binding = nonEmpty(
        table.ownerBinding.binding,
        `${label}.ownerBinding.binding`,
      );
      const hasColumn = table.ownerBinding.column !== undefined;
      const hasColumns = table.ownerBinding.columns !== undefined;
      if (hasColumn === hasColumns) {
        throw new Error(
          `${label}.ownerBinding must declare exactly one of column or columns.`,
        );
      }
      let ownerColumns: string[];
      if (hasColumn) {
        if (table.ownerBinding.match !== undefined) {
          throw new Error(
            `${label}.ownerBinding.match is supported only with columns.`,
          );
        }
        ownerColumns = [
          identifier(table.ownerBinding.column, `${label}.ownerBinding.column`),
        ];
      } else {
        if (
          !Array.isArray(table.ownerBinding.columns) ||
          table.ownerBinding.columns.length === 0 ||
          table.ownerBinding.columns.length > 16
        ) {
          throw new Error(
            `${label}.ownerBinding.columns must contain 1 through 16 columns.`,
          );
        }
        if (table.ownerBinding.match !== "any") {
          throw new Error(
            `${label}.ownerBinding.match must be any when columns are used.`,
          );
        }
        ownerColumns = table.ownerBinding.columns.map((column, index) =>
          identifier(column, `${label}.ownerBinding.columns[${index}]`),
        );
        if (new Set(ownerColumns).size !== ownerColumns.length) {
          throw new Error(
            `${label}.ownerBinding.columns must not contain duplicates.`,
          );
        }
      }
      if (
        table.ownerBinding.nullBehavior !== undefined &&
        table.ownerBinding.nullBehavior !== "otherwise"
      ) {
        throw new Error(
          `${label}.ownerBinding.nullBehavior must be otherwise when declared.`,
        );
      }
      if (!Object.hasOwn(bindings, binding)) {
        throw new Error(`${label}.ownerBinding references an unknown binding.`);
      }
      for (const column of ownerColumns) {
        if (!columnNames.has(column)) {
          throw new Error(
            `${label}.ownerBinding references an unknown column.`,
          );
        }
        const ownerColumn = columns.find((entry) => entry.name === column);
        if (!ownerColumn || ownerColumn.action !== "PSEUDONYMIZE") {
          throw new Error(
            `${label}.ownerBinding columns must be explicitly pseudonymized.`,
          );
        }
      }
      ownerBinding = Object.freeze({
        binding,
        columns: Object.freeze(ownerColumns),
        match: "any",
        ...(table.ownerBinding.nullBehavior === undefined
          ? {}
          : { nullBehavior: table.ownerBinding.nullBehavior }),
      });
    }
    const usesApprovedOwner = (declaration: NormalizedDeclaration): boolean =>
      (declaration.recipe !== null &&
        "kind" in declaration.recipe &&
        declaration.recipe.kind === "approved-owner") ||
      structuredJsonDeclarations<NormalizedDeclaration>(
        declaration.recipe,
      ).some(usesApprovedOwner);
    if (columns.some(usesApprovedOwner) && !ownerBinding) {
      throw new Error(`${label} uses approved-owner without ownerBinding.`);
    }
    const visitRecipes = (
      declaration: NormalizedDeclaration,
      visit: (recipe: NormalizedRecipe) => void,
    ): void => {
      visit(declaration.recipe);
      if (
        declaration.recipe !== null &&
        "kind" in declaration.recipe &&
        declaration.recipe.kind === "approved-owner"
      ) {
        visitRecipes(declaration.recipe.approved, visit);
        visitRecipes(declaration.recipe.otherwise, visit);
      } else {
        structuredJsonDeclarations<NormalizedDeclaration>(
          declaration.recipe,
        ).forEach((nested) => visitRecipes(nested, visit));
      }
    };
    for (const column of columns) {
      visitRecipes(column, (recipe: NormalizedRecipe) => {
        if (
          recipe &&
          "kind" in recipe &&
          recipe.kind === "path-map" &&
          !Object.hasOwn(pathMappings, recipe.mapping)
        ) {
          throw new Error(
            `${label} references unknown path mapping ${recipe.mapping}.`,
          );
        }
        if (
          recipe !== null &&
          "kind" in recipe &&
          recipe.kind === "binding-substitute" &&
          !Object.hasOwn(bindings, recipe.binding)
        ) {
          throw new Error(
            `${label} references unknown privacy binding ${recipe.binding}.`,
          );
        }
      });
    }
    const dependencies = new Map<string, string[]>(
      columns.map((column) => [column.name, []]),
    );
    const visitDigestInputs = (
      declaration: NormalizedDeclaration,
    ): string[] => {
      if (
        declaration.recipe !== null &&
        "kind" in declaration.recipe &&
        declaration.recipe.kind === "digest"
      ) {
        return [...declaration.recipe.inputs];
      }
      if (
        declaration.recipe !== null &&
        "kind" in declaration.recipe &&
        declaration.recipe.kind === "approved-owner"
      ) {
        return [
          ...visitDigestInputs(declaration.recipe.approved),
          ...visitDigestInputs(declaration.recipe.otherwise),
        ];
      }
      return structuredJsonDeclarations<NormalizedDeclaration>(
        declaration.recipe,
      ).flatMap(visitDigestInputs);
    };
    for (const column of columns) {
      const inputs = [...new Set(visitDigestInputs(column))];
      for (const input of inputs) {
        const inputColumn = columns.find((entry) => entry.name === input);
        if (!inputColumn) {
          throw new Error(
            `${label}.${column.name} digest references unknown column ${input}.`,
          );
        }
        if (inputColumn.action === "EXCLUDE") {
          throw new Error(
            `${label}.${column.name} digest input ${input} is excluded instead of sanitized.`,
          );
        }
      }
      dependencies.set(column.name, inputs);
    }
    const resolvedDependencies = new Set<string>();
    const resolvingDependencies = new Set<string>();
    const visitDependency = (columnName: string): void => {
      if (resolvedDependencies.has(columnName)) return;
      if (resolvingDependencies.has(columnName)) {
        throw new Error(`${label} contains a cyclic digest dependency.`);
      }
      resolvingDependencies.add(columnName);
      for (const input of dependencies.get(columnName) ?? []) {
        visitDependency(input);
      }
      resolvingDependencies.delete(columnName);
      resolvedDependencies.add(columnName);
    };
    columns.forEach((column) => visitDependency(column.name));
    return Object.freeze({
      schema,
      name,
      sourceRows,
      ownerBinding,
      columns: Object.freeze(columns),
    });
  });
  const dateShiftGroups = new Map<string, number>();
  const visitDateShiftGroups = (declaration: NormalizedDeclaration): void => {
    const recipe = declaration.recipe;
    if (!recipe || !("kind" in recipe)) return;
    if (recipe.kind === "date-shift" && recipe.group) {
      const existing = dateShiftGroups.get(recipe.group);
      if (existing !== undefined && existing !== recipe.days) {
        throw new Error(
          `Privacy date-shift group ${recipe.group} must use one days value.`,
        );
      }
      dateShiftGroups.set(recipe.group, recipe.days);
    }
    if (recipe.kind === "approved-owner") {
      visitDateShiftGroups(recipe.approved);
      visitDateShiftGroups(recipe.otherwise);
    } else {
      structuredJsonDeclarations<NormalizedDeclaration>(recipe).forEach(
        visitDateShiftGroups,
      );
    }
  };
  tables.forEach((table) => table.columns.forEach(visitDateShiftGroups));
  return Object.freeze({
    policyVersion: 2,
    migrationCutoff: policy.migrationCutoff,
    bindings: Object.freeze(bindings),
    pathMappings: Object.freeze(pathMappings),
    tables: Object.freeze(tables),
  });
};

const digest = (key: Uint8Array, namespace: string, value: unknown): Buffer => {
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

const pseudonym = (
  key: Uint8Array,
  recipe: PseudonymRecipe,
  value: unknown,
): unknown => {
  if (value === null) return null;
  const bytes = digest(key, recipe.namespace, value);
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
    let source;
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

const remapPath = ({
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
    String(pseudonym(key, mapping, bindingValue)),
    ...segments.slice(1),
  ].join("/");
  if (Buffer.byteLength(destination) > mapping.maximumBytes) {
    throw new Error(`${label} destination exceeds its reviewed byte limit.`);
  }
  return destination;
};

const substituteBinding = ({
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
  const replacement = String(pseudonym(key, recipe, bindingValue));
  const destination = value.replaceAll(bindingValue, replacement);
  if (Buffer.byteLength(destination) > recipe.maximumBytes) {
    throw new Error(`${label} destination exceeds its reviewed byte limit.`);
  }
  return destination;
};

const executeDeclaration = ({
  declaration,
  value,
  key,
  path,
  ownerApproved,
  pathMappings,
  bindingValues,
  resolveInput,
}: {
  declaration: NormalizedDeclaration;
  value: unknown;
  key: Uint8Array;
  path: string;
  ownerApproved: boolean | undefined;
  pathMappings: Readonly<Record<string, PrivacyPathMapping>>;
  bindingValues: ReadonlyMap<string, string>;
  resolveInput: (name: string) => unknown;
}): unknown => {
  if (declaration.action === "KEEP") return value;
  if (declaration.action === "EXCLUDE") return undefined;
  if (declaration.action === "REPLACE")
    return structuredClone((declaration.recipe as ConstantRecipe).value);
  if (declaration.action === "PSEUDONYMIZE") {
    return pseudonym(key, declaration.recipe as PseudonymRecipe, value);
  }
  const recipe = declaration.recipe;
  if (!recipe || !("kind" in recipe) || recipe.kind === "constant") {
    throw new Error(`${path} has an invalid derivation recipe.`);
  }
  if (recipe.kind === "date-shift") {
    if (value === null) return null;
    if (
      recipe.representation === "epoch-milliseconds" &&
      (typeof value !== "number" || !Number.isSafeInteger(value))
    ) {
      throw new Error(`${path} must be a safe epoch-millisecond integer.`);
    }
    const date = new Date(value as string | number);
    if (!Number.isFinite(date.valueOf()))
      throw new Error(`${path} is not a valid date.`);
    const direction = recipe.group
      ? digest(key, "date-shift-group", recipe.group)[0]! % 2 === 0
        ? -1
        : 1
      : digest(key, path, value)[0]! % 2 === 0
        ? -1
        : 1;
    date.setUTCDate(date.getUTCDate() + direction * recipe.days);
    if (!Number.isFinite(date.valueOf())) {
      throw new Error(`${path} shifts outside the supported date range.`);
    }
    return recipe.representation === "epoch-milliseconds"
      ? date.valueOf()
      : date.toISOString();
  }
  if (recipe.kind === "enum") {
    if (value === null && recipe.allowNull) return null;
    if (
      !recipe.values.some((candidate: string | number | boolean) =>
        Object.is(candidate, value),
      )
    ) {
      throw new Error(`${path} is outside its reviewed scalar domain.`);
    }
    return value;
  }
  if (recipe.kind === "validated-string") {
    if (value === null && recipe.allowNull) return null;
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > recipe.maximumBytes ||
      !PORTABLE_CODE.test(value)
    ) {
      throw new Error(`${path} is not a valid reviewed portable code.`);
    }
    return value;
  }
  if (recipe.kind === "digest") {
    const inputs = recipe.inputs.map((name: string) => {
      const sanitized = resolveInput(name);
      if (sanitized === undefined) {
        throw new Error(`${path} digest input ${name} was not sanitized.`);
      }
      return { name, value: sanitized };
    });
    return digest(key, recipe.namespace, inputs)
      .toString("hex")
      .slice(0, recipe.length);
  }
  if (recipe.kind === "path-map") {
    const mapping = pathMappings[recipe.mapping];
    if (!mapping) {
      throw new Error(`${path} references an unknown privacy path mapping.`);
    }
    return remapPath({
      key,
      mapping,
      bindingValue: bindingValues.get(mapping.binding),
      value,
      label: path,
    });
  }
  if (recipe.kind === "binding-substitute") {
    return substituteBinding({
      key,
      recipe,
      bindingValue: bindingValues.get(recipe.binding),
      value,
      label: path,
    });
  }
  if (recipe.kind === "approved-owner") {
    if (ownerApproved === undefined) {
      throw new Error(`${path} has no reviewed owner condition.`);
    }
    return executeDeclaration({
      declaration: ownerApproved ? recipe.approved : recipe.otherwise,
      value,
      key,
      path,
      ownerApproved,
      pathMappings,
      bindingValues,
      resolveInput,
    });
  }
  if (!STRUCTURED_JSON_KINDS.has(recipe.kind)) {
    throw new Error(`${path} uses an unsupported privacy recipe.`);
  }
  return executeStructuredJsonDeclaration({
    declaration,
    value,
    key,
    path,
    pseudonymize: (nestedKey, nestedRecipe, nestedValue) =>
      pseudonym(nestedKey, nestedRecipe as PseudonymRecipe, nestedValue),
    execute: (
      nestedDeclaration: NormalizedDeclaration,
      nestedValue: unknown,
      nestedPath: string,
    ) =>
      executeDeclaration({
        declaration: nestedDeclaration,
        value: nestedValue,
        key,
        path: nestedPath,
        ownerApproved,
        pathMappings,
        bindingValues,
        resolveInput,
      }),
  });
};

export interface PrivacySourceRecord {
  schema?: string;
  table: string;
  row: Record<string, unknown>;
}

export interface PrivacyEngine {
  readonly keyFingerprint: string;
  remapPath(input: { mapping: string; value: string }): string;
  sanitize(record: unknown): PrivacySourceRecord | null;
}

export const createPrivacyEngine = ({
  policy,
  key,
  environment = process.env,
}: {
  policy: unknown;
  key: Uint8Array | string;
  environment?: NodeJS.ProcessEnv;
}): Readonly<PrivacyEngine> => {
  const normalized = validateExecutablePrivacyPolicy(policy);
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(key ?? "");
  if (secret.length < KEY_BYTES) {
    throw new Error(`Privacy key must contain at least ${KEY_BYTES} bytes.`);
  }
  const bindingValues = new Map<string, string>(
    Object.entries(normalized.bindings).map(([name, binding]) => {
      const value = environment[binding.environmentVariable];
      if (typeof value !== "string" || !value) {
        throw new Error(
          `Privacy binding ${name} requires ${binding.environmentVariable}.`,
        );
      }
      const receipt = createHash("sha256").update(value).digest("hex");
      if (receipt !== binding.approvedValueSha256) {
        throw new Error(
          `Privacy binding ${name} does not match its review receipt.`,
        );
      }
      return [name, value];
    }),
  );
  const tables = new Map<string, PrivacyTable>(
    normalized.tables.map((table) => [
      table.schema === "public" ? table.name : `${table.schema}.${table.name}`,
      table,
    ]),
  );
  return Object.freeze({
    keyFingerprint: createHash("sha256").update(secret).digest("hex"),
    remapPath({
      mapping: mappingName,
      value,
    }: {
      mapping: string;
      value: string;
    }): string {
      const mapping = normalized.pathMappings[mappingName];
      if (!mapping) {
        throw new Error(`Privacy path mapping ${mappingName} is not declared.`);
      }
      return remapPath({
        key: secret,
        mapping,
        bindingValue: bindingValues.get(mapping.binding),
        value,
        label: `Privacy path mapping ${mappingName}`,
      });
    },
    sanitize(record: unknown): PrivacySourceRecord | null {
      if (
        !isObject(record) ||
        typeof (record.schema ?? "public") !== "string" ||
        !IDENTIFIER.test(String(record.schema ?? "public")) ||
        typeof record.table !== "string" ||
        !IDENTIFIER.test(record.table) ||
        !isObject(record.row)
      ) {
        throw new Error("Source record has an invalid privacy-engine shape.");
      }
      const schema = String(record.schema ?? "public");
      const rowSource = record.row;
      const relation =
        schema === "public" ? record.table : `${schema}.${record.table}`;
      const table = tables.get(relation);
      if (!table)
        throw new Error(`Privacy policy does not classify table ${relation}.`);
      if (table.sourceRows === "EXCLUDE") return null;
      const actual = Object.keys(rowSource).sort();
      const expected = table.columns.map((column) => column.name).sort();
      if (actual.join("\0") !== expected.join("\0")) {
        throw new Error(
          `Source table ${relation} contains an unclassified or missing column.`,
        );
      }
      let ownerApproved: boolean | undefined;
      if (table.ownerBinding) {
        const approvedValue = bindingValues.get(table.ownerBinding.binding);
        const owners = table.ownerBinding.columns.map(
          (column: string) => rowSource[column],
        );
        for (const owner of owners) {
          if (owner === null) {
            if (table.ownerBinding.nullBehavior !== "otherwise") {
              throw new Error(
                `${relation} has an invalid owner binding value.`,
              );
            }
            continue;
          }
          if (
            !["string", "number"].includes(typeof owner) ||
            owner === "" ||
            (typeof owner === "number" && !Number.isFinite(owner))
          ) {
            throw new Error(`${relation} has an invalid owner binding value.`);
          }
        }
        ownerApproved = owners.some(
          (owner: unknown) => owner !== null && String(owner) === approvedValue,
        );
      }
      const sanitizedColumns = new Map<string, unknown>();
      const resolvingColumns = new Set<string>();
      const sanitizeColumn = (columnName: string): unknown => {
        if (sanitizedColumns.has(columnName)) {
          return sanitizedColumns.get(columnName);
        }
        if (resolvingColumns.has(columnName)) {
          throw new Error(`${relation} contains a cyclic digest dependency.`);
        }
        const column = table.columns.find((entry) => entry.name === columnName);
        if (!column) {
          throw new Error(
            `${relation} digest references unknown column ${columnName}.`,
          );
        }
        resolvingColumns.add(columnName);
        try {
          const transformed = executeDeclaration({
            declaration: column,
            value: rowSource[column.name],
            key: secret,
            path: `${relation}.${column.name}`,
            ownerApproved,
            pathMappings: normalized.pathMappings,
            bindingValues,
            resolveInput: sanitizeColumn,
          });
          sanitizedColumns.set(columnName, transformed);
          return transformed;
        } finally {
          resolvingColumns.delete(columnName);
        }
      };
      const row = Object.fromEntries(
        table.columns.flatMap((column) => {
          const transformed = sanitizeColumn(column.name);
          return transformed === undefined ? [] : [[column.name, transformed]];
        }),
      );
      return schema === "public"
        ? { table: record.table, row }
        : { schema, table: record.table, row };
    },
  });
};

export const createPrivacyKey = async (
  path: string,
): Promise<{ fingerprint: string }> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${key.toString("base64")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return { fingerprint: createHash("sha256").update(key).digest("hex") };
};

export const readPrivacyKey = async (path: string): Promise<Buffer> => {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error("Privacy key must be an owner-only regular file.");
  }
  const encoded = (await readFile(path, "utf8")).trim();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Privacy key file is invalid.");
  }
  return key;
};

export const assertPrivacyKeyFingerprint = (
  key: Uint8Array,
  expected: unknown,
): void => {
  if (typeof expected !== "string" || !HEX_64.test(expected))
    throw new Error("Privacy key fingerprint is invalid.");
  const actual = createHash("sha256").update(key).digest("hex");
  if (actual !== expected)
    throw new Error(
      "Privacy key does not match the reviewed baseline receipt.",
    );
};
