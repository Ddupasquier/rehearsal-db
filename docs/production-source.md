# Optional production-shaped preparation

Start with synthetic data. Use this workflow only when the source owner has approved the
exact tables, columns, owner scope, assets, and privacy policy.

Ordinary Rehearsal commands remain local-only. Source preparation is separate and cannot
be triggered by `run`, `reset`, `migrate`, `verify`, or application launch.

## 1. Add the config paths

```js
preparation: {
  sourcePolicy: "infrastructure/rehearsal/source-access-policy.json",
  privacyKey: ".rehearsal/secrets/privacy.key",
  batchRows: 500,
  maximumRows: 1000000,
  maximumBytes: 2147483648,
  diskHeadroomBytes: 67108864,
},
```

The privacy key stays ignored under `.rehearsal`. The policy is safe to review in source
control because it contains hashes and environment-variable names, not credentials,
URLs, or raw owner identifiers.

## 2. Declare the source boundary

`source-access-policy.json` uses this shape:

```json
{
  "accessVersion": 1,
  "targetFingerprint": "<sha256 of the approved PostgreSQL host, port, and database>",
  "administratorEnvironmentVariable": "REHEARSAL_SOURCE_ADMIN_URL",
  "reader": {
    "mode": "managed",
    "role": "rehearsal_example_reader",
    "ownerRole": "rehearsal_example_owner",
    "credentialFile": ".rehearsal/secrets/source-reader.env",
    "validForMinutes": 30
  },
  "exportSchema": "rehearsal_export_example",
  "migrationLedger": {
    "schema": "supabase_migrations",
    "table": "schema_migrations",
    "versionColumn": "version",
    "nameColumn": "name",
    "statementsColumn": "statements"
  },
  "relations": [
    {
      "source": { "schema": "public", "table": "widgets" },
      "view": "widgets",
      "targetSchema": "public",
      "targetTable": "widgets",
      "columns": ["id", "owner_id", "name"],
      "orderBy": ["id"],
      "rowScope": { "kind": "approved-public" }
    },
    {
      "source": { "schema": "public", "table": "profiles" },
      "view": "approved_owner_profile",
      "targetSchema": "app_api",
      "targetTable": "profiles",
      "columns": ["id", "email", "avatar_path"],
      "orderBy": ["id"],
      "rowScope": {
        "kind": "approved-owner",
        "column": "id",
        "valueEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_ID"
      }
    }
  ],
  "assetReader": {
    "endpointFingerprint": "<sha256 of the approved Storage endpoint>",
    "baseUrlEnvironmentVariable": "REHEARSAL_SOURCE_STORAGE_URL",
    "tokenEnvironmentVariable": "REHEARSAL_SOURCE_STORAGE_TOKEN",
    "maximumObjects": 1000,
    "maximumObjectBytes": 52428800,
    "maximumTotalBytes": 2147483648
  },
  "assets": [
    {
      "bucket": "avatars",
      "prefixEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_ID",
      "rights": "approved-owner",
      "pathMapping": "owner-storage"
    }
  ]
}
```

`managed` is the default for existing policies, but writing it explicitly makes the
credential boundary easier to review.

Calculate fingerprints with the exported helpers from `@rehearsal-db/core/source-access`
or a reviewed local script. A fingerprint binds the destination without recording its
address. Changing the host, port, or database invalidates the plan.

`approved-public` means every selected row is licensed or otherwise approved for this
use. `approved-owner` requires one explicit owner value from the named environment
variable. Rehearsal never chooses an owner by finding an administrator.

### Use a provider-managed reader

If a database owner already supplies the restricted export views and reader, use
`mode: "external"`. Omit `administratorEnvironmentVariable`; Rehearsal will not request
an administrator credential or change the source:

```json
{
  "reader": {
    "mode": "external",
    "role": "provided_rehearsal_reader",
    "connectionEnvironmentVariable": "REHEARSAL_SOURCE_READER_URL",
    "credentialFile": ".rehearsal/secrets/source-reader.env",
    "maximumValidForMinutes": 30
  },
  "exportSchema": "provided_rehearsal_export",
  "relations": [
    {
      "source": { "schema": "private", "table": "profiles" },
      "view": "approved_owner_profile",
      "targetSchema": "app_api",
      "targetTable": "profiles",
      "columns": ["id", "email", "avatar_path"],
      "orderBy": ["id"],
      "rowScope": {
        "kind": "approved-owner",
        "column": "id",
        "valueEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_ID"
      },
      "viewDefinitionSha256": "<sha256 from externalViewDefinitionFingerprint>"
    }
  ]
}
```

The database owner must create a `security_barrier` view owned by a role other than the
reader. Record PostgreSQL's exact canonical definition, not handwritten SQL:

```js
import { externalViewDefinitionFingerprint } from "@rehearsal-db/core/source-access";

console.log(externalViewDefinitionFingerprint(canonicalViewDefinition));
```

Obtain `canonicalViewDefinition` with
`select pg_get_viewdef('provided_rehearsal_export.approved_owner_profile'::regclass, false)`.
Rehearsal verifies that fingerprint before saving any local access receipt.
The resulting receipt also binds the normalized source-policy fingerprint. Editing the
view hash, columns, scopes, or reader declaration requires a new verification.

