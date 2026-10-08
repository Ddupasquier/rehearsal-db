/** Validate and execute the bounded structured-JSON privacy recipes. */

const JSON_UNION_VARIANTS = new Set([
  "string",
  "number",
  "boolean",
  "array",
  "object",
]);
const DICTIONARY_KEY_FORMATS = new Set([
  "integer",
  "positive-integer",
  "uuid",
  "identifier",
  "text",
]);
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAXIMUM_BYTES = 65_536;
const DEFAULT_MAXIMUM_DEPTH = 8;

export const STRUCTURED_JSON_KINDS = new Set([
  "json-object",
  "json-array",
  "json-union",
  "json-dictionary",
]);

const isObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const knownKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};

const positiveInteger = (value, label, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
};

const safeInteger = (value, label) => {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value;
};

const boundsFor = (recipe, label, maximumPolicyDepth) => ({
  maximumBytes: positiveInteger(
    recipe.maximumBytes ?? DEFAULT_MAXIMUM_BYTES,
    `${label}.recipe.maximumBytes`,
    16_777_216,
  ),
  maximumDepth: positiveInteger(
    recipe.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH,
    `${label}.recipe.maximumDepth`,
    maximumPolicyDepth,
  ),
});

const classifiesUnknownJsonValue = (declaration) => {
  if (["REPLACE", "EXCLUDE", "PSEUDONYMIZE"].includes(declaration.action)) {
    return true;
  }
  if (declaration.action !== "DERIVE") return false;
  if (declaration.recipe.kind === "approved-owner") {
    return (
      classifiesUnknownJsonValue(declaration.recipe.approved) &&
      classifiesUnknownJsonValue(declaration.recipe.otherwise)
    );
  }
  if (declaration.recipe.kind === "json-union") return true;
  if (declaration.recipe.kind === "json-array") {
    return classifiesUnknownJsonValue(declaration.recipe.items);
  }
  if (declaration.recipe.kind === "json-object") {
    return Object.values(declaration.recipe.fields).every(
      classifiesUnknownJsonValue,
    );
  }
  if (declaration.recipe.kind === "json-dictionary") {
    return classifiesUnknownJsonValue(declaration.recipe.values);
  }
  return [
    "date-shift",
    "enum",
    "validated-string",
    "path-map",
    "binding-substitute",
  ].includes(declaration.recipe.kind);
};

const classifiesContainer = (declaration, expectedType) => {
  if (["REPLACE", "EXCLUDE", "PSEUDONYMIZE"].includes(declaration.action)) {
    return true;
  }
  if (declaration.action !== "DERIVE") return false;
  if (declaration.recipe.kind === "approved-owner") {
    return (
      classifiesContainer(declaration.recipe.approved, expectedType) &&
      classifiesContainer(declaration.recipe.otherwise, expectedType)
    );
  }
  if (declaration.recipe.kind === "json-union") return true;
  return expectedType === "array"
    ? declaration.recipe.kind === "json-array" &&
        classifiesUnknownJsonValue(declaration.recipe.items)
    : declaration.recipe.kind === "json-object"
      ? Object.values(declaration.recipe.fields).every(
          classifiesUnknownJsonValue,
        )
      : declaration.recipe.kind === "json-dictionary" &&
        classifiesUnknownJsonValue(declaration.recipe.values);
};

