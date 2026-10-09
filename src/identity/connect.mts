/** Read-only discovery and redacted review for the guided account connection. */

import pg from "pg";
import type {
  IdentityClaimPlan,
  IdentityClientFactory,
  IdentityDatabaseClient,
  IdentityProvider,
  JsonObject,
} from "./claim_contract.mjs";
import {
  findVerifiedLocalIdentity,
  isIdentityNotFoundError,
} from "./claim_identity_lookup.mjs";
import { getIdentityPlanMatchValue } from "./claim_plan.mjs";

const { Client } = pg;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export interface IdentityConnectionPreview {
  readonly name: string;
  readonly provider: IdentityProvider;
  readonly planDigest: string;
  readonly relationalGroups: number;
  readonly preservedAuditGroups: number;
  readonly nestedJsonGroups: number;
  readonly signupDefaults: number;
  readonly storagePathGroups: number;
  readonly assetScopes: number;
  readonly claimKeys: number;
  readonly tokenHookConfigured: boolean;
  readonly associated: boolean;
}

const assertLocalDatabase = (connectionString: string): void => {
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error("Identity connection requires a valid local database URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !["127.0.0.1", "::1", "localhost"].includes(target.hostname)
  ) {
    throw new Error(
      "Identity connection may inspect only the local Rehearsal database.",
    );
  }
};

const hasAssociationReceipt = async ({
  client,
  name,
  placeholderUserId,
  localUserId,
}: {
  client: IdentityDatabaseClient;
  name: string;
  placeholderUserId: string;
  localUserId: string;
}): Promise<boolean> => {
  const relation = await client.query<{ relation: unknown }>(
    "select to_regclass('rehearsal_internal.identity_claims')::text as relation",
  );
  if (relation.rows[0]?.relation !== "rehearsal_internal.identity_claims") {
    return false;
  }
  const receipt = await client.query<JsonObject>(
    `select 1
     from rehearsal_internal.identity_claims
     where identity_name = $1
       and placeholder_user_id = $2::uuid
       and local_user_id = $3::uuid
     limit 1`,
    [name, placeholderUserId, localUserId],
  );
  return receipt.rows.length === 1;
};

export const inspectIdentityConnection = async ({
  plan,
  connectionString,
  clientFactory,
}: {
  plan: IdentityClaimPlan;
  connectionString: string;
  clientFactory?: IdentityClientFactory;
}): Promise<IdentityConnectionPreview> => {
  assertLocalDatabase(connectionString);
  const matchValue = getIdentityPlanMatchValue(plan);
  if (!matchValue) {
    throw new Error(
      "Identity connection plans must use the reviewed local matcher environment.",
    );
  }
  const client: IdentityDatabaseClient = clientFactory
    ? await clientFactory(connectionString)
    : (new Client({
        connectionString,
        application_name: "rehearsal-identity-connect",
      }) as unknown as IdentityDatabaseClient);
  await client.connect?.();
  try {
    const localIdentity = await findVerifiedLocalIdentity({
      client,
      plan,
      matchValue,
      lock: false,
    });
    if (!UUID.test(localIdentity.id)) {
      throw new Error("Matched local identity is invalid.");
    }
    return Object.freeze({
      name: plan.review.name,
      provider: localIdentity.provider,
      planDigest: plan.digest,
      relationalGroups: plan.review.references.filter(
        (reference) => reference.strategy === "transfer",
      ).length,
      preservedAuditGroups: plan.review.references.filter(
        (reference) => reference.strategy === "preserve-audit",
      ).length,
      nestedJsonGroups: plan.review.jsonReferences.length,
      signupDefaults: plan.review.signupDefaults.length,
      storagePathGroups: plan.review.pathReferences.length,
      assetScopes: plan.review.assets.length,
      claimKeys: plan.review.claimKeys.length,
      tokenHookConfigured: plan.review.tokenHook !== null,
      associated: await hasAssociationReceipt({
        client,
        name: plan.identity.name,
        placeholderUserId: plan.identity.placeholderUserId,
        localUserId: localIdentity.id,
      }),
    });
  } finally {
    await client.end?.();
  }
};

const abortableDelay = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Identity connection was cancelled."));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(
          signal.reason ?? new Error("Identity connection was cancelled."),
        );
      },
      { once: true },
    );
  });

export const waitForIdentityConnection = async ({
  plan,
  connectionString,
  clientFactory,
  inspect = inspectIdentityConnection,
  signal,
  pollIntervalMs = 750,
  timeoutMs = 15 * 60 * 1_000,
}: {
  plan: IdentityClaimPlan;
  connectionString: string;
  clientFactory?: IdentityClientFactory;
  inspect?: typeof inspectIdentityConnection;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<IdentityConnectionPreview> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Identity connection was cancelled.");
    }
    try {
      return await inspect({
        plan,
        connectionString,
        ...(clientFactory === undefined ? {} : { clientFactory }),
      });
    } catch (error) {
      if (!isIdentityNotFoundError(error)) throw error;
    }
    await abortableDelay(pollIntervalMs, signal);
  }
  throw new Error(
    "Timed out waiting for the approved verified local identity. Nothing was changed.",
  );
};
