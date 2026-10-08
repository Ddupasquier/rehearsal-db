/** Explicit typed registry for every normalized privacy action and derivation rule. */

import { executeStructuredJsonDeclaration } from "./privacy_structured_json.mjs";
import type {
  ApprovedOwnerRecipe,
  BindingSubstituteRecipe,
  ConstantRecipe,
  DateShiftRecipe,
  DerivationRecipe,
  DigestRecipe,
  EnumRecipe,
  NormalizedDeclaration,
  PathMapRecipe,
  PrivacyAction,
  PrivacyPathMapping,
  PseudonymRecipe,
  ValidatedStringRecipe,
} from "./privacy_contract.mjs";
import {
  privacyDigest,
  pseudonymize,
  remapPrivacyPath,
  substitutePrivacyBinding,
} from "./privacy_transforms.mjs";
import { PORTABLE_CODE } from "./privacy_validation_shared.mjs";

interface PrivacyExecutionContext {
  readonly declaration: NormalizedDeclaration;
  readonly value: unknown;
  readonly key: Uint8Array;
  readonly path: string;
  readonly ownerApproved: boolean | undefined;
  readonly pathMappings: Readonly<Record<string, PrivacyPathMapping>>;
  readonly bindingValues: ReadonlyMap<string, string>;
  readonly resolveInput: (name: string) => unknown;
}

type ActionHandler = (context: PrivacyExecutionContext) => unknown;
type DerivationHandler = (
  recipe: DerivationRecipe,
  context: PrivacyExecutionContext,
) => unknown;

const dateShift: DerivationHandler = (normalized, context) => {
  const recipe = normalized as DateShiftRecipe;
  if (context.value === null) return null;
  if (
    recipe.representation === "epoch-milliseconds" &&
    (typeof context.value !== "number" || !Number.isSafeInteger(context.value))
  ) {
    throw new Error(
      `${context.path} must be a safe epoch-millisecond integer.`,
    );
  }
  const date = new Date(context.value as string | number);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${context.path} is not a valid date.`);
  }
  const direction = recipe.group
    ? privacyDigest(context.key, "date-shift-group", recipe.group)[0]! % 2 === 0
      ? -1
      : 1
    : privacyDigest(context.key, context.path, context.value)[0]! % 2 === 0
      ? -1
      : 1;
  date.setUTCDate(date.getUTCDate() + direction * recipe.days);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${context.path} shifts outside the supported date range.`);
  }
  return recipe.representation === "epoch-milliseconds"
    ? date.valueOf()
    : date.toISOString();
};

const retainEnum: DerivationHandler = (normalized, context) => {
  const recipe = normalized as EnumRecipe;
  if (context.value === null && recipe.allowNull) return null;
  if (!recipe.values.some((candidate) => Object.is(candidate, context.value))) {
    throw new Error(`${context.path} is outside its reviewed scalar domain.`);
  }
  return context.value;
};

const retainValidatedString: DerivationHandler = (normalized, context) => {
  const recipe = normalized as ValidatedStringRecipe;
  if (context.value === null && recipe.allowNull) return null;
  if (
    typeof context.value !== "string" ||
    Buffer.byteLength(context.value) > recipe.maximumBytes ||
    !PORTABLE_CODE.test(context.value)
  ) {
    throw new Error(`${context.path} is not a valid reviewed portable code.`);
  }
  return context.value;
};

const deriveDigest: DerivationHandler = (normalized, context) => {
  const recipe = normalized as DigestRecipe;
  const inputs = recipe.inputs.map((name) => {
    const sanitized = context.resolveInput(name);
    if (sanitized === undefined) {
      throw new Error(
        `${context.path} digest input ${name} was not sanitized.`,
      );
    }
    return { name, value: sanitized };
  });
  return privacyDigest(context.key, recipe.namespace, inputs)
    .toString("hex")
    .slice(0, recipe.length);
};

const mapPath: DerivationHandler = (normalized, context) => {
  const recipe = normalized as PathMapRecipe;
  const mapping = context.pathMappings[recipe.mapping];
  if (!mapping) {
    throw new Error(
      `${context.path} references an unknown privacy path mapping.`,
    );
  }
  return remapPrivacyPath({
    key: context.key,
    mapping,
    bindingValue: context.bindingValues.get(mapping.binding),
    value: context.value,
    label: context.path,
  });
};

const substituteBinding: DerivationHandler = (normalized, context) => {
  const recipe = normalized as BindingSubstituteRecipe;
  return substitutePrivacyBinding({
    key: context.key,
    recipe,
    bindingValue: context.bindingValues.get(recipe.binding),
    value: context.value,
    label: context.path,
  });
};

const chooseApprovedOwner: DerivationHandler = (normalized, context) => {
  const recipe = normalized as ApprovedOwnerRecipe;
  if (context.ownerApproved === undefined) {
    throw new Error(`${context.path} has no reviewed owner condition.`);
  }
  return executePrivacyDeclaration({
    ...context,
    declaration: context.ownerApproved ? recipe.approved : recipe.otherwise,
  });
};

const structuredJson: DerivationHandler = (_recipe, context) =>
  executeStructuredJsonDeclaration({
    declaration: context.declaration,
    value: context.value,
    key: context.key,
    path: context.path,
    pseudonymize: (nestedKey, nestedRecipe, nestedValue) =>
      pseudonymize(nestedKey, nestedRecipe as PseudonymRecipe, nestedValue),
    execute: (
      nestedDeclaration: NormalizedDeclaration,
      nestedValue: unknown,
      nestedPath: string,
    ) =>
      executePrivacyDeclaration({
        ...context,
        declaration: nestedDeclaration,
        value: nestedValue,
        path: nestedPath,
      }),
  });

export const PRIVACY_DERIVATION_RULES: Readonly<
  Record<DerivationRecipe["kind"], DerivationHandler>
> = Object.freeze({
  "date-shift": dateShift,
  enum: retainEnum,
  "validated-string": retainValidatedString,
  digest: deriveDigest,
  "path-map": mapPath,
  "binding-substitute": substituteBinding,
  "approved-owner": chooseApprovedOwner,
  "json-object": structuredJson,
  "json-array": structuredJson,
  "json-union": structuredJson,
  "json-dictionary": structuredJson,
});

const derive: ActionHandler = (context) => {
  const recipe = context.declaration.recipe;
  if (!recipe || !("kind" in recipe) || recipe.kind === "constant") {
    throw new Error(`${context.path} has an invalid derivation recipe.`);
  }
  const handler = PRIVACY_DERIVATION_RULES[recipe.kind];
  if (!handler) {
    throw new Error(`${context.path} uses an unsupported privacy recipe.`);
  }
  return handler(recipe, context);
};

export const PRIVACY_ACTION_RULES: Readonly<
  Record<PrivacyAction, ActionHandler>
> = Object.freeze({
  KEEP: ({ value }) => value,
  EXCLUDE: () => undefined,
  REPLACE: ({ declaration }) =>
    structuredClone((declaration.recipe as ConstantRecipe).value),
  PSEUDONYMIZE: ({ declaration, key, value }) =>
    pseudonymize(key, declaration.recipe as PseudonymRecipe, value),
  DERIVE: derive,
});

export const executePrivacyDeclaration = (
  context: PrivacyExecutionContext,
): unknown => PRIVACY_ACTION_RULES[context.declaration.action](context);
