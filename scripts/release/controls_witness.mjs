import { createHash } from "node:crypto";

const refuse = (code) => {
  throw new Error(`Release witness refused: ${code}.`);
};
const record = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("invalid_metadata");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    refuse("invalid_metadata");
  return value;
};
const keys = (value, expected) => {
  const actual = Object.keys(record(value));
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    refuse("unexpected_fields");
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha256 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const repositoryName = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(value);

// Accept only bounded JSON, preserving array order and sorting object keys.
const canonical = (value) => {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 20_000 || depth > 20) refuse("metadata_bound");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.length > 65_536) refuse("metadata_bound");
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > 1000) refuse("metadata_bound");
      return Array.from(item, (entry) => visit(entry, depth + 1));
    }
    const source = record(item);
    const names = Object.keys(source).sort();
    if (names.length > 100) refuse("metadata_bound");
    const result = Object.create(null);
    for (const name of names) result[name] = visit(source[name], depth + 1);
    return result;
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > 262_144) refuse("metadata_bound");
  return json;
};
const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");

const timestamp = (value) => {
  if (typeof value !== "string" || value.length > 35)
    refuse("invalid_timestamp");
  const match =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|[+-]\d\d:\d\d)$/u.exec(
      value,
    );
  if (!match) refuse("invalid_timestamp");
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    refuse("invalid_timestamp");
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const zone = match[8];
  if (
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    zone === "-00:00" ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  )
    refuse("invalid_timestamp");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) refuse("invalid_timestamp");
  return new Date(milliseconds).toISOString();
};

const exactReferences = (raw, repository) => {
  if (
    !repositoryName(repository) ||
    !positive(raw.id) ||
    raw.source_type !== "Repository" ||
    raw.source !== repository ||
    raw.enforcement !== "active" ||
    !["branch", "tag"].includes(raw.target) ||
    !Array.isArray(raw.rules)
  )
    refuse("invalid_ruleset");
  keys(raw.conditions, ["ref_name"]);
  keys(raw.conditions.ref_name, ["include", "exclude"]);
  const reference =
    raw.target === "branch" ? "refs/heads/main" : "refs/tags/v*";
  if (
    !Array.isArray(raw.conditions.ref_name.include) ||
    raw.conditions.ref_name.include.length !== 1 ||
    raw.conditions.ref_name.include[0] !== reference ||
    !Array.isArray(raw.conditions.ref_name.exclude) ||
    raw.conditions.ref_name.exclude.length !== 0
  )
    refuse("invalid_references");
};

/** Hash public control fields only. Timestamps and the hidden assertion bind separately. */
export function rulesetPublicDigest(raw) {
  const source = record(raw);
  const fields = [
    "id",
    "source_type",
    "source",
    "target",
    "enforcement",
    "conditions",
    "rules",
  ];
  if (fields.some((field) => !Object.hasOwn(source, field)))
    refuse("missing_public_control");
  exactReferences(source, source.source);
  return digest(
    Object.fromEntries(fields.map((field) => [field, source[field]])),
  );
}

function validatedWitness(witness) {
  keys(witness, [
    "schemaVersion",
    "repository",
    "repositoryId",
    "ownerId",
    "environmentId",
    "observedAt",
    "rulesets",
  ]);
  if (
    witness.schemaVersion !== 1 ||
    !repositoryName(witness.repository) ||
    !positive(witness.repositoryId) ||
    !positive(witness.ownerId) ||
    !positive(witness.environmentId) ||
    timestamp(witness.observedAt) !== witness.observedAt ||
    !Array.isArray(witness.rulesets) ||
    witness.rulesets.length !== 2
  )
    refuse("invalid_witness");
  const identities = new Set();
  const targets = new Set();
  for (const rule of witness.rulesets) {
    keys(rule, [
      "id",
      "target",
      "createdAt",
      "updatedAt",
      "publicSha256",
      "bypassActors",
    ]);
    if (
      !positive(rule.id) ||
      !["branch", "tag"].includes(rule.target) ||
      identities.has(rule.id) ||
      targets.has(rule.target) ||
      !sha256(rule.publicSha256) ||
      timestamp(rule.createdAt) !== rule.createdAt ||
      timestamp(rule.updatedAt) !== rule.updatedAt ||
      Date.parse(rule.createdAt) > Date.parse(rule.updatedAt) ||
      Date.parse(witness.observedAt) < Date.parse(rule.updatedAt) + 2000 ||
      !Array.isArray(rule.bypassActors) ||
      rule.bypassActors.length !== 0
    )
      refuse("invalid_witness_ruleset");
    identities.add(rule.id);
    targets.add(rule.target);
  }
  canonical(witness);
  return witness;
}

