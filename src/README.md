# Source layout

This guide owns the source folder map. The [architecture guide](../docs/architecture.md)
explains the contracts between these owners and the rest of the repository.

All production modules use `.mts`. The build emits `.mjs` files and declarations into
`dist/`; edit source, never generated output.

```text
src/
├── index.mts                 public package entry point
├── application/              application lifecycle, activity and HTTP proofs
├── baseline/                 baseline artifacts, preparation and validation
│   ├── producers/            Prisma and Drizzle baseline construction
│   └── privacy/              typed privacy policy and execution stages
├── cli/                      executable, arguments, command contract and guided entry
│   ├── commands/             command registry composition and handler families
│   ├── presentation/         terminal rendering, result envelopes and failure output
│   ├── runtime/              runtime plans, admission and serial stack execution
│   └── updates/              release checks and guided update consent
├── identity/                 copied-account connection, providers and Storage
│   └── claims/               claim policy, planning, SQL, execution and verification
├── project/                  configuration/discovery facades, setup and support
│   ├── configuration/        configuration contracts, validation and owned-path resolution
│   └── discovery/            read-only metadata, application and migration-tool detection
├── runtime/                  runtime compatibility facades and domain owners
│   ├── engines/              engine discovery, selection, ownership and VM shutdown
│   ├── lifecycle/            plans, topology, persistence, markers and runtime identity
│   ├── managed/              managed prototype and worker
│   ├── migrations/           shared history, identity, planning and failure classification
│   │   ├── impact/           impact plans, catalog predicates, aggregate queries and binding
│   │   ├── inspection/       source inspection, insights and static SQL analysis
│   │   └── native/           native migration contracts and complete toolchain fingerprints
│   │       ├── prisma/       Prisma history and execution dependencies
│   │       └── drizzle/      Drizzle history, baseline contract and toolchain
│   ├── recovery/             restore and reviewed stale-environment recovery
│   └── resources/            inventories, retirement, caches and workload coordination
├── shared/                   small target-neutral infrastructure
├── source/                   approved source access and baseline refresh
│   └── shaping/              shape policy, sampling, keys, preparation and evidence
└── targets/                  target registry and stable PostgreSQL/Supabase driver entries
    ├── native/               target-bound native migration processes
    ├── postgresql/           PostgreSQL container lifecycle, migrations, process and status
    └── supabase/             Supabase environment, processes, services, startup and status
```

Place implementation in the folder that owns its policy. Shared native migration
inventory and toolchain contracts belong in `runtime/migrations/native/`; execution
against a proven local target belongs in `targets/native/`. Baseline producers create
artifacts and do not become a second migration execution engine.

Public consumers use only `package.json#exports`. Keep the existing configuration,
discovery, identity-claim, privacy and shape facades at their parent paths. The runtime
compatibility facades and `cli/rehearsal.mts`, `targets/postgresql.mts` and
`targets/supabase.mts` entry paths also remain stable; private imports use the owning
implementation folders directly.

Unit tests mirror these implementation folders. Public facade tests stay with their
parent domain, cross-domain workflows belong in `tests/integration/`, and public
promises belong in `tests/contracts/`. Repository-only verification belongs in
`scripts/verification/`, which production modules never import.
