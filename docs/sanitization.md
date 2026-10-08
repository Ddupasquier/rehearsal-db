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

Version 2 supports keyed UUID, email, text, integer, fixed-width hexadecimal, and GTIN
pseudonyms; digests derived from named sanitized columns; explicit constant replacement;
bounded and grouped date shifting; identity-aware path mapping;
approved-owner conditionals; exhaustively classified JSON objects; bounded JSON arrays;
reviewed JSON type unions; and runtime-keyed JSON dictionaries. Unknown tables, columns,
nested keys, formats, recipes, variants, or missing required fields fail closed. It never
evaluates JavaScript, regular expressions, or SQL from the policy.

## Approved-owner values

Keep the raw approved owner outside the policy and baseline. The policy stores only its
environment-variable name and SHA-256 receipt:

```json
{
  "bindings": {
    "approved-owner": {
      "environmentVariable": "REHEARSAL_APPROVED_OWNER_ID",
      "approvedValueSha256": "<lowercase sha256 of the exact owner value>"
    }
  },
  "tables": [
    {
      "name": "profiles",
      "sourceRows": "STREAM AND SANITIZE",
      "ownerBinding": { "binding": "approved-owner", "column": "user_id" },
      "columns": [
        {
          "name": "user_id",
          "action": "PSEUDONYMIZE",
          "recipe": { "format": "uuid", "namespace": "account-id" },
          "generated": "NEVER",
          "identity": "NO",
          "foreignKey": null
        },
        {
          "name": "display_name",
          "action": "DERIVE",
          "recipe": {
            "kind": "approved-owner",
            "approved": { "action": "KEEP" },
            "otherwise": {
              "action": "REPLACE",
              "recipe": { "kind": "constant", "value": "Synthetic account" }
            }
          },
          "generated": "NEVER",
          "identity": "NO",
          "foreignKey": null
        }
      ]
    }
  ]
}
```

Generate the receipt without putting the owner value in shell history:

```sh
node -e 'const {createHash}=require("node:crypto"); process.stdout.write(createHash("sha256").update(process.env.REHEARSAL_APPROVED_OWNER_ID).digest("hex")+"\n")'
```

Every conditional table names its owner column. Missing bindings, hash mismatches,
missing owner columns, unsupported owner values, and conditionals without an owner
binding are refused. The owner column must use `PSEUDONYMIZE`, preventing a conditional
policy from retaining raw account IDs.

When ownership may come through several relationships, replace `column` with an explicit
bounded any-of declaration:

```json
{
  "ownerBinding": {
    "binding": "approved-owner",
    "columns": ["target_user_id", "actor_user_id"],
    "match": "any",
    "nullBehavior": "otherwise"
  }
}
```

Every listed column must exist and be pseudonymized. One matching value selects the
`approved` branch. `nullBehavior: "otherwise"` explicitly treats a null value as a
non-match; it never grants owner access. Without that declaration, encountering null is
an error. Empty strings, non-finite numbers (`NaN`, positive infinity, or negative
infinity), objects, arrays, booleans, missing columns, duplicate declarations, and
unsupported matching modes remain errors. Rehearsal validates every declared owner
column before selecting either branch, even when another owner column matches. A
single-column binding may also declare `nullBehavior: "otherwise"` when that column is
reviewed as nullable.

`identity` describes PostgreSQL's generated SQL identity metadata, not whether a value
identifies a person: ordinary UUID primary keys use `"NO"`, while a genuine
`GENERATED ... AS IDENTITY` column uses `"YES"`. Rehearsal checks the restored PostgreSQL
schema for a real backing sequence before attempting a sequence reset, so UUID identity
values never receive numeric sequence operations. Other owners take the declared
`otherwise` path; every other identity-bearing field still needs its own pseudonymization
declaration. Supply the binding only to the local server-side Rehearsal process; do not
put it in the policy, baseline, or tracked files.

## Identity-aware Storage paths

Use one named mapping when a database column and a physical Storage object both begin
with the approved owner's ID. Rehearsal pseudonymizes only that first segment and keeps
the remaining path unchanged:

```json
{
  "pathMappings": {
    "owner-storage": {
      "binding": "approved-owner",
      "format": "uuid",
      "namespace": "account-id",
      "maximumBytes": 512,
      "maximumSegments": 8
    }
  },
  "tables": [
    {
      "name": "profiles",
      "sourceRows": "STREAM AND SANITIZE",
      "columns": [
        {
          "name": "avatar_path",
          "action": "DERIVE",
          "recipe": { "kind": "path-map", "mapping": "owner-storage" },
          "generated": "NEVER",
          "identity": "NO",
          "foreignKey": null
        }
      ]
    }
  ]
}
```