/** This creates an unsigned owner assertion, never proof of an authenticated approval. */
export function createControlsWitness({
  repository,
  repositoryId,
  ownerId,
  environmentId,
  observedAt,
  rulesets,
}) {
  if (!Array.isArray(rulesets) || rulesets.length !== 2)
    refuse("invalid_rulesets");
  const witness = {
    schemaVersion: 1,
    repository,
    repositoryId,
    ownerId,
    environmentId,
    observedAt: timestamp(observedAt),
    rulesets: rulesets
      .map((raw) => {
        record(raw);
        exactReferences(raw, repository);
        if (
          !Object.hasOwn(raw, "bypass_actors") ||
          !Array.isArray(raw.bypass_actors) ||
          raw.bypass_actors.length !== 0
        )
          refuse("bypass_not_observed_empty");
        return {
          id: raw.id,
          target: raw.target,
          createdAt: timestamp(raw.created_at),
          updatedAt: timestamp(raw.updated_at),
          publicSha256: rulesetPublicDigest(raw),
          bypassActors: [],
        };
      })
      .sort((left, right) => left.target.localeCompare(right.target, "en-US")),
  };
  return validatedWitness(witness);
}

export function controlsWitnessDigest(witness) {
  return digest(validatedWitness(witness));
}

/** Validate one live ruleset against an unsigned witness and independently supplied identity. */
export function witnessRulesetProof(
  witness,
  raw,
  {
    repository,
    repositoryId,
    ownerId,
    environmentId,
    now = Date.now(),
    maximumAgeMs,
  } = {},
) {
  try {
    validatedWitness(witness);
    if (
      witness.repository !== repository ||
      witness.repositoryId !== repositoryId ||
      witness.ownerId !== ownerId ||
      witness.environmentId !== environmentId
    )
      return false;
    const currentTime = now instanceof Date ? now.getTime() : now;
    const age = currentTime - Date.parse(witness.observedAt);
    if (
      !Number.isSafeInteger(currentTime) ||
      age < 0 ||
      (maximumAgeMs !== undefined &&
        (!Number.isSafeInteger(maximumAgeMs) ||
          maximumAgeMs < 0 ||
          age > maximumAgeMs))
    )
      return false;
    record(raw);
    exactReferences(raw, repository);
    if (
      Object.hasOwn(raw, "bypass_actors") &&
      (!Array.isArray(raw.bypass_actors) || raw.bypass_actors.length !== 0)
    )
      return false;
    const rule = witness.rulesets.find(
      (entry) => entry.id === raw.id && entry.target === raw.target,
    );
    return Boolean(
      rule &&
      rule.createdAt === timestamp(raw.created_at) &&
      rule.updatedAt === timestamp(raw.updated_at) &&
      rule.publicSha256 === rulesetPublicDigest(raw),
    );
  } catch {
    return false;
  }
}

/**
 * Corroborate a human review in this workflow run, independently of comment text.
 * GitHub's enforced environment admission protects the current job. This history
 * does not establish a fresh attempt, artifact approval or current hidden settings.
 */
export function assertEnvironmentApproval(reviews, { ownerId, environmentId }) {
  if (
    !positive(ownerId) ||
    !positive(environmentId) ||
    !Array.isArray(reviews) ||
    reviews.length === 0 ||
    reviews.length > 100
  )
    refuse("invalid_approval_metadata");
  canonical(reviews);
  const matches = reviews.filter((raw) => {
    const review = record(raw);
    const user = record(review.user);
    if (
      !["approved", "rejected"].includes(review.state) ||
      (Object.hasOwn(review, "comment") &&
        review.comment !== null &&
        (typeof review.comment !== "string" || review.comment.length > 4096)) ||
      !positive(user.id) ||
      !["User", "Bot"].includes(user.type) ||
      !Array.isArray(review.environments) ||
      review.environments.length > 6
    )
      refuse("invalid_approval_metadata");
    for (const environment of review.environments) {
      record(environment);
      if (
        !positive(environment.id) ||
        typeof environment.name !== "string" ||
        environment.name.length > 100
      )
        refuse("invalid_approval_metadata");
    }
    return (
      review.state === "approved" &&
      user.type === "User" &&
      user.id === ownerId &&
      review.environments.length === 1 &&
      review.environments[0].id === environmentId &&
      review.environments[0].name === "npm"
    );
  });
  if (matches.length === 0) refuse("owner_approval_not_proven");
  return true;
}
