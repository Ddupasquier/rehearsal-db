# Configuration reference

Most users should let the guide create this file:

```bash
npx rehearsal
```

The first run uses your chosen database type and detects the project name, migration
folder, package-manager commands, and free local ports. After you approve the setup
preview, it creates a commented `rehearsal.config.mjs` with those values filled in.
Installation itself does not use a `postinstall` script or silently modify the project.

Review lines marked `CHECK`, especially the application proof command. Optional settings
are present as commented examples, and secrets never belong in this file. Rehearsal will
not overwrite an existing config.

Use this page when changing the generated file. The schema is strict: misspelled fields,
unknown fields, and unsupported versions are errors. The `.mjs` extension works in both
CommonJS and ESM projects.

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

    // Optional; configure both keys together.
    // serviceEnvironmentFile: ".env.rehearsal-service.local",
    // serviceEnvironmentVariables: ["LOCAL_IDP_CLIENT_ID", "LOCAL_IDP_SECRET"],
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },
  containerRuntime: {
    autoStartColima: true,
  },
  cleanup: {
    retainBaselineGenerations: 2,
  },
  application: {
    // CHECK: replace these when the detected package scripts are not correct.
    startCommand: "npm run dev:rehearsal",
    proofCommand: "npm run test:rehearsal",
    environmentFile: ".rehearsal/runtime.env",
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

Rehearsal never overwrites this config. To start over, move the existing file somewhere
safe, run setup again, and compare the two files before deleting either one.

## Container runtime and cleanup

```ts
containerRuntime: {
  autoStartColima: true,
},
cleanup: {
  retainBaselineGenerations: 2,
},
```

Rehearsal uses whichever Docker-compatible engine already answers `docker info`. If none
is running and `autoStartColima` is `true`, Rehearsal may run `colima start`. It respects
the user's Colima CPU, memory, and disk settings and never changes them. Set the field to
`false` when you prefer to start Docker or Colima yourself.

`retainBaselineGenerations` controls how many immutable baseline generations survive
`rehearsal cleanup`; it must be at least 1. Runtime deletion and shared-image inspection
are command choices, not automatic retention settings. See [CLI commands](commands.md).

## Supabase service environment

Some local identity providers need a client ID and secret. Configure both fields or
neither:

```ts
serviceEnvironmentFile: ".env.rehearsal-service.local",
serviceEnvironmentVariables: ["LOCAL_IDP_CLIENT_ID", "LOCAL_IDP_SECRET"],
```

The file must be ignored, owner-readable only, and contain only the exact allowlisted
names. These credentials may authorize an identity handshake, but the callback must
terminate at local Auth. They do not grant hosted database access.

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

Project-owned runtime adapters remain the place for application-specific setup and
checks; they do not replace the database driver.

## Application proof

`proofCommand` is mandatory and project-owned. It should test restored relationships,
authentication shape, critical reads, and candidate-migration behavior. A command that
only checks whether the home page returns 200 is usually too weak.

## Runtime adapters

Most projects do not need an adapter. Use one only for schema-specific restore setup,
synthetic local identities, explicit generated environment variables, or post-restore
invariants. See [adapters](adapters.md).

## Advanced library entry points

The CLI is the primary interface. Baseline builders and project-owned refresh tooling
may use these explicit subpaths:

- `@rehearsal-db/core/baseline`
- `@rehearsal-db/core/migrations`
- `@rehearsal-db/core/schema`
- `@rehearsal-db/core/diagnostics`
- `@rehearsal-db/core/process-environment`
- `@rehearsal-db/core/service-environment`

These advanced entry points are ESM JavaScript APIs in the first beta. The root
configuration and sanitization API has TypeScript declarations; the advanced subpaths do
not yet promise a typed surface.

Undocumented files under `scripts/` are package internals and are not compatibility
contracts.