The source policy uses the same mapping name and names the binding's environment
variable as `prefixEnvironmentVariable`; it never contains the raw owner ID. During
`rehearsal refresh`, the package uses the mapping for both database values and physical
object destinations. A missing mapping, a different environment variable, a path whose
first segment is not the exact reviewed owner, traversal, or a size/segment limit breach
stops the refresh.

## Related dates

Give related timestamps the same `group` and `days` value to shift them by one stable
offset. This preserves their order and duration:

```json
{
  "name": "starts_at",
  "action": "DERIVE",
  "recipe": { "kind": "date-shift", "days": 30, "group": "event-window" },
  "generated": "NEVER",
  "identity": "NO",
  "foreignKey": null
}
```

Apply the same recipe to `ends_at`. Rehearsal refuses a group that declares conflicting
`days` values. Leave out `group` when a date should shift independently.

`date-shift` returns an ISO string by default, preserving the existing behavior. When
the reviewed application model stores a date as numeric epoch milliseconds, declare
that representation explicitly:

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "date-shift",
    "days": 30,
    "group": "saved-recipe-window",
    "representation": "epoch-milliseconds"
  }
}
```

This form accepts only finite safe integers that JavaScript can represent as dates and
returns a numeric epoch-millisecond value. It preserves `null`, refuses strings,
fractions, non-finite numbers, unsafe integers and values outside the supported date
range. ISO-string and epoch-millisecond declarations may share a group; they receive the
same stable offset while each retains its declared output representation. The only
supported representation names are `iso-string` and `epoch-milliseconds`.

## Constraint-preserving identifiers and fingerprints

Use a keyed `hex` pseudonym when one source value must remain a lowercase 32- or
64-character hexadecimal value:

```json
{
  "name": "source_fingerprint",
  "action": "PSEUDONYMIZE",
  "recipe": {
    "format": "hex",
    "namespace": "source-fingerprint",
    "length": 64
  },
  "generated": "NEVER",
  "identity": "NO",
  "foreignKey": null
}
```

Use a `digest` derivation when the fingerprint must describe other sanitized fields.
Inputs are column names, evaluated in the listed order after their own privacy recipes.
The existing raw fingerprint is ignored:

```json
{
  "name": "evidence_fingerprint",
  "action": "DERIVE",
  "recipe": {
    "kind": "digest",
    "format": "hex",
    "namespace": "evidence-fingerprint",
    "length": 32,
    "inputs": ["sanitized_owner_id", "evidence_state"]
  },
  "generated": "NEVER",
  "identity": "NO",
  "foreignKey": null
}
```

Digest inputs must exist, must not be excluded, and cannot form a dependency cycle.
Rehearsal supports only 32- and 64-character hexadecimal output. The namespace and local
privacy key separate otherwise identical declarations.

Use the `gtin` pseudonym format for a normalized GTIN whose length and check digit must
remain valid:

```json
{
  "name": "barcode",
  "action": "PSEUDONYMIZE",
  "recipe": { "format": "gtin", "namespace": "product-barcode", "length": 14 },
  "generated": "NEVER",
  "identity": "NO",
  "foreignKey": null
}
```

Supported GTIN lengths are 8, 12, 13, and 14. Non-null input must be a normalized string
of exactly that length with a valid check digit; malformed input stops preparation. Null
stays null. Rehearsal creates a deterministic keyed payload and recalculates the check
digit, so related fields using the same namespace, length, source value, and key remain
aligned.

When one reviewed field legitimately contains more than one GTIN length, replace
`"length": 14` with an explicit allowlist such as `"allowedLengths": [12, 14]`. The two
keys are mutually exclusive. Each source value must match one allowed length, and its
result retains that exact length. Empty, duplicated, or unsupported allowlist entries
are refused. This also works inside structured JSON declarations; a JSON union is not
needed merely to distinguish GTIN string lengths.

Use the `url` pseudonym format when a sanitized field must remain an HTTPS URL:

```json
{
  "name": "evidence_reference",
  "action": "PSEUDONYMIZE",
  "recipe": {
    "format": "url",
    "namespace": "evidence-url",
    "origin": "https://127.0.0.1:58432",
    "maxLength": 500
  },
  "generated": "NEVER",
  "identity": "NO",
  "foreignKey": null
}
```

`origin` is required and must be an HTTPS loopback origin using `127.0.0.1`, `::1`, or
`localhost`. Credentials, paths, queries, fragments, non-HTTPS schemes, and non-local
hosts are refused. The value must be the canonical origin itself, optionally followed by
one `/`; dot segments and encoded dot segments are rejected before URL normalization.
`maxLength` is also required, cannot exceed 2,048 characters, and must fit the complete
generated URL.

Non-null input must be a valid HTTPS URL without surrounding or embedded whitespace.
Rehearsal hashes the entire source value with the local privacy key and namespace, then
emits only the reviewed origin and a 32-character pseudonymous path. It never copies the
source host, credentials, path, query, token, or fragment. Null remains null. Equal
inputs using the same namespace, key, and origin correspond across ordinary columns and
structured JSON; different inputs and rotated keys produce different paths.

The same declaration can be used for items inside bounded `json-array` recipes, which
covers PostgreSQL text-array projections represented by the source pipeline. Each array
and object still needs its ordinary item, depth, and byte bounds.

### Retained text containing a reviewed identity

Use `binding-substitute` when permitted text may contain the exact value of a reviewed
UUID binding. This keeps the surrounding text but replaces every occurrence of that UUID
with the same keyed pseudonym used by a `uuid` declaration sharing its namespace:

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "approved-owner",
    "approved": {
      "action": "DERIVE",
      "recipe": {
        "kind": "binding-substitute",
        "binding": "approved-owner",
        "format": "uuid",
        "namespace": "account-id",
        "maximumBytes": 256
      }
    },
    "otherwise": {
      "action": "PSEUDONYMIZE",
      "recipe": {
        "format": "text",
        "namespace": "food-description",
        "maxLength": 128
      }
    }
  }
}
```

