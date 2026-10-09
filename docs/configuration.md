# Configuration reference

An ordinary npm application install creates this file in the application root when the
root can be identified safely:

```bash
npm install --save-dev @rehearsal-db/core
```

The install hook detects the database type, project name, migration folder,
package-manager commands, and free local ports. It also creates the dedicated local
runtime config and appends the two Rehearsal local-artifact entries to `.gitignore`.
Existing configs and existing ignore content are never rewritten.

When lifecycle scripts are disabled or the application root is not provable, run
`npx rehearsal` inside the application. The guide provides the same setup with a preview
and confirmation. Automatic root generation is tested with npm. pnpm and Yarn users
should use this guided fallback because their lifecycle and workspace layouts vary.

Review lines marked `CHECK`, especially the application proof command. Optional settings
are present as commented examples, and secrets never belong in this file. Rehearsal will
not overwrite an existing config.

Use this page when changing the generated file. The schema is strict: misspelled fields,
unknown fields, and unsupported versions are errors. The `.mjs` extension works in both
CommonJS and ESM projects.

The generated file also receives editor and compiler checking through the package's
public TypeScript declarations. See [TypeScript](typescript.md) for the supported type
surface and checked examples. Keep the runnable configuration as `.mjs`; a project does
not need to rename it to `.ts`.

```ts
// @ts-check
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
  // Configuration format. Rehearsal will explain if an upgrade is ever needed.
  schemaVersion: 1,
  // Stable local name used in Rehearsal labels and reports.
  project: { name: "example-app" },

  // Project files Rehearsal reads. Every path stays inside this repository.
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",

    // Optional local OAuth connection. Secrets stay in the ignored owner-only file.
    // Register http://127.0.0.1:58321/auth/v1/callback with the provider.
    // authentication: {
    //   enableLocalSignup: true,
    //   environmentFile: ".env.rehearsal-service.local",
    //   providers: [
    //     {
    //       name: "google",
    //       clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
    //       clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
    //       skipNonceCheck: false,
    //       emailOptional: false,
    //     },
    //   ],
    // },
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },
  // Optional, separately approved production-shaped preparation.
  // preparation: {
  //   sourcePolicy: "infrastructure/rehearsal/source-access-policy.json",
  //   privacyKey: ".rehearsal/secrets/privacy.key",
  //   batchRows: 500,
  //   maximumRows: 1000000,
  //   maximumBytes: 2147483648,
  //   diskHeadroomBytes: 67108864,
  // },
  // runtimePolicy: "infrastructure/rehearsal/runtime-policy.json",
  // Optional copied-account association. The JSON stores reviewed matcher hashes only;
  // raw emails/subjects and provider credentials stay in ignored environment files.
  // After setup, run: npx rehearsal identity connect
  // identityPolicy: "infrastructure/rehearsal/identity-policy.json",
  containerRuntime: {
    autoStartColima: false,
  },
  cleanup: {
    retainBaselineGenerations: 2,
  },
  // Optional. Each dependent database uses another complete Rehearsal config.
  // dependentTargets: [
  //   {
  //     name: "publication-api",
  //     configPath: "rehearsal.publication.config.mjs",
  //     prepareCommand: "npm run rehearsal:prepare-publication",
  //   },
  // ],
  application: {
    // CHECK: replace these when the detected package scripts are not correct.
    startCommand: "npm run dev:rehearsal",
    proofCommand: "npm run test:rehearsal",
    environmentFile: ".rehearsal/runtime.env",
    // environmentVariables: { DATABASE_URL: "primary:DATABASE_URL" },
    readiness: {
      url: "http://localhost:5175/health",
      expectedStatus: 200,
      timeoutSeconds: 30,
    },
    // Add at least one real positive and one negative before enabling.
    // httpProofs: [],
  },
  runtime: {
    target: "supabase",
    applicationUrl: "http://localhost:5175",
    projectId: "example-app-rehearsal",
    apiPort: 58321,
    databasePort: 58322,
    studioPort: 58323,
  },
  safety: {
    allowedHosts: ["127.0.0.1", "::1", "localhost"],
    blockedEnvironmentVariables: [
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
      "SUPABASE_PROJECT_ID",
    ],
    hostedAccess: "disabled",
    outboundNetwork: "deny",
  },
});
```