export const validateStructuredJsonRecipe = ({
  recipe,
  label,
  depth,
  maximumPolicyDepth,
  validateDeclaration,
  validatePseudonymRecipe,
}) => {
  const bounds = boundsFor(recipe, label, maximumPolicyDepth);
  if (recipe.allowNull !== undefined && typeof recipe.allowNull !== "boolean") {
    throw new Error(`${label}.recipe.allowNull must be true or false.`);
  }
  if (recipe.kind === "json-array") {
    knownKeys(
      recipe,
      [
        "kind",
        "items",
        "allowNull",
        "maximumBytes",
        "maximumDepth",
        "maximumItems",
      ],
      `${label}.recipe`,
    );
    return Object.freeze({
      kind: "json-array",
      allowNull: recipe.allowNull === true,
      ...bounds,
      maximumItems: positiveInteger(
        recipe.maximumItems,
        `${label}.recipe.maximumItems`,
        10_000,
      ),
      items: validateDeclaration(recipe.items, `${label}.recipe.items`, {
        depth,
      }),
    });
  }
  if (recipe.kind === "json-union") {
    knownKeys(
      recipe,
      [
        "kind",
        "variants",
        "allowNull",
        "maximumBytes",
        "maximumDepth",
        "maximumItems",
      ],
      `${label}.recipe`,
    );
    if (
      !isObject(recipe.variants) ||
      Object.keys(recipe.variants).length === 0
    ) {
      throw new Error(
        `${label}.recipe.variants must classify JSON value types.`,
      );
    }
    const variants = Object.fromEntries(
      Object.entries(recipe.variants).map(([type, declaration]) => {
        if (!JSON_UNION_VARIANTS.has(type)) {
          throw new Error(`${label}.recipe.variants.${type} is unsupported.`);
        }
        const normalized = validateDeclaration(
          declaration,
          `${label}.recipe.variants.${type}`,
          { depth },
        );
        if (
          ["array", "object"].includes(type) &&
          !classifiesContainer(normalized, type)
        ) {
          throw new Error(
            `${label}.recipe.variants.${type} must classify container contents instead of retaining the whole value.`,
          );
        }
        return [type, normalized];
      }),
    );
    return Object.freeze({
      kind: "json-union",
      allowNull: recipe.allowNull === true,
      ...bounds,
      maximumItems: positiveInteger(
        recipe.maximumItems,
        `${label}.recipe.maximumItems`,
        10_000,
      ),
      variants: Object.freeze(variants),
    });
  }
  if (recipe.kind === "json-dictionary") {
    knownKeys(
      recipe,
      [
        "kind",
        "keys",
        "values",
        "allowNull",
        "maximumBytes",
        "maximumDepth",
        "maximumItems",
      ],
      `${label}.recipe`,
    );
    if (!isObject(recipe.keys)) {
      throw new Error(`${label}.recipe.keys must be an object.`);
    }
    knownKeys(
      recipe.keys,
      ["format", "action", "minimum", "maximum", "maximumLength", "recipe"],
      `${label}.recipe.keys`,
    );
    if (!DICTIONARY_KEY_FORMATS.has(recipe.keys.format)) {
      throw new Error(`${label}.recipe.keys.format is unsupported.`);
    }
    if (!["KEEP", "PSEUDONYMIZE"].includes(recipe.keys.action)) {
      throw new Error(
        `${label}.recipe.keys.action must be KEEP or PSEUDONYMIZE.`,
      );
    }
    const maximumLength =
      recipe.keys.format === "text"
        ? positiveInteger(
            recipe.keys.maximumLength,
            `${label}.recipe.keys.maximumLength`,
            1_024,
          )
        : undefined;
    const integerRange =
      recipe.keys.format === "integer"
        ? {
            minimum: safeInteger(
              recipe.keys.minimum,
              `${label}.recipe.keys.minimum`,
            ),
            maximum: safeInteger(
              recipe.keys.maximum,
              `${label}.recipe.keys.maximum`,
            ),
          }
        : null;
    if (integerRange !== null && integerRange.minimum > integerRange.maximum) {
      throw new Error(`${label}.recipe.keys.minimum must not exceed maximum.`);
    }
    if (
      recipe.keys.format !== "integer" &&
      (recipe.keys.minimum !== undefined || recipe.keys.maximum !== undefined)
    ) {
      throw new Error(
        `${label}.recipe.keys.minimum and maximum are supported only for integer keys.`,
      );
    }
    if (
      recipe.keys.format !== "text" &&
      recipe.keys.maximumLength !== undefined
    ) {
      throw new Error(
        `${label}.recipe.keys.maximumLength is supported only for text keys.`,
      );
    }
    const keyRecipe =
      recipe.keys.action === "PSEUDONYMIZE"
        ? validatePseudonymRecipe(
            recipe.keys.recipe,
            `${label}.recipe.keys`,
            depth + 1,
          )
        : null;
    if (recipe.keys.action === "KEEP" && recipe.keys.recipe !== undefined) {
      throw new Error(
        `${label}.recipe.keys.recipe is not allowed when keys are kept.`,
      );
    }
    const values = validateDeclaration(
      recipe.values,
      `${label}.recipe.values`,
      { depth },
    );
    if (!classifiesUnknownJsonValue(values)) {
      throw new Error(
        `${label}.recipe.values must classify value types instead of retaining unknown values.`,
      );
    }
    return Object.freeze({
      kind: "json-dictionary",
      allowNull: recipe.allowNull === true,
      ...bounds,
      maximumItems: positiveInteger(
        recipe.maximumItems,
        `${label}.recipe.maximumItems`,
        10_000,
      ),
      keys: Object.freeze({
        format: recipe.keys.format,
        action: recipe.keys.action,
        ...(integerRange === null ? {} : integerRange),
        ...(maximumLength === undefined ? {} : { maximumLength }),
        ...(keyRecipe === null ? {} : { recipe: keyRecipe }),
      }),
      values,
    });
  }
  if (!isObject(recipe.fields) || Object.keys(recipe.fields).length === 0) {
    throw new Error(`${label}.recipe.fields must classify JSON object keys.`);
  }
  knownKeys(
    recipe,
    ["kind", "fields", "allowNull", "maximumBytes", "maximumDepth"],
    `${label}.recipe`,
  );
  const fields = Object.fromEntries(
    Object.entries(recipe.fields).map(([key, declaration]) => {
      if (!key) {
        throw new Error(`${label}.recipe.fields contains an invalid key.`);
      }
      return [
        key,
        validateDeclaration(declaration, `${label}.recipe.fields.${key}`, {
          allowRequired: true,
          depth,
        }),
      ];
    }),
  );
  return Object.freeze({
    kind: "json-object",
    allowNull: recipe.allowNull === true,
    ...bounds,
    fields: Object.freeze(fields),
  });
};

