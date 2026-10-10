# Contributing

Thank you for helping make database migration rehearsal safer.

## Adaptive Codex workflow

Start future tasks with `dev-task "task"`, or run VS Code's global
**dev-task: adaptive Codex** user task. Global defaults and the Rehearsal profile apply
automatically; this repository needs no router installation or registration. Routing is
automatic only through those entry points. Direct Codex CLI/sidebar use and sessions
already running do not inherit per-task effort, and documentation cannot change an
active session's reasoning setting.

Authentication, permission, sanitization, and migration-source changes may be
implemented locally at high reasoning effort. Destructive database operations,
production work, deployment, commits, and pushes are restricted to read-only planning.
Use the default interactive mode when approval prompts may be needed, or `--exec` for
headless sandboxed work with escalation denied. For measurable validation, pass
`--validate '["npm","test"]'`.

For a deliberate follow-up, review the existing changes first, then continue the exact
session with `dev-task --resume SESSION_UUID --effort high "follow-up task"`. Do not
repeat partially completed tasks or create automatic retry loops.

Before opening a pull request:

1. use Node.js 24 and install with `npm ci`;
2. follow the placement rules in [Repository architecture](docs/architecture.md);
3. keep the engine generic—project table names, policies, credentials, and fixtures do
   not belong in the package;
4. preserve fail-closed behavior and add a regression test for every safety change;
5. run `npm run build` and `npm run typecheck` while developing, then `npm run check`
   before review;
6. run the relevant `test:fixture:*` scenario while developing; before a release, run
   `npm run release:verify` so every scenario installs the same exact tarball;
7. update public contracts and the changelog when behavior changes.

Never use real production data in an issue, test, fixture, or pull request. Use small
synthetic examples. Security findings belong in private vulnerability reporting, not a
public issue.

Changes to configuration, baseline formats, CLI behavior, JSON envelopes, verification
order, or exit codes are compatibility changes. Explain the migration path.
