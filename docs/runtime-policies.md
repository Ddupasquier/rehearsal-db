# Runtime and identity policies

These optional JSON files replace common project-owned Rehearsal adapters. They contain
declarations only: unknown fields, SQL, JavaScript, and unsupported extensions fail.

## Runtime policy

Point `runtimePolicy` in `rehearsal.config.mjs` to a reviewed file:

```json
{
  "policyVersion": 1,
  "prerequisites": {
    "schemas": ["extensions"],
    "extensions": [{ "name": "pgcrypto", "schema": "extensions" }]
  },
  "triggers": [
    {
      "name": "profile_after_auth_insert",
      "table": { "schema": "auth", "name": "users" },
      "timing": "after",
      "events": ["insert"],
      "function": { "schema": "public", "name": "handle_new_user" }
    }
  ],
  "localRows": [
    {
      "table": { "schema": "public", "name": "runtime_settings" },
      "keyColumns": ["name"],
      "values": { "name": "scheduler_enabled", "value": false }
    },
    {
      "table": { "schema": "public", "name": "app_role_assignments" },
      "keyColumns": ["user_id"],
      "values": {
        "user_id": "11111111-1111-4111-8111-111111111111",
        "role": "owner"
      },
      "identityAssociation": {
        "identity": "approved-owner",
        "column": "user_id"
      }
    }
  ],
  "expectations": [
    {
      "table": { "schema": "public", "name": "profiles" },
      "rowLevelSecurity": true,
      "columns": [{ "name": "id", "generated": false, "identity": false }],
      "foreignKeys": [],
      "policies": []
    }
  ]
}
```

Restore order is fixed: Rehearsal creates named schemas and allowlisted extensions
before dependent schema objects, adds declared triggers after their tables and functions
exist, then inserts local-only rows after baseline data. Application schema remains in
immutable migrations or the verified schema snapshot. Verification checks extensions,
triggers, local-only rows, columns, generated/identity behavior, foreign keys, named RLS
policies, RLS state, and unvalidated constraints.

Use `identityAssociation` when a local seed is intentionally transferred by a named
identity policy. Verification accepts the configured placeholder before association and
the exact recorded local identity afterward. Rehearsal stores that mapping only in its
local internal schema; it does not duplicate the old role or weaken the row check.

## Identity policy

The identity policy links one verified local Supabase identity to a copied pseudonymous
graph without an application callback patch:

```json
{
  "identityVersion": 1,
  "identities": [
    {
      "name": "approved-owner",
      "provider": "google",
      "emailEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_EMAIL",
      "approvedEmailSha256": "<sha256 of the lowercase approved email>",
      "placeholderUserId": "11111111-1111-4111-8111-111111111111",
      "references": [
        {
          "schema": "public",
          "table": "profiles",
          "column": "user_id",
          "required": true
        },
        {
          "schema": "public",
          "table": "app_role_assignments",
          "column": "user_id",
          "required": true
        },
        {
          "schema": "public",
          "table": "food_compatibility_feedback",
          "column": "reviewed_by",
          "required": true,
          "strategy": "preserve-audit"
        }
      ],
      "jsonReferences": [
        {
          "schema": "public",
          "table": "events",
          "column": "payload",
          "path": ["actor_id"]
        }
      ],
      "signupDefaults": [
        {
          "table": { "schema": "public", "table": "profiles" },
          "identityColumn": "user_id",
          "ignoredColumns": ["created_at", "updated_at"],
          "values": {
            "display_name": {
              "kind": "pattern",
              "pattern": "^User[0-9]{14}$"
            },
            "avatar_path": null
          }
        }
      ],
      "pathReferences": [
        {
          "schema": "public",
          "table": "profiles",
          "column": "avatar_path",
          "valueType": "text"
        }
      ],
      "assets": [
        {
          "bucket": "avatars",
          "prefix": "11111111-1111-4111-8111-111111111111/",
          "rewritePath": true
        }
      ],
      "claims": { "rehearsal_owner": true },
      "tokenHook": {
        "function": {
          "schema": "public",
          "name": "custom_access_token_hook"
        },
        "expectedClaims": { "app_role": "developer" }
      }
    }
  ]
}
```

The email stays in an environment variable; only its reviewed hash is committed. Run
`rehearsal open`, complete the ordinary local Google sign-in, and stop the app with
`Ctrl+C`. Then preview and confirm the association:

```bash
npx rehearsal identity plan --identity=approved-owner
npx rehearsal identity claim --identity=approved-owner \
  --confirm-identity=<full-sha256>
```

Rehearsal requires exactly one verified matching local provider identity. Every
`required` reference must exist after transfer. Declare application role tables as
references; `claims` alone is not a replacement for a database-backed token hook.

References use `"strategy": "transfer"` by default. Use `"preserve-audit"` only for
immutable historical authorship, such as a completed review. Rehearsal leaves that row
and its synthetic Auth actor unchanged, but still transfers the active profile, roles,
and other declared data. Undeclared references still stop the claim.

`signupDefaults` resolves a copied-profile collision only when the local row's complete
non-ignored shape matches. List every remaining column. Use ignored columns only for
server-managed values such as timestamps. An edited value, extra column, ambiguous row,
or unrelated local application data rolls back the entire claim.

`rewritePath` copies approved Storage objects through the local Supabase Storage API,
verifies the destination bytes, updates the declared database paths, and then removes
the old objects. A database failure removes the new copies and leaves the originals
usable. Restored objects may begin with either the placeholder owner or no owner;
another owner is refused. `pathReferences` updates matching text or JSONB pointers. A
configured `tokenHook` must return the declared claim subset before commit. The browser must then
refresh its session or sign in again because Rehearsal cannot rewrite an issued JWT.
Run `rehearsal open` again for that fresh-session check; runtime data is preserved.

The transaction does not import production passwords, sessions, refresh tokens,
cookies, MFA secrets, or provider credentials. Local MFA and authorization rules remain
real.

A synthetic test can prove the plumbing and refusal controls. Claim that Google account
selection or callback behavior works only after directly observing that real flow.
