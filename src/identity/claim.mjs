/** Associate a reviewed copied owner graph with one verified local Auth identity. */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { IDENTITY_CLAIM_RECEIPT_SQL } from "../runtime/policy.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const LABEL = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/u;
const SUPPORTED_IDENTITY_PROVIDERS = Object.freeze([
  "email",
  "github",
  "google",
]);
const identityPlanValues = new WeakMap();

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value, label) => {
  if (!IDENTIFIER.test(value ?? ""))
    throw new Error(`${label} is not a safe identifier.`);
  return value;
};
const qid = (value) => `"${id(value, "SQL identifier")}"`;
const canonical = (value) => `${JSON.stringify(value, null, "\t")}\n`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const keys = (value, allowed, label) => {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown.`);
  }
};
const relation = (value, label) => {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  keys(value, ["schema", "table"], label);
  return Object.freeze({
    schema: id(value.schema, `${label}.schema`),
    table: id(value.table, `${label}.table`),
  });
};
const jsonValue = (value, label) => {
  let serialized;
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
const defaultMatcher = (value, label) => {
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

const provider = (value, label, { subject = false } = {}) => {
  if (!SUPPORTED_IDENTITY_PROVIDERS.includes(value)) {
    throw new Error(`${label} is unsupported.`);
  }
  if (subject && value === "email") {
    throw new Error(
      `${label} cannot use email with a provider-subject matcher.`,
    );
  }
  return value;
};

const normalizeIdentityMatcher = (entry, label) => {
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
    if (!ENVIRONMENT_KEY.test(entry.emailEnvironmentVariable ?? "")) {
      throw new Error(`${label}.emailEnvironmentVariable is invalid.`);
    }
    if (!SHA256.test(entry.approvedEmailSha256 ?? "")) {
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
    if (!ENVIRONMENT_KEY.test(entry.matcher.emailEnvironmentVariable ?? "")) {
      throw new Error(`${matcherLabel}.emailEnvironmentVariable is invalid.`);
    }
    if (!SHA256.test(entry.matcher.approvedEmailSha256 ?? "")) {
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
    if (!ENVIRONMENT_KEY.test(entry.matcher.subjectEnvironmentVariable ?? "")) {
      throw new Error(`${matcherLabel}.subjectEnvironmentVariable is invalid.`);
    }
    if (!SHA256.test(entry.matcher.approvedSubjectSha256 ?? "")) {
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

export const validateIdentityPolicy = (policy) => {
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
  const names = new Set();
  const identities = policy.identities.map((entry, index) => {
    const label = `identityPolicy.identities[${index}]`;
    for (const key of Object.keys(entry ?? {})) {
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
    if (!LABEL.test(entry.name ?? ""))
      throw new Error(`${label}.name is invalid.`);
    const name = entry.name;
    if (names.has(name)) throw new Error(`Identity policy duplicates ${name}.`);
    names.add(name);
    const matcher = normalizeIdentityMatcher(entry, label);
    if (!UUID.test(entry.placeholderUserId ?? ""))
      throw new Error(`${label}.placeholderUserId is invalid.`);
    const references = (entry.references ?? []).map(
      (reference, referenceIndex) => {
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
          !["transfer", "preserve-audit"].includes(reference.strategy)
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
          strategy: reference.strategy ?? "transfer",
        });
      },
    );
    const jsonReferences = (entry.jsonReferences ?? []).map(
      (reference, referenceIndex) => {
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
      },
    );
    const signupDefaults = (entry.signupDefaults ?? []).map(
      (declaration, declarationIndex) => {
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
        const ignoredColumns = (declaration.ignoredColumns ?? []).map(
          (column, columnIndex) =>
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
      },
    );
    const pathReferences = (entry.pathReferences ?? []).map(
      (reference, referenceIndex) => {
        const referenceLabel = `${label}.pathReferences[${referenceIndex}]`;
        if (!isObject(reference))
          throw new Error(`${referenceLabel} must be an object.`);
        keys(
          reference,
          ["schema", "table", "column", "valueType"],
          referenceLabel,
        );
        if (!["text", "jsonb"].includes(reference.valueType)) {
          throw new Error(`${referenceLabel}.valueType is unsupported.`);
        }
        return Object.freeze({
          schema: id(reference.schema, `${referenceLabel}.schema`),
          table: id(reference.table, `${referenceLabel}.table`),
          column: id(reference.column, `${referenceLabel}.column`),
          valueType: reference.valueType,
        });
      },
    );
    const assets = (entry.assets ?? []).map((asset, assetIndex) => {
      const assetLabel = `${label}.assets[${assetIndex}]`;
      if (!isObject(asset)) throw new Error(`${assetLabel} must be an object.`);
      keys(asset, ["bucket", "prefix", "rewritePath"], assetLabel);
      if (!/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(asset.bucket ?? "")) {
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
    });
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
    if (!isObject(entry.claims ?? {}))
      throw new Error(`${label}.claims must be an object.`);
    JSON.stringify(entry.claims);
    let tokenHook = null;
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
      tokenHook = Object.freeze({
        function: Object.freeze({
          schema: id(
            entry.tokenHook.function.schema,
            `${hookLabel}.function.schema`,
          ),
          name: id(entry.tokenHook.function.name, `${hookLabel}.function.name`),
        }),
        expectedClaims: Object.freeze(
          jsonValue(
            entry.tokenHook.expectedClaims,
            `${hookLabel}.expectedClaims`,
          ),
        ),
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
      claims: Object.freeze(entry.claims ?? {}),
      tokenHook,
    });
  });
  return Object.freeze({
    identityVersion: 1,
    identities: Object.freeze(identities),
  });
};

export const createIdentityClaimPlan = ({
  policy,
  name,
  environment = process.env,
}) => {
  const normalized = validateIdentityPolicy(policy);
  const identity = normalized.identities.find((entry) => entry.name === name);
  if (!identity) throw new Error(`Identity policy does not declare ${name}.`);
  const matcher = identity.matcher;
  const environmentVariable =
    matcher.type === "verified-email"
      ? matcher.emailEnvironmentVariable
      : matcher.subjectEnvironmentVariable;
  const rawValue = environment[environmentVariable];
  const matchValue =
    matcher.type === "verified-email"
      ? rawValue?.trim().toLowerCase()
      : rawValue?.trim();
  const approvedSha256 =
    matcher.type === "verified-email"
      ? matcher.approvedEmailSha256
      : matcher.approvedSubjectSha256;
  if (!matchValue || hash(matchValue) !== approvedSha256) {
    throw new Error(
      matcher.type === "verified-email"
        ? "Local identity email does not match the reviewed receipt."
        : "Local identity provider subject does not match the reviewed receipt.",
    );
  }
  const review = {
    planVersion: 3,
    operation: "claim-local-identity",
    name: identity.name,
    matcher,
    placeholderUserId: identity.placeholderUserId,
    references: identity.references,
    jsonReferences: identity.jsonReferences,
    signupDefaults: identity.signupDefaults.map((declaration) => ({
      table: declaration.table,
      identityColumn: declaration.identityColumn,
      ignoredColumns: declaration.ignoredColumns,
      valuesSha256: hash(canonical(declaration.values)),
    })),
    pathReferences: identity.pathReferences,
    assets: identity.assets,
    claimKeys: Object.keys(identity.claims).sort(),
    claimsSha256: hash(canonical(identity.claims)),
    tokenHook: identity.tokenHook
      ? {
          function: identity.tokenHook.function,
          expectedClaimsSha256: hash(
            canonical(identity.tokenHook.expectedClaims),
          ),
        }
      : null,
  };
  const plan = {
    identity,
    review: Object.freeze(review),
    digest: hash(canonical(review)),
  };
  identityPlanValues.set(plan, matchValue);
  return Object.freeze(plan);
};

const inspectDeclaredDefault = ({ row, declaration }) => {
  if (!isObject(row)) {
    return { matches: false, actualColumns: [], mismatchedColumns: [] };
  }
  const comparable = { ...row };
  delete comparable[declaration.identityColumn];
  for (const column of declaration.ignoredColumns) delete comparable[column];
  const actualColumns = Object.keys(comparable).sort();
  const declaredColumns = Object.keys(declaration.values).sort();
  const mismatchedColumns = Object.entries(declaration.values)
    .filter(([column, matcher]) =>
      matcher.kind === "pattern"
        ? typeof comparable[column] !== "string" ||
          !new RegExp(matcher.pattern, "u").test(comparable[column])
        : !isDeepStrictEqual(comparable[column], matcher.value),
    )
    .map(([column]) => column)
    .sort();
  return {
    matches:
      isDeepStrictEqual(actualColumns, declaredColumns) &&
      mismatchedColumns.length === 0,
    actualColumns,
    mismatchedColumns,
  };
};

const containsJson = (actual, expected) => {
  if (!isObject(expected)) return isDeepStrictEqual(actual, expected);
  if (!isObject(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    containsJson(actual[key], value),
  );
};

const valueKind = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const discoverPublicAuthReferences = async (client) => {
  const result = await client.query(`select distinct
       source_namespace.nspname as schema,
       source_table.relname as table,
       source_column.attname as column
     from pg_constraint constraint_record
     join pg_class source_table on source_table.oid = constraint_record.conrelid
     join pg_namespace source_namespace on source_namespace.oid = source_table.relnamespace
     join unnest(constraint_record.conkey) with ordinality source_key(attnum, position) on true
     join unnest(constraint_record.confkey) with ordinality target_key(attnum, position)
       on target_key.position = source_key.position
     join pg_attribute source_column
       on source_column.attrelid = constraint_record.conrelid
      and source_column.attnum = source_key.attnum
     join pg_attribute target_column
       on target_column.attrelid = constraint_record.confrelid
      and target_column.attnum = target_key.attnum
     where constraint_record.contype = 'f'
       and constraint_record.confrelid = 'auth.users'::regclass
       and target_column.attname = 'id'
       and source_namespace.nspname = 'public'`);
  return result.rows.map((reference, index) => ({
    schema: id(reference.schema, `discoveredReference[${index}].schema`),
    table: id(reference.table, `discoveredReference[${index}].table`),
    column: id(reference.column, `discoveredReference[${index}].column`),
  }));
};

const countIdentityRows = async ({ client, reference, userId }) => {
  const result = await client.query(
    `select count(*)::integer as count
     from ${qid(reference.schema)}.${qid(reference.table)}
     where ${qid(reference.column)} = $1::uuid`,
    [userId],
  );
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("A local identity reference returned an invalid count.");
  }
  return count;
};

const findVerifiedLocalIdentity = async ({ client, plan, matchValue }) => {
  const matcher = plan.identity.matcher;
  if (matcher.type === "verified-email") {
    const match = await client.query(
      `select u.id::text, i.provider
       from auth.users u
       join auth.identities i on i.user_id = u.id
       where lower(coalesce(i.identity_data->>'email', u.email)) = $1
         and i.provider = any($2::text[])
         and (
           coalesce((i.identity_data->>'email_verified')::boolean, false)
           or u.email_confirmed_at is not null
         )
       for update of u`,
      [matchValue, matcher.providers],
    );
    if (match.rows.length !== 1) {
      throw new Error(
        match.rows.length === 0
          ? "No verified local identity matches the reviewed email and provider allowlist."
          : "More than one verified local identity matches the reviewed email and provider allowlist.",
      );
    }
    const matchedProvider =
      match.rows[0].provider ??
      (matcher.providers.length === 1 ? matcher.providers[0] : null);
    if (!matcher.providers.includes(matchedProvider)) {
      throw new Error("Matched local identity provider is invalid.");
    }
    return { id: match.rows[0].id, provider: matchedProvider };
  }
  const candidates = await client.query(
    `select u.id::text,
            i.provider,
            i.provider_id::text,
            i.identity_data->>'sub' as subject
     from auth.users u
     join auth.identities i on i.user_id = u.id
     where i.provider = $1
       and (
         coalesce((i.identity_data->>'email_verified')::boolean, false)
         or u.email_confirmed_at is not null
       )
     for update of u`,
    [matcher.provider],
  );
  const matches = [];
  for (const candidate of candidates.rows) {
    const subjects = [candidate.provider_id, candidate.subject]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    const uniqueSubjects = [...new Set(subjects)];
    if (
      uniqueSubjects.some(
        (subject) => hash(subject) === matcher.approvedSubjectSha256,
      )
    ) {
      if (uniqueSubjects.length !== 1) {
        throw new Error(
          "The matched local provider identity has conflicting stable subjects.",
        );
      }
      matches.push({ id: candidate.id, provider: candidate.provider });
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "No verified local identity matches the reviewed provider subject."
        : "More than one verified local identity matches the reviewed provider subject.",
    );
  }
  if (matches[0].provider !== matcher.provider) {
    throw new Error("Matched local identity provider is invalid.");
  }
  return matches[0];
};

export const applyIdentityClaim = async ({
  plan,
  confirmation,
  connectionString,
  clientFactory,
  storageTransfer,
}) => {
  if (confirmation !== plan.digest) {
    throw new Error(
      `Identity claim confirmation does not match. Expected ${plan.digest}.`,
    );
  }
  const matchValue = identityPlanValues.get(plan);
  if (!matchValue) {
    throw new Error(
      "Identity claim plans must be created from the reviewed local matcher environment.",
    );
  }
  const target = new URL(connectionString);
  if (!["127.0.0.1", "::1", "localhost"].includes(target.hostname)) {
    throw new Error(
      "Identity claims may target only the local Rehearsal database.",
    );
  }
  const client = clientFactory
    ? await clientFactory(connectionString)
    : new Client({
        connectionString,
        application_name: "rehearsal-identity-claim",
      });
  await client.connect?.();
  let removedSignupDefaults = 0;
  let tokenHookVerified = false;
  let placeholderRetainedForAudit = false;
  const stagedStorageCopies = [];
  let committed = false;
  let storageObjectsTransferred = 0;
  try {
    await client.query("begin");
    const localIdentity = await findVerifiedLocalIdentity({
      client,
      plan,
      matchValue,
    });
    const localUserId = localIdentity.id;
    if (!UUID.test(localUserId))
      throw new Error("Matched local identity is invalid.");
    const placeholderUser = await client.query(
      "select 1 from auth.users where id = $1::uuid limit 1",
      [plan.identity.placeholderUserId],
    );
    const placeholderReferenceCounts =
      localUserId === plan.identity.placeholderUserId
        ? []
        : await Promise.all(
            plan.identity.references.map((reference) =>
              countIdentityRows({
                client,
                reference,
                userId: plan.identity.placeholderUserId,
              }),
            ),
          );
    const transferReferences = plan.identity.references.filter(
      (reference) => reference.strategy === "transfer",
    );
    const preservedReferences = plan.identity.references.filter(
      (reference) => reference.strategy === "preserve-audit",
    );
    const transferPlaceholderCounts = transferReferences.map((reference) => {
      const index = plan.identity.references.indexOf(reference);
      return placeholderReferenceCounts[index] ?? 0;
    });
    const transferLocalCounts =
      localUserId === plan.identity.placeholderUserId ||
      preservedReferences.length === 0
        ? []
        : await Promise.all(
            transferReferences.map((reference) =>
              countIdentityRows({ client, reference, userId: localUserId }),
            ),
          );
    const alreadyClaimed =
      localUserId !== plan.identity.placeholderUserId &&
      transferPlaceholderCounts.every((count) => count === 0) &&
      (preservedReferences.length > 0
        ? transferLocalCounts.some((count) => count > 0)
        : placeholderUser.rows.length === 0);
    const publicAuthReferences =
      localUserId === plan.identity.placeholderUserId
        ? []
        : await discoverPublicAuthReferences(client);
    if (localUserId !== plan.identity.placeholderUserId) {
      const placeholderIdentity = await client.query(
        "select 1 from auth.identities where user_id = $1::uuid limit 1",
        [plan.identity.placeholderUserId],
      );
      if (placeholderIdentity.rows.length > 0) {
        throw new Error(
          "The copied placeholder already belongs to a conflicting local identity.",
        );
      }
    }
    for (const reference of alreadyClaimed ? [] : publicAuthReferences) {
      const declared = plan.identity.references.find(
        (candidate) =>
          candidate.schema === reference.schema &&
          candidate.table === reference.table &&
          candidate.column === reference.column,
      );
      if (declared?.strategy === "preserve-audit") continue;
      const localRows = await countIdentityRows({
        client,
        reference,
        userId: localUserId,
      });
      if (localRows === 0) continue;
      const declaredDefault = plan.identity.signupDefaults.find(
        (declaration) =>
          declaration.table.schema === reference.schema &&
          declaration.table.table === reference.table &&
          declaration.identityColumn === reference.column,
      );
      if (!declaredDefault) {
        throw new Error(
          "The local account already contains independent application data; nothing was changed.",
        );
      }
    }
    if (localUserId !== plan.identity.placeholderUserId && !alreadyClaimed) {
      for (const declaration of plan.identity.signupDefaults) {
        const target = `${qid(declaration.table.schema)}.${qid(declaration.table.table)}`;
        const rows = await client.query(
          `select candidate.${qid(declaration.identityColumn)}::text as identity,
                  to_jsonb(candidate) as row
           from ${target} candidate
           where candidate.${qid(declaration.identityColumn)} in ($1::uuid, $2::uuid)
           for update`,
          [localUserId, plan.identity.placeholderUserId],
        );
        const localRows = rows.rows.filter(
          (row) => row.identity === localUserId,
        );
        const placeholderRows = rows.rows.filter(
          (row) => row.identity === plan.identity.placeholderUserId,
        );
        if (localRows.length > 1 || placeholderRows.length > 1) {
          throw new Error(
            "The declared signup-default relation is ambiguous; nothing was changed.",
          );
        }
        if (localRows.length === 1 && placeholderRows.length === 1) {
          const defaultInspection = inspectDeclaredDefault({
            row: localRows[0].row,
            declaration,
          });
          if (!defaultInspection.matches) {
            const declaredColumns = Object.keys(declaration.values).sort();
            const mismatchKinds = defaultInspection.mismatchedColumns.map(
              (column) =>
                `${column}(${valueKind(localRows[0].row[column])}/${declaration.values[column].kind === "exact" ? valueKind(declaration.values[column].value) : "pattern"})`,
            );
            throw new Error(
              `The local signup row was edited or does not match its complete declared default; nothing was changed. Declared columns: ${declaredColumns.join(", ")}. Actual columns: ${defaultInspection.actualColumns.join(", ") || "none"}. Mismatched column shapes: ${mismatchKinds.join(", ") || "none"}.`,
            );
          }
          await client.query(
            `delete from ${target}
             where ${qid(declaration.identityColumn)} = $1::uuid`,
            [localUserId],
          );
          removedSignupDefaults += 1;
        }
      }
    }
    for (const reference of plan.identity.references) {
      const expectedUserId =
        reference.strategy === "preserve-audit"
          ? plan.identity.placeholderUserId
          : localUserId;
      if (reference.strategy === "transfer") {
        await client.query(
          `update ${qid(reference.schema)}.${qid(reference.table)}
           set ${qid(reference.column)} = $1::uuid
           where ${qid(reference.column)} = $2::uuid`,
          [localUserId, plan.identity.placeholderUserId],
        );
      }
      if (reference.required) {
        const required = await client.query(
          `select 1
           from ${qid(reference.schema)}.${qid(reference.table)}
           where ${qid(reference.column)} = $1::uuid
           limit 1`,
          [expectedUserId],
        );
        if (required.rows.length !== 1) {
          throw new Error(
            "A required local identity reference is missing; nothing was changed.",
          );
        }
      }
    }
    for (const reference of plan.identity.jsonReferences) {
      await client.query(
        `update ${qid(reference.schema)}.${qid(reference.table)}
         set ${qid(reference.column)} = jsonb_set(
           ${qid(reference.column)}, $3::text[], to_jsonb($1::text), false
         )
         where ${qid(reference.column)} #>> $3::text[] = $2`,
        [localUserId, plan.identity.placeholderUserId, reference.path],
      );
    }
    const sourcePathPrefix = `${plan.identity.placeholderUserId}/`;
    let sourcePathReferenceCount = 0;
    if (plan.identity.assets.some((asset) => asset.rewritePath)) {
      for (const reference of plan.identity.pathReferences) {
        const target = `${qid(reference.schema)}.${qid(reference.table)}`;
        const column = qid(reference.column);
        const result = await client.query(
          reference.valueType === "text"
            ? `select count(*)::integer as count from ${target} where ${column} like $1::text || '%'`
            : `select count(*)::integer as count from ${target} where ${column}::text like '%' || $1::text || '%'`,
          [sourcePathPrefix],
        );
        const count = Number(result.rows[0]?.count);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error(
            "A Storage path reference returned an invalid count.",
          );
        }
        sourcePathReferenceCount += count;
      }
    }
    for (const asset of plan.identity.assets) {
      const sourceObjects = await client.query(
        `select name, owner_id
         from storage.objects
         where bucket_id = $1
           and name like $2::text || '%'
         order by name`,
        [asset.bucket, asset.prefix],
      );
      if (
        sourceObjects.rows.some(
          ({ owner_id: ownerId }) =>
            ownerId !== null &&
            ownerId !== plan.identity.placeholderUserId &&
            !(alreadyClaimed && ownerId === localUserId),
        )
      ) {
        throw new Error(
          "A Storage object in the reviewed placeholder path belongs to another identity; nothing was changed.",
        );
      }
      if (sourceObjects.rows.length === 0) continue;
      if (!asset.rewritePath) {
        await client.query(
          `update storage.objects
           set owner_id = $1::text
           where bucket_id = $2 and name = any($3::text[])`,
          [
            localUserId,
            asset.bucket,
            sourceObjects.rows.map(({ name }) => name),
          ],
        );
        continue;
      }
      if (!storageTransfer) {
        throw new Error(
          "Storage path transfer requires the local Supabase Storage service; nothing was changed.",
        );
      }
      const copies = sourceObjects.rows.map(({ name }) => {
        if (typeof name !== "string" || !name.startsWith(asset.prefix)) {
          throw new Error(
            "A Storage object escaped its reviewed identity scope.",
          );
        }
        return {
          bucket: asset.bucket,
          source: name,
          destination: `${localUserId}/${name.slice(asset.prefix.length)}`,
        };
      });
      const collisions = await client.query(
        `select name
         from storage.objects
         where bucket_id = $1 and name = any($2::text[])
         limit 1`,
        [asset.bucket, copies.map((copy) => copy.destination)],
      );
      if (collisions.rows.length > 0) {
        throw new Error(
          "A destination Storage path already exists; nothing was changed.",
        );
      }
      for (const copy of copies) {
        await storageTransfer.copyAndVerify(copy);
        stagedStorageCopies.push(copy);
      }
      await client.query(
        `update storage.objects
         set owner_id = $1::text
         where bucket_id = $2 and name = any($3::text[])`,
        [localUserId, asset.bucket, copies.map((copy) => copy.destination)],
      );
      const transferred = await client.query(
        `select count(*)::integer as count
         from storage.objects
         where owner_id = $1::text
           and bucket_id = $2
           and name = any($3::text[])`,
        [localUserId, asset.bucket, copies.map((copy) => copy.destination)],
      );
      if (Number(transferred.rows[0]?.count) !== copies.length) {
        throw new Error(
          "Storage ownership did not match the verified physical copies; nothing was changed.",
        );
      }
      storageObjectsTransferred += copies.length;
    }
    if (sourcePathReferenceCount > 0 && storageObjectsTransferred === 0) {
      throw new Error(
        "Copied records reference Storage paths, but no matching objects were available; nothing was changed.",
      );
    }
    const targetPathPrefix = `${localUserId}/`;
    for (const reference of plan.identity.pathReferences) {
      const target = `${qid(reference.schema)}.${qid(reference.table)}`;
      const column = qid(reference.column);
      await client.query(
        reference.valueType === "text"
          ? `update ${target}
             set ${column} = $1::text || substring(${column} from char_length($2::text) + 1)
             where ${column} like $2::text || '%'`
          : `update ${target}
             set ${column} = replace(${column}::text, $2::text, $1::text)::jsonb
             where ${column}::text like '%' || $2::text || '%'`,
        [targetPathPrefix, sourcePathPrefix],
      );
    }
    await client.query(
      `update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       where id = $1::uuid`,
      [localUserId, JSON.stringify(plan.identity.claims)],
    );
    if (plan.identity.tokenHook) {
      const hook = plan.identity.tokenHook;
      const tokenResult = await client.query(
        `select ${qid(hook.function.schema)}.${qid(hook.function.name)}(
           jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb)
         ) as event`,
        [localUserId],
      );
      const claims = tokenResult.rows[0]?.event?.claims;
      if (!containsJson(claims, hook.expectedClaims)) {
        throw new Error(
          "The configured local token hook did not return the declared claims; nothing was changed.",
        );
      }
      tokenHookVerified = true;
    }
    await client.query(IDENTITY_CLAIM_RECEIPT_SQL);
    await client.query(
      `insert into rehearsal_internal.identity_claims (
         identity_name, placeholder_user_id, local_user_id
       ) values ($1, $2::uuid, $3::uuid)
       on conflict (identity_name) do nothing`,
      [plan.identity.name, plan.identity.placeholderUserId, localUserId],
    );
    const claimReceipt = await client.query(
      `select 1
       from rehearsal_internal.identity_claims
       where identity_name = $1
         and placeholder_user_id = $2::uuid
         and local_user_id = $3::uuid`,
      [plan.identity.name, plan.identity.placeholderUserId, localUserId],
    );
    if (claimReceipt.rows.length !== 1) {
      throw new Error(
        "The local identity claim conflicts with an existing association receipt; nothing was changed.",
      );
    }
    if (localUserId !== plan.identity.placeholderUserId) {
      for (const reference of publicAuthReferences) {
        const remaining = await countIdentityRows({
          client,
          reference,
          userId: plan.identity.placeholderUserId,
        });
        if (remaining === 0) continue;
        const declared = preservedReferences.find(
          (candidate) =>
            candidate.schema === reference.schema &&
            candidate.table === reference.table &&
            candidate.column === reference.column,
        );
        if (!declared) {
          throw new Error(
            "The identity policy omitted a copied application reference; nothing was changed.",
          );
        }
        placeholderRetainedForAudit = true;
      }
      if (!placeholderRetainedForAudit) {
        await client.query(
          `delete from auth.users
           where id = $1::uuid
             and not exists (select 1 from auth.identities where user_id = $1::uuid)`,
          [plan.identity.placeholderUserId],
        );
      }
    }
    await client.query("commit");
    committed = true;
    const copiesByBucket = Map.groupBy(
      stagedStorageCopies,
      (copy) => copy.bucket,
    );
    for (const [bucket, copies] of copiesByBucket) {
      await storageTransfer.remove({
        bucket,
        paths: copies.map((copy) => copy.source),
      });
    }
    return {
      name: plan.identity.name,
      provider: localIdentity.provider,
      claimed: true,
      removedSignupDefaults,
      tokenHookVerified,
      placeholderRetainedForAudit,
      storageObjectsTransferred,
      idempotent: alreadyClaimed,
    };
  } catch (error) {
    if (committed) {
      throw new Error(
        "The identity claim committed and the new Storage copies are usable, but old Storage cleanup failed.",
        { cause: error },
      );
    }
    await client.query("rollback").catch(() => undefined);
    if (stagedStorageCopies.length > 0) {
      const cleanupErrors = [];
      for (const [bucket, copies] of Map.groupBy(
        stagedStorageCopies,
        (copy) => copy.bucket,
      )) {
        await storageTransfer
          .remove({
            bucket,
            paths: copies.map((copy) => copy.destination),
          })
          .catch((cleanupError) => cleanupErrors.push(cleanupError));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "The identity claim rolled back, but copied Storage cleanup needs attention.",
        );
      }
    }
    throw error;
  } finally {
    await client.end?.();
  }
};
