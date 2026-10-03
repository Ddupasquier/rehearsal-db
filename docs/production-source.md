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
      "columns": ["id", "email"],
      "orderBy": ["id"],
      "rowScope": {
        "kind": "approved-owner",
        "column": "id",
        "valueEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_ID"
      }
    }
  ],
  "assets": []
}
```

Calculate fingerprints with the exported helpers from `@rehearsal-db/core/source-access`
or a reviewed local script. A fingerprint binds the destination without recording its
address. Changing the host, port, or database invalidates the plan.

`approved-public` means every selected row is licensed or otherwise approved for this
use. `approved-owner` requires one explicit owner value from the named environment
variable. Rehearsal never chooses an owner by finding an administrator.

`targetSchema` is optional and defaults to `public`. Set it when the restored relation
belongs elsewhere, and use the same schema in privacy policy version 2. This is relation
identity, not a request to search every schema.

For Storage, add an `assetReader` block and approved `assets` entries. The reader URL and
token come from named environment variables. Objects outside the exact bucket/prefix are
not listed or downloaded. Size, object-count, path, ETag, and exact-byte checks apply.

## 3. Use executable privacy policy version 2

Every selected column has one action and, where required, a bounded recipe:

```json
{
  "policyVersion": 2,
  "migrationCutoff": "20260101000000",
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
        }
      ]
    }
  ]
}
```

Supported recipes are intentionally small: keyed UUID/email/text/integer pseudonyms,
explicit constants, bounded date shifts, and fully classified JSON objects. Unknown
tables, columns, JSON keys, formats, and recipes stop the refresh. There is no JavaScript
or SQL escape hatch.

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

`source apply` creates new time-limited roles and export views only when every exact name
is unused. It verifies the reader cannot read raw tables, write, escalate roles, or call
an exposed security-definer network function. Externally provisioned readers are not yet
supported; use the managed reader so Rehearsal can prove its scope and retirement.

`refresh` previews the complete replacement first. After exact confirmation, its baseline
step uses one read-only repeatable-read transaction for the schema shape,
migration ledger, and rows. It streams in bounded batches, records only counts and
hashes, stages privately, rechecks schema/ledger drift, and activates atomically. It then
resets the local runtime stack and applies configured baseline retention. A failed new
runtime is rolled back to the previous baseline and runtime. The lower-level `baseline
refresh` command remains available when automation should activate a baseline without
resetting the runtime or pruning old generations.

Storage cannot share PostgreSQL's transaction snapshot. Rehearsal instead verifies each
object's inventory version and byte count during transfer, then records its SHA-256 in
the immutable baseline.

`source retire` inventories the exact recorded views before removal, then removes only
those views, the two recorded roles, and local credential/receipt files. Unrelated roles,
grants, objects, baselines, runtimes, and Docker resources are preserved.

## Limits

Rehearsal does not decide consent, licensing, retention rights, privileged-role meaning,
or which owner is yours. It does not provide an OS firewall, backup, disaster recovery,
or universal database support. Real Google account selection and provider callbacks
still require direct human observation; a synthetic redirect cannot prove them.
