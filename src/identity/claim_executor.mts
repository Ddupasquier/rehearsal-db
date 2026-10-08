/** Execute and verify one confirmed local identity claim transaction. */

import pg from "pg";
import { IDENTITY_CLAIM_RECEIPT_SQL } from "../runtime/policy.mjs";
import type {
  IdentityClaimPlan,
  IdentityClaimResult,
  IdentityClientFactory,
  IdentityDatabaseClient,
  JsonObject,
  StorageCopy,
} from "./claim_contract.mjs";
import {
  countIdentityRows,
  discoverPublicAuthReferences,
  findVerifiedLocalIdentity,
} from "./claim_identity_lookup.mjs";
import { getIdentityPlanMatchValue } from "./claim_plan.mjs";
import {
  planJsonReferenceTransfer,
  planPathReferenceCount,
  planPathReferenceTransfer,
  planRelationalReferenceTransfer,
  planRequiredReferenceCheck,
  planSignupDefaultInspection,
  planSignupDefaultRemoval,
} from "./claim_sql.mjs";
import {
  containsJson,
  inspectDeclaredDefault,
  valueKind,
} from "./claim_verification.mjs";
import type { SupabaseStorageTransfer } from "./storage.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const groupStorageCopies = (
  copies: readonly StorageCopy[],
): Map<string, StorageCopy[]> => {
  const grouped = new Map<string, StorageCopy[]>();
  for (const copy of copies) {
    const bucketCopies = grouped.get(copy.bucket);
    if (bucketCopies) bucketCopies.push(copy);
    else grouped.set(copy.bucket, [copy]);
  }
  return grouped;
};

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(`${label} is not a safe identifier.`);
  return value;
};
const qid = (value: unknown): string => `"${id(value, "SQL identifier")}"`;

export const applyIdentityClaim = async ({
  plan,
  confirmation,
  connectionString,
  clientFactory,
  storageTransfer,
}: {
  plan: IdentityClaimPlan;
  confirmation: string;
  connectionString: string;
  clientFactory?: IdentityClientFactory;
  storageTransfer?: SupabaseStorageTransfer;
}): Promise<IdentityClaimResult> => {
  if (confirmation !== plan.digest) {
    throw new Error(
      `Identity claim confirmation does not match. Expected ${plan.digest}.`,
    );
  }
  const matchValue = getIdentityPlanMatchValue(plan);
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
  const client: IdentityDatabaseClient = clientFactory
    ? await clientFactory(connectionString)
    : (new Client({
        connectionString,
        application_name: "rehearsal-identity-claim",
      }) as unknown as IdentityDatabaseClient);
  await client.connect?.();
  let removedSignupDefaults = 0;
  let tokenHookVerified = false;
  let placeholderRetainedForAudit = false;
  const stagedStorageCopies: StorageCopy[] = [];
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
    const placeholderUser = await client.query<JsonObject>(
      "select 1 from auth.users where id = $1::uuid limit 1",
      [plan.identity.placeholderUserId],
    );
    const placeholderReferenceCounts: number[] = [];
    if (localUserId !== plan.identity.placeholderUserId) {
      for (const reference of plan.identity.references) {
        placeholderReferenceCounts.push(
          await countIdentityRows({
            client,
            reference,
            userId: plan.identity.placeholderUserId,
          }),
        );
      }
    }
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
    const transferLocalCounts = [];
    if (
      localUserId !== plan.identity.placeholderUserId &&
      preservedReferences.length > 0
    ) {
      for (const reference of transferReferences) {
        transferLocalCounts.push(
          await countIdentityRows({ client, reference, userId: localUserId }),
        );
      }
    }
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
      const placeholderIdentity = await client.query<JsonObject>(
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
        const rows = await client.query<{ identity: unknown; row: unknown }>(
          planSignupDefaultInspection(declaration),
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
          const localRow = localRows[0];
          if (!localRow) {
            throw new Error(
              "The declared signup-default relation is ambiguous; nothing was changed.",
            );
          }
          const defaultInspection = inspectDeclaredDefault({
            row: localRow.row,
            declaration,
          });
          if (!defaultInspection.matches) {
            const declaredColumns = Object.keys(declaration.values).sort();
            const mismatchKinds = defaultInspection.mismatchedColumns.map(
              (column) =>
                `${column}(${valueKind(isObject(localRow.row) ? localRow.row[column] : undefined)}/${declaration.values[column]?.kind === "exact" ? valueKind(declaration.values[column].value) : "pattern"})`,
            );
            throw new Error(
              `The local signup row was edited or does not match its complete declared default; nothing was changed. Declared columns: ${declaredColumns.join(", ")}. Actual columns: ${defaultInspection.actualColumns.join(", ") || "none"}. Mismatched column shapes: ${mismatchKinds.join(", ") || "none"}.`,
            );
          }
          await client.query(planSignupDefaultRemoval(declaration), [
            localUserId,
          ]);
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
        await client.query(planRelationalReferenceTransfer(reference), [
          localUserId,
          plan.identity.placeholderUserId,
        ]);
      }
      if (reference.required) {
        const required = await client.query(
          planRequiredReferenceCheck(reference),
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
      await client.query(planJsonReferenceTransfer(reference), [
        localUserId,
        plan.identity.placeholderUserId,
        reference.path,
      ]);
    }
    const sourcePathPrefix = `${plan.identity.placeholderUserId}/`;
    let sourcePathReferenceCount = 0;
    if (plan.identity.assets.some((asset) => asset.rewritePath)) {
      for (const reference of plan.identity.pathReferences) {
        const result = await client.query<{ count: unknown }>(
          planPathReferenceCount(reference),
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
      const sourceObjects = await client.query<{
        name: unknown;
        owner_id: unknown;
      }>(
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
      const copies: StorageCopy[] = sourceObjects.rows.map(({ name }) => {
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
      const transferred = await client.query<{ count: unknown }>(
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
      await client.query(planPathReferenceTransfer(reference), [
        targetPathPrefix,
        sourcePathPrefix,
      ]);
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
      const tokenResult = await client.query<{ event?: unknown }>(
        `select ${qid(hook.function.schema)}.${qid(hook.function.name)}(
           jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb)
         ) as event`,
        [localUserId],
      );
      const event = tokenResult.rows[0]?.event;
      const claims = isObject(event) ? event.claims : undefined;
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
    const claimReceipt = await client.query<JsonObject>(
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
    const copiesByBucket = groupStorageCopies(stagedStorageCopies);
    for (const [bucket, copies] of copiesByBucket) {
      if (!storageTransfer) {
        throw new Error("Storage transfer became unavailable after commit.");
      }
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
      const cleanupErrors: unknown[] = [];
      if (!storageTransfer) throw error;
      for (const [bucket, copies] of groupStorageCopies(stagedStorageCopies)) {
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
