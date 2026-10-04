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
      "matcher": {
        "type": "verified-email",
        "providers": ["google"],
        "emailEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_EMAIL",
        "approvedEmailSha256": "<sha256 of the lowercase approved email>"
      },
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

Authentication has three separate parts:

1. The local Supabase configuration enables Google, GitHub, or email sign-in and reads
   any provider credentials from the environment.
2. The application completes the ordinary sign-in and receives a normal Supabase
   session. Rehearsal does not intercept the callback.
3. The identity policy matches that verified local identity and transfers only the
   reviewed copied-account graph.

The email stays in an environment variable; only its reviewed hash is committed. Run
`rehearsal open`, complete the ordinary local sign-in, and stop the app with `Ctrl+C`.
Then preview and confirm the association:

```bash
npx rehearsal identity plan --identity=approved-owner
npx rehearsal identity claim --identity=approved-owner \
  --confirm-identity=<full-sha256>
```

Rehearsal requires exactly one verified matching local provider identity. Every
`required` reference must exist after transfer. Declare application role tables as
references; `claims` alone is not a replacement for a database-backed token hook.

### Supported identity matchers

Rehearsal currently supports the Supabase provider values `email`, `google`, and
`github`. Other provider names fail closed until their Auth representation has package
coverage. Two matcher types are supported:

- `verified-email` accepts one or more supported providers. It lowercases the email from
  the named environment variable and compares its SHA-256 receipt before querying Auth.
- `provider-subject` accepts one OAuth provider (`google` or `github`). It compares the
  reviewed SHA-256 to Supabase's stable provider ID/subject without placing the raw
  subject in the policy, baseline, command output, SQL parameters, or receipt.

Google by verified email:

```json
"matcher": {
  "type": "verified-email",
  "providers": ["google"],
  "emailEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_EMAIL",
  "approvedEmailSha256": "<sha256 of the lowercase email>"
}
```

Supabase email/password or magic-link sign-in uses the same matcher with
`"providers": ["email"]`. An account intentionally allowed to use either ordinary
email or Google can declare `"providers": ["email", "google"]`; the claim still refuses
zero or multiple matching identities.

GitHub by stable provider subject:

```json
"matcher": {
  "type": "provider-subject",
  "provider": "github",
  "subjectEnvironmentVariable": "REHEARSAL_APPROVED_OWNER_SUBJECT",
  "approvedSubjectSha256": "<sha256 of the exact GitHub subject>"
}
```

Set the raw value only in the local shell or an ignored environment file. Existing
policies using the older top-level `provider`, `emailEnvironmentVariable`, and
`approvedEmailSha256` fields remain accepted as a single-provider verified-email
matcher. New policies should use the explicit `matcher` object.

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

After a claim, sign out and sign in again (or otherwise force a full token refresh) before
judging application roles. This preserves normal RLS, account blocks, role checks, and
MFA; identity association is not an authentication bypass.

The transaction does not import production passwords, sessions, refresh tokens,
cookies, MFA secrets, or provider credentials. Local MFA and authorization rules remain
real.

A synthetic test can prove the plumbing and refusal controls. Claim that Google account
selection or callback behavior works only after directly observing that real flow.
