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
    serviceProfile: "application",

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
    stopOwnedColimaWhenIdle: false,
    diskWarningPercent: 80,
    minimumFreeBytes: 8589934592,
  },
  cleanup: {
    retainBaselineGenerations: 2,
  },
  resources: {
    staleAfterSeconds: null,
    retainedEnvironmentCount: 2,
    maximumBytes: null,
    cleanupSchedule: "manual",
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
    requiredServices: ["database"],
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
    displayName: "My local sandbox",
    protected: false,
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
The [runtime policy guide](runtime-policies.md#explicit-data-api-grants) also owns the
least-privilege Data API migration checklist and core 1.1.0's optional read-only
required/forbidden privilege declarations. Earlier releases do not accept that new
declaration. Rehearsal never infers or automatically grants API access.
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
  stopOwnedColimaWhenIdle: false,
  diskWarningPercent: 80,
  minimumFreeBytes: 8589934592,
},
lifecycle: {
  run: "stop-after-run",
  open: "stop-on-application-exit",
  openIdleTimeoutSeconds: null,
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
is `false`: start Docker or Colima yourself before a mutating command. Rehearsal preserves
the shared container engine by default.

Colima auto-start also requires its local Docker context and a provably stopped default
profile. An already-running VM with an unavailable Docker daemon is not claimed by
Rehearsal. All runtime actions refuse remote or unverified engine endpoints.

`stopOwnedColimaWhenIdle` is also `false` by default. When both settings are explicitly
enabled, Rehearsal writes an owner-only receipt only after it actually starts Colima. A
later `stop` or `discard` may stop that same Colima boot only after every selected target
has stopped and Docker reports zero running containers across the shared engine. A
missing, malformed, permissive, wrong-project, or prior-boot receipt preserves Colima.
Rehearsal rechecks for running containers immediately before shutdown and preserves a
receipt replaced by another operation. External Docker clients are not coordinated
atomically with that final check; leave engine shutdown disabled when sharing a VM
with other tools.
Docker Desktop and other Docker-compatible engines are never stopped. Containers,
images, networks, volumes, databases, and Storage are never deleted by engine shutdown.

Before a runtime starts, Rehearsal measures the Docker VM disk when the active context is
Colima. It warns at `diskWarningPercent` and refuses to start below
`minimumFreeBytes`, before creating containers. Generated Supabase configs reserve 8 GiB;
generated PostgreSQL configs reserve 2 GiB. Engines that do not expose a portable disk
measurement continue normally and report capacity as unavailable in `environments`.

Choose the smallest reviewed environment that supplies the proof's dependencies:

| Proof needs                                                      | Select                                                                                   | Retained dependencies and boundary                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL migrations, schema, triggers, or sanitized relational data   | `runtime.target: "postgresql"`                                                           | One PostgreSQL container; no native Supabase Auth, Storage, or Data API.                                                                   |
| Supabase Auth, Storage, or Data API behavior                     | `runtime.target: "supabase"` with `supabase.serviceProfile: "application"` (the default) | Keep database, Auth, Storage, PostgREST, gateway, and local mail together. Direct SQL alone does not prove these application-facing paths. |
| Studio, Realtime, Edge Functions, analytics, or image transforms | Supabase with `serviceProfile: "full"`                                                   | Remove Rehearsal's exclusions, retain the application dependencies, and explicitly enable the needed services in the reviewed TOML.        |

The application profile omits Studio, Realtime, Edge Functions, analytics, Vector, and
image transforms. These are reviewed bundles, not permission to trim individual services
with ad hoc CLI flags. Declare what the proof uses through
[`application.requiredServices`](#required-application-services); a conflicting profile
or disabled required service refuses before startup. Profile selection does not change
data retention, shared-engine ownership, or supported-platform boundaries.

Compare resource measurements only for the same exact package, fixture, engine, and
hardware. Test Lab's fresh-container startup measurement includes provisioning, health
checks, and baseline restoration on an already-running engine; record whether images
were cached. It does not measure VM boot or uncached-image downloads. Owned-container CPU/memory
samples are not host/VM memory reservations or an application-load soak test. Keep these
limits with the results rather than comparing mixed-version samples as an optimization.
Do not prune shared images or restart another project's engine to obtain a benchmark.
See [resource inspection](runtime-lifecycle.md#diagnosing-unexpected-activity).

After each Supabase start, Rehearsal changes only the exact target's containers to
Docker's `no` restart policy. Its database and Storage volumes remain intact,
`rehearsal start` can resume it, and restarting Docker does not silently wake stopped
Rehearsal stacks.

`lifecycle.run` controls what happens to database targets after `run` finishes:
The bounded default `stop-after-run` stops
the targets after proofs, proof failures, or interruption. Opt-in `discard-after-run`
automatically removes the owned disposable runtime and its data volumes instead.
`lifecycle.open` accepts `keep-until-stop`, `stop-on-application-exit` or explicit
`discard-on-application-exit`. Protected targets refuse destructive completion modes.
`stop-on-application-exit` is the bounded default for `open`; explicit `keep-until-stop`
is for an actively owned hands-on session that you finish with `stop`.
Every mode affects
only Rehearsal's configured targets; lifecycle selection does not enable engine shutdown.
The separately opted-in `stopOwnedColimaWhenIdle` policy above is the only guarded Colima
shutdown path. Ordinary stopping keeps database and Storage volumes and all sandbox
edits; it does not reset or discard them.
See [Container runtime lifecycle](runtime-lifecycle.md).

### Foreground application idle shutdown

Idle shutdown is off by default. Enable it only after your application implements
the activity route below; a health check or quiet Docker container is not activity evidence.

```js
lifecycle: {
  open: "stop-on-application-exit",
  openIdleTimeoutSeconds: 900, // 30–86400 seconds; null disables shutdown.
},
application: {
  // Keep your existing start/proof commands and environment mappings.
  readiness: { url: "http://localhost:5175/health", expectedStatus: 200 },
  activity: { url: "http://localhost:5175/rehearsal-activity" },
},
```

The application-owned route must return HTTP 200, `Content-Type: application/json`,
and only these three fields, within two seconds and 4 KiB:

```json
{ "schemaVersion": 1, "busy": false, "activitySequence": 12 }
```

`activitySequence` is a non-negative safe integer. Increase it for every meaningful
user action, API request, authentication or Storage operation, and background task.
Keep `busy: true` while work that must not be interrupted is active. Include browser
interaction that makes no network request, or conservatively report busy. Do not count
Rehearsal's readiness/activity probes themselves. The counter must not reset during
the owned application session, including hot reload. Never return private rows,
credentials, user identifiers, logs or arbitrary extra fields. The app—not a request
parameter—owns the activity facts. This example does not implement that instrumentation.

The activity URL must use the readiness route's exact HTTP(S) loopback origin and an
explicit non-privileged port, without credentials, queries or fragments. Redirects
are refused. `open` polls serially every five seconds only while its owned app session
is active. It requires at least two valid, unchanged, non-busy samples spanning the
entire timeout, measured with a monotonic clock. Busy work or a changed counter restarts
the window. Missing, malformed, failed, oversized or regressed evidence cancels the
window and keeps the sandbox running. A transport that ignores abort/cancellation
disables monitoring for that session rather than accumulating requests; review the
route and reopen explicitly.

An idle close reports `application.stoppedBy` and `application.closeReason` as
`idle-timeout`, not a signal or a successful application proof. It stops only the
owned app process group and applies the configured non-destructive target stop policy.
Database and Storage contents remain. No watcher or daemon survives the foreground
session. Apps unable to provide complete activity evidence should leave the timeout
`null` and use ordinary stop-on-application-exit instead.

`retainBaselineGenerations` controls how many immutable baseline generations survive an
approved `rehearsal refresh` or `rehearsal cleanup`; it must be at least 1. Refresh shows
the exact old generations before confirmation and never removes the active baseline
before its replacement is verified. Runtime deletion outside refresh and shared-image
inspection remain explicit command choices. See [CLI commands](commands.md).

### Resource review policies

Resource review limits apply to the configured project topology, not the shared Docker
engine. The optional workload queue instead coordinates participating local projects:

```ts
resources: {
  staleAfterSeconds: 3600,
  retainedEnvironmentCount: 2,
  maximumBytes: null,
  cleanupSchedule: "daily-preview",
  workloadQueue: { enabled: true, waitTimeoutSeconds: 30 },
},
```

- `staleAfterSeconds` is a **review cutoff**, measured from container start/stop timestamps.
  It is not application or database idle detection. `null` disables the cutoff. Rehearsal
  never stops an environment merely because this age is exceeded.
- `retainedEnvironmentCount` is an advisory limit of 1–1000 configured environments with
  retained containers or volumes. Exceeding it offers guidance; it never deletes data.
- `maximumBytes` is an optional hard startup limit for the topology's currently measured
  owned data-volume bytes. `null` disables it. A configured limit refuses startup when
  measurements are incomplete or over budget. It does not predict future database growth
  or include shared image layers; stopping a database does not reclaim its stored bytes.
- `cleanupSchedule` is `manual`, `daily-preview`, or `weekly-preview`. A due review is
  shown on the next resource inspection. There is no daemon, operating-system scheduler,
  or automatic deletion. An approved cleanup records an owner-only, project/policy-bound
  review time; ordinary read-only inspection writes nothing.
- `workloadQueue` is optional and off when omitted. With `enabled: true`, participating
  Rehearsal clients serialize their `start`, `reset`, `run` and `migrate` runtime phases
  across projects for the same local OS user, boot and process namespace. Waiting is
  bounded to `waitTimeoutSeconds` (integer 0–300; default 30); zero refuses immediately
  when busy. Ctrl+C cancels the waiting request without interrupting its holder.
  Stop, discard, inspection and cleanup remain available. `open` releases admission
  after startup, before its interactive session; application proofs run outside this
  first lifecycle-only queue. This does **not** measure available RAM, stop existing
  runtimes, limit other tools, or promise an entire Docker/VM memory budget. All projects
  that should cooperate must opt in. Older clients and different OS users/namespaces do
  not participate. Local filesystems with coherent atomic file operations are required;
  this is not a network-filesystem or distributed scheduler.
  Configure it in the source configuration for now; the existing editor field-metadata
  contract is unchanged so older supported Starter clients keep working.

### Measured capacity admission

`resources.capacityAdmission` adds an optional measured headroom check inside that
queue lease. It requires `workloadQueue.enabled: true` and explicit reviewed budgets:

```ts
capacityAdmission: {
  enabled: true,
  hostReserveBytes: 2147483648,
  engineReserveBytes: 536870912,
  maximumRunningContainers: 24,
  targetMemoryBytes: {
    postgresql: 536870912,
    supabaseApplication: 1073741824,
    supabaseFull: 3221225472,
  },
},
```

These are example budgets, not measured requirements or safe defaults for your machine.
Include startup, restore/COPY working memory and the selected workload's peak when setting
budgets. Rehearsal measures host available memory, normal macOS pressure where applicable,
engine available memory and every currently running container before admitting selected
targets. It rechecks the pinned engine before starting. Unknown, stale, incomplete or
insufficient observations refuse the new phase; stop/discard remain available. The first
probe supports an exactly identified local Colima profile with a matching guest daemon
identity. Native Docker on Linux currently refuses this opt-in check: a matching kernel
release and host free memory do not establish daemon/container cgroup headroom. Unknown
VM backends also refuse rather than treating VM capacity as free memory.

This is cooperative measured admission, not an operating-system hard memory limit.
Measurements apply when the lifecycle phase is admitted; later targets pin the same
daemon but do not continuously reserve or remeasure memory.
Unrelated programs can allocate memory after inspection and older/nonparticipating clients
do not obey the queue. No workload is killed, stopped or resized. Omission keeps existing
behavior; `enabled: false` does not accept dormant budgets.

### Verified COPY encoding reuse and baseline sizing

`rehearsal inspect sizing --json` reports the verified baseline's actual bytes/rows and
existing shape-policy bindings, required-goal status and relationship checks. Inspection
never samples rows. Use the existing reviewed shape policy to retain required troublesome
rows, foreign-key closure, privacy cohorts and representative distributions; fewer rows
alone do not prove equivalent fidelity.

The optional `resources.restoreCache` reuses the encoding of sanitized rows for PostgreSQL
COPY, not a live database or a previously migrated target:

```ts
restoreCache: {
  enabled: true,
  maximumBytes: 67108864,
  minimumFreeBytes: 1073741824,
},
```

The private cache lives inside the configured artifact directory. `maximumBytes` bounds
retained cache storage (at most 512 MiB), and `minimumFreeBytes` reserves disk headroom.
The default is off. Each use still verifies the immutable baseline and binds exact source,
privacy-policy, generation, encoder/core version and target. Payload/receipt corruption,
changed inputs, unsafe paths, unavailable space and interrupted/concurrent builders never
justify stale rows or deletion of unrelated files. The cache uses private authenticated
receipts for accidental/tampered cache bytes; it trusts the local account controlling the
baseline and package and is not a boundary against a malicious administrator. Failed reuse
regenerates through the safe full-data path or refuses invalid baseline input. Required
rows, assets, schema and migration history are unchanged.
Runtime output reports `COPY encoding cache: disabled`, `created`, `verified-hit`
or `safe-fallback` after consuming the prepared stream. This identifies the encoding
path, not successful database restoration; require the complete command to succeed
and verify the restored rows separately.

Run `rehearsal workloads` (or `--json`) without Docker to inspect this queue. Waiting
requests whose processes have died can be removed automatically because guarded work
never began. A dead **holder** remains blocking: its child may still be running.
After checking its owned commands and descendants, use the exact digest shown by
inspection with `rehearsal workloads recover --confirm-workloads=<digest>`. Recovery
removes only those reviewed dead-holder metadata records. It never kills a process,
stops a container, removes data or treats age alone as permission to steal admission.
Live owners cannot be recovered, even after a wait expires. Malformed or inaccessible
state refuses admission; it is not silently deleted.

Queue state is private to the local OS user under `~/Library/Application Support/Rehearsal`
on macOS or `~/.local/state/rehearsal` on Linux/WSL, independent of `TMPDIR`. Advanced
launchers can set `REHEARSAL_USER_STATE_DIRECTORY` to one absolute local directory;
every cooperating client must use the same value. Do not delete or move active queue
state. Boot/namespace-separated records are retained, not automatically pruned.

Temporary files and application processes created by an operation are cleaned up by
that operation's existing ownership boundary. These policies do not turn a persistent
database or Storage volume into a temporary resource.

### Named environment profiles

Profiles are reviewed selections, not new databases or scripts:

```ts
profiles: [
  { name: "Primary sandbox", targets: ["primary"] },
  {
    name: "Complete application",
    targets: ["primary", "publication-api"],
    applicationUrl: "http://localhost:5175",
  },
],
```

Every target must already be declared in this config. Names are unique, single-line text
of at most 80 characters; at most 20 profiles are allowed. The optional application URL
must be loopback-only. Selecting a profile is read-only. Review the exact target and
command before starting, resetting, or deleting anything.

### Reviewing endpoints in a multi-target project

Application, readiness and named-profile URLs cannot use a database, API or Studio
port from **any** target in the selected configuration graph. Rehearsal checks this
before runtime startup. Targets may share an application URL when its port does not
belong to a native database service; a display profile does not start a second app.

`rehearsal configuration review --proposal=proposal.json --json` validates a proposed
literal change without writing configuration or executing the proposed commands.
The proposal contains `schemaVersion: 1`, the active file's `sourceSha256`, and a
`changes` array of `{ path, value }` entries. When reviewing a dependent config with
`--config`, also include `topologyConfigPath` in the proposal, for example:

```json
{
  "schemaVersion": 1,
  "sourceSha256": "COPY_THE_DEPENDENT_FILE_FINGERPRINT_FROM_CONFIGURATION",
  "topologyConfigPath": "rehearsal.config.mjs",
  "changes": [
    {
      "path": "application.readiness.url",
      "value": "http://localhost:5175/health"
    }
  ]
}
```

The parent must be an explicit project-local regular file and must actually declare
the edited target. Rehearsal substitutes the proposed values in memory, checks them
against every declared service port, and refuses concurrently changed graph files.
It never guesses a parent from unrelated configs. Without `topologyConfigPath`,
validation covers only the selected config and the dependents that it declares.
The result names the checked target set; it is not a runtime or login test.
Configuration metadata advertises
`patchContract.dependentTargetReview: "explicit-topologyConfigPath"`. Editor clients
send the optional parent field only when that capability is present; older contract-1
packages retain their original proposal format.

### Required application services

`application.requiredServices` names the services the proof actually needs. Supported
names are `database`, `auth`, `storage`, `postgrest`, `gateway`, `mail`, `studio`,
`realtime`, `edge-functions`, `analytics`, and `image-transforms`. PostgreSQL supplies
only `database`; Supabase's `application` profile omits the last five. A conflicting
declaration fails configuration validation before any runtime starts. Use `full` when
those excluded services are under test. An omitted list remains compatible, but cannot
prove that an undeclared application dependency is safe to exclude.

For a declared Supabase service, its matching section in the reviewed local TOML must
also have exactly one `enabled = true`. `full` removes Rehearsal's exclusion list; it
does not silently enable features you disabled in the template. For example, a Realtime
proof needs both `serviceProfile: "full"` and `[realtime]` with `enabled = true`.

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

Keep these addresses distinct:

- `runtime.applicationUrl` is the browser address to open.
- `application.readiness.url` is the app's separate health route; changing the browser
  address must not erase its health path.
- The application return URL, such as `http://localhost:5175/auth/callback`, belongs
  to your application's ordinary sign-in flow.
- The provider callback is the derived API address
  `http://127.0.0.1:<apiPort>/auth/v1/callback`; it is not an editable app-return path.

When changing app host, port or return path, review your app's own redirect setting
and the dedicated Supabase template's `[auth] site_url` and `additional_redirect_urls`
together. Keep every redirect local and list only intended app-return addresses. Keep
the provider console registered to the derived API callback. Rehearsal copies the
reviewed template into the disposable runtime; editing a browser URL does **not**
silently rewrite tracked Auth settings, your dev command, or provider-console entries.
Review those explicit edits before restarting the sandbox, then test a fresh login.

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

The VS Code **Data & auth** review consumes `explain --json`'s optional
`authenticationReview`. It distinguishes enabled, disabled and unknown public settings,
shows the exact local callback, and identifies unsupported providers without guessing.
Email/password state and TOTP enrollment/verification come only from unambiguous public
boolean declarations in the tracked local Supabase template. No credential or `.env`
value is read for this review.

These are configuration facts, not a successful login or security test. Fresh sign-in,
identity conflicts and idempotence, refresh, restart persistence, role/RLS isolation,
account blocking, actual MFA enforcement and reset-invalidated sessions still need their
own observed proofs. Plain PostgreSQL has no native Supabase Auth service; its application
owns authentication.

## Safety fields

Version 1 accepts loopback runtime URLs only. `hostedAccess` can only be `disabled`, and
`outboundNetwork` can only be `deny`. Common hosted Supabase and PostgreSQL credentials
are quarantined from child processes. These fields are fail-closed configuration rules,
not a host firewall: trusted project proof commands and runtime adapters remain ordinary
local code and must be reviewed. There is no force flag to weaken the configuration
rules.

## Ports and project identity

`runtime.displayName` is a friendly single-line label of up to 100 characters. It defaults
to the project name and never changes `projectId`, Docker names, labels, or ports.
`runtime.protected` defaults to `false`. Set it to `true` to pin the sandbox against
`run`, `reset`, `migrate`, `discard`, and runtime cleanup; start/stop still preserve its data.
The VS Code Local Resources manager reviews an exact diff before changing either value.
See [Local Resources](runtime-lifecycle.md#local-resources-manager) for image and volume rules.

Use unique, non-privileged ports that do not overlap. `projectId` accepts lowercase
letters, numbers, and hyphens: 2–40 characters for Supabase, or 2–63 for PostgreSQL.
It labels the local Docker resources so cleanup targets only this exact project.
Overlong configured IDs are refused before a provider starts; Rehearsal never truncates
them or adopts resources using a shortened prefix. Review existing resources before
changing a configured ID, and use a distinct reviewed identity for a new disposable
runtime rather than assuming that a renamed config owns old containers or volumes.

For new setup only, the generated `<project-name>-rehearsal` ID stays unchanged when it
fits the selected provider. Longer new IDs use a readable prefix and a deterministic
hash suffix within that provider's limit. Setup uses the same exact ID in the generated
Rehearsal config and Supabase TOML. Existing configuration files are never rewritten.

Application and readiness URLs must use a different port from the configured database,
API, and Studio services. Editing a URL does not rewrite your framework's development
script or make it listen on that port. Update the project-owned command consistently;
Rehearsal refuses an occupied application port rather than taking over an unknown process.

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

### Native Prisma migrations — development candidate

The unreleased native-migration capability is opt-in. Existing SQL configurations
keep their current behavior. Independent installed-consumer and editor acceptance
is still pending; this section does not claim a published integration.

```ts
postgresql: {
  migrationDirectory: "prisma/migrations",
  migrationTool: {
    kind: "prisma",
    version: "7.10.1",
    packageDirectory: "node_modules/prisma",
  },
},
```

Install that exact Prisma version in the consuming project. Rehearsal does not
install it, generate Prisma Client, execute the project's Prisma configuration or
load its environment files. Execution requires Node 22.12+ in the 22 series, 24 or 26.

Keep `migration_lock.toml` with PostgreSQL provider and the original
`<14-digit-version>_<name>/migration.sql` files. Baseline creation takes explicit
local records and a successful native ledger export containing `migration_name`,
`checksum`, `finished_at` and `rolled_back_at`. Hosted preparation and Storage are
outside this candidate's scope. Baseline format 3 retains the exact native history;
formats 1 and 2 are not converted automatically.

Migration versions must be unique. Missing, divergent, incomplete, failed or
rolled-back history is refused rather than reordered or repaired. The installed
Prisma package, engine and resolved runtime dependencies must remain regular files
inside the consuming project; escaping or symlinked package layouts are unsupported.

Review binds the ordered files and installed toolchain before `migrate deploy`
targets the ownership-proven local PostgreSQL database. This checks migration
history; it does not establish that the physical schema has no drift. A native
failure, cancellation or timeout preserves the data volume and blocks automatic
resume. Inspect the retained recovery state before choosing explicit `reset`,
which replaces that disposable sandbox from its baseline. No automatic SQL rollback
or migration-history repair is promised.

## Application proof and hands-on sessions

`startCommand` is the ordinary application command. When `readiness` is present,
`rehearsal run` launches it with a minimal environment, waits for the exact local status,
runs proofs, and stops only that child process group. `environmentVariables` explicitly
maps generated runtime values such as `primary:DATABASE_URL`; undeclared inherited
hosted secrets are not passed through.

Before spawning the application, Rehearsal checks the readiness endpoint's local
TCP port. An existing listener or unknown availability refuses startup; Rehearsal
does not reuse, replace or stop that application. Choose another port or stop your
existing app explicitly. Update both the project-owned start command and the
Rehearsal URLs together. This bounded startup check sends no HTTP request or URL
query values and is not a permanent port reservation; another process can still
race startup, so readiness and child-exit checks remain necessary.

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

### Native Drizzle migrations — unqualified development candidate

Builds advertising `rehearsalContracts.drizzleMigrations: 1` add a separate,
explicit PostgreSQL candidate. The Drizzle development source is not a
published or independently qualified integration. Prisma's `nativeMigrations: 1`
and flat SQL histories keep their existing contracts.

```ts
postgresql: {
  migrationDirectory: "drizzle",
  migrationTool: {
    kind: "drizzle",
    kitVersion: "0.31.11",
    ormVersion: "0.45.4",
    driver: "pg",
    driverVersion: "8.23.1",
    packageDirectory: "node_modules/drizzle-kit",
    ormPackageDirectory: "node_modules/drizzle-orm",
    driverPackageDirectory: "node_modules/pg",
  },
},
```

Select exact installed project-local packages yourself. Rehearsal neither installs
nor downloads the SDK, evaluates `drizzle.config.*`/schema files, generates
migrations, nor runs `push`. Only Kit `migrate` with Core-generated closed CJS
configuration targets an ownership-proven loopback PostgreSQL sandbox. The fixed
ledger is `drizzle.__drizzle_migrations`; other schemas, tables, drivers, providers,
Kit/ORM versions and release candidates are unsupported. Initially, Kit-resolvable
`postgres`, `@vercel/postgres` and `@neondatabase/serverless` are refused so a failed
`pg` import cannot silently select an alternate client. Kit's directly resolved
`esbuild` must be a stable 0.25.x release at patch 4 or later and joins the full
fingerprint; the isolated qualification fixture selects 0.25.12. This is not a
conformance claim for every patch. The pinned Kit lock can also contain unused
legacy esbuild 0.18.20 through `@esbuild-kit/core-utils`/`esm-loader`; the reviewed
migrate path uses embedded tsx and the direct patched esbuild transform API, not
those legacy loaders or esbuild's HTTP serve API. This narrow boundary does not
certify other SDK commands, Studio, application servers or a clean security audit.

Baseline creation uses explicit reviewed local records plus a native JSON ledger
export with exactly `id`, `hash` and `created_at`. Every journal entry must already
be applied before baseline creation: pending entries are refused before record
streaming or artifact creation. Review the policy's native cutoff explicitly:

```json
{ "kind": "drizzle", "idx": 1, "when": 1720000001000, "tag": "a_index" }
```

Format 4 preserves the exact raw `meta/_journal.json` and SQL bytes, journal order,
entry fields and source ledger IDs. Source serial-ID gaps are valid provenance;
replay identity is the ordered SQL hash and native millisecond timestamp. SQL
filename lexical order and Prisma timestamp-file versions are not substituted.
Later candidate journals may append entries only while preserving the complete
baseline semantic prefix and SQL hashes. Journal formatting changes require fresh
candidate consent even when that prefix remains the same. No source history is
truncated, synthesized or rewritten. Generator-only snapshot metadata is bounded
and checked as regular files; it is not consumed by the selected migrate path.
History is limited to 10,000 entries, 8 MiB per file and 64 MiB total, including
journal and snapshot metadata sizes. The installed dependency closure is bounded
to 256 packages, 16,384 files and 384 MiB total; four readers share a 64 MiB
inflight buffer budget including growth sentinels.

The full resolved runtime dependency closure, including Kit's actual selected ORM
and `pg` packages, is fingerprinted before and after execution. Regular canonical
project-local paths are required; symlinked, escaping or ambiguous installations
are refused. Fingerprinting detects observed identity/content/timestamp drift; it
is not a filesystem sandbox or an atomic snapshot against a malicious local owner.
The existing 120-second native execution/verification bound, cancellation, output
redaction and retained-volume recovery apply. A failed native migration preserves
the volume and blocks automatic resume until reviewed explicit reset. Hosted
source preparation, Storage, live impact measurement, statement-failure attribution, Client generation and
automatic history repair are outside this candidate. Independent genuine Kit/ORM
and database acceptance remains required before advertising support.

### Native Knex migrations — unqualified isolated candidate

`rehearsalContracts.knexMigrations: 1` identifies the separate `2.3.0-dev.1`
source candidate, not a published or independently qualified integration. Select
exact local Knex 3.3.0 and its actually resolved pg 8.23.1 installation explicitly:

```ts
postgresql: {
  migrationDirectory: "database/migrations",
  migrationTool: {
    kind: "knex",
    version: "3.3.0",
    driver: "pg",
    driverVersion: "8.23.1",
    packageDirectory: "node_modules/knex",
    driverPackageDirectory: "node_modules/pg",
  },
},
```

Only PostgreSQL's default `public.knex_migrations` and its native lock are supported.
Keep migration modules as flat, confined ASCII `.cjs` filenames in native filename
order. Nested support files are part of the reviewed code bundle. Dotfiles,
`notes`, `node_modules`, package manifests, symlinks and escaping paths inside that
code root are refused. Inventory is limited to 10,000 migrations, 16,000 total
entries, depth 16, 8 MiB per file and 64 MiB total. The complete SDK dependency
closure uses the existing bounded native fingerprint; no persistent hash cache is
introduced. Discovery/review does not evaluate knexfile, project modules or `.env`.
There is no automatic install, dependency download, TypeScript/ESM loader, custom
migration source, custom ledger, provider, `down` or automatic unlock/repair support.

Knex's native ledger stores names, batches and times, **not historical file
checksums**. The explicit `historicalFileChecksums: "unavailable"` notice means a
baseline locks the currently reviewed migration/support bytes; it cannot prove
those were the bytes originally applied. Initial baseline creation requires the
complete source history already applied and the exact `{kind:"knex",name:"FILE.cjs"}`
cutoff. Later candidates may append names only while preserving every baseline
migration and support-file receipt. No source history is rewritten. See
[baseline format 5](baselines.md#native-knex-candidate-format).

Execution uses genuine `knex.migrate.latest()` inside a disposable Linux worker,
not host JavaScript or a SQL translator. Only copied reviewed inputs and the full
resolved SDK are mounted read-only. The fixed reviewed Node 24.21.0 image must
already exist locally; no image is pulled. Its pinned index is
`sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
The initial execution path requires macOS, Linux or WSL with supported POSIX mount paths; native Windows host execution refuses before reset. A local selected Linux Docker daemon must report and enforce the required controls:
network `none`, nonroot UID 65532, read-only root/binds, private PID/IPC/cgroup
namespaces, dropped capabilities, no-new-privileges, built-in seccomp, no Docker
socket/host mounts or ports, no daemon logs, 256 MiB memory with no extra swap,
one CPU, 32 PIDs and bounded `/tmp` tmpfs. The image and actual controls still need
genuine SDK/platform qualification; metadata alone is not that proof.

A bounded private Unix-socket relay reaches only the ownership-proven loopback
PostgreSQL target. Startup must name its exact database and dedicated restricted
role; worker-selected destinations, TLS/GSS/cancel negotiation and unknown startup
options are refused. The worker never receives the administrative password. The
role has no administrator membership, database CREATE, server-file/program,
replication or bypass-RLS privileges; only the supported application schema is
granted. Unsafe effective privileges, executable security-definer/untrusted
functions, foreign servers/wrappers or privileged extensions refuse execution.
Existing PUBLIC/application ACLs are never rewritten to make a target pass. Unknown
same-name roles are never adopted; a private cluster/database/role-OID receipt binds
reuse. Its temporary login credential is disabled and owned sessions are checked
at completion. These restrictions can make administrator-dependent migrations
unsupported; there is no privileged or host fallback.

Post-worker ledger reads, row restore and verification use separately authenticated
restricted PostgreSQL roles, not an administrative session followed by `SET ROLE`.
Only the restore role temporarily receives `SET` permission on
`session_replication_role` for cyclic-FK COPY restoration; catalog checks verify its
revocation and owned sessions are terminated afterward. This can suppress triggers
and FK enforcement inside the disposable database, so it is a specific restore
capability, not a claim that arbitrary SQL cannot change owned data. It does not
confer superuser, bypass-RLS, server-file or `ALTER SYSTEM` permission. Verification
is granted SELECT access without that capability. The generated application
connection uses a separate restricted DML role; its credential remains valid after
successful setup, while temporary worker/restore/verification logins are disabled. Core configuration
queries use a fifth ephemeral application-query role with application DML grants
but no CREATE or restore-parameter capability. Its sessions are terminated/checked
at phase exit even if SQL changes statement_timeout. Adapters receive the captured
user application environment while their Core SQL callback uses the temporary role;
that query credential is never written into the user environment. Existing live
application connections and the persistent password are preserved on query failure.
Each role has its own private project/cluster/database/OID receipt. The application
credential is additionally bound to the baseline generation and stored owner-private;
start and verify authenticate and reuse it without password rotation. Drift or failed
authentication refuses reuse while preserving an already live credential; replacement
requires reviewed reset or repair. Restricted COPY uses CONTINUE IDENTITY with
catalog-guarded setval for reviewed serial/identity columns, rather than granting
sequence ownership. Other migration producers retain their existing restart behavior. Runtime adapters
receive restricted credentials and cannot replace generated PostgreSQL connection
variables. These new boundaries remain unqualified pending genuine SQL-isolation,
restore, cancellation and recovery acceptance.

The fixed worker completion receipt describes worker cleanup only: `dataDeletionRequested:false` means no target-volume deletion was requested by cleanup. It does not promise that reviewed migration SQL leaves rows or tables unchanged.

Native transactions and lock semantics remain Knex-owned. Execution/verification
has the existing 120-second native deadline. Cancellation tears down only the owned
worker and verifies its database sessions; unknown cleanup preserves recovery
receipts. A prior project worker blocks reset from deleting its mounted evidence.
A migration failure preserves the disposable volume and blocks automatic resume
until explicit reviewed reset. Container/kernel isolation assumes a trusted local
engine/kernel; it is not a hostile-host sandbox or a hard quota on PostgreSQL data
writes. Optional capacity admission includes an additional 256 MiB worker and one
container. JavaScript receives no static SQL Insights or statement-failure attribution.
Independent real SDK, database, cancellation and adversarial isolation acceptance
remain required before support is advertised.