export const structuredJsonDeclarations = (recipe) => {
  if (recipe?.kind === "json-object") return Object.values(recipe.fields);
  if (recipe?.kind === "json-array") return [recipe.items];
  if (recipe?.kind === "json-union") return Object.values(recipe.variants);
  if (recipe?.kind === "json-dictionary") return [recipe.values];
  return [];
};

const assertJsonBounds = (value, recipe, path) => {
  let bytes = 0;
  const jsonStringBytes = (string) => {
    let size = 2;
    for (let index = 0; index < string.length; index += 1) {
      const code = string.charCodeAt(index);
      if (code === 34 || code === 92) size += 2;
      else if (code < 32) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = string.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          size += 4;
          index += 1;
        } else size += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) size += 6;
      else if (code <= 0x7f) size += 1;
      else if (code <= 0x7ff) size += 2;
      else size += 3;
    }
    return size;
  };
  const visit = (current, depth) => {
    if (depth > recipe.maximumDepth) {
      throw new Error(`${path} exceeds maximumDepth ${recipe.maximumDepth}.`);
    }
    if (typeof current === "string") bytes += jsonStringBytes(current);
    else if (current === null) bytes += 4;
    else if (typeof current === "number" && !Number.isFinite(current)) {
      throw new Error(`${path} contains an unsupported JSON value.`);
    } else if (["number", "boolean"].includes(typeof current)) {
      bytes += String(current).length;
    } else if (Array.isArray(current)) {
      if (
        recipe.kind === "json-array" &&
        current.length > recipe.maximumItems
      ) {
        throw new Error(`${path} exceeds maximumItems ${recipe.maximumItems}.`);
      }
      bytes += 2 + Math.max(0, current.length - 1);
      for (const item of current) visit(item, depth + 1);
    } else if (isObject(current)) {
      bytes += 2 + Math.max(0, Object.keys(current).length - 1);
      for (const [key, nested] of Object.entries(current)) {
        bytes += jsonStringBytes(key) + 1;
        visit(nested, depth + 1);
      }
    } else throw new Error(`${path} contains an unsupported JSON value.`);
    if (bytes > recipe.maximumBytes) {
      throw new Error(`${path} exceeds maximumBytes ${recipe.maximumBytes}.`);
    }
  };
  visit(value, 1);
};

const jsonValueType = (value) => {
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (["string", "number", "boolean"].includes(typeof value)) {
    return typeof value;
  }
  return null;
};