The named binding must already exist in `policy.bindings`, and its environment value must
match the tracked SHA-256 review receipt. For this recipe the reviewed value must be a
UUID. `maximumBytes` is required and applies before and after replacement. Null remains
null; other input must be text. Ordinary text is unchanged, literal UUID occurrences are
all replaced, and the raw identity is never stored in policy.

This is intentionally not a general search-and-replace facility: there are no regular
expressions, arbitrary patterns, replacement strings, or callbacks. Pair it with an
`approved-owner` branch when only the reviewed owner's surrounding text may be retained.

## Structured JSON

`json-object` fields are required by default. Set `"required": false` on an explicitly
optional field. Unknown keys remain errors. `json-array` declares one item recipe and a
required `maximumItems`. Both recipes accept `maximumDepth`, `maximumBytes`, and
`allowNull`; defaults are 8 levels, 65,536 bytes, and no null container. Bounds are
checked before producing the transformed structure. Nested objects and arrays repeat
the same declarations, and every nested identity uses an explicit pseudonym recipe.

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "json-array",
    "maximumItems": 25,
    "maximumDepth": 4,
    "maximumBytes": 8192,
    "items": {
      "action": "DERIVE",
      "recipe": {
        "kind": "json-object",
        "fields": {
          "actor_id": {
            "action": "PSEUDONYMIZE",
            "recipe": { "format": "uuid", "namespace": "account-id" }
          },
          "note": {
            "action": "REPLACE",
            "required": false,
            "recipe": { "kind": "constant", "value": "Synthetic note" }
          }
        }
      }
    }
  }
}
```

### JSON values with several reviewed types

Use `json-union` when one JSON column legitimately stores more than one root type. Every
accepted type has its own declaration. Null is rejected unless `allowNull` is explicitly
true. Arrays and objects cannot use whole-value `KEEP`; their contents must be classified
through `json-array`, `json-object`, `json-dictionary`, another bounded union, or a safe
replacement or pseudonymization.

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "json-union",
    "allowNull": true,
    "maximumItems": 25,
    "maximumDepth": 5,
    "maximumBytes": 8192,
    "variants": {
      "string": { "action": "KEEP" },
      "number": { "action": "KEEP" },
      "array": {
        "action": "DERIVE",
        "recipe": {
          "kind": "json-array",
          "maximumItems": 25,
          "items": {
            "action": "REPLACE",
            "recipe": { "kind": "constant", "value": "Synthetic item" }
          }
        }
      },
      "object": {
        "action": "DERIVE",
        "recipe": {
          "kind": "json-object",
          "fields": {
            "status": { "action": "KEEP" },
            "note": {
              "action": "REPLACE",
              "required": false,
              "recipe": { "kind": "constant", "value": "Synthetic note" }
            }
          }
        }
      }
    }
  }
}
```

Supported variant names are `string`, `number`, `boolean`, `array`, and `object`.
Undeclared types, non-finite numbers, excessive bytes, depth or items, and unclassified
object fields fail closed.

### Reviewed scalar domains

