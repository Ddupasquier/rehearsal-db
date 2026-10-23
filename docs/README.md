# Rehearsal documentation

Most migration tests start with an empty database. Production does not. Existing rows,
relationships, authentication identities, stored files, and migration history are where
risky changes break.

Rehearsal restores a reviewed, sanitized baseline into a disposable local environment,
applies only the exact migrations you approve, and runs your application's own proof.

You do not need to read this documentation from top to bottom. Choose what you want to
accomplish and follow that path.

## Getting started

Install Rehearsal, rehearse a migration, understand the result and fix a failure.

| Your goal                           | Best next page                        |
| ----------------------------------- | ------------------------------------- |
| Add Rehearsal to a project          | [Getting started](getting-started.md) |
| Use the visual database workbench   | [VS Code extension](vscode.md)        |
| Try it in a disposable project      | [Hands-on tutorial](tutorial.md)      |
| Update an existing installation     | [Releases and updates](updating.md)   |
| Fix a setup or runtime problem      | [Troubleshooting](troubleshooting.md) |
| Browse the friendlier web-docs home | [Documentation home](index.md)        |

## User reference

Look up only what you need for your next decision. Start with
[supported environments](https://github.com/Ddupasquier/rehearsal-db/blob/main/COMPATIBILITY.md),
[configuration](configuration.md) or [troubleshooting](troubleshooting.md).

### Data safety

- [Baselines](baselines.md) — the verified starting copy
- [Sanitization](sanitization.md) — what may enter that copy
- [Production-shaped preparation](production-source.md) — the optional source boundary
- [Security model](security-model.md) — the independent safety barriers
- [Standalone workflow](standalone-workflow.md) — the complete declarative contract

### Commands and settings

- [CLI commands](commands.md)
- [Configuration](configuration.md)
- [Container runtime lifecycle](runtime-lifecycle.md)
- [TypeScript](typescript.md)
- [Runtime and identity policies](runtime-policies.md)
- [Database adapters](adapters.md)
- [Glossary](glossary.md)
- [Roadmap](roadmap.md)

## Maintainers

These pages explain developing and publishing Rehearsal itself, not using it in
your application. Installing or updating does not require the publisher checklist.

- [Repository architecture](architecture.md)
- [Building and testing](https://github.com/Ddupasquier/rehearsal-db/blob/main/CONTRIBUTING.md)
- [Release verification](stability.md)
- [Maintainers: publishing Rehearsal](releasing.md)

To preview the styled documentation locally, run `npm run docs:preview`, then open the
address it prints.
