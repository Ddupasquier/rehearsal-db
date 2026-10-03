# Sanitization policy

Rehearsal never decides what your application may copy. The project owner reviews an
exhaustive policy; the package validates and executes the supported recipes.

Every exported field should receive one action:

- `KEEP`: retain an explicitly non-sensitive value needed for realistic behavior;
- `PSEUDONYMIZE`: replace identity while preserving stable joins;
- `REPLACE`: substitute a safe value of compatible shape;
- `EXCLUDE`: omit data that the rehearsal does not need;
- `DERIVE`: create a bounded safe value from approved inputs.

Fail if a new column is unclassified. Do not default unknown fields to `KEEP`.

For runtime restore, each included column must also classify whether it is generated,
whether it is an identity column, and its foreign-key target or explicit absence. Run
`rehearsal baseline prepare` to create a shape-only draft from synthetic NDJSON. The
draft uses `REVIEW REQUIRED` placeholders and cannot be activated until they are
replaced and the `draft` marker is removed.

Tables default to the `public` schema. Add `"schema": "app_api"` beside `name`
for another schema. Schema plus table is the identity, so two schemas may safely contain
tables with the same name.

In an interactive terminal, the guided **Review the script** action works table by table.
For larger tables, a human can explicitly apply safe defaults (`REPLACE`, `NEVER`
generated, `NO` identity, and no foreign key), then review only exceptions. Likely
structural columns such as `id`, `*_id`, and timestamps start selected as exceptions.
Users can instead review every column individually. Retaining a value is explicitly
labeled as sensitive, every saved field remains classified, and no preset is silently
applied. The reviewer validates the completed policy and refuses to overwrite a draft
changed during the session.

Two policy versions exist:

- Version 1 describes data that a project has already made safe. It remains supported
  for synthetic/local inputs and existing baselines.
- Version 2 is required by `baseline refresh`. It adds bounded declarative recipes so
  Rehearsal can sanitize without project callbacks.

Version 2 supports keyed UUID, email, text, and integer pseudonyms; explicit constant
replacement; bounded date shifting; and exhaustively classified JSON objects. Unknown
tables, columns, nested keys, formats, recipes, or missing fields fail closed. It never
evaluates JavaScript or SQL from the policy.

The package still exports `validateSanitizationCoverage` and
`applySanitizationAction` for existing version 1 preparation tools:

```ts
import {
  applySanitizationAction,
  validateSanitizationCoverage,
} from "@rehearsal-db/core";

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
entries both fail. New standalone preparation should use the version 2 engine described
in [Production source](production-source.md).

## Stable identity

Use keyed, deterministic pseudonyms when relationships must survive across tables.
Keep the key under `.rehearsal`, outside source control and the final baseline. The same source ID
should map consistently within a generation, while the original value cannot be
recovered from the artifact. The manifest records only the key fingerprint.

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

The exact reviewed policy bytes are checksum-bound to the active baseline. Planning,
candidate inspection, and runtime restore refuse to continue if that file later changes;
build a new reviewed baseline instead of editing the active policy in place.