Use `enum` when a structural string, number, or boolean must remain exact, but only a
small reviewed set is valid. For example, an image mode can retain its application
meaning without allowing arbitrary text through:

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "enum",
    "values": ["contain", "cover", "custom"],
    "allowNull": true
  }
}
```

The recipe accepts one through 128 distinct values. Each value must be a JSON string,
finite number, or boolean; strings are limited to 256 UTF-8 bytes. `null` is accepted
only when `allowNull` is true. Runtime values match by both type and exact value, so the
number `1` does not authorize the string `"1"`. Rejected values are never included in
the error message.

An enum can be used directly or inside reviewed objects, arrays, dictionary values, and
`approved-owner` branches. It validates structure; it is not a place to list private
data, credentials, tokens, user-entered prose, or identifiers.

### Open structural codes

Use `validated-string` when an open set of structural codes must remain exact and an
enum would incorrectly freeze the domain. The built-in `portable-code` format accepts
case-preserving ASCII letters, digits, `_`, and `-`, starting with a letter or digit:

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "validated-string",
    "format": "portable-code",
    "maximumBytes": 64,
    "allowNull": true
  }
}
```

`maximumBytes` is required and may be 1 through 1,024. Dots, whitespace, slashes,
colons, control characters, non-ASCII text, wrong JSON types, and over-limit strings
are rejected without printing the input. This preserves codes such as `PROCNT`, `203`,
or `energy-kcal_100g`, while refusing JWT-shaped strings. Arbitrary regular expressions
are not supported.

Like enums, validated strings compose inside reviewed objects, arrays, dictionary
values, and `approved-owner` branches. Use them only for documented structural code
domains—not prose, URLs, paths, credentials, secrets, personal data, or identifiers
whose legitimate alphabet requires other characters.

### JSON dictionaries with runtime keys

Use `json-dictionary` for a reviewed object whose keys come from runtime data. This is
different from `json-object`, where every field name is known in advance. A dictionary
requires a key format, an explicit key action, one value declaration, and item, depth and
byte bounds:

```json
{
  "action": "DERIVE",
  "recipe": {
    "kind": "json-dictionary",
    "maximumItems": 100,
    "maximumDepth": 3,
    "maximumBytes": 8192,
    "keys": { "format": "positive-integer", "action": "KEEP" },
    "values": {
      "action": "DERIVE",
      "recipe": {
        "kind": "json-union",
        "maximumItems": 1,
        "variants": { "number": { "action": "KEEP" } }
      }
    }
  }
}
```

Key formats are `integer`, `positive-integer`, `uuid`, `identifier`, and bounded `text`.
Use `integer` when runtime keys may be positive, negative, or zero. It requires inclusive
safe-integer `minimum` and `maximum` bounds, accepts only canonical decimal keys, and
preserves their exact spelling:

```json
{
  "keys": {
    "format": "integer",
    "action": "KEEP",
    "minimum": -9007199254740991,
    "maximum": 9007199254740991
  }
}
```

The reviewed range decides whether zero is allowed. Leading zeroes, `-0`, a leading `+`,
fractions, exponents, unsafe integers, and unrelated text are rejected. Use
`positive-integer` for canonical decimal keys starting at 1. Text keys must declare
`maximumLength`. Every key explicitly uses either `KEEP` or `PSEUDONYMIZE`.
Identity-bearing keys should use `PSEUDONYMIZE` with the ordinary keyed pseudonym recipe:

```json
{
  "keys": {
    "format": "uuid",
    "action": "PSEUDONYMIZE",
    "recipe": { "format": "uuid", "namespace": "account-id" }
  }
}
```

When a dictionary is keyed by the same numeric identity stored in a column or nested
numeric field, use `format: "integer"` for both pseudonym recipes and reuse the exact
namespace:

```json
{
  "keys": {
    "format": "integer",
    "action": "PSEUDONYMIZE",
    "minimum": -9007199254740991,
    "maximum": 9007199254740991,
    "recipe": { "format": "integer", "namespace": "external:food-id" }
  }
}
```

Rehearsal validates the object key as canonical decimal text, converts it to its safe
integer identity, and then applies the keyed mapping. Therefore the source number `203`
and reviewed dictionary key `"203"` receive the same pseudonym. Positive, negative, and
reviewed zero identities correspond; namespace changes and privacy-key rotation still
produce separate mappings. This normalization applies only to explicitly typed
`integer` dictionary keys. It does not weaken the key syntax or range checks.

Invalid keys, duplicate transformed keys, excessive entries, unclassified surrounding
object fields, and values rejected by the declared value recipe stop preparation. A
dictionary never infers that runtime keys are safe. Its value declaration also cannot
retain an unknown JSON shape wholesale; use a bounded union when a scalar value should be
kept exactly.

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
