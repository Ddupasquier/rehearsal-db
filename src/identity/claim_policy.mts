/** Validate and normalize the reviewed local identity policy. */

import {
  SUPPORTED_IDENTITY_PROVIDERS,
  type IdentityMatcher,
  type IdentityPolicy,
  type IdentityProvider,
  type IdentityStrategy,
  type IdentityTokenHook,
  type JsonObject,
  type PathValueType,
  type Relation,
  type SignupDefaultMatcher,
  type SubjectIdentityProvider,
} from "./claim_contract.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const LABEL = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/u;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(`${label} is not a safe identifier.`);
  return value;
};
const keys = (
  value: JsonObject,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};
const optionalArray = (value: unknown, label: string): readonly unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};
const relation = (value: unknown, label: string): Readonly<Relation> => {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  keys(value, ["schema", "table"], label);
  return Object.freeze({
    schema: id(value.schema, `${label}.schema`),
    table: id(value.table, `${label}.table`),
  });
};
const jsonValue = (value: unknown, label: string): unknown => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-compatible.`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} must be JSON-compatible.`);
  }
  return JSON.parse(serialized);
};
const defaultMatcher = (
  value: unknown,
  label: string,
): Readonly<SignupDefaultMatcher> => {
  if (isObject(value) && value.kind === "pattern") {
    keys(value, ["kind", "pattern"], label);
    if (
      typeof value.pattern !== "string" ||
      value.pattern.length > 256 ||
      !value.pattern.startsWith("^") ||
      !value.pattern.endsWith("$")
    ) {
      throw new Error(
        `${label}.pattern must be anchored and at most 256 characters.`,
      );
    }
    try {
      new RegExp(value.pattern, "u");
    } catch {
      throw new Error(`${label}.pattern is invalid.`);
    }
    return Object.freeze({ kind: "pattern", pattern: value.pattern });
  }
  if (isObject(value) && value.kind === "exact") {
    keys(value, ["kind", "value"], label);
    return Object.freeze({
      kind: "exact",
      value: jsonValue(value.value, `${label}.value`),
    });
  }
  return Object.freeze({ kind: "exact", value: jsonValue(value, label) });
};

function provider(
  value: unknown,
  label: string,
  options: { subject: true },
): SubjectIdentityProvider;
function provider(
  value: unknown,
  label: string,
  options?: { subject?: false },
): IdentityProvider;
function provider(
  value: unknown,
  label: string,
  { subject = false }: { subject?: boolean } = {},
): IdentityProvider {
  if (
    typeof value !== "string" ||
    !SUPPORTED_IDENTITY_PROVIDERS.includes(value as IdentityProvider)
  ) {
    throw new Error(`${label} is unsupported.`);
  }
  if (subject && value === "email") {
    throw new Error(
      `${label} cannot use email with a provider-subject matcher.`,
    );
  }
  return value as IdentityProvider;
}

