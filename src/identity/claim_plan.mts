/** Deterministic identity claim review, digest, and local matcher binding. */

import { createHash } from "node:crypto";
import type {
  IdentityClaimPlan,
  IdentityClaimReview,
  IdentityPolicy,
} from "./claim_contract.mjs";
import { validateIdentityPolicy } from "./claim_policy.mjs";

const canonical = (value: unknown): string =>
  `${JSON.stringify(value, null, "\t")}\n`;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const identityPlanValues = new WeakMap<IdentityClaimPlan, string>();

export const createIdentityClaimPlan = ({
  policy,
  name,
  environment = process.env,
}: {
  policy: unknown;
  name: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): IdentityClaimPlan => {
  const normalized: IdentityPolicy = validateIdentityPolicy(policy);
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
  const review: IdentityClaimReview = {
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
  const plan: IdentityClaimPlan = {
    identity,
    review: Object.freeze(review),
    digest: hash(canonical(review)),
  };
  identityPlanValues.set(plan, matchValue);
  return Object.freeze(plan);
};

export const getIdentityPlanMatchValue = (
  plan: IdentityClaimPlan,
): string | undefined => identityPlanValues.get(plan);
