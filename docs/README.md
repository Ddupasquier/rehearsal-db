# Rehearsal documentation

Most migration tests start with an empty database. Production does not. Existing rows,
relationships, authentication identities, stored files, and migration history are where
risky changes break.

Rehearsal restores a reviewed, sanitized baseline into a disposable local environment,
applies only the exact migrations you approve, and runs your application's own proof.

You do not need to read this documentation from top to bottom. Choose what you want to
accomplish and follow that path.

## Start here

| Your goal                           | Best next page                        |
| ----------------------------------- | ------------------------------------- |
| Add Rehearsal to a project          | [Getting started](getting-started.md) |
| Try it in a disposable project      | [Hands-on tutorial](tutorial.md)      |
| Fix a setup or runtime problem      | [Troubleshooting](troubleshooting.md) |
| Browse the friendlier web-docs home | [Documentation home](index.md)        |

## Work safely

- [Baselines](baselines.md) — the verified starting copy
- [Sanitization](sanitization.md) — what may enter that copy
- [Production-shaped preparation](production-source.md) — the optional source boundary
- [Security model](security-model.md) — the independent safety barriers
- [Standalone workflow](standalone-workflow.md) — the complete declarative contract

## Look something up

- [CLI commands](commands.md)
- [Configuration](configuration.md)
- [Container runtime lifecycle](runtime-lifecycle.md)
- [TypeScript](typescript.md)
- [Runtime and identity policies](runtime-policies.md)
- [Database adapters](adapters.md)
- [Glossary](glossary.md)

## Follow the project

- [Roadmap](roadmap.md)
- [Stability and the first stable release](stability.md)
- [Repository architecture](architecture.md)
- [Release process](releasing.md)

To preview the styled documentation locally, run `npm run docs:preview`, then open the
address it prints.
