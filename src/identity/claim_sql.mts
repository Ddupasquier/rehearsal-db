/** Pure SQL planning for reviewed identity references. No function executes SQL. */

import type {
  IdentityReference,
  JsonIdentityReference,
  PathIdentityReference,
  SignupDefaultDeclaration,
} from "./claim_contract.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;

export const quoteIdentityIdentifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) {
    throw new Error("Identity SQL identifier is not safe.");
  }
  return `"${value}"`;
};

const target = ({ schema, table }: { schema: string; table: string }) =>
  `${quoteIdentityIdentifier(schema)}.${quoteIdentityIdentifier(table)}`;

export const planSignupDefaultInspection = (
  declaration: SignupDefaultDeclaration,
): string => `select candidate.${quoteIdentityIdentifier(declaration.identityColumn)}::text as identity,
       to_jsonb(candidate) as row
from ${target(declaration.table)} candidate
where candidate.${quoteIdentityIdentifier(declaration.identityColumn)} in ($1::uuid, $2::uuid)
for update`;

export const planSignupDefaultRemoval = (
  declaration: SignupDefaultDeclaration,
): string => `delete from ${target(declaration.table)}
where ${quoteIdentityIdentifier(declaration.identityColumn)} = $1::uuid`;

export const planRelationalReferenceTransfer = (
  reference: IdentityReference,
): string => `update ${target(reference)}
set ${quoteIdentityIdentifier(reference.column)} = $1::uuid
where ${quoteIdentityIdentifier(reference.column)} = $2::uuid`;

export const planRequiredReferenceCheck = (
  reference: IdentityReference,
): string => `select 1
from ${target(reference)}
where ${quoteIdentityIdentifier(reference.column)} = $1::uuid
limit 1`;

export const planJsonReferenceTransfer = (
  reference: JsonIdentityReference,
): string => `update ${target(reference)}
set ${quoteIdentityIdentifier(reference.column)} = jsonb_set(
  ${quoteIdentityIdentifier(reference.column)}, $3::text[], to_jsonb($1::text), false
)
where ${quoteIdentityIdentifier(reference.column)} #>> $3::text[] = $2`;

export const planPathReferenceCount = (
  reference: PathIdentityReference,
): string => {
  const relation = target(reference);
  const column = quoteIdentityIdentifier(reference.column);
  return reference.valueType === "text"
    ? `select count(*)::integer as count from ${relation} where ${column} like $1::text || '%'`
    : `select count(*)::integer as count from ${relation} where ${column}::text like '%' || $1::text || '%'`;
};

export const planPathReferenceTransfer = (
  reference: PathIdentityReference,
): string => {
  const relation = target(reference);
  const column = quoteIdentityIdentifier(reference.column);
  return reference.valueType === "text"
    ? `update ${relation}
set ${column} = $1::text || substring(${column} from char_length($2::text) + 1)
where ${column} like $2::text || '%'`
    : `update ${relation}
set ${column} = replace(${column}::text, $2::text, $1::text)::jsonb
where ${column}::text like '%' || $2::text || '%'`;
};
