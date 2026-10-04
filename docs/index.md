# Rehearsal documentation

## Pick the path that fits today

You do not need to read everything before your first rehearsal. Start with the outcome
you want, then follow the links when a term or safety check is new.

| I want to…                            | Go here                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| Set up my own project                 | [Getting started](getting-started.md)                             |
| Try Rehearsal without touching my app | [Hands-on tutorial](tutorial.md)                                  |
| Understand what makes a copy safe     | [Baselines](baselines.md) and [Sanitization](sanitization.md)     |
| Look up a command or setting          | [CLI commands](commands.md) and [Configuration](configuration.md) |
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