const normalizeIdentityMatcher = (
  entry: JsonObject,
  label: string,
): Readonly<IdentityMatcher> => {
  const legacyKeys = [
    "provider",
    "emailEnvironmentVariable",
    "approvedEmailSha256",
  ];
  const hasLegacyMatcher = legacyKeys.some((key) => entry[key] !== undefined);
  if (entry.matcher !== undefined && hasLegacyMatcher) {
    throw new Error(
      `${label} cannot combine matcher with legacy provider and email fields.`,
    );
  }
  if (entry.matcher === undefined) {
    const legacyProvider = provider(entry.provider, `${label}.provider`);
    if (
      typeof entry.emailEnvironmentVariable !== "string" ||
      !ENVIRONMENT_KEY.test(entry.emailEnvironmentVariable)
    ) {
      throw new Error(`${label}.emailEnvironmentVariable is invalid.`);
    }
    if (
      typeof entry.approvedEmailSha256 !== "string" ||
      !SHA256.test(entry.approvedEmailSha256)
    ) {
      throw new Error(`${label}.approvedEmailSha256 must be a SHA-256.`);
    }
    return Object.freeze({
      type: "verified-email",
      providers: Object.freeze([legacyProvider]),
      emailEnvironmentVariable: entry.emailEnvironmentVariable,
      approvedEmailSha256: entry.approvedEmailSha256,
    });
  }
  if (!isObject(entry.matcher)) {
    throw new Error(`${label}.matcher must be an object.`);
  }
  const matcherLabel = `${label}.matcher`;
  if (entry.matcher.type === "verified-email") {
    keys(
      entry.matcher,
      ["type", "providers", "emailEnvironmentVariable", "approvedEmailSha256"],
      matcherLabel,
    );
    if (
      !Array.isArray(entry.matcher.providers) ||
      entry.matcher.providers.length === 0
    ) {
      throw new Error(`${matcherLabel}.providers must not be empty.`);
    }
    const providers = entry.matcher.providers.map((value, index) =>
      provider(value, `${matcherLabel}.providers[${index}]`),
    );
    if (new Set(providers).size !== providers.length) {
      throw new Error(`${matcherLabel}.providers must not contain duplicates.`);
    }
    if (
      typeof entry.matcher.emailEnvironmentVariable !== "string" ||
      !ENVIRONMENT_KEY.test(entry.matcher.emailEnvironmentVariable)
    ) {
      throw new Error(`${matcherLabel}.emailEnvironmentVariable is invalid.`);
    }
    if (
      typeof entry.matcher.approvedEmailSha256 !== "string" ||
      !SHA256.test(entry.matcher.approvedEmailSha256)
    ) {
      throw new Error(`${matcherLabel}.approvedEmailSha256 must be a SHA-256.`);
    }
    return Object.freeze({
      type: "verified-email",
      providers: Object.freeze(providers),
      emailEnvironmentVariable: entry.matcher.emailEnvironmentVariable,
      approvedEmailSha256: entry.matcher.approvedEmailSha256,
    });
  }
  if (entry.matcher.type === "provider-subject") {
    keys(
      entry.matcher,
      [
        "type",
        "provider",
        "subjectEnvironmentVariable",
        "approvedSubjectSha256",
      ],
      matcherLabel,
    );
    const subjectProvider = provider(
      entry.matcher.provider,
      `${matcherLabel}.provider`,
      { subject: true },
    );
    if (
      typeof entry.matcher.subjectEnvironmentVariable !== "string" ||
      !ENVIRONMENT_KEY.test(entry.matcher.subjectEnvironmentVariable)
    ) {
      throw new Error(`${matcherLabel}.subjectEnvironmentVariable is invalid.`);
    }
    if (
      typeof entry.matcher.approvedSubjectSha256 !== "string" ||
      !SHA256.test(entry.matcher.approvedSubjectSha256)
    ) {
      throw new Error(
        `${matcherLabel}.approvedSubjectSha256 must be a SHA-256.`,
      );
    }
    return Object.freeze({
      type: "provider-subject",
      provider: subjectProvider,
      subjectEnvironmentVariable: entry.matcher.subjectEnvironmentVariable,
      approvedSubjectSha256: entry.matcher.approvedSubjectSha256,
    });
  }
  throw new Error(`${matcherLabel}.type is unsupported.`);
};