const validateDictionaryKey = (value, rule, path) => {
  if (rule.format === "integer") {
    if (!/^(?:0|-?[1-9][0-9]{0,15})$/u.test(value)) {
      throw new Error(`${path} contains an invalid integer key.`);
    }
    const integer = Number(value);
    if (
      !Number.isSafeInteger(integer) ||
      String(integer) !== value ||
      integer < rule.minimum ||
      integer > rule.maximum
    ) {
      throw new Error(
        `${path} contains an integer key outside the reviewed range ${rule.minimum} through ${rule.maximum}.`,
      );
    }
    return integer;
  } else if (rule.format === "positive-integer") {
    if (!/^[1-9][0-9]{0,18}$/u.test(value)) {
      throw new Error(`${path} contains an invalid positive-integer key.`);
    }
  } else if (rule.format === "uuid") {
    if (!UUID.test(value)) {
      throw new Error(`${path} contains an invalid uuid key.`);
    }
  } else if (rule.format === "identifier") {
    if (!IDENTIFIER.test(value)) {
      throw new Error(`${path} contains an invalid identifier key.`);
    }
  } else if (
    !value ||
    value.length > rule.maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${path} contains an invalid bounded text key.`);
  }
  return value;
};

export const executeStructuredJsonDeclaration = ({
  declaration,
  value,
  key,
  path,
  execute,
  pseudonymize,
}) => {
  const recipe = declaration.recipe;
  if (value === null && recipe.allowNull) return null;
  assertJsonBounds(value, recipe, path);
  if (recipe.kind === "json-union") {
    const type = jsonValueType(value);
    if (type === null) {
      throw new Error(`${path} contains an unsupported JSON value.`);
    }
    if (
      ["array", "object"].includes(type) &&
      Object.keys(value).length > recipe.maximumItems
    ) {
      throw new Error(`${path} exceeds maximumItems ${recipe.maximumItems}.`);
    }
    const variant = recipe.variants[type];
    if (!variant) {
      throw new Error(`${path} has an unreviewed JSON ${type} variant.`);
    }
    return execute(variant, value, path);
  }
  if (recipe.kind === "json-array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be a JSON array.`);
    return value.flatMap((item, index) => {
      const transformed = execute(recipe.items, item, `${path}[${index}]`);
      return transformed === undefined ? [] : [transformed];
    });
  }
  if (recipe.kind === "json-dictionary") {
    if (!isObject(value)) {
      throw new Error(`${path} must be a JSON dictionary object.`);
    }
    const entries = Object.entries(value);
    if (entries.length > recipe.maximumItems) {
      throw new Error(`${path} exceeds maximumItems ${recipe.maximumItems}.`);
    }
    const transformed = [];
    const transformedKeys = new Set();
    for (const [sourceKey, nestedValue] of entries) {
      const canonicalSourceKey = validateDictionaryKey(
        sourceKey,
        recipe.keys,
        path,
      );
      const destinationKey =
        recipe.keys.action === "KEEP"
          ? sourceKey
          : String(pseudonymize(key, recipe.keys.recipe, canonicalSourceKey));
      if (transformedKeys.has(destinationKey)) {
        throw new Error(`${path} produced a duplicate transformed JSON key.`);
      }
      transformedKeys.add(destinationKey);
      const nested = execute(
        recipe.values,
        nestedValue,
        `${path}.${sourceKey}`,
      );
      if (nested !== undefined) transformed.push([destinationKey, nested]);
    }
    return Object.fromEntries(transformed);
  }
  if (!isObject(value)) throw new Error(`${path} must be a JSON object.`);
  const actual = Object.keys(value).sort();
  const expected = Object.keys(recipe.fields);
  if (actual.some((field) => !expected.includes(field))) {
    throw new Error(`${path} contains an unclassified JSON key.`);
  }
  const missing = expected.filter(
    (field) => recipe.fields[field].required && !Object.hasOwn(value, field),
  );
  if (missing.length) throw new Error(`${path} is missing required JSON keys.`);
  return Object.fromEntries(
    Object.entries(recipe.fields).flatMap(([field, nested]) => {
      if (!Object.hasOwn(value, field)) return [];
      const transformed = execute(nested, value[field], `${path}.${field}`);
      return transformed === undefined ? [] : [[field, transformed]];
    }),
  );
};
