# Repository architecture

Rehearsal separates shipped product code, repository automation, tests, fixtures, and
documentation so each file has one obvious home.

Machine-specific suite drive placement has one local owner document, discoverable
through `dt b open --json`. It does not change these repository boundaries or authorize
independent migration of shared temporary coordination, fixtures or recovery evidence.

```text
rehearsal-db/
├── src/                    TypeScript product source
│   ├── application/       application lifecycle and HTTP proofs
│   ├── baseline/          sanitized baseline creation and validation
│   ├── cli/               the `rehearsal` executable
│   ├── identity/          local account and Storage association
│   ├── project/           configuration, setup, and support
│   ├── runtime/           plans and disposable-runtime lifecycle
│   ├── shared/            small target-neutral utilities
│   ├── source/            approved source access and refresh
│   └── targets/           PostgreSQL and Supabase adapters
├── scripts/
│   ├── build/             clean TypeScript compilation helpers
│   ├── install/           TypeScript install-hook source
│   ├── runtime/           TypeScript runtime-launcher source
│   └── verification/      repository-only package and fixture proofs
├── dist/                   generated ESM and declaration output; never edit directly
├── types/                  compatibility entry point for generated declarations
├── tests/
│   ├── unit/              mirrors the `src/` domains
│   ├── integration/       multi-module and terminal behavior
│   ├── contracts/         public documentation and package promises
│   └── fixtures/          disposable example projects
└── docs/                  user and maintainer documentation
```

## Boundaries

- `src/` must never import from tests or repository-only verification scripts.
- `dist/` is rebuilt from TypeScript before tests and packaging; never hand-edit it.
- Database-specific lifecycle behavior belongs in `src/targets/`.
- `scripts/verification/` is never included in the npm package.
- Public consumers use only the paths declared in `package.json#exports`.
- Unit tests mirror their source domain. Cross-domain workflows belong in
  `tests/integration/`; durable public promises belong in `tests/contracts/`.
- `tests/helpers/public_cli.mjs` bounds setup-test child output and projects only
  fixed failure categories, exit/signal metadata and recognized setup refusal kinds.
  It never retains raw child errors, argv, provider text or output in failure reports.
  An unrecognized failure stays unclassified; a later green test does not establish
  the cause of a historical failure. This test helper is not shipped product code.

## Documentation audiences

Site navigation separates Getting started, User reference and Maintainers. Installation,
rehearsal, results and failure recovery belong in the first journey; configuration,
supported environments, troubleshooting and data safety belong in reference. Keep
deletion, production-access and unsupported-behavior warnings visible to users.

`docs/updating.md` answers release changes, compatibility, updating, breaking changes
and origin verification with links to deeper owners. Build, test and publishing details
belong in maintainer guidance, not installation prerequisites. `docs/releasing.md` owns
current publishing controls; historical incidents stay in release and issue history.

## CLI modules

The executable is split by responsibility so no command file becomes a second
application layer. Scripted commands and the interactive guide resolve through the same
typed registry and produce the same result contract:

- `rehearsal.mts` owns process lifecycle, project locking, guided-loop coordination, and
  top-level error handling. It does not implement commands.
- `arguments.mts` owns the command-line contract and mutation classification.
- `command_contract.mts`, `command_registry.mts`, and `command_output.mts` define command
  context, handler selection, stable JSON envelopes, human rendering, and exit codes.
- `*_command_handlers.mts` and `runtime_action_handlers.mts` group handlers by project,
  source, identity, inspection, application, or runtime responsibility.
- `cli_commands.mts` composes those focused families in precedence order without
  implementing their behavior.
- `guided.mts` owns the interactive home screen and first-run questions.
- `guided_updates.mts` owns optional update consent and reminders in that guide;
  `update_advisory.mts` bounds public release metadata, private preferences and
  installation-origin checks. Neither participates in passive JSON inspection.
- `runtime_commands.mts` coordinates local runtimes and project proofs.
- `runtime_readiness_rendering.mts` presents shared engine choices and doctor readiness.
  `engine_discovery.mts` owns bounded host/engine observations; `local_docker_context.mts`
  owns explicit selection and local endpoint binding. Support reports reuse those
  observations without exposing private context or endpoint identities.
- `runtime_stack_runner.mts` selects configured targets, binds their reviewed engine
  and configuration identities, executes the serial stack and retains receipt-bound
  cleanup. `runtime_workload_admission.mts` applies optional lifecycle admission before
  that work; application proofs and interactive sessions are deliberately outside it.
- `workload_command_handlers.mts` exposes local queue inspection and exact dead-holder
  metadata recovery without a project lock or Docker. `runtime/workload_queue.mts`
  owns cooperative lifecycle admission; its store owns bounded private atomic tickets,
  and its location helper binds the local user, boot and PID namespace independently
  of per-command temporary directories. No background scheduler is installed.