External mode also requires all non-system readable columns to match only the declared
views and migration-ledger columns. It refuses database, schema, relation, or column
writes; inherited roles; privileged role attributes; executable non-system
security-definer functions; a reader-owned view; or a database-enforced expiration
beyond `maximumValidForMinutes`.

`targetSchema` is optional and defaults to `public`. Set it when the restored relation
belongs elsewhere, and use the same schema in privacy policy version 2. This is relation
identity, not a request to search every schema.

For Storage, the reader URL and token come from named environment variables. A public,
non-identity prefix may use `prefix`. A private owner prefix uses
`prefixEnvironmentVariable`, `rights: "approved-owner"`, and a `pathMapping` declared in
the privacy policy below. Its raw value stays out of tracked files and the review plan
records only its SHA-256. Objects outside the exact bucket/prefix are not listed or
downloaded. Size, object-count, path, ETag, and exact-byte checks apply.

## 3. Use executable privacy policy version 2

Every selected column has one action and, where required, a bounded recipe:

```json
{
  "policyVersion": 2,
  "migrationCutoff": "20260101000000",
  "bindings": {
    "approved-owner": {
      "environmentVariable": "REHEARSAL_APPROVED_OWNER_ID",
      "approvedValueSha256": "<sha256 of the exact approved owner ID>"
    }
  },
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
      "schema": "app_api",
      "name": "profiles",
      "sourceRows": "STREAM AND SANITIZE",
      "columns": [
        {
          "name": "id",
          "action": "PSEUDONYMIZE",
          "recipe": { "format": "uuid", "namespace": "account-id" },
          "generated": "NEVER",
          "identity": "NO",
          "foreignKey": null
        },
        {
          "name": "email",
          "action": "PSEUDONYMIZE",
          "recipe": { "format": "email", "namespace": "account-email" },
          "generated": "NEVER",
          "identity": "NO",
          "foreignKey": null
        },
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

Supported recipes are intentionally small: keyed UUID/email/text/integer pseudonyms,
explicit constants, bounded or grouped date shifts, identity-aware path mappings, and
fully classified JSON objects. Unknown tables, columns, JSON keys, formats, and recipes
stop the refresh. There is no JavaScript or SQL escape hatch. See
[Sanitization policy](sanitization.md) for complete path and date examples.

## 4. Preview, apply, refresh, and retire

Keep credentials out of shell history by loading them from an owner-only environment
manager or file, then run:

```bash
npx rehearsal privacy key --write
npx rehearsal source plan
npx rehearsal source apply --confirm-source-access=<full-sha256>
npx rehearsal refresh
npx rehearsal refresh --confirm-refresh=<full-sha256>
npx rehearsal source retire
npx rehearsal source retire --confirm-source-retirement=<full-sha256>
```

In managed mode, `source apply` creates new time-limited roles and export views only when
every exact name is unused. It verifies the reader cannot read raw tables, write,
escalate roles, or call an exposed security-definer network function. In external mode,
the same command performs only the read-only checks above and stores the already supplied
credential in the ignored owner-only local file. It never creates, grants, alters, or
drops a source object.

`refresh` previews the complete replacement first. After exact confirmation, its baseline
step uses one read-only repeatable-read transaction for the schema shape,
migration ledger, and rows. It streams in bounded batches, records only counts and
hashes, stages privately, rechecks schema/ledger drift, and activates atomically. It then
resets the local runtime stack and applies configured baseline retention. A failed new
runtime is rolled back to the previous baseline and runtime. The lower-level `baseline
refresh` command remains available when automation should activate a baseline without
resetting the runtime or pruning old generations.

Rows committed after the repeatable-read transaction begins belong to the next refresh;
they cannot leak into the current snapshot midway through streaming. A schema or ledger
change during preparation stops activation. Malformed batches, network loss, interruption,
limit overruns, and low disk also leave the previous baseline active. Because `baseline
refresh` never resets the runtime, local runtime edits remain in place whether that
baseline-only preparation succeeds or fails.

Privacy `identity` metadata describes PostgreSQL `GENERATED ... AS IDENTITY`, not a
person or account identifier. UUID account keys normally use `identity: "NO"` while
remaining explicitly pseudonymized. During restore, Rehearsal consults the actual local
table for a backing sequence before resetting it; UUID columns never receive numeric
`max` or `setval` operations.

Storage cannot share PostgreSQL's transaction snapshot. Rehearsal instead verifies each
object's inventory version and byte count during transfer, then records its SHA-256 in
the immutable baseline. For an identity-aware path, the database reference and physical
destination use the same package-owned pseudonym; the source suffix is preserved.

In managed mode, `source retire` inventories the exact recorded views before removal,
then removes only those views, the two recorded roles, and local credential/receipt
files. In external mode, it removes only Rehearsal's local credential and receipt; the
provider-owned role and views remain untouched. The database-enforced expiration still
limits access, and the provider may revoke it sooner. Rehearsal does not claim that local
cleanup revoked a provider-owned credential. Unrelated roles, grants, objects, baselines,
runtimes, and Docker resources are preserved.

## Limits

Rehearsal does not decide consent, licensing, retention rights, privileged-role meaning,
or which owner is yours. It does not provide an OS firewall, backup, disaster recovery,
or universal database support. Real Google account selection and provider callbacks
still require direct human observation; a synthetic redirect cannot prove them.
