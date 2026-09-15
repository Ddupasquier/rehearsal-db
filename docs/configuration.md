# Configuration reference

`rehearsal.config.mjs` is executable configuration with a strict versioned schema. The
initializer uses an explicit ESM extension so the same generated file works in CommonJS
and ESM projects.
Unknown fields and unknown schema versions are errors, not warnings.

```ts
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "example-app" },
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev:rehearsal",
    proofCommand: "npm run test:rehearsal",
  },
  runtime: {
    applicationUrl: "http://localhost:5175",
    projectId: "example-app-rehearsal",
    apiPort: 58321,
    databasePort: 58322,
    studioPort: 58323,
  },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
});
```

## Paths

All paths resolve inside the consuming project. The artifact directory must be named
`.rehearsal`; this is an intentional deletion guard. `runtimeWorkdir` must be its
`runtime` child, and the generated application environment file must remain inside it.

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

Version 1 accepts loopback hosts only. `hostedAccess` can only be `disabled`, and
`outboundNetwork` can only be `deny`. Ambient hosted Supabase variables are quarantined
from child processes. There is no force flag to weaken these rules.

## Ports and project identity

Use unique, non-privileged ports that do not overlap. `projectId` accepts lowercase
letters, numbers, and hyphens. It labels the local Docker resources so cleanup targets
only this project.

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
