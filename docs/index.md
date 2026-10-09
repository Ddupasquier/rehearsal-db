# Rehearsal documentation

## Why an empty database is not enough

Most migration tests start with an empty database. Production does not.

Existing rows, relationships, authentication identities, stored files, and migration
history are where risky changes break. A migration can build successfully and still fail
against the data and application behavior you actually have.

Rehearsal catches those problems before deployment. It restores a reviewed, sanitized
baseline into a disposable local PostgreSQL or Supabase environment, applies only the
exact migrations you approve, and runs your application's own proof.

| Empty-database tests miss…                        | Rehearsal exercises…                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| old rows and edge cases                           | a reviewed, production-shaped baseline                    |
| relationships between data, identities, and files | database, Auth, and Storage in one local sandbox          |
| whether the product still behaves correctly       | your automated proof and hands-on application walkthrough |

## Pick the path that fits today

You do not need to read everything before your first rehearsal. Start with the outcome
you want, then follow the links when a term or safety check is new.

| I want to…                            | Go here                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| Set up my own project                 | [Getting started](getting-started.md)                             |
| Try Rehearsal without touching my app | [Hands-on tutorial](tutorial.md)                                  |
| Understand what makes a copy safe     | [Baselines](baselines.md) and [Sanitization](sanitization.md)     |
| Look up a command or setting          | [CLI commands](commands.md) and [Configuration](configuration.md) |
| Add editor and compiler type checks   | [TypeScript](typescript.md)                                       |
| Fix something that did not work       | [Troubleshooting](troubleshooting.md)                             |

## The short version

Rehearsal restores an approved local baseline, applies only the migration files you
reviewed, and runs the application checks your project owns. The normal workflow stays
on your computer and does not deploy anything.

1. **Prepare** a safe baseline.
2. **Review** the exact candidate migrations.
3. **Run** them in a disposable local database.
4. **Prove** the application behavior that matters.
5. **Open** the sandbox for hands-on testing.

## Safety is part of the workflow

Rehearsal does not ask you to trust one giant switch. Baseline checksums, local-only
networking, exact confirmation digests, project-owned proofs, and narrowly owned cleanup
each protect a different boundary.

Start with synthetic data when you can. If a project needs a production-shaped copy,
read [Production-shaped preparation](production-source.md) before providing any source
access.

## Still unsure where to begin?

Run the interactive guide from the project you want to test:

```bash
npx rehearsal
```

It reads the project state, explains the next safe step, and keeps the full command
reference available when you need it.