## Paths

All paths resolve inside the consuming project. The artifact directory must be named
`.rehearsal`; this is an intentional deletion guard. `runtimeWorkdir` must be its
`runtime` child, and the generated application environment file must remain inside it.

Rehearsal never overwrites this config. Do not move it merely to inspect a newer template.
After upgrading, run `npx rehearsal init` to print the current release's generated
template beside the path of your existing config. This comparison is read-only; adding a
new optional key remains your decision. `npx rehearsal init --write` still refuses to
replace an existing config. Rehearsal lists important optional settings that are
available but not enabled before printing the template, so they are easier to find.

If setup was interrupted after creating only some files, rerun
`npx rehearsal setup --write`. It recreates missing generated files while preserving every
existing config and local runtime file. When a config itself is invalid, keep it as a
backup, generate a fresh file, and manually carry over only reviewed settings. See
[Getting started](getting-started.md#if-setup-or-an-upgrade-is-interrupted) for the short
recovery table.

### Workspaces and custom paths

For an npm workspace, automatic creation proceeds only when exactly one application
package already declares `@rehearsal-db/core` in the manifest or lockfile visible to the
install hook. npm can save a new `--workspace` dependency after that hook runs, so a
first workspace install may safely skip creation. If several applications declare it,
Rehearsal also refuses to choose. Run `npx rehearsal` inside each intended application.
Global installs, package caches, temporary `npx` installs, and Rehearsal's own source
checkout never receive project files.

Supported existing config paths—including
`infrastructure/rehearsal/rehearsal.config.mjs`—are preserved, and a second root config
is not created. The install hook reports the exact active path when npm displays lifecycle
output, and setup always prints it. `npx rehearsal init --json` is the package-manager-
independent way to check the `destination`. Rehearsal checks the supported root filenames
first and then the supported nested filenames; finding any one of them prevents automatic
creation of another. Use
`--config=<project-relative-path>` for other explicit paths when running commands.

### Move an existing config to the project root

Relocation is deliberately manual because the config may contain reviewed settings and
JavaScript imports. Rehearsal will never move it or create a competing root file.

From the directory containing `package.json`:

1. Stop active Rehearsal commands and confirm the current path with
   `npx rehearsal init --json`.
2. Make a backup outside every supported discovery path, such as
   `.rehearsal/config-backups/rehearsal.config.mjs`.
3. Move—do not copy—the active file to `./rehearsal.config.mjs`. Use `git mv` when it is
   tracked so review history remains clear.
4. Update relative JavaScript `import` specifiers inside the moved file. Imports resolve
   from the config file's own folder, so a nested `../../something.mjs` import usually
   changes after moving to the root.
5. Leave config values such as `migrationDirectory`, `sanitizationPolicy`,
   `runtimePolicy`, `identityPolicy`, and `dependentTargets[].configPath` unchanged unless
   the referenced project file also moved. Rehearsal resolves those values from the
   project root, not from the config file's folder.
6. Run `npx rehearsal init --json`, confirm its `destination` is
   `rehearsal.config.mjs`, then run `npx rehearsal doctor` and review the Git diff.

If validation fails, restore the backup to its original path. Do not run setup while the
move is half-finished; setup may correctly conclude that no supported config exists.

`preparation.privacyKey` must stay inside `.rehearsal`; it is ignored and owner-readable
only. Source, runtime, and identity policy files are declarations that may be reviewed in
source control. They must never contain passwords, tokens, production URLs, raw owner
identifiers, SQL, or executable code.

## Optional source preparation

`preparation` enables the separate `source` and `baseline refresh` commands. It does not
change ordinary `run`, `reset`, `migrate`, or `verify` behavior.

- `sourcePolicy` declares the hashed target identity, temporary roles, exact export
  columns, public/approved-owner row scope, migration ledger, and optional Storage scope.
- `privacyKey` stores the local keyed-pseudonym secret.
- `batchRows`, `maximumRows`, and `maximumBytes` bound extraction.
- `diskHeadroomBytes` prevents activation when the copy cannot be built safely.

See [Production source](production-source.md) for complete examples and the exact
approval sequence.

`runtimePolicy` replaces common restore adapters with reviewed schemas, allowlisted
extensions, managed triggers, local-only singleton rows, and structural expectations.
`identityPolicy` declares a hashed verified-email or provider-subject matcher, copied
placeholder, safe signup defaults, required role/reference transfers, Storage path
rewrites, and token checks. Provider credentials stay in the local Supabase runtime
environment; association values stay in named environment variables and only their
SHA-256 receipts are tracked. See
[Runtime and identity policies](runtime-policies.md).

## Container runtime and cleanup

```ts
containerRuntime: {
  autoStartColima: false,
},
cleanup: {
  retainBaselineGenerations: 2,
},
```

Rehearsal uses whichever Docker-compatible engine already answers `docker info`. If none
is running and `autoStartColima` is `true`, Rehearsal may run `colima start`. This is an
explicit opt-in because starting a shared Docker engine can also restart unrelated
containers whose restart policy is `always` or `unless-stopped`. Rehearsal respects the
user's Colima CPU, memory, and disk settings and never changes them. The generated default
is `false`: start Docker or Colima yourself before a mutating command. Rehearsal never
stops a shared container engine automatically.

After each Supabase start, Rehearsal changes only the exact target's containers to
Docker's `no` restart policy. Its database and Storage volumes remain intact,
`rehearsal start` can resume it, and restarting Docker does not silently wake stopped
Rehearsal stacks.

`retainBaselineGenerations` controls how many immutable baseline generations survive an
approved `rehearsal refresh` or `rehearsal cleanup`; it must be at least 1. Refresh shows
the exact old generations before confirmation and never removes the active baseline
before its replacement is verified. Runtime deletion outside refresh and shared-image
inspection remain explicit command choices. See [CLI commands](commands.md).

## Dependent databases

Use `dependentTargets` when one local application needs another database, such as a
publication or read-model database:

```ts
dependentTargets: [
  {
    name: "publication-api",
    configPath: "rehearsal.publication.config.mjs",
    prepareCommand: "npm run rehearsal:prepare-publication",
  },
],
```

The referenced file is an ordinary complete Rehearsal config. Give it its own runtime
project ID, ports, application environment file, and artifact folder ending in
`.rehearsal`, for example `infrastructure/rehearsal/publication/.rehearsal`. Create and
review its baseline separately:

The easiest starting point is to copy the generated primary config, then change the
project name, migration folder, artifact folder, environment file, runtime project ID,
ports, and proof command. Keep the same fail-closed safety settings. Omit
`prepareCommand` when the dependent baseline is already ready to test. Rehearsal never
copies rows between databases automatically. A dependent Supabase target also needs its
own local `rehearsalConfig` file with matching dedicated ports. Preparation must be safe
to rerun because `run`, `reset`, and `migrate` each invoke it after the databases are
ready.

```bash
npx rehearsal baseline create \
  --config=rehearsal.publication.config.mjs \
  --records=path/to/publication-data.ndjson \
  --ledger=path/to/publication-ledger.json
```

The primary `doctor`, `explain`, `candidates`, lifecycle, and cleanup commands then cover
the whole stack. Rehearsal restores and migrates the primary target first, followed by
dependents in the listed order. For `run`, `reset`, and `migrate`, it next runs each
`prepareCommand`. On `run`, it executes each dependent config's
`application.proofCommand` before the primary proof. `stop` and `discard` run in reverse
order. Cleanup verifies every target's exact preview before removing any selected
resource.

Legacy preparation commands receive paths—not credentials—in environment variables:
`REHEARSAL_PRIMARY_ENV_FILE` and
`REHEARSAL_DEPENDENT_<UPPERCASE_NAME>_ENV_FILE`. New integrations should prefer an
already prepared dependent baseline or the package's declarative source/privacy
workflow. `prepareCommand` remains compatible for existing projects but is ordinary
project code and must be reviewed. Nested dependencies are rejected.

The dependent proof must include at least one known successful lookup and appropriate
negative controls, such as unauthorized, malformed, withheld, or missing records. A
response that merely avoids a server error does not prove that eligible data was
published or can be found.

## Supabase authentication

Rehearsal can configure a Google or GitHub OAuth connection in its disposable local
Supabase runtime. Declare the provider and the names of its credential variables:

```ts
authentication: {
  enableLocalSignup: true,
  environmentFile: ".env.rehearsal-service.local",
  providers: [
    {
      name: "google",
      clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
      clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
      skipNonceCheck: false,
      emailOptional: false,
    },
  ],
},
```

Create the ignored file, add the values, then restrict it to your account:

```dotenv
REHEARSAL_GOOGLE_CLIENT_ID=your-local-oauth-client-id
REHEARSAL_GOOGLE_CLIENT_SECRET=your-local-oauth-client-secret
```

```bash
chmod 600 .env.rehearsal-service.local
```

Register `http://127.0.0.1:<apiPort>/auth/v1/callback` with the provider, using the
`runtime.apiPort` value from this config. `rehearsal explain` also prints the exact URL.
Rehearsal writes that callback and `env(...)` references into the disposable runtime; it
never copies credential values into tracked configuration. Use `name: "github"` and
distinct GitHub variable names for GitHub. Duplicate providers, reused variable names,
unsupported providers, extra keys, and a template that already owns the same provider
are refused. This follows Supabase's documented
[`env()` configuration pattern](https://supabase.com/docs/guides/local-development/managing-config).

`enableLocalSignup: true` explicitly acknowledges that disposable local Auth may create
the temporary user returned by OAuth. Rehearsal changes the generated runtime copy only;
the tracked Supabase template and every hosted project remain unchanged.

The older `serviceEnvironmentFile`, `serviceEnvironmentVariables`, and
`safety.authenticationProviders` fields remain compatible for projects that manually
own their Supabase provider TOML. Do not combine those fields with the declarative
`authentication` block.

To migrate a manual Google or GitHub setup, replace those three legacy config fields
with the `authentication` block together. The tracked Supabase template may keep its
existing provider section: Rehearsal replaces a compatible legacy section only in the
generated disposable runtime copy. The section may contain `enabled`, `client_id`,
`secret`, `redirect_uri`, `skip_nonce_check`, and `email_optional`. The latter two must
match the explicit `skipNonceCheck` and `emailOptional` declarations, which default to
`false`. Keep them false unless the provider integration has a reviewed need; Supabase
warns in its [CLI configuration reference](https://supabase.com/docs/guides/local-development/cli/config#auth.external.provider.skip_nonce_check)
that skipping nonce validation reduces replay protection. Unknown settings,
duplicate sections, nested provider tables, or mismatched options fail
`rehearsal doctor` before reset. Rehearsal never edits the tracked template during this
transition.

Provider connection and copied-account association are separate. This block lets the
ordinary application sign-in reach local Auth. An optional `identityPolicy` decides
whether that verified local identity may claim a reviewed copied account.

## Safety fields

Version 1 accepts loopback runtime URLs only. `hostedAccess` can only be `disabled`, and
`outboundNetwork` can only be `deny`. Common hosted Supabase and PostgreSQL credentials
are quarantined from child processes. These fields are fail-closed configuration rules,
not a host firewall: trusted project proof commands and runtime adapters remain ordinary
local code and must be reviewed. There is no force flag to weaken the configuration
rules.

## Ports and project identity

Use unique, non-privileged ports that do not overlap. `projectId` accepts lowercase
letters, numbers, and hyphens. It labels the local Docker resources so cleanup targets
only this project.

## Database runtime

`runtime.target` selects the isolated database driver. It is optional in existing
configurations and currently defaults to `"supabase"`, so upgrading does not change an
existing project's behavior. Unknown targets are rejected before any runtime action.

For ordinary PostgreSQL, use `postgresql` instead of `supabase`:

```ts
postgresql: {
  migrationDirectory: "database/migrations",
  runtimeWorkdir: ".rehearsal/runtime",
  image: "postgres:17-alpine",
  database: "postgres",
  user: "postgres",
},
runtime: {
  target: "postgresql",
  applicationUrl: "http://localhost:5175",
  projectId: "example-app-rehearsal",
  databasePort: 58322,
},
```

The image must be an official versioned Alpine PostgreSQL image and must already exist
locally. Rehearsal runs it with `--pull=never`, publishes it only on `127.0.0.1`, and
creates a fresh random runtime password in owner-readable ignored files. It manages only
the exactly named container and volume carrying the matching project label.
Plain PostgreSQL does not restore Supabase Storage assets or synthesize Supabase Auth
users.

Declarative runtime policies are preferred for supported schema prerequisites and
checks. Existing project-owned adapters remain compatible but do not replace the
database driver.

## Application proof and hands-on sessions

`startCommand` is the ordinary application command. When `readiness` is present,
`rehearsal run` launches it with a minimal environment, waits for the exact local status,
runs proofs, and stops only that child process group. `environmentVariables` explicitly
maps generated runtime values such as `primary:DATABASE_URL`; undeclared inherited
hosted secrets are not passed through.

Your application framework may still load `.env` files from the project directory on
its own. Rehearsal cannot intercept that file loading. If a local proof could otherwise
pick up a hosted URL, token, CAPTCHA key, or similar value, set an explicit safe local
value in the configured `startCommand` or the framework's test-mode configuration.
Environment filtering is a process boundary, not an operating-system or file-access
firewall.

Supabase targets write validated loopback-only `DATABASE_URL`, `PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, and `PGPASSWORD` values into the ignored runtime environment.
Package-owned identity commands use that same local connection; an adapter is not
required to provide it.

`proofCommand` remains an ordinary project test command. Optional `httpProofs` add
package-owned checks and must include real positive and negative expectations. A 200,
404, 401, empty result, or non-5xx response is not a positive unless it matches the
declared status and body assertion.

After a successful rehearsal, `rehearsal open` uses the same `startCommand`, readiness
check, and environment mappings for a hands-on session. It starts and verifies every
configured database target but does not reset them. The app remains available until
`Ctrl+C` or `Ctrl+Z`; Rehearsal then stops only its application process group. Database
and Storage changes remain for the next `open`, `verify`, or `start` command.

`application.readiness` is required for `open`. Point it at a route that returns the
configured status only when the local app is ready. Keep the URL on a loopback host.

## Runtime adapters

Existing adapters remain compatible, but new projects should first use `runtimePolicy`,
`identityPolicy`, environment mappings, and HTTP proofs. Use an adapter only for a shape
the documented declarations explicitly reject. See [adapters](adapters.md).

## Advanced library entry points

The CLI is the primary interface. Baseline builders and project-owned refresh tooling
may use these explicit subpaths:

- `@rehearsal-db/core/baseline`
- `@rehearsal-db/core/migrations`
- `@rehearsal-db/core/schema`
- `@rehearsal-db/core/diagnostics`
- `@rehearsal-db/core/process-environment`
- `@rehearsal-db/core/privacy`
- `@rehearsal-db/core/service-environment`
- `@rehearsal-db/core/source-access`

These advanced entry points ship as ordinary ESM JavaScript with generated TypeScript
declarations. The root configuration and sanitization contract remains the explicitly
reviewed public type surface. The exact current boundary is documented in
[TypeScript](typescript.md).

Undocumented files under `scripts/` are package internals and are not compatibility
contracts.
