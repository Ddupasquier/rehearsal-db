/** Read-only identity discovery and reference inspection. */

import { createHash } from "node:crypto";
import type {
  IdentityClaimPlan,
  IdentityDatabaseClient,
  IdentityProvider,
  IdentityReference,
} from "./claim_contract.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} is not a safe identifier.`);
  }
  return value;
};
const qid = (value: unknown): string => `"${id(value, "SQL identifier")}"`;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const discoverPublicAuthReferences = async (
  client: IdentityDatabaseClient,
): Promise<IdentityReference[]> => {
  const result = await client.query<{
    schema: unknown;
    table: unknown;
    column: unknown;
  }>(`select distinct
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
    required: false,
    strategy: "transfer",
  }));
};

export const countIdentityRows = async ({
  client,
  reference,
  userId,
}: {
  client: IdentityDatabaseClient;
  reference: Pick<IdentityReference, "schema" | "table" | "column">;
  userId: string;
}): Promise<number> => {
  const result = await client.query<{ count: unknown }>(
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

export interface VerifiedLocalIdentity {
  readonly id: string;
  readonly provider: IdentityProvider;
}

export class IdentityLookupError extends Error {
  readonly reason: "none" | "ambiguous" | "conflict" | "invalid";

  constructor(
    reason: "none" | "ambiguous" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "IdentityLookupError";
    this.reason = reason;
  }
}

export const isIdentityNotFoundError = (
  error: unknown,
): error is IdentityLookupError =>
  error instanceof IdentityLookupError && error.reason === "none";

export const findVerifiedLocalIdentity = async ({
  client,
  plan,
  matchValue,
  lock = true,
}: {
  client: IdentityDatabaseClient;
  plan: IdentityClaimPlan;
  matchValue: string;
  lock?: boolean;
}): Promise<VerifiedLocalIdentity> => {
  const matcher = plan.identity.matcher;
  if (matcher.type === "verified-email") {
    const match = await client.query<{ id: unknown; provider?: unknown }>(
      `select u.id::text, i.provider
       from auth.users u
       join auth.identities i on i.user_id = u.id
       where lower(coalesce(i.identity_data->>'email', u.email)) = $1
         and i.provider = any($2::text[])
         and (
           coalesce((i.identity_data->>'email_verified')::boolean, false)
           or u.email_confirmed_at is not null
         )
         ${lock ? "for update of u" : ""}`,
      [matchValue, matcher.providers],
    );
    if (match.rows.length !== 1) {
      throw new IdentityLookupError(
        match.rows.length === 0 ? "none" : "ambiguous",
        match.rows.length === 0
          ? "No verified local identity matches the reviewed email and provider allowlist."
          : "More than one verified local identity matches the reviewed email and provider allowlist.",
      );
    }
    const matchedRow = match.rows[0];
    if (!matchedRow)
      throw new IdentityLookupError(
        "invalid",
        "Matched local identity is invalid.",
      );
    const matchedProvider =
      matchedRow.provider ??
      (matcher.providers.length === 1 ? matcher.providers[0] : null);
    if (
      typeof matchedProvider !== "string" ||
      !matcher.providers.includes(matchedProvider as IdentityProvider)
    ) {
      throw new IdentityLookupError(
        "invalid",
        "Matched local identity provider is invalid.",
      );
    }
    if (typeof matchedRow.id !== "string") {
      throw new IdentityLookupError(
        "invalid",
        "Matched local identity is invalid.",
      );
    }
    return {
      id: matchedRow.id,
      provider: matchedProvider as IdentityProvider,
    };
  }

  const candidates = await client.query<{
    id: unknown;
    provider: unknown;
    provider_id: unknown;
    subject: unknown;
  }>(
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
     ${lock ? "for update of u" : ""}`,
    [matcher.provider],
  );
  const matches: VerifiedLocalIdentity[] = [];
  for (const candidate of candidates.rows) {
    const subjects = [candidate.provider_id, candidate.subject]
      .filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      )
      .map((value) => value.trim());
    const uniqueSubjects = [...new Set(subjects)];
    if (
      uniqueSubjects.some(
        (subject) => hash(subject) === matcher.approvedSubjectSha256,
      )
    ) {
      if (uniqueSubjects.length !== 1) {
        throw new IdentityLookupError(
          "conflict",
          "The matched local provider identity has conflicting stable subjects.",
        );
      }
      if (
        typeof candidate.id !== "string" ||
        candidate.provider !== matcher.provider
      ) {
        throw new IdentityLookupError(
          "invalid",
          "Matched local identity provider is invalid.",
        );
      }
      matches.push({ id: candidate.id, provider: matcher.provider });
    }
  }
  if (matches.length !== 1) {
    throw new IdentityLookupError(
      matches.length === 0 ? "none" : "ambiguous",
      matches.length === 0
        ? "No verified local identity matches the reviewed provider subject."
        : "More than one verified local identity matches the reviewed provider subject.",
    );
  }
  const match = matches[0];
  if (!match || match.provider !== matcher.provider) {
    throw new IdentityLookupError(
      "invalid",
      "Matched local identity provider is invalid.",
    );
  }
  return match;
};
