# Sanitization policy

Rehearsal deliberately does not decide what your application may copy. The consuming
project owns an exhaustive, reviewable policy for its export surface.

Every exported field should receive one action:

- `KEEP`: retain an explicitly non-sensitive value needed for realistic behavior;
- `PSEUDONYMIZE`: replace identity while preserving stable joins;
- `REPLACE`: substitute a safe value of compatible shape;
- `EXCLUDE`: omit data that the rehearsal does not need;
- `DERIVE`: create a bounded safe value from approved inputs.

Fail if a new column is unclassified. Do not default unknown fields to `KEEP`.

The package exports `validateSanitizationCoverage` and
`applySanitizationAction` as generic primitives:

```ts
import {
  applySanitizationAction,
  validateSanitizationCoverage,
} from "@rehearsal/db";

validateSanitizationCoverage({ policy, schemaTables });

const safeValue = applySanitizationAction({
  action: column.action,
  value: sourceValue,
  pseudonymize: projectPseudonymizer,
  replace: projectReplacement,
  derive: projectDerivation,
  context: { table: table.name, column: column.name },
});
```

Coverage validation requires a one-to-one table and column match: missing and unknown
entries both fail. The package supplies the operation contract; the project supplies
the schema inventory, keys, replacements, and derivation logic.

## Stable identity

Use keyed, deterministic pseudonyms when relationships must survive across tables.
Keep the key outside source control and outside the final baseline. The same source ID
should map consistently within a generation, while the original value cannot be
recovered from the artifact.

## High-risk fields

Exclude or replace secrets, password material, refresh tokens, session tokens, payment
data, private messages, precise location, raw uploads, provider credentials, and
unbounded free text unless a reviewed test requirement proves they are necessary.

Images and Storage objects need the same classification as database columns. A public
product image may be retained under its license; a private upload generally may not.

## Validation

Before activation, verify:

1. every exported column is classified;
2. prohibited values and secret canaries are absent;
3. referential relationships required by the app remain valid;
4. row counts match the approved export manifest;
5. the policy digest is recorded in the baseline manifest;
6. raw staging files and temporary credentials are removed.

Completeness is not correctness. Human review of the policy and export boundary remains
mandatory before any real source is introduced.