- `engine_command_handlers.mts` exposes configuration-independent engine status and
  reviewed VM shutdown. `runtime/engine_lifecycle.mts` owns the closed result,
  shared-workload review and coordination; `engine_colima_backend.mts` owns the
  qualified profile, disk, boot and process proofs. Explicit shutdown uses the
  shared `engine-stop` workload ticket instead of creating a project lock. Its
  signal scope preserves typed uncertainty after dispatch, and installed-package
  fingerprint checks still surround the mutation. Automatic owned-idle shutdown
  remains a separate receipt-bound policy.
- `runtime_planning.mts` owns read-only stack plans and exact candidate summaries.
- `editor_command_handlers.mts` exposes bounded migration and configuration review
  contracts plus digest-bound, non-destructive stale-environment stop review. It also
  keeps impact preview/measurement dispatch thin; aggregate policy stays in runtime.
- `source_commands.mts` coordinates approved source access and refresh.
- `renderers.mts` formats human-readable results without changing state.
- `terminal.mts` owns prompts, colors, and terminal exit behavior.

Command handlers receive an explicit context containing parsed flags, selected config,
guided state, and session-local caches. They return a rendered, text, or silent result;
only the shared output boundary creates JSON envelopes or writes final human output.
`runtime/migration_failure.mts` owns bounded provider-envelope SQLSTATE recognition,
fixed classification/remediation and closed safe diagnostic validation. Target drivers
never forward SQL or provider error details. The manager summary reconstructs that
fixed diagnostic across the child-process boundary; CLI JSON and private operation
history expose the same projection. Activity adds a separate `recentFailures` list,
leaving existing strict progress/recent receipt shapes unchanged for old clients.
The optional `source` projection is owned by `runtime/migration_failure_source.mts`.
For individually dispatched PostgreSQL files, it identifies the attempted execution
input by its reviewed filename, exact SHA-256 and baseline/candidate kind. The driver
hashes the bytes it loads before dispatch; changed reviewed bytes refuse execution.
Only a safe project-relative candidate path may be included, never an absolute path;
baseline inputs keep that path null. This is not attribution of the failing SQL's actual
origin: included scripts, functions and triggers can fail elsewhere. SQL line and column
remain null. Supabase batch execution currently supplies no file attribution, and
ambiguous or unavailable evidence is not inferred from candidate count or provider text.
`cli/failure_output.mts` preserves the outer category and cleanup warning when a
stack failure wraps the original migration error. It projects only a validated fixed
diagnosis from at most four original-error wrappers, never cleanup siblings or causes.
Session caches never appear in the public parsed-flags type.
Owned child output has a byte boundary. If a process floods it, Rehearsal sends TERM
and forcibly reaps only that owned process group after one second; a child ignoring
TERM cannot leave the operation hanging indefinitely.

Repository contracts keep the process entry point at 300 lines or fewer and every
handler-family module at 350 lines or fewer. A new command belongs in the narrowest
existing family, or in a new focused family when it represents a genuinely separate
responsibility.

Static Migration Insights has a separate additive contract from migration-plan v1 and
post-failure SQLSTATE diagnosis. `runtime/migration_insights_input.mts` owns bounded
regular-file reads and private exact-input text; the existing inventory, baseline-prefix
and topology owners still calculate the candidate digest. Repeated shared-directory
inputs must keep the same raw hash; findings retrieve text only by its expected hash.
`shared/held_path_ancestry.mts` retains canonical directory identities and timestamps
to refuse detected concurrent ancestry changes. This is not atomic `openat` resolution
or a filesystem sandbox; leaf checks and existing workspace trust remain necessary.
`migration_sql_lexer.mts` and
`migration_sql_scan.mts` own bounded lexical positions and fixed review hints, not SQL
validation. `migration_insights.mts` alone projects redacted public findings and explicit
coverage/unknown states. The editor consumes that contract; it must not reimplement SQL
analysis or infer runtime measurements from static warnings.

Migration impact is a separate optional contract, not a new rehearsal gate.
`runtime/migration_impact_plan.mts` recognizes only bounded simple SQL forms and retains
private relation/column specifications; it does not execute migrations or claim SQL
validity. `migration_impact_queries.mts` validates those specifications and generates
fixed, identifier-quoted aggregate queries. `migration_impact_catalog.mts` owns the
closed native index, statistics and operator-family predicates. Metadata checks refuse unsupported
table, type and operator semantics; public output contains count strings or explicit
unknowns, never those private specifications, SQL, object names or row contents.
`migration_impact.mts` binds preview and measurement reports to the whole candidate
digest, selected target, immutable baseline and exact input bytes. It rechecks the
binding after measurement and never interprets current counts as sequential migration
simulation or a production prediction.

