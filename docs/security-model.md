# Security model

Rehearsal assumes a mistake is more likely than an attacker. Its design makes ordinary
misconfiguration fail closed before a state-changing operation.

## Trust boundaries

The engine trusts the reviewed package code, strict project configuration, a verified
active baseline, exact migration bytes, and explicitly project-owned proof code. It does
not trust ambient environment variables, hosted project state, unknown config fields,
changed migration history, incomplete artifacts, or an unverified runtime.

## Independent barriers

- loopback-only application and service URLs;
- a dedicated unlinked Supabase workdir and project ID;
- exact non-overlapping local ports;
- a clean child-process environment that omits hosted credentials;
- immutable baseline files and checksums;
- exact migration-prefix and candidate digests;
- local runtime labels used for bounded stop/removal;
- successful receipts written only after verification.

No single environment variable or config edit should redirect the tool to production.
Version 1 provides no hosted execution mode.

## Identity providers

An optional external identity handshake is distinct from database access. Only declared
credential names are read from an ignored owner-only file, and the callback must target
local Auth. The local account may represent a sanitized production identity, but its
session and writes remain local.

## Remaining responsibilities

Rehearsal cannot prove that retained data is lawful, a sanitization rule is ethically
appropriate, a migration has the intended business meaning, or a project adapter is
safe. Repository owners must review those decisions and protect artifacts.

Report vulnerabilities using the private process in the root security policy.
