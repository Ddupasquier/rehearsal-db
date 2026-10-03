# Repository architecture

Rehearsal separates shipped product code, repository automation, tests, fixtures, and
documentation so each file has one obvious home.

```text
rehearsal-db/
├── src/                    shipped package code
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
│   ├── runtime/           shipped internal runtime launcher
│   └── verification/      repository-only package and fixture proofs
├── tests/
│   ├── unit/              mirrors the `src/` domains
│   ├── integration/       multi-module and terminal behavior
│   ├── contracts/         public documentation and package promises
│   └── fixtures/          disposable example projects
└── docs/                  user and maintainer documentation
```

## Boundaries

- `src/` must never import from tests or repository-only verification scripts.
- Database-specific lifecycle behavior belongs in `src/targets/`.
- `scripts/verification/` is never included in the npm package.
- Public consumers use only the paths declared in `package.json#exports`.
- Unit tests mirror their source domain. Cross-domain workflows belong in
  `tests/integration/`; durable public promises belong in `tests/contracts/`.

## CLI modules

The executable is split by responsibility so no command file becomes a second
application layer:

- `rehearsal.mjs` starts the process and dispatches commands.
- `arguments.mjs` owns the command-line contract and mutation classification.
- `guided.mjs` owns the interactive home screen and first-run questions.
- `runtime_commands.mjs` coordinates local runtimes and project proofs.
- `source_commands.mjs` coordinates approved source access and refresh.
- `renderers.mjs` formats human-readable results without changing state.
- `terminal.mjs` owns prompts, colors, and terminal exit behavior.

## Adding something new

1. Put policy and reusable behavior in the domain that owns it.
2. Put target-specific implementation behind the target boundary.
3. Add its focused test under the matching `tests/unit/` domain.
4. Add an integration or contract test only when behavior crosses domains or becomes a
   public promise.
5. Update the documentation map when adding a new guide.