`targets/migration_impact_runtime.mts` owns access to an already-running, verified,
ownership-proven local sandbox and its unchanged identity. It does not start/repair
an engine, reset data or apply migrations. Measurement uses one read-only repeatable
read count transaction with bounded locks, statements, output and total duration.
The environment-scrubbed client connects only through the proven owned container's
fixed local socket. PostgreSQL uses its configured local owner; Supabase uses its
built-in `supabase_admin`, not the restricted application-facing `postgres` role.
The fixed temporary-file bound and namespace-catalog lock require that local
administrator. No grants, role promotion, password access, network connection or
caller-selected SQL is added; the same read-only compiler and metadata refusals apply.
A separate read-only catalog preflight retains relation OIDs; globally ordered
`SHARE ROW EXCLUSIVE` locks precede the first repeatable-read snapshot, preventing
index/statistics DDL from outrunning its metadata checks. Counts recheck the retained
OIDs and supported semantics after locking. A concurrent name-to-view swap can
transiently lock view dependencies within the selected sandbox, but cannot make the
compiler execute that view query or return its counts. This is not atomic name/OID
resolution or a sandbox for a compromised database server. The private transport
also takes a bounded database-local namespace-catalog `SHARE` lock before relation
name resolution, preventing schema rename/swap during checks and aggregates.
This can temporarily block schema-catalog changes anywhere in that selected
disposable database; it does not change another database or acquire a cluster-wide lock.
The transport invokes the script compiler after final identity preflight so a slow check cannot
leave an earlier, larger server deadline embedded in the submitted script. The CLI
classifies `measure impact` for the existing project-operation lock and cancellation
owner despite the SQL being read-only; operation metadata/history may be written.
`inspect impact` is an offline preview. Both require one explicit configured target;
measurement additionally requires the exact whole-plan confirmation. Neither command
is a prerequisite for ordinary `run` or `migrate`, and both remain free CLI features.

## Configuration pipeline

The stable `project/configuration.mts` facade keeps existing imports compatible while
configuration work moves through explicit phases:

1. `configuration_discovery.mts` selects one supported project-owned config path.
2. `configuration_schema.mts` validates the raw object shape and rejects unknown keys.
3. `configuration_normalization.mts` applies defaults and semantic safety constraints.
4. `configuration_resolution.mts` resolves owned paths from the project root and checks
   destructive-operation boundaries.

The `project_discovery.mts` facade orchestrates the separate read-only Project Profile.
Its versioned contract, bounded metadata access, and application inference live in
focused `project_discovery_*` modules. They never import project modules and classify
output as detected, suggested, or requiring a human decision. Discovery may report
proposed configuration fields, but setup and configuration rendering remain the only
owners that can prepare writes. Editor clients consume `rehearsal discover --json`;
they do not reproduce comprehensive discovery rules.

The public contract/defaults, primitive validators, project detection, and starter
rendering have their own focused modules. `NormalizedRehearsalConfig` is inferred from
the normalizer, while the package's public declarations are emitted from the same
TypeScript implementation. Repository contracts keep the facade at 50 lines or fewer
and each configuration phase at 700 lines or fewer.

## Installed-consumer verification

Repository verification installs the package tarball into disposable projects; it must
not import unpublished product source by accident. One scenario catalog drives both the
individual fixture commands and `npm run release:verify`.

- `scenarios/artifact.mjs` selects or packs one tarball, reads its package identity, and
  records its SHA-256 before installation.
- `scenarios/workspace.mjs` creates and removes only scenario-owned scratch roots.
- `scenarios/process.mjs` starts commands with inherited credentials removed unless a
  scenario explicitly supplies a safe value.
- `scenarios/application_session.mjs` owns persistent application and terminal-session
  checks.
- `scenarios/fixture_container.mjs` owns only the standalone source fixture: a unique
  creation ID and nonce, pinned local engine, and image-created anonymous volumes.
  Cleanup refuses ownership or mount drift, verifies removal, and cannot hide the
  original failure or report success early. This is not persistent-runtime cleanup.
- `scenarios/catalog.mjs` is the sole ordered list of installed-consumer scenarios.
- Fixture files contain only the target setup and assertions unique to that scenario.

Each scenario remains independently runnable through its `test:fixture:*` script. The
complete release gate runs every catalog entry against the same immutable tarball and
writes its version, SHA-256, tool environment, commands, timings, and results under
`test-results/release-gate/`.
The existing Supabase scenario includes native syntax and populated-row constraint
failures, fixed public error/history diagnostics, reviewed corrections and independent
data/Storage preservation checks. It does not infer a rollback from a failed migration.

## Runtime lifecycle

