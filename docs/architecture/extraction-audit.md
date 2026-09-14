# Extraction audit

DEV-082 extracts only behavior already proven by BlendCalc's production-shaped
Rehearsal environment. It does not move BlendCalc's source-access authority, privacy
policy, identity mapping, application behavior, or browser acceptance tests into the
package.

## Proven reusable boundary

The package owns:

- strict project configuration and loopback-only runtime validation;
- immutable baseline activation, checksums, retention, and verification;
- exact migration-file and migration-ledger hashing;
- candidate-suffix planning and confirmation digests;
- disposable local Supabase lifecycle, restore, migration, and cleanup;
- bounded PostgreSQL streaming and safe failure summaries;
- versioned diagnostics, exit codes, redaction, and machine output;
- project-owned application proof and post-restore adapter hooks.

BlendCalc owns:

- production export views and temporary source credential provisioning;
- the complete table-and-column sanitization classification;
- authorization for retained owner data and Storage objects;
- synthetic identity replacement and owner-account claiming;
- local application startup, side-effect policy, and browser proof;
- BlendCalc-specific schema, data, images, providers, and acceptance thresholds.

## First-release support claim

Version `0.1` is a Supabase CLI runtime orchestrator whose migration and restore model
uses PostgreSQL. It does not claim compatibility with an arbitrary unmanaged PostgreSQL
installation. A future database-runtime adapter may broaden that boundary only after a
second implementation proves the interface.

## Dependency and streaming evidence

The engine has no runtime npm dependencies and uses Node.js streams plus PostgreSQL
`COPY` through the local Supabase database container. The production-shaped BlendCalc
baseline proved bounded restore of more than one million rows; the standalone synthetic
fixture proves that no BlendCalc table or policy is required.

## Compatibility and failure contract

Configuration schema, baseline format, migration digest semantics, command names,
versioned JSON results, exit categories, and verification order are public compatibility
surfaces. Unknown configuration, changed migration history, unsafe targets, invalid
baselines, failed candidates, and failed application proofs stop closed and never mark
the runtime trusted.

## Extraction rule

Code moves only when the independent fixture exercises it without a BlendCalc import.
Source extraction and sanitization remain project-owned until a separate generic source
boundary is designed and independently proven.
