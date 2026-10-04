# Rehearsal

[![Monthly npm downloads](https://img.shields.io/npm/dm/%40rehearsal-db%2Fcore?style=flat-square&logo=npm&logoColor=white&label=npm%20downloads&labelColor=1c2a34&color=287b5c)](https://www.npmjs.com/package/@rehearsal-db/core)

[Read the documentation](https://ddupasquier.github.io/rehearsal-db/) · [View on npm](https://www.npmjs.com/package/@rehearsal-db/core) · [Report a problem](https://github.com/Ddupasquier/rehearsal-db/issues)

Rehearsal tests PostgreSQL and Supabase migrations on your computer before you run them
anywhere important. It restores safe test data into a disposable local database, applies
only the migrations you approve, and runs your project's own test command.

Projects with a separate publication or read-model database can declare it as a
dependent target. Rehearsal then manages the complete isolated runtime stack.

Normal rehearsal commands never connect to a hosted database. An optional, separately
approved preparation workflow can create a short-lived read-only export surface, stream
it through a reviewed privacy policy, and retire the access again. It is never part of
`run`, `reset`, `migrate`, or application launch. Rehearsal is not a backup system or a
production deployment tool.

> Rehearsal is in public beta. Use it on a branch and keep a working backup of your
> project.

## What you need

- Node.js 24 and npm
- Docker Desktop, Colima, or another Docker-compatible engine
- timestamped `.sql` migration files
- a project test command that can prove the migrated application works
- Supabase CLI 2.117.0 for a Supabase project, or the local
  `postgres:17-alpine` image for a PostgreSQL project

No database experience is required to follow the guide, but you should understand what
your migration is intended to change.

## Quick start

From your project directory:

```bash
npm install --save-dev @rehearsal-db/core@beta
npx rehearsal
```

For an ordinary npm application install, Rehearsal safely creates a commented
`rehearsal.config.mjs` in the project root, adds only its local-artifact entries to
`.gitignore`, and prepares the isolated local runtime configuration. It detects the
project name, database target, migration paths, commands, and free ports. Review lines
marked `CHECK`, then open the guide. Existing files are never overwritten.

If install scripts are disabled or the workspace root is ambiguous, installation makes
no guess. Run `npx rehearsal` inside the application and choose **Set the stage** for the
same previewed setup.

For PostgreSQL, download the reviewed local image once before running the guide:

```bash
docker pull postgres:17-alpine
```

Rehearsal itself never downloads a database image during a rehearsal.

## Three terms you will see

- **Baseline:** a locked, safe starting copy of your schema and test data.
- **Candidate migration:** a new migration that is not part of the baseline yet.
- **Runtime:** the disposable local database where the rehearsal happens.

The baseline may contain synthetic data or properly sanitized production-shaped data.
Start with synthetic data. Real source preparation is opt-in and requires separate
source-owner approval; see [Standalone workflow](docs/standalone-workflow.md).

## The normal workflow

1. Run `npx rehearsal`.
2. Review the generated local-only configuration, or let the guide create it when the
   install hook safely skipped it.
3. Review the sanitization policy and create the baseline.
4. Review the exact candidate migration list.
5. Run the rehearsal and your application proof.
6. Choose **Open the sandbox app** for hands-on testing, then verify, reset, stop, or
   discard the runtime.

`npx rehearsal open` starts and verifies the existing local runtime, keeps the configured
app available until you press `Ctrl+C`, and preserves database and Storage changes for
the next session.

For an approved production-shaped copy, the optional sequence is `source plan`, `source
apply`, `refresh`, and `source retire`. `refresh` verifies the replacement before it
resets the local runtime or removes an old copy. Every source-side or identity change has
its own exact confirmation digest.

When local disk space gets tight, choose **Clean up disk space** in the guide. Rehearsal
previews old baseline generations first and keeps runtime or shared-image removal
explicit.

Press `Ctrl+Z` at any guided prompt to exit the whole session. Choose **Get help**, or run
`npx rehearsal support`, to create a privacy-safe diagnostic report.

## What Rehearsal protects

- The database listens only on your computer.
- Hosted database credentials are removed from child processes.
- The approved baseline and migration history are checksum-verified.
- A changed migration produces a new approval digest.
- Failed migrations cannot leave a runtime marked as trusted.
- Runtime cleanup targets only resources carrying the exact Rehearsal labels.

Rehearsal does not prove that a migration is correct for every user workflow. Your
project's proof command should test the behavior that matters, not only whether a page
loads.

## Supported today

| Environment                                      | Support                |
| ------------------------------------------------ | ---------------------- |
| Supabase CLI projects                            | Supported              |
| Ordinary PostgreSQL in local Docker              | Supported              |
| macOS and Linux                                  | Supported              |
| WSL                                              | Experimental           |
| Native Windows                                   | Not yet supported      |
| Hosted database URLs                             | Intentionally rejected |
| Optional read-only PostgreSQL source preparation | Explicit opt-in beta   |
| MySQL, MongoDB, and other database families      | Not yet supported      |

See [COMPATIBILITY.md](COMPATIBILITY.md) for the exact support contract.

## Documentation

Start here:

- [Documentation home](docs/index.md) — choose the shortest path for your goal
- [Getting started](docs/getting-started.md) — set up your own project
- [Safe hands-on tutorial](docs/tutorial.md) — try the full flow in a disposable project
- [Troubleshooting](docs/troubleshooting.md) — fix common setup problems
- [Next steps](docs/roadmap.md) — see the current product sequence

Reference:

- [CLI commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Baselines](docs/baselines.md)
- [Sanitization](docs/sanitization.md)
- [Security model](docs/security-model.md)
- [Project adapters](docs/adapters.md)
- [Production data boundary](docs/production-source.md)
- [Standalone workflow and security gates](docs/standalone-workflow.md)
- [Runtime and local identity policies](docs/runtime-policies.md)
- [Glossary](docs/glossary.md)
- [Repository architecture](docs/architecture.md)
- [Release process](docs/releasing.md)

## Getting support

Run:

```bash
npx rehearsal support
```

Review the result, then include it in a
[GitHub issue](https://github.com/Ddupasquier/rehearsal-db/issues). Never share database
rows, credentials, connection strings, private migrations, or baseline files. Security
problems belong in the private process described in [SECURITY.md](SECURITY.md).

## For contributors

Use Node.js 24, run `npm ci`, then run:

```bash
npm run check
npm run test:fixture:standalone
npm run test:fixture:postgresql
npm run test:fixture
```

The fixture commands install the packed package into clean synthetic projects. They do
not connect to hosted services. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full rules.

Preview the styled documentation site locally with:

```bash
npm run docs:preview
```
