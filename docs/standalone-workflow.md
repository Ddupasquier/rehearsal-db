# Standalone workflow contract

Rehearsal's normal commands remain local-only. `run`, `start`, `reset`,
`migrate`, `verify`, and `cleanup` never receive source credentials and never
connect to a hosted database.

The optional preparation workflow is a separate security boundary. It has
three deliberately separate phases:

1. `source plan` reads declarations and produces a redacted, exact plan.
2. `source apply` requires the plan digest. Managed mode uses source-owner credentials
   from a named environment variable and creates only the declared, time-limited reader
   and export surface. External mode verifies an already restricted reader without an
   administrator credential or source-side writes.
3. `refresh` uses that reader in a read-only repeatable-read transaction, builds
   privately, activates only after verification, resets the local runtime, and applies
   reviewed retention. `baseline refresh` is the lower-level baseline-only form.

`source retire` has its own preview and digest. Managed mode removes only the exact
reader and export objects Rehearsal recorded. External mode removes only local Rehearsal
credentials and receipts, preserving provider-owned objects. It never searches for
similarly named roles or removes unrelated grants.

## What belongs in declarations

Projects declare application meaning; Rehearsal executes it. Declarations may
name:

- approved source relations and columns;
- whether rows are approved public data or belong to one explicitly approved
  owner;
- privacy actions and bounded transformation recipes;
- hashed server-side owner bindings and explicit approved/other-owner branches;
- bounded nested JSON objects and arrays with required/optional fields;
- licensed or consented Storage buckets and prefixes;
- schema and extension prerequisites;
- local identities and reference locations;
- ordinary application commands and observable proof expectations.

Declarations cannot contain JavaScript callbacks, SQL fragments, passwords,
tokens, production URLs, or automatic consent decisions. Unknown fields,
tables, columns, recipes, JSON keys, and target identities fail closed.

## Credential separation

Provisioning, extraction, asset, provider, and local-runtime credentials are
separate. A declaration contains only the name of an environment variable or
owner-only secret file. Rehearsal never puts credential values in command-line
arguments, reports, baselines, receipts, or a launched application.

The default managed workflow creates and verifies its own temporary PostgreSQL reader.
External mode accepts a provider-managed reader only when its complete non-system
readable-column surface exactly matches the reviewed export views and migration ledger.
It also verifies canonical view-definition fingerprints, `security_barrier`, ownership,
write denial, security-definer denial, and a short database-enforced expiration. An
external login can declare a bounded exact list of provider-owned permission groups;
each must be non-login, non-privileged, directly inherited, unable to be assumed or
delegated, and free of nested membership. Undeclared or unsafe role membership fails as
an actionable source-authorization refusal. Rehearsal never claims ownership or
revocation of provider-managed objects.

## Snapshot and privacy guarantees

Database schema, migration evidence, and selected rows are read in one
read-only repeatable-read PostgreSQL transaction. Rehearsal rechecks the source
identity and migration evidence before commit. Rows stream in bounded batches;
record bodies never appear in progress or error output.

The snapshot boundary is deliberate: row commits made after extraction starts are left
for the next baseline, while concurrent schema or migration-ledger changes block the
current activation. Invalid estimates, malformed batches, connection loss, interruption,
and disk or configured-limit failures remove private staging and preserve the previously
active baseline.

Cleanup recursively makes only Rehearsal's private staging tree removable. A failed
Storage transfer therefore reports the original safe transfer error, removes incomplete
files, and does not alter the active generation.

Storage objects do not share the database transaction guarantee. Their inventory records
size and version metadata; transfer requires that version, verifies the exact byte count,
and records a SHA-256 in the immutable baseline. Transfer refuses an object that changes,
exceeds its declared limit, or falls outside an approved bucket and prefix.

Privacy policy version 2 is executable without project sanitizer code. It
supports exact keep, exclusion, keyed and constraint-preserving pseudonyms (including
safe loopback HTTPS replacements), bounded reviewed-identity substitution inside
retained text,
constants, named sanitized-input digests, and a small set of documented
derivations. Policies classify every selected field and supported nested JSON
key. A new or unknown field blocks refresh until the policy is reviewed again.

The pseudonym key is an owner-only local secret. It is not stored in the
baseline or source control. Receipts bind the policy bytes, schema shape,
source scope, migration evidence, and key fingerprint without storing the key
or source identifiers.

## Restore, identities, and applications

Restore performs only supported declarative prerequisites. Application schema
changes remain immutable migration files; configuration is never an arbitrary
privileged-SQL escape hatch.

Local identities never reuse production sessions, refresh tokens, password
hashes, provider secrets, or MFA material. An approved provider association is
performed inside the local runtime and must match the reviewed receipt.

Rehearsal launches ordinary project commands with a minimal environment and
generated local connection files. It verifies every configured dependency
before launch, owns only the child process group it starts, and does not claim
to provide an operating-system firewall.

Proofs require explicit positives and negatives. A process starting, a non-5xx
response, an empty 200, a 401, or a 404 cannot satisfy a declared positive.
Reports distinguish engine readiness, dependency readiness, proof completion,
and provider behavior that was directly observed by a person.

## Failure and upgrade behavior

- Failed, interrupted, changed-policy, low-disk, or drifted refreshes leave the
  prior active baseline and any edited runtime untouched.
- Setup and upgrades preview exact file changes and never overwrite a reviewed
  policy, config, baseline, or local edit silently.
- Reset, discard, and cleanup operate only on purpose-created Rehearsal
  resources and retain their existing exact-preview protections.
- Rehearsal does not make legal, consent, licensing, backup, disaster-recovery,
  universal-database, or OS-firewall guarantees.

The final acceptance gate uses the exact packed or published artifact in clean
Supabase and PostgreSQL consumers. Consumer integration code is removed only
after that replacement is proved and the removal is separately approved.
