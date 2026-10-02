# Rehearsal

Rehearsal tests PostgreSQL and Supabase migrations on your computer before you run them
anywhere important. It restores safe test data into a disposable local database, applies
only the migrations you approve, and runs your project's own test command.

Rehearsal never connects to a hosted database. It is a migration-testing tool, not a
backup system or a production deployment tool.

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

The guide shows your progress and offers the next safe action. On first use, choose
**Set the stage**, select Supabase or PostgreSQL, review the preview, and confirm the files
it will create. Existing files are never overwritten.

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
Start with synthetic data. Rehearsal does not copy or sanitize production data for you.

## The normal workflow

1. Run `npx rehearsal`.
2. Let the guide create the local-only configuration.
3. Review the sanitization policy and create the baseline.
4. Review the exact candidate migration list.
5. Run the rehearsal and your application proof.
6. Test the local application, then verify, reset, stop, or discard the runtime.

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

| Environment                                 | Support                |
| ------------------------------------------- | ---------------------- |
| Supabase CLI projects                       | Supported              |
| Ordinary PostgreSQL in local Docker         | Supported              |
| macOS and Linux                             | Supported              |
| WSL                                         | Experimental           |
| Native Windows                              | Not yet supported      |
| Hosted database URLs                        | Intentionally rejected |
| MySQL, MongoDB, and other database families | Not yet supported      |

See [COMPATIBILITY.md](COMPATIBILITY.md) for the exact support contract.

## Documentation

Start here:

- [Getting started](docs/getting-started.md) — set up your own project
- [Safe hands-on tutorial](docs/tutorial.md) — try the full flow in a disposable project
- [Troubleshooting](docs/troubleshooting.md) — fix common setup problems

Reference:

- [CLI commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Baselines](docs/baselines.md)
- [Sanitization](docs/sanitization.md)
- [Security model](docs/security-model.md)
- [Project adapters](docs/adapters.md)
- [Production data boundary](docs/production-source.md)
- [Glossary and architecture](docs/glossary.md)
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
npm run test:fixture:postgresql
npm run test:fixture
```

The fixture commands install the packed package into clean synthetic projects. They do
not connect to hosted services. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full rules.
