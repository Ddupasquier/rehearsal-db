# Contributing

Thank you for helping make database migration rehearsal safer.

For owner-managed local suite work, retrieve `dt b open --json` and follow its
shared drive-layout document and pre-runtime command launcher before starting npm,
Node or tsx. The launcher owns machine-specific temporary/cache placement; ordinary
package commands and repository-relative source, build and evidence paths are unchanged.
Do not independently migrate shared locks, leases, fixtures or recovery archives.

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

For cross-session recovery, use `dev-task context list`, then
`dev-task context show TASK_OR_ID` and reconcile that historical checkpoint with the
current branch, diff, documentation, and GitHub issue before continuing. Save a concise
new revision with `dev-task context save FILE.json` when the objective or verified state
changes. Central context is private recovery metadata—not a replacement for this
repository's documentation or issue tracker, and never operational permission.

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

The unit suite uses two workers to limit overlapping CLI imports and memory pressure.
On a slow filesystem, `npm test -- --maxWorkers=1` runs the same checks serially;
it does not relax timeouts or skip safety assertions. Keep live database scenarios serial.
Temporary test fixtures must use the worker-provided `tmpdir()` (or the shared
test-only directory helper), never create children directly in the checkout's
`test-results`. That shared-parent churn invalidates another worker's strict
ancestry checks even when the individual fixture directories differ.

The installed-consumer PTY check gives the application 10 seconds after Ctrl+C
to close HTTP and reach the subsequent owned-runtime stop phase. Database cleanup
then has a separate fixed 60-second fixture bound: PostgreSQL's existing graceful
`docker stop --time 10` uses a 45-second transport bound, followed by ownership,
volume and recovery-receipt verification. This does not change product timers.
The fixture still requires successful exit, shutdown receipts and closed HTTP;
a hung application or cleanup fails and the owned PTY is killed with a bounded
exit wait. Application readiness remains 30 seconds.

The PostgreSQL impact fixture supplements public-CLI count, lock and cancellation
checks with fixed read-only deadline probes through the **installed package's private
transport**. One statement exceeds 5 seconds; separate short statements exceed the
30-second server transaction limit. Runtime opening and the subsequent server probe
each have a separate fixed 35-second fixture bound. The probe timer starts after
opening, like its elapsed clock, and is never renewed during SQL or post-query
identity checks. This lets server expiry reach the transport and verifies the backend is gone. It does not
change or prove the public command's 30-second end-to-end budget, production aggregate
performance, or another provider/platform. Independent Test Lab coverage continues to
consume only public interfaces. These probes never execute pending migration SQL.
The transport rechecks receipt, engine and container identity before returning a
server timeout; the fixture additionally checks the pinned resources and absent
backend. It does not repeat the same transport check with an already-spent signal.
The separate queued-index race setup reports only bounded exit/signal values and
four allowlisted timeout SQLSTATEs. Raw provider output, SQL and object names stay
withheld; a setup failure is not reported as an impact-measurement result.
Its auxiliary DDL lock/statement limits match the holder's existing 8-second bound,
instead of expiring at 4 seconds while a 5-second queue observation is still valid.
For the queued-index race, a private fixture-only Docker wrapper pauses the public
command at its exact owned SQL-exec boundary before starting the auxiliary holder.
It forwards only fixed pinned metadata and that owned invocation, without reading
or recording SQL. The public 30-second total and 35-second child clocks keep running;
the existing 8-second server and 5-second lock-observation limits are unchanged.
An expired holder still fails; it never becomes successful race evidence. The
10/15-second owned-client bounds are unchanged. This fixture-only setup budget is
separate from the product's unchanged 1-second lock, 5-second statement and
30-second total limits. An earlier setup failure with no SQLSTATE remains
unclassified; a later successful WSL run does not establish its historical cause.

The existing Supabase installed-consumer scenario also measures seven current-sandbox
aggregates on two nonce-owned temporary tables, then checks a deliberate current-row
edit, RLS unknowns and stale whole-plan refusal. It preserves the original widgets,
live migration ledger, configuration, keys, immutable baseline and runtime identity.
Only its exact owned migration file and nonce-identified schema are removed; pending
migration SQL is never applied. This provider slice is not hosted, native editor or
Supabase-specific statement/cancellation-deadline evidence.

Never use real production data in an issue, test, fixture, or pull request. Use small
synthetic examples. Security findings belong in private vulnerability reporting, not a
public issue.

Changes to configuration, baseline formats, CLI behavior, JSON envelopes, verification
order, or exit codes are compatibility changes. Explain the migration path.