Explicit native Prisma configuration selects `runtime/prisma_history.mts` for
bounded raw-byte history and native-ledger validation. The toolchain owner binds
the installed execution dependencies; `native_migration_contract.mts` distinguishes
portable baseline history from the current execution binding. Baseline format 3
preserves native paths and lock bytes; existing SQL formats remain unchanged.
`targets/postgresql_migrations.mts` owns SQL/native dispatch, while
`prisma_migration_process.mts` owns only private-config, bounded native execution
against the exact target proven by `prisma_target_binding.mts`. A native migration
failure preserves its data volume and requires explicit recovery; the extension
consumes the public review contract and never runs a second migration engine.

`runtime/lifecycle_engine.mts` owns the target-neutral lifecycle contract. Both
PostgreSQL and Supabase use it to dispatch commands, verify active baseline inputs,
calculate and confirm the exact migration set, write target-bound receipts, validate
runtime markers, and attempt owned failure cleanup without hiding the original error.
That cleanup can remove the disposable runtime; a failure message does not establish a
SQL transaction rollback, restoration of sandbox edits, or successful resource removal.

The files in `src/targets/` remain drivers. They prove ownership before deleting local
resources and implement only the behavior that genuinely differs: Docker PostgreSQL
containers and SQL setup on one side; Supabase CLI, Auth, Storage, and generated config
on the other. An ordinary `stop` never enters rollback or discard, so later `start`
preserves the sandbox database and Storage contents.

CLI command completion and database lifecycle are separate. A successful `run` can finish
and release its project lock while the configured keep-until-stop database remains
running. The project-owned CLI proof has its own primary `application-proof` stage;
HTTP readiness is optional and is not a prerequisite for a database-only proof. Public
operation receipts record those past stages, not fresh proof of subsequently changed
configuration, baseline or migration bytes. Editor presentation consumes that evidence
without interpreting database liveness as an active command or successful proof.

Repository contracts keep each target driver at 900 lines or fewer and the shared
lifecycle engine at 300 lines or fewer. A new database target must use this lifecycle
boundary rather than copying an existing driver's orchestration.

## Identity claim pipeline

The stable `identity/claim.mts` facade exposes policy validation, deterministic planning,
and confirmed execution while keeping those responsibilities separate:

1. `claim_contract.mts` defines the normalized policy, plan, database, and receipt types.
2. `claim_policy.mts` validates and normalizes the reviewed declaration.
3. `claim_plan.mts` binds the local matcher value to an immutable redacted review and
   digest without opening a database or Storage connection.
4. `claim_sql.mts` generates identifier-safe relational, JSON, signup-default, and path
   SQL without executing it.
5. `claim_identity_lookup.mts` performs read-only local Auth and reference discovery.
6. `claim_verification.mts` checks signup defaults and token-hook claim shapes.
7. `claim_executor.mts` alone owns the database transaction, Storage staging, rollback,
   commit, old-object cleanup, and final receipt.
8. `connect.mts` performs read-only, provider-neutral sign-in discovery and produces the
   redacted preview used by the interactive copied-account connection.

Repository contracts keep the facade at 50 lines or fewer and every identity-claim
stage at 600 lines or fewer. Provider callbacks and consumer application behavior stay
outside this pipeline.

## Privacy rule pipeline

The stable `baseline/privacy_engine.mts` facade preserves the documented privacy import
path while policy work is divided into fail-closed typed stages:

1. `privacy_contract.mts` defines normalized policy and execution types.
2. `privacy_recipe_validation.mts` normalizes only reviewed rule shapes;
   `privacy_policy.mts` validates complete policy structure.
3. `privacy_dependency_graph.mts` checks owner bindings, path mappings, sanitized digest
   inputs, cycles, and shared date groups.
4. `privacy_transforms.mts` implements deterministic pseudonyms and bounded paths.
5. `privacy_rule_registry.mts` explicitly registers every action and derivation kind;
   unknown kinds have no fallback execution path.
6. `privacy_structured_json.mts` owns bounded object, array, union, and dictionary rules.
7. `privacy_pipeline.mts` resolves reviewed bindings and executes rows, while
   `privacy_key.mts` owns the local secret-file boundary.

Repository contracts keep the facade at 50 lines or fewer and every privacy stage at
700 lines or fewer. Adding a rule requires its normalized type, validator, registered
handler, focused boundary tests, and documentation—without widening policy version 2.

## Adding something new

1. Put policy and reusable behavior in the domain that owns it.
2. Put target-specific implementation behind the target boundary.
3. Add its focused test under the matching `tests/unit/` domain.
4. Add an integration or contract test only when behavior crosses domains or becomes a
   public promise.
5. Update the documentation map when adding a new guide.

Run `npm run build` after changing TypeScript source. Tests import the generated package
code so the same JavaScript boundary consumers install is exercised locally.
