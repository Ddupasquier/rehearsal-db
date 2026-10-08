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
├── types/                  reviewed public root declaration contract
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

## Adding something new

1. Put policy and reusable behavior in the domain that owns it.
2. Put target-specific implementation behind the target boundary.
3. Add its focused test under the matching `tests/unit/` domain.
4. Add an integration or contract test only when behavior crosses domains or becomes a
   public promise.
5. Update the documentation map when adding a new guide.

Run `npm run build` after changing TypeScript source. Tests import the generated package
code so the same JavaScript boundary consumers install is exercised locally.
