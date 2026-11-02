/**
 * Validate and normalize reviewed privacy recipes for policy version 2.
 */

import { validateStructuredJsonRecipe } from "./privacy_structured_json.mjs";
import type {
  DateShiftRecipe,
  NormalizedDeclaration,
  NormalizedRecipe,
  PrivacyAction,
  PseudonymRecipe,
} from "./privacy_contract.mjs";
import {
  ACTIONS,
  BINDING_NAME,
  DATE_REPRESENTATIONS,
  DERIVATION_KINDS,
  GTIN_LENGTHS,
  HEX_LENGTHS,
  MAXIMUM_ENUM_VALUES,
  MAXIMUM_POLICY_DEPTH,
  MAXIMUM_TEXT_SUBSTITUTION_BYTES,
  MAXIMUM_URL_LENGTH,
  PSEUDONYM_FORMATS,
  URL_PATH_PREFIX,
  URL_TOKEN_LENGTH,
  assertKnownKeys as knownKeys,
  isPrivacyObject as isObject,
  validateHttpsLoopbackOrigin as httpsLoopbackOrigin,
  validateIdentifier as identifier,
  validateNonEmpty as nonEmpty,
  validatePositiveInteger as positiveInteger,
  validateReviewedScalar as reviewedScalar,
} from "./privacy_validation_shared.mjs";

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
    recipe: validatePrivacyRecipe(
      action as PrivacyAction,
      declaration.recipe,
      label,
      depth + 1,
    ),
    ...(allowRequired ? { required: declaration.required !== false } : {}),
  });
};

export const validatePrivacyRecipe = (
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
    ) =>
      validatePrivacyRecipe(
        "PSEUDONYMIZE",
        nestedRecipe,
        nestedLabel,
        nestedDepth,
      ),
  }) as NormalizedRecipe;
};