export const validateIdentityPolicy = (policy: unknown): IdentityPolicy => {
  if (
    !isObject(policy) ||
    policy.identityVersion !== 1 ||
    !Array.isArray(policy.identities)
  ) {
    throw new Error(
      "Identity policy must use identityVersion 1 and list identities.",
    );
  }
  for (const key of Object.keys(policy)) {
    if (!["identityVersion", "identities"].includes(key)) {
      throw new Error(`identityPolicy.${key} is unknown.`);
    }
  }
  const names = new Set<string>();
  const identities = policy.identities.map((entry, index) => {
    const label = `identityPolicy.identities[${index}]`;
    if (!isObject(entry)) throw new Error(`${label} must be an object.`);
    for (const key of Object.keys(entry)) {
      if (
        ![
          "name",
          "matcher",
          "provider",
          "emailEnvironmentVariable",
          "approvedEmailSha256",
          "placeholderUserId",
          "references",
          "jsonReferences",
          "signupDefaults",
          "pathReferences",
          "assets",
          "claims",
          "tokenHook",
        ].includes(key)
      ) {
        throw new Error(`${label}.${key} is unknown.`);
      }
    }
    if (typeof entry.name !== "string" || !LABEL.test(entry.name))
      throw new Error(`${label}.name is invalid.`);
    const name = entry.name;
    if (names.has(name)) throw new Error(`Identity policy duplicates ${name}.`);
    names.add(name);
    const matcher = normalizeIdentityMatcher(entry, label);
    if (
      typeof entry.placeholderUserId !== "string" ||
      !UUID.test(entry.placeholderUserId)
    )
      throw new Error(`${label}.placeholderUserId is invalid.`);
    const references = optionalArray(
      entry.references,
      `${label}.references`,
    ).map((reference, referenceIndex) => {
      const referenceLabel = `${label}.references[${referenceIndex}]`;
      if (!isObject(reference))
        throw new Error(`${referenceLabel} must be an object.`);
      keys(
        reference,
        ["schema", "table", "column", "required", "strategy"],
        referenceLabel,
      );
      if (
        reference.required !== undefined &&
        typeof reference.required !== "boolean"
      ) {
        throw new Error(`${referenceLabel}.required must be boolean.`);
      }
      if (
        reference.strategy !== undefined &&
        !["transfer", "preserve-audit"].includes(reference.strategy as string)
      ) {
        throw new Error(
          `${referenceLabel}.strategy must be transfer or preserve-audit.`,
        );
      }
      return Object.freeze({
        schema: id(reference.schema, `${referenceLabel}.schema`),
        table: id(reference.table, `${referenceLabel}.table`),
        column: id(reference.column, `${referenceLabel}.column`),
        required: reference.required === true,
        strategy: (reference.strategy ?? "transfer") as IdentityStrategy,
      });
    });
    const jsonReferences = optionalArray(
      entry.jsonReferences,
      `${label}.jsonReferences`,
    ).map((reference, referenceIndex) => {
      const referenceLabel = `${label}.jsonReferences[${referenceIndex}]`;
      if (!isObject(reference))
        throw new Error(`${referenceLabel} must be an object.`);
      keys(reference, ["schema", "table", "column", "path"], referenceLabel);
      if (!Array.isArray(reference.path) || reference.path.length === 0) {
        throw new Error(`${referenceLabel}.path is invalid.`);
      }
      return {
        schema: id(reference.schema, `${referenceLabel}.schema`),
        table: id(reference.table, `${referenceLabel}.table`),
        column: id(reference.column, `${referenceLabel}.column`),
        path: reference.path.map((part, pathIndex) =>
          id(part, `${referenceLabel}.path[${pathIndex}]`),
        ),
      };
    });
    const signupDefaults = optionalArray(
      entry.signupDefaults,
      `${label}.signupDefaults`,
    ).map((declaration, declarationIndex) => {
      const declarationLabel = `${label}.signupDefaults[${declarationIndex}]`;
      if (!isObject(declaration))
        throw new Error(`${declarationLabel} must be an object.`);
      keys(
        declaration,
        ["table", "identityColumn", "ignoredColumns", "values"],
        declarationLabel,
      );
      const table = relation(declaration.table, `${declarationLabel}.table`);
      const identityColumn = id(
        declaration.identityColumn,
        `${declarationLabel}.identityColumn`,
      );
      if (!isObject(declaration.values)) {
        throw new Error(`${declarationLabel}.values must be an object.`);
      }
      const values = Object.fromEntries(
        Object.entries(declaration.values).map(([column, value]) => [
          id(column, `${declarationLabel}.values key`),
          defaultMatcher(value, `${declarationLabel}.values.${column}`),
        ]),
      );
      if (Object.keys(values).length === 0) {
        throw new Error(`${declarationLabel}.values must not be empty.`);
      }
      const ignoredColumns = optionalArray(
        declaration.ignoredColumns,
        `${declarationLabel}.ignoredColumns`,
      ).map((column, columnIndex) =>
        id(column, `${declarationLabel}.ignoredColumns[${columnIndex}]`),
      );
      if (
        new Set([identityColumn, ...ignoredColumns, ...Object.keys(values)])
          .size !==
        1 + ignoredColumns.length + Object.keys(values).length
      ) {
        throw new Error(`${declarationLabel} repeats a column.`);
      }
      if (
        !references.some(
          (reference) =>
            reference.schema === table.schema &&
            reference.table === table.table &&
            reference.column === identityColumn,
        )
      ) {
        throw new Error(
          `${declarationLabel} must match a declared relational reference.`,
        );
      }
      return Object.freeze({
        table,
        identityColumn,
        ignoredColumns: Object.freeze(ignoredColumns),
        values: Object.freeze(values),
      });
    });
    const pathReferences = optionalArray(
      entry.pathReferences,
      `${label}.pathReferences`,
    ).map((reference, referenceIndex) => {
      const referenceLabel = `${label}.pathReferences[${referenceIndex}]`;
      if (!isObject(reference))
        throw new Error(`${referenceLabel} must be an object.`);
      keys(
        reference,
        ["schema", "table", "column", "valueType"],
        referenceLabel,
      );
      if (
        typeof reference.valueType !== "string" ||
        !["text", "jsonb"].includes(reference.valueType)
      ) {
        throw new Error(`${referenceLabel}.valueType is unsupported.`);
      }
      return Object.freeze({
        schema: id(reference.schema, `${referenceLabel}.schema`),
        table: id(reference.table, `${referenceLabel}.table`),
        column: id(reference.column, `${referenceLabel}.column`),
        valueType: reference.valueType as PathValueType,
      });
    });
    const assets = optionalArray(entry.assets, `${label}.assets`).map(
      (asset, assetIndex) => {
        const assetLabel = `${label}.assets[${assetIndex}]`;
        if (!isObject(asset))
          throw new Error(`${assetLabel} must be an object.`);
        keys(asset, ["bucket", "prefix", "rewritePath"], assetLabel);
        if (
          typeof asset.bucket !== "string" ||
          !/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(asset.bucket)
        ) {
          throw new Error(`${assetLabel}.bucket is invalid.`);
        }
        if (
          typeof asset.prefix !== "string" ||
          !asset.prefix ||
          asset.prefix.startsWith("/") ||
          asset.prefix
            .replace(/\/$/u, "")
            .split("/")
            .some(
              (part) =>
                !part || part === "." || part === ".." || /[%_]/u.test(part),
            )
        ) {
          throw new Error(`${assetLabel}.prefix is invalid.`);
        }
        if (
          asset.rewritePath !== undefined &&
          typeof asset.rewritePath !== "boolean"
        ) {
          throw new Error(`${assetLabel}.rewritePath must be boolean.`);
        }
        return Object.freeze({
          bucket: asset.bucket,
          prefix: asset.prefix,
          rewritePath: asset.rewritePath === true,
        });
      },
    );
    for (const asset of assets) {
      if (
        asset.rewritePath &&
        asset.prefix !== `${entry.placeholderUserId.toLowerCase()}/`
      ) {
        throw new Error(
          `${label}.assets rewritePath requires the placeholder UUID prefix.`,
        );
      }
    }
    const rawClaims = entry.claims ?? {};
    if (!isObject(rawClaims))
      throw new Error(`${label}.claims must be an object.`);
    const claims = jsonValue(rawClaims, `${label}.claims`);
    if (!isObject(claims))
      throw new Error(`${label}.claims must be an object.`);
    let tokenHook: Readonly<IdentityTokenHook> | null = null;
    if (entry.tokenHook != null) {
      const hookLabel = `${label}.tokenHook`;
      if (!isObject(entry.tokenHook))
        throw new Error(`${hookLabel} must be an object.`);
      keys(entry.tokenHook, ["function", "expectedClaims"], hookLabel);
      if (!isObject(entry.tokenHook.function))
        throw new Error(`${hookLabel}.function must be an object.`);
      keys(
        entry.tokenHook.function,
        ["schema", "name"],
        `${hookLabel}.function`,
      );
      if (!isObject(entry.tokenHook.expectedClaims))
        throw new Error(`${hookLabel}.expectedClaims must be an object.`);
      const expectedClaims = jsonValue(
        entry.tokenHook.expectedClaims,
        `${hookLabel}.expectedClaims`,
      );
      if (!isObject(expectedClaims))
        throw new Error(`${hookLabel}.expectedClaims must be an object.`);
      tokenHook = Object.freeze({
        function: Object.freeze({
          schema: id(
            entry.tokenHook.function.schema,
            `${hookLabel}.function.schema`,
          ),
          name: id(entry.tokenHook.function.name, `${hookLabel}.function.name`),
        }),
        expectedClaims: Object.freeze(expectedClaims),
      });
    }
    return Object.freeze({
      name,
      matcher,
      placeholderUserId: entry.placeholderUserId.toLowerCase(),
      references: Object.freeze(references),
      jsonReferences: Object.freeze(jsonReferences),
      signupDefaults: Object.freeze(signupDefaults),
      pathReferences: Object.freeze(pathReferences),
      assets: Object.freeze(assets),
      claims: Object.freeze(claims),
      tokenHook,
    });
  });
  return Object.freeze({
    identityVersion: 1,
    identities: Object.freeze(identities),
  });
};
