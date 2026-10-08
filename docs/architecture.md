# Repository architecture

Rehearsal separates shipped product code, repository automation, tests, fixtures, and
documentation so each file has one obvious home.

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
- `runtime_commands.mts` coordinates local runtimes and project proofs.
- `source_commands.mts` coordinates approved source access and refresh.
- `renderers.mts` formats human-readable results without changing state.
- `terminal.mts` owns prompts, colors, and terminal exit behavior.

Command handlers receive an explicit context containing parsed flags, selected config,
guided state, and session-local caches. They return a rendered, text, or silent result;
only the shared output boundary creates JSON envelopes or writes final human output.
Session caches never appear in the public parsed-flags type.

Repository contracts keep the process entry point at 300 lines or fewer and every
handler-family module at 350 lines or fewer. A new command belongs in the narrowest
existing family, or in a new focused family when it represents a genuinely separate
responsibility.

## Configuration pipeline

The stable `project/configuration.mts` facade keeps existing imports compatible while
configuration work moves through explicit phases:

1. `configuration_discovery.mts` selects one supported project-owned config path.
2. `configuration_schema.mts` validates the raw object shape and rejects unknown keys.
3. `configuration_normalization.mts` applies defaults and semantic safety constraints.
4. `configuration_resolution.mts` resolves owned paths from the project root and checks
   destructive-operation boundaries.

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
- `scenarios/catalog.mjs` is the sole ordered list of installed-consumer scenarios.
- Fixture files contain only the target setup and assertions unique to that scenario.

Each scenario remains independently runnable through its `test:fixture:*` script. The
complete release gate runs every catalog entry against the same immutable tarball and
writes its version, SHA-256, tool environment, commands, timings, and results under
`test-results/release-gate/`.

## Runtime lifecycle

`runtime/lifecycle_engine.mts` owns the target-neutral lifecycle contract. Both
PostgreSQL and Supabase use it to dispatch commands, verify active baseline inputs,
calculate and confirm the exact migration set, write target-bound receipts, validate
runtime markers, and roll back a failed reset or migration without hiding the original
failure.

The files in `src/targets/` remain drivers. They prove ownership before deleting local
resources and implement only the behavior that genuinely differs: Docker PostgreSQL
containers and SQL setup on one side; Supabase CLI, Auth, Storage, and generated config
on the other. An ordinary `stop` never enters rollback or discard, so later `start`
preserves the sandbox database and Storage contents.

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

Repository contracts keep the facade at 50 lines or fewer and every identity-claim
stage at 600 lines or fewer. Provider callbacks and consumer application behavior stay
outside this pipeline.

## Adding something new

1. Put policy and reusable behavior in the domain that owns it.
2. Put target-specific implementation behind the target boundary.
3. Add its focused test under the matching `tests/unit/` domain.
4. Add an integration or contract test only when behavior crosses domains or becomes a
   public promise.
5. Update the documentation map when adding a new guide.

Run `npm run build` after changing TypeScript source. Tests import the generated package
code so the same JavaScript boundary consumers install is exercised locally.
