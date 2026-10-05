# Security model

Rehearsal assumes a mistake is more likely than an attacker. Its design makes ordinary
misconfiguration fail closed before a state-changing operation.

## Trust boundaries

The engine trusts reviewed package code, strict declarations, a verified active baseline,
and exact migration bytes. It does not trust ambient environment variables, hosted
project state, unknown fields, changed history, incomplete artifacts, or an unverified
runtime.

## Independent barriers

- loopback-only application and service URLs;
- a dedicated unlinked Supabase workdir, or an exactly named and labeled PostgreSQL
  container and volume;
- exact non-overlapping local ports;
- a clean child-process environment that omits hosted credentials;
- immutable baseline files and checksums;
- exact migration-prefix and candidate digests;
- local runtime labels used for bounded stop/removal;
- PostgreSQL images must already exist locally and are never pulled implicitly;
- plain PostgreSQL receives a fresh random password per disposable runtime, retained
  only in owner-readable ignored runtime files;
- successful receipts written only after verification.
- separate exact-digest approval for source setup, source retirement, and identity claim;
- short-lived source readers limited to reviewed views/columns and deny checks;
- externally provisioned readers require canonical view-definition receipts,
  `security_barrier`, independent ownership, an exact non-system readable-column surface,
  no write or role-escalation paths, and database-enforced expiration;
- bounded read-only extraction with no raw dump or row-value logging;
- exhaustive privacy policy version 2 with an owner-only local pseudonym key;
- application children receive only explicit local mappings and stay in an owned process
  group.
- only one state-changing Rehearsal command may own a project at a time; stale locks are
  recovered after their process exits;
- a state-changing command fingerprints its installed Rehearsal package and refuses to
  continue if that installation changes while the command is running.

No single environment variable or config edit can redirect runtime commands to
production. Optional source preparation is a separate boundary and never provides a
hosted execution mode.

External source mode verifies access but does not own it. Rehearsal makes no source-side
changes and removes only its local credential and receipt. The provider owns early
revocation and the database enforces the reviewed short expiration; Rehearsal never
reports local cleanup as proof that a provider-owned role was deleted.

## Identity providers

An optional external identity handshake is distinct from database access. Only declared
credential names are read from an ignored owner-only file, and the callback must target
local Auth. The local account may represent a sanitized production identity, but its
session and writes remain local.

Account association is one local transaction. Rehearsal removes a signup-created row
only when its complete declared default shape still matches, refuses unrelated local
application data, verifies required role references and an optional token hook, and can
copy, byte-check, and retire only declared placeholder-owned Storage paths. Immutable
audit references may explicitly retain their synthetic historical actor. Rehearsal also
refuses to rewrite application paths when copied records refer to files that are absent
from local Storage. Existing browser JWTs still require an ordinary refresh or new
sign-in.

## Remaining responsibilities

Rehearsal cannot prove that retained data is lawful, a sanitization rule is ethically
appropriate, a migration has the intended business meaning, or a real provider flow was
observed. Repository owners must review those decisions and protect artifacts. The
configuration barriers are not an operating-system firewall.

Report vulnerabilities using the private process in the root security policy.
