# CLI commands

Run project commands from the directory containing `rehearsal.config.mjs`. Engine and
workload inspection/review commands need no project configuration. The examples
use `npx`, so a global install is not required.

## Participating local workloads

Core 1.3.0 and later builds advertising `rehearsalContracts.workloadQueue: 1` support
`npx --no-install rehearsal workloads --json`. This read-only command needs no
project configuration or Docker. Its version-1 `data` lists lifecycle ticket IDs,
commands, PIDs, phases (`choosing`, `queued`, `held`), owner liveness and creation
times. It reports `capacity: "not-measured"`: this is cooperative admission, not
a claim about spare host/VM memory. Project paths, migration SQL and credentials
are not included. Enable participation with
[`resources.workloadQueue`](configuration.md#resource-review-policies).

A dead holder blocks new admission until explicitly reviewed. Confirm its owned
commands and descendants have ended before running
`npx --no-install rehearsal workloads recover --confirm-workloads=<recoveryDigest>`.
The exact inspection digest binds only the dead held records; changed records,
missing confirmation and live owners refuse recovery. This operation clears local
queue metadata only. It does not stop processes/containers or alter databases.
Waiting requests can be cancelled; expiry never steals a live holder. Read-only
inspection does not clean stale records or create state directories.
Explicit VM shutdown participates as `engine-stop` in this same queue. Older
clients that do not recognize this ticket refuse admission; they must not remove it.

## Engine status and reviewed VM shutdown

Builds advertising `rehearsalContracts.containerEngineLifecycle: 1` provide:

```bash
npx --no-install rehearsal engine status --json
npx --no-install rehearsal engine stop --json
npx --no-install rehearsal engine stop --confirm-engine-stop=<consentDigest> --json
```

The first command observes the selected local Docker engine and the default
Colima profile separately. The second previews whole-VM impact without stopping
anything; `--write` alone does not apply it, and `--dry-run` always remains a
preview even with confirmation. `--target` is refused because it cannot limit a
whole-VM shutdown to one project target. Only the exact confirmation applies
a fresh, unchanged review. These commands do not load project configuration or
create a project operation lock. See the [VM shutdown policy](runtime-lifecycle.md#shut-down-the-vm-explicitly)
for qualified backends, shared-workload checks and preservation boundaries.

Version-1 status `data` contains `selected` (nullable context, endpoint identity,
daemon ID and `running`, `unavailable`, `unknown` or `unsupported-host` state),
`colimaDefault` (profile `default`, independent state, `shutdownSupported` and
fixed `reason`), and `safety`. A failed daemon probe does not prove a VM stopped.
Colima can remove its Docker context when it stops; a subsequent default Docker
selection is not inferred to be Colima.

Preview `data` contains `schemaVersion: 1`, `action: "engine-stop"`, `state`
(`review-required`, `already-stopped`, `unsupported` or `blocked`), fixed `reason`,
nullable `consentDigest`, nullable `engine` identity, nullable `impact` and
`safety`. Available impact lists exact container IDs, names, states, restart
counts and start/finish times, plus the running count. Unknown impact is `null`,
not zero. Read-only observations and previews return envelope `success` and
exit `0`; that means inspection completed, not that a VM was stopped.

Apply returns structured `data` even for an unsuccessful outcome: schema version
`1`, `status` (`stopped`, `already-stopped`, `refused`, `failed`, `cancelled` or
`unknown`), fixed `reason`, nullable reviewed `engine`, `confirmed` flags
`profileStopped` and `vmProcessAbsent`, nullable `selectionAfter`, and `safety`.
Only a stopped outcome with both confirmation flags true returns envelope
`success` and exit `0`. An already-stopped profile without a previous captured
process binding returns `not_ready` and exit `1`; it does not fabricate a process
exit or memory-release result. Other unconfirmed outcomes return `error` and
exit `1`; cancellation before dispatch returns exit `130`.

The closed reason codes are `ready`, `profile-stopped`, `unsupported-host`,
`selection-unverified`, `daemon-unavailable`, `backend-unqualified`,
`profile-unavailable`, `ownership-unverified`, `coordination-active`,
`coordination-unavailable`, `review-changed`, `confirmation-required`,
`cancelled-before-dispatch`, `cancelled-after-dispatch`, `shutdown-unconfirmed`,
`shutdown-command-failed`, and `shutdown-confirmed`.

The safety fields are `globalContextSwitchRequested: false`,
`dataDeletionRequested: false`, `forceRequested: false`, and
`enginesStarted: false`. They describe requested actions, not a promise that the
backend leaves Docker's selected context unchanged. No raw endpoints, home paths,
SQL, credentials or process arguments are returned. Cancellation after dispatch
can leave shutdown in progress: an `unknown` outcome needs fresh inspection,
not an automatic retry. Exit `0` alone is never a memory-release measurement.

## Completed container retirement

Builds advertising `rehearsalContracts.containerRetirement: 1` provide container-only
retirement through `cleanup containers` and the public
`@rehearsal-db/core/resource-lifecycle` export. PostgreSQL `stop` uses it automatically,
with a private receipt that lets `start` reconstruct the container around its retained
volume. Use ordinary `stop` for a resumable configured PostgreSQL runtime.

For separately owned completed container helpers, supply a versioned claims file:

```json
{
  "schemaVersion": 1,
  "claims": [
    {
      "fullId": "<exact full 64-character container ID>",
      "expectedLabels": { "com.docker.compose.project": "my-completed-test" },
      "completedDisposable": true
    }
  ]
}
```

```bash
npx --no-install rehearsal cleanup containers --proposal=completed-containers.json --json
npx --no-install rehearsal cleanup containers --proposal=completed-containers.json \
  --write --confirm-cleanup=<consentDigest-from-preview> --json
```

Declare completion only after checking the owning session and preserving any required
container writable-layer files and diagnostics. A stopped container is not proof of
completion. The generic API preserves Docker volumes and bind-mounted files; its caller
owns the application's reconstruction procedure. It does not create a PostgreSQL resume
receipt for an arbitrary manually adopted container. Existing private runtime markers,
credentials and recovery receipts must remain available.

The preview pins exact IDs, labels, mounted volume identities and local daemon. Apply
rechecks them and uses non-forced container removal without deleting volumes. Inspect
each outcome on failure; unknown preservation is never reported as success. This does
not remove shared images, retained databases or foreign workloads. See the
[owning lifecycle policy](runtime-lifecycle.md#completed-container-retirement).

## Verified baseline sizing

Builds advertising `rehearsalContracts.baselineSizing: 1` provide
`npx --no-install rehearsal inspect sizing --json`. This verifies the active
immutable baseline and reports its complete sanitized row count, byte sizes and
available representative-shape evidence. It starts no engine and writes no files.
Missing source counts or shape evidence remain unknown; a small baseline is not
proof of production fidelity or runtime performance. See
[baseline sizing and COPY reuse](configuration.md#verified-copy-encoding-reuse-and-baseline-sizing).

## Synthetic managed-protocol prototype

Development builds advertising `rehearsalContracts.managedPrototype: 1` expose a
local protocol prototype. It accepts only its fixed generated 100-row synthetic
input. It is not a hosted service, a customer-data upload path, a network sandbox
or proof of tenant isolation, hard memory limits or service cost.

```bash
npx --no-install rehearsal managed example --json > synthetic-request.json
npx --no-install rehearsal managed plan --proposal=synthetic-request.json --json
npx --no-install rehearsal managed prototype --proposal=synthetic-request.json \
  --confirm-managed=<consentSha256-from-plan> --json
```

The exact confirmation binds the input, tenant, expiry and quotas. Changed or
expired requests require a fresh plan. The worker has bounded runtime and output;
cancellation stops the owned worker and attempts cleanup. A cleanup failure is
reported as quarantined, never successful cleanup. Its returned recovery request
and confirmation may be reviewed and supplied to `managed recover --proposal=... \
--confirm-managed=... --json`. Recovery refuses changed ownership, a live worker,
foreign files or a mismatched receipt; it never recursively removes unknown data.
An overdue recovery deadline is reported for review, not automatically deleted.
Keep retained paths and recovery receipts until cleanup is confirmed.

## Guided mode

For editor-style review, `npx rehearsal inspect plan --json` returns a bounded,
versioned migration history with required predecessor links, statuses, warnings, and
the exact complete candidate digest. Filters never change the required ordered suffix;
Rehearsal does not infer SQL safety from filenames.

### Static Migration Insights

In a core build advertising `rehearsalContracts.migrationInsights: 1`, run
`npx --no-install rehearsal inspect insights --json` to inspect pending SQL without
starting an engine, connecting to a database, running application commands or changing
files. This additive contract, introduced in core 1.2.0, does not change
`inspect plan` version 1. Older releases without the capability do not provide it.

The normal version-1 command envelope contains `data.schemaVersion: 1`, the exact
complete `candidateSha256`, candidate count, aggregate verdict and per-target entries.
Each entry binds its version, filename, SHA-256 and nullable safe workspace-relative
path to fixed findings. Findings expose only a rule, severity, one-based line and
UTF-16 column, fixed summary and suggestion—never SQL snippets, object names or row
values. Locations identify the static construct, not the origin of a later provider
error. Refresh after editing; editor navigation must recheck the source hash.

Rules flag table/column removal, truncation, UPDATE/DELETE without an outer WHERE,
NOT NULL requirements, new constraints and recognized CASCADE clauses. Comments,
strings, quoted identifiers and routine bodies are not reinterpreted as executable
statements. CTE mutations are considered separately from the outer statement.

Verdicts are `static_warnings`, `no_detected_warning`, and `unknown`.
**No detected warning does not mean safe, syntactically valid or database-verified.**
Coverage describes recognized lexical rules only. Unsupported statements, malformed
lexical input, runtime-dependent plain-string escaping and bounded/truncated analysis
remain unknown. A file can retain a warning while its overall coverage is unknown.
This is not a full PostgreSQL parser or a predictor of row loss, constraint compliance,
locks, rollback, permissions, production performance or external effects. Use the
ordinary reviewed rehearsal and application proof for actual behavior.

Input is limited to 10,000 SQL files across targets, 10,000 directory entries per
migration directory (including non-SQL entries), 1,000 pending candidates, 2 MiB per
file and 16 MiB total. Lexical analysis is bounded to 20,000 tokens and depth
128 per file; findings are bounded to 1,000 per file and 5,000 total. Symlinks, escaping
paths, unsafe filenames, invalid UTF-8 and changed input refuse inspection. Exceeded
lexical/finding bounds produce incomplete coverage rather than a safety verdict.
The CLI and these essential safety warnings remain free.

### Current-sandbox data impact

A build advertising `rehearsalContracts.migrationImpact: 1` adds two free,
optional commands, introduced in core 1.2.0. Check the installed capability rather
than assuming an older release provides them. It does not change migration-plan v1,
static Insights, failure diagnosis, or the gates for `run` and `migrate`.

```bash
npx --no-install rehearsal inspect impact --target=primary --json
npx --no-install rehearsal measure impact --target=primary \
  --confirm-candidates=<whole-plan-sha256-from-the-preview> --json
```

Both commands require an explicit configured target name, even for `primary`.
`inspect impact` reads the reviewed project inputs only: it does not contact a
database, start an engine, run SQL, apply migrations, or change files. Its preview
binds planned aggregate kinds to the exact whole-project candidate digest, selected
target, baseline generation, and each candidate filename and hash. In a multi-target
project, confirmation still uses the **whole-plan** digest, not the selected target's
digest. Editing any target's pending migrations requires a fresh preview.

`measure impact` requires that exact confirmation and an already-running, verified,
ownership-proven disposable local sandbox. It refuses an unavailable, stale or
unmanaged runtime rather than starting, repairing or resetting it. The existing
project-operation lock prevents a concurrent Rehearsal mutation; operation lock files
and bounded local activity history may be written. A bounded read-only catalog
preflight retains eligible relation identities. The counts then use one
`REPEATABLE READ READ ONLY` transaction, which is rolled back after the counts.
Neither command executes pending migrations or application commands.
Measurements use the selected local sandbox's administrative connection, not the
application's role. They inspect stored data, not application permissions; RLS-enabled
or otherwise unsupported objects remain unknown. No application grants are changed.

Before the count snapshot, Rehearsal locks eligible measured relations in a fixed
order with `SHARE ROW EXCLUSIVE`. These locks temporarily block writers and
index/statistics/schema changes on that disposable sandbox; ordinary readers can
continue. They use the same 1-second lock wait and remaining total budget. Name
lookup also holds a bounded `SHARE` lock on the selected database's namespace
catalog to prevent concurrent schema renames; this temporarily blocks schema
catalog changes across that database and requires sufficient local privileges.
A relation name swapped to a view between preflight and locking may transiently lock that view's
dependencies inside the selected sandbox, but the retained-identity/type check
refuses its counts without executing the view query. This is not atomic name
resolution or protection against a compromised PostgreSQL server/catalog.
See PostgreSQL's [locking behavior](https://www.postgresql.org/docs/17/sql-lock.html).

The narrow recognizer supports simple, schema-qualified, unquoted SQL forms for:

| Recognized change                                               | Aggregate on the current sandbox                        |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| Drop a table, truncate one table, or delete without a predicate | Row count                                               |
| Drop one column                                                 | Rows whose current column is not NULL                   |
| Set one column NOT NULL                                         | Rows whose current column is NULL                       |
| Add a simple UNIQUE constraint                                  | Rows in non-NULL duplicate groups, not only excess rows |
| Add a simple FOREIGN KEY with MATCH SIMPLE semantics            | Non-NULL referencing rows with no match                 |

Measurements require PostgreSQL 17 or newer with server-side transaction deadlines,
ordinary non-inherited, non-partitioned heap tables without RLS, and supported built-in
column/operator semantics. Older or unsupported server semantics remain unknown;
Rehearsal never upgrades a database to obtain counts. Quoted identifiers, CHECK constraints,
UPDATE, predicates, CASCADE, expressions, routines, custom types/operators and other
unsupported forms remain unknown. The recognizer is not a PostgreSQL parser. A table
created or a column changed by an earlier pending migration is **not** simulated: all
counts describe the same current snapshot before any pending migration. Row counts
do not measure cascade, trigger or external effects, prove constraint validity, or
predict production locking, performance, data loss or safety.

The version-1 result includes the exact candidate/target bindings, `mode`
(`preview` or `measurement`), `measurementStatus`, nullable snapshot time and runtime
identity hash, per-file coverage/unknown reasons, and fixed operation/metric kinds
with lexical locations. Public counts are decimal **strings**, including `"0"`;
`null` means unavailable, never zero. No SQL, database object names or row contents
are returned. `planned` preview status may contain unsupported input and is not
measurement evidence. Measurement status is `measured`, `partial`, `unknown`, or
`not_required`. Partial or unknown measurement returns envelope `status: "not_ready"`
and exit `1`, retaining only the available evidence; neither a successful envelope
nor zero counts is a safety verdict.

The same bounded migration-input rules as static Insights apply. A review plans at
most 100 aggregates. Measurement uses a 1-second lock timeout, 5-second statement
timeout, 30-second total budget, 128 KiB output limit and 256 KiB generated-script
limit. The server transaction budget is reduced after runtime identity checks and
catalog preflight; it is never increased to compensate for a slow check.
Lock/statement/budget failures remain unknown instead of returning guessed counts.
Client cancellation is not by itself proof of immediate server-backend termination;
server-side deadlines additionally bound owned query/transaction lifetime.
Package-owned cancellation supports the ordinary cancellation signals,
releases the project lock and returns exit `130`; it does not reset or discard data.
Older editor versions may refuse the new `measure impact` operation kind in current
activity or retained history. This source command does not itself update the editor;
use the CLI until a compatible editor consumer is released.
Continue to use the normal reviewed rehearsal and application proof for actual
migration behavior.

`npx rehearsal configuration --json` identifies the exact active config, its source
fingerprint, validated field metadata, and saved named profiles. To validate an edit
without writing it, use `npx rehearsal configuration review --proposal=review.json --json`.
The input is a project-local JSON object with `schemaVersion: 1`, the current
`sourceSha256`, and `changes: [{ path: "runtime.displayName", value: "Feature branch" }]`.
Only the listed structured fields are accepted. Core validates the complete proposed
configuration and refuses stale fingerprints; it does not execute proposed commands or
write the configuration. The editor shows the exact source diff and asks before saving.

`npx rehearsal stop-stale --json` previews long-running, ownership-proven environments.
Configure `resources.staleAfterSeconds` first. Review active application sessions,
then repeat with `--confirm-stop=FULL_DIGEST` to stop precisely those environments.
Container start/stop times do not prove inactivity. This command retains all database
and Storage contents, volumes, images, baselines, and the shared engine.

```bash
npx rehearsal
```

The guide reads the current project state and recommends the next useful action. It stays
open after each action. Press `Ctrl+Z` at a prompt to exit the entire session.

Use `npx rehearsal guide` for the same screen or add `--plain` to use numbered menus
without decorative terminal styling. When input or output is not an interactive terminal,
bare `npx rehearsal` prints help instead of waiting for input.

## Setup and baseline

| Command                                                           | What it does                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `npx rehearsal setup --target=supabase`                           | Preview Supabase setup files.                          |
| `npx rehearsal setup --target=postgresql`                         | Preview PostgreSQL setup files.                        |
| Add `--write` to either setup command                             | Create the previewed files without overwriting.        |
| `npx rehearsal init`                                              | Preview the current config template without writing.   |
| `npx rehearsal init --write`                                      | Create only `rehearsal.config.mjs`.                    |
| `npx rehearsal baseline prepare --records=<path> --ledger=<path>` | Preview a sanitization-policy draft.                   |
| Add `--write` to `baseline prepare`                               | Write the draft for human review.                      |
| `npx rehearsal baseline create --records=<path> --ledger=<path>`  | Create and activate a baseline from safe local inputs. |

Add `--assets=<manifest.json>` to `baseline create` only for approved local Supabase
Storage files. `baseline create` and `baseline prepare` are local-only.

`setup --write` is idempotent: supported existing config files and completed runtime
files remain unchanged, while missing safe ignore entries may be appended. On upgrades,
`init` first lists important optional settings that are available but not enabled, then
prints the installed release's template for comparison. `init --write` never replaces an
existing config.

## Optional source preparation

These commands are separate from ordinary rehearsals. Configure `preparation` only after
reviewing [the standalone security contract](standalone-workflow.md).

| Command                                                       | What it does                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npx rehearsal privacy key`                                   | Preview the owner-only pseudonym-key path.                              |
| `npx rehearsal privacy key --write`                           | Create the key once; refuses to replace an existing key.                |
| `npx rehearsal source plan`                                   | Preview the exact temporary reader, views, columns, and asset scope.    |
| `npx rehearsal source apply --confirm-source-access=<sha256>` | Create managed access, or verify external access without source writes. |
| `npx rehearsal baseline refresh`                              | Replace only the baseline from a reviewed source.                       |
| `npx rehearsal refresh`                                       | Preview a complete safe refresh of the baseline and local runtime.      |
| Add `--confirm-refresh=<sha256>`                              | Create the replacement, reset locally, and prune listed old copies.     |
| `npx rehearsal source retire`                                 | Preview managed retirement or external local-secret cleanup.            |
| Add `--confirm-source-retirement=<sha256>`                    | Apply that retirement plan and verify the exact object inventory.       |

Source credentials are read from environment variables named in the reviewed source
policy. Never paste a connection string into an argument. `baseline refresh` leaves the
previous active baseline and edited runtime untouched when it fails. It does not reset
the runtime.

Use `refresh` for the normal end-to-end job. It first previews the exact source receipt,
configuration receipts, runtime targets, retention rule, and old generations that may be
removed. After exact confirmation, it builds and verifies a replacement beside the
current baseline, resets the complete local runtime stack, then removes only the listed
old generations. If replacement or runtime verification fails, Rehearsal reactivates the
previous baseline and restores the previous runtime. Source-access retirement remains a
separate approval.

In short: `refresh` gets a new source copy; `reset` restores the copy you already have;
`run` tests pending migrations against that copy.

## Local identity association

For a reviewed Google, GitHub, or email identity, use the guided connection:

```bash
npx rehearsal identity connect
```

Rehearsal starts and checks the local runtime, keeps the configured application open,
and waits for an ordinary provider sign-in. It reads only the local Auth database—not
browser cookies, passwords, passkeys, MFA secrets, or session tokens. When exactly one
approved verified identity matches, it stops the owned app, shows a redacted preview,
and offers **Connect my copied account**. One confirmation binds the exact current plan.
After the verified transfer, Rehearsal reopens the app and asks for one sign-out/sign-in
so the application receives fresh role claims.

If the policy declares more than one copied identity, choose one with
`--identity=<reviewed-name>`. The interactive guide presents the reviewed names. A
completed connection is recognized from its local runtime receipt and is not repeated.
Resetting the runtime removes that receipt and requires a fresh review and connection.

For automation or detailed inspection, keep using the explicit commands:

```bash
npx rehearsal identity plan --identity=approved-owner
npx rehearsal identity claim --identity=approved-owner \
  --confirm-identity=<sha256>
```

The first command shows only hashes and declared reference counts. The second updates
only the reviewed local relational, JSON, Storage-owner, and claim locations in one
transaction. It rejects hosted database URLs, wrong or unverified people, ambiguity, and
stale confirmation digests. Reopen the application and sign in again afterward to obtain
fresh claims. Neither flow bypasses application roles, account blocks, RLS, or MFA.

If a runtime-policy seed moves with that identity, declare its `identityAssociation` in
the runtime policy. Later `verify` calls then require the transferred row instead of the
obsolete placeholder key.

## Check and inspect

| Command                                                                                                 | What it does                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npx rehearsal doctor`                                                                                  | Check dependencies, inputs, and safety rules.                           |
| `npx rehearsal discover`                                                                                | Explain detected facts, suggestions, and decisions.                     |
| `npx rehearsal support`                                                                                 | Print a privacy-safe report for a support request.                      |
| `npx rehearsal activity`                                                                                | Report whether another Rehearsal operation is active.                   |
| `npx rehearsal environments`                                                                            | Show owned runtimes, live resource use, and Docker capacity.            |
| `npx rehearsal resources`                                                                               | Browse images, volumes, container references, and cleanup explanations. |
| `npx rehearsal explain`                                                                                 | Show the exact plan without changing anything.                          |
| `npx rehearsal run --dry-run`                                                                           | Show the same non-mutating plan.                                        |
| `npx rehearsal candidates`                                                                              | List pending migrations and their approval digest.                      |
| `npx rehearsal inspect baseline`                                                                        | Show active and retained baseline metadata without row values.          |
| `npx rehearsal inspect migrations`                                                                      | Classify every historical and candidate migration.                      |
| `npx rehearsal inspect source --target= --native-identity= --source-sha256= --candidate-sha256= --json` | Return an exact reviewed Drizzle source reference.                      |
| `npx rehearsal inspect impact --target=<name>`                                                          | Preview exact aggregate kinds without contacting a database.            |
| `npx rehearsal measure impact --target=<name> --confirm-candidates=<sha256>`                            | Read bounded aggregates from that current verified sandbox.             |
| `npx rehearsal status`                                                                                  | Report baseline, candidates, and local runtime state.                   |

State-reporting commands accept `--json` for scripts. Scripts should use the JSON fields
and process exit code, not parse human-facing text.

`explain --json` includes the validated application start, proof, and readiness settings,
the lifecycle modes, and the retained-baseline count. These are safe configuration facts
for editor review; environment-file values and credentials are never included.

The baseline metadata in `explain --json` and `inspect baseline --json` includes
`sourceSchemaSha256`: an exact digest of reviewed source-column metadata, or `null`
when unavailable. Matching row counts or migration histories cannot replace this
receipt. It does not identify complete current runtime DDL or prove schema equivalence.

`inspect baseline --json` includes a `generations` array for the active and retained
immutable copies. Each entry contains only the generation identifier, derived creation
time, active flag, format, aggregate row/table/migration/Storage counts, and migration
cutoff. It never reads or returns database row values, credentials, source URLs, or
environment-file contents. Listing generations does not activate, restore, remove, or
start anything.

### Smart project discovery

```bash
npx rehearsal discover --json
```

`discover` inspects bounded project metadata and returns three deliberately separate
collections:

- `detected` contains facts supported by project-local files or a read-only runtime
  probe;
- `suggested` contains a confidence level, evidence, and the configuration field that a
  person should review;
- `decisions` contains privacy, security, destructive, or genuinely ambiguous choices
  that Rehearsal refuses to settle automatically.

The result also includes proposed configuration-field states and the detected config
paths. A present JavaScript or TypeScript configuration is reported as
`present_unvalidated`: discovery never imports it just to inspect the project. The
ordinary `doctor` command remains the authority for validating an explicitly selected
configuration.

Discovery reads `package.json`, runtime selector files, lockfile names, known config and
policy filenames, and conventional migration directories. Script names may be returned,
but script bodies are not. It may run `docker info` as a bounded reachability probe; it
never starts Docker, Colima, a database, or an application. It does not read `.env`
files, follow project-file symlinks, inspect private rows, contact a database, or execute
project code. No configuration is written by this command.

`discover`, setup previews and `doctor` also report versioned `containerEngines`
options for the detected host. The current verified local Docker selection is
preserved automatically. Other installed tools and local contexts are choices,
not proof of vendor compatibility or lower memory use. Alternate daemons are not
contacted. Use a scoped `DOCKER_CONTEXT=your-local-context npx rehearsal doctor`
override in macOS/Linux/WSL shells to review another engine without changing the
global context. Changing engines never migrates retained database volumes. See
[engine selection](runtime-lifecycle.md#machine-aware-engine-selection).

### Machine-readable contract

`--json` returns one JSON object and no decorative terminal output. Successful and
not-ready results use this versioned envelope:

```json
{
  "schemaVersion": 1,
  "rehearsalVersion": "0.1.0",
  "command": "doctor",
  "status": "success",
  "startedAt": "2026-10-09T12:00:00.000Z",
  "durationMs": 12,
  "warnings": [],
  "data": {}
}
```

Treat `schemaVersion`, `command`, `status`, and each command's documented `data` fields
as the interface. Reject an unknown schema version. Do not infer state from prose in a
`data.output` field. `--version --json` is intentionally smaller and returns only
`name` and `version`.

| Exit  | Meaning                                        |
| ----- | ---------------------------------------------- |
| `0`   | Success                                        |
| `1`   | A check completed but the project is not ready |
| `2`   | Invalid configuration                          |
| `3`   | Unsafe environment                             |
| `4`   | Invalid baseline                               |
| `5`   | Baseline checksum mismatch                     |
| `6`   | Candidate migration failure                    |
| `7`   | Migration verification failure                 |
| `8`   | Application proof failure                      |
| `9`   | Runtime dependency failure                     |
| `10`  | Internal failure                               |
| `130` | A supported mutating operation was cancelled   |

An error result keeps `schemaVersion`, `rehearsalVersion`, and `status: "error"`, then
provides a stable category, code, safe message, suggestions, diagnostic ID, and redacted
context under `error`. Callers should use the category and code for decisions and show
the message and suggestions to people.

Failed migration execution additionally supplies `error.context.migrationFailure`:
schema version `1`, provider (`postgresql` or `supabase`), classification (`syntax`,
`schema`, `constraint`, `permission`, `connectivity`, `timeout_or_cancel`, or `unknown`),
nullable `sqlState`, evidence (`provider_sqlstate`, `unavailable`, or `ambiguous`),
fixed `summary` and fixed `suggestions`. Classification uses recognized native SQLSTATE
envelopes, never SQL-text guessing. Unknown evidence does not establish syntax failure.
Direct manager failures separately name the target in `error.context.target`; raw
SQL, row values, provider DETAIL, absolute paths and connection strings are not
included. Optional attempted-input metadata is described below; it does not locate
the failing SQL statement. Existing exit codes and `MANAGER_RUN_FAILED` / `MANAGER_MIGRATE_FAILED`
codes are unchanged. If cleanup also fails, the outer failure keeps its existing
category, exit and cleanup warning while retaining the original fixed migration
diagnosis. A diagnosis is not borrowed from a cleanup error, and is not evidence that
cleanup completed.

When PostgreSQL submits one known migration file, the diagnostic may include a closed
`source` object: schema version `1`, `kind` (`baseline` or `candidate`), `filename`,
`sha256`, nullable `workspaceRelativePath`, `line: null`, `column: null`, and
`evidence: "owned_execution_input"`. The loaded bytes must match the reviewed hash.
This identifies the attempted input, not the exact origin of failing SQL; statements,
functions and included files can fail elsewhere. No statement counting, provider caret,
or batch candidate count is converted into a source position. Baseline snapshot paths
are not exposed; unavailable or ambiguous attribution is omitted, including the
current Supabase batch path. The editor opens a project-local input only after fresh
containment, regular-file, identity and exact-byte checks; a changed file needs manual
review instead of a stale link.

`activity --json` may also provide `data.recentFailures`: up to 20 entries with
`operationId` and the same `diagnostic`, joined to a failed receipt in `data.recent`.
Missing means an older producer; `null` means private history is unavailable; `[]`
means no retained migration diagnosis. These are recent observations, not current
runtime verification. Existing `recent[]` and progress object fields are unchanged,
so older clients can ignore the new top-level projection. The local owner-only history
stores only this fixed safe projection, not arbitrary errors or terminal output.

Invalid positive-integer settings and rejected proposal structure or fields use
`configuration_invalid` with code `CONFIGURATION_INVALID` (exit `2`), including
baseline-retention settings and fields that require manual review. They are not
baseline corruption or internal failures. Review never writes configuration or
executes proposed commands; unexpected faults retain their existing classification.

A wrong or stale source-access confirmation and an executable privacy policy still
marked as a review-required draft also return `configuration_invalid` /
`CONFIGURATION_INVALID` (exit `2`). Review a fresh `source plan` before confirming it;
complete the privacy review before retrying `baseline refresh`. These refusals do not
grant source access, export rows, or replace the current baseline.

Editor integrations should resolve the project's installed `@rehearsal-db/core`
manifest and its declared `rehearsal` binary. They should not import private package
files, search for a global installation, invoke through a shell, or parse styled output.
Keep each workspace folder isolated, pass an explicit project-relative `--config` when
needed, and run nothing until the workspace is trusted.

Use `discover --json` as the public editor contract for a project profile. Keep evidence
and confidence visible, and require explicit approval before a separate mutating flow
writes any proposed configuration. The presence of a suggestion is never permission to
copy production data, select an identity policy, or clean local resources.

`status --json` reports a `runtimeStatus` object for one target. A multi-target project
reports the same object under every entry in `data.targets`. Clients should read these
fields and ignore the compatibility-only human `output` string:

```json
{
  "schemaVersion": 1,
  "state": "running",
  "reason": null,
  "runtimeTarget": "supabase",
  "projectId": "example-rehearsal",
  "verifiedRuntimeAvailable": true,
  "endpoint": {
    "kind": "http",
    "url": "http://127.0.0.1:54321"
  },
  "baselineGenerationId": "20261009T120000Z-example",
  "candidateSha256": "…",
  "candidates": []
}
```

| Runtime state | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `running`     | The target is running and its health check passed. A credential-free loopback endpoint is present.   |
| `stopped`     | No target workload is running. Existing local state may still be retained.                           |
| `unavailable` | The shared container engine cannot currently be inspected. Rehearsal does not start it for `status`. |
| `unhealthy`   | Target workloads are running, but the target health check did not pass.                              |

`reason` is respectively `null`, `runtime_not_running`,
`container_engine_unavailable`, or `health_check_failed`. PostgreSQL endpoints contain
only `kind`, loopback `host`, `port`, and database name; credentials are never included.
`verifiedRuntimeAvailable` reports whether a current runtime receipt matches the active
verified baseline. It stays `true` when a prepared runtime is safely stopped, and is
`false` when a client must create or reset the disposable runtime before opening it.
Checking this field never starts Docker or repairs runtime state.
An unknown status schema version, state, reason, target, remote endpoint, or malformed
digest is rejected before it reaches the public result.

`activity --json` reports a separate privacy-safe operation snapshot. `state` is `idle`,
`busy`, `stale`, or `invalid`. `operation` is `null` for idle and invalid states. For a
busy or stale state it contains the broad operation `kind`, ISO `startedAt` time,
owning `rehearsalVersion`, and `progress` when instrumentation is available. Progress
has schema version 1, an opaque operation ID, overall state, start/update timestamps,
elapsed milliseconds, the current stage or `null`, up to 20 completed stages, and up
to 40 fixed-code events. Stages identify only their phase, reviewed target name,
state, timestamps and duration; `truncated` flags indicate bounded history loss.
The runtime manager is one honest lifecycle stage: restore and migration timings
are not inferred from stdout. Read-only status is not reported as verification.

`recent` contains up to 20 observed terminal operations from the same project's
private temporary cache, oldest first. `[]` means no records were found; `null`
means history was unsafe or unavailable. Current `progress: null` likewise means
unavailable instrumentation, not inactivity or success. Abrupt exits may leave no
completed record. This history is not a durable audit log or task tracker.

It never exposes application output, arbitrary log/error text, or the
PID, arguments, lock path, token, credentials, URLs, or raw lock contents. `activity`
does not remove a stale or malformed lock, stop a process, or mutate runtime resources.
Clients should disable conflicting actions unless the state is `idle`.

### Cancelling a mutation

`run`, `reset`, `migrate`, `measure impact`, confirmed `refresh`, and direct or guided `open` preparation support
package-owned cancellation.
Send `SIGINT`, `SIGTERM`, `SIGHUP`, or `SIGTSTP` to the Rehearsal CLI process. Rehearsal
handles repeated delivery as one request, forwards it only to the detached process group
it launched, waits for package rollback and child cleanup, releases the project lock, and
then returns exit `130`. With `--json`, the stable error category is
`operation_cancelled`, the code is `OPERATION_CANCELLED`, and safe context identifies
the first signal.

For `reset` and `migrate`, an interrupted unverified runtime is removed while the
immutable baseline remains available. For `refresh`, Rehearsal shields rollback from the
cancellation request and restores the previous baseline and verified runtime before it
reports cancellation. If `run` is interrupted after its runtime phase has already passed,
the verified local runtime may remain; use `status` and `verify` before retrying. Candidate
digests and confirmation requirements do not change.

These project cancellation paths do not stop Docker itself, signal unrelated processes, prune shared resources,
or delete unrelated volumes. `SIGTSTP` is treated as cancellation and becomes `SIGTERM`
for the owned child group instead of suspending it mid-cleanup. Windows uses direct child
signalling; the detached process-group guarantee is supported on macOS and Linux.
During an interactive cancellable operation, Rehearsal temporarily owns terminal control
input so `Ctrl+C` and `Ctrl+Z` request cleanup without suspending an invoking npm job.
It restores the terminal's previous raw mode and consuming/non-consuming input state
after cleanup. Piped input is not consumed by this shortcut.
For direct or guided `open`, cancellation before the ready attached session returns this same
exit `130` contract, including interruption during runtime preparation or application
readiness. A cancellation during the ready application's handoff stops that owned
application before returning; cleanup failure is not reported as clean cancellation.

`SIGKILL`, host shutdown, and a force-quit cannot produce a result or run cleanup. After
one of those events, clients must not guess: run `activity --json`. A `stale` or `invalid`
state is not permission to delete a lock or runtime. Run `status`, `doctor`, and `verify`,
then let the next reviewed mutation use Rehearsal's existing stale-lock recovery.

Other mutations retain their existing terminal workflow. Explicit `engine stop`
has its own structured cancellation/outcome contract above, so a compatible editor
can execute that specifically approved JSON action without parsing terminal output.

## Run and manage the local sandbox

| Command                                               | What it does                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| `npx rehearsal run --confirm-candidates=<sha256>`     | Reset, apply exact candidates, launch the app, and run its proofs.  |
| `npx rehearsal open`                                  | Start, verify, and keep the configured application open.            |
| `npx rehearsal migrate --confirm-candidates=<sha256>` | Apply the exact candidates without resetting existing runtime data. |
| `npx rehearsal start`                                 | Start an existing verified runtime.                                 |
| `npx rehearsal verify`                                | Verify the current runtime and receipt.                             |
| `npx rehearsal reset`                                 | Discard runtime edits and restore the baseline.                     |
| `npx rehearsal stop`                                  | Stop the runtime but keep its local state.                          |
| `npx rehearsal discard`                               | Remove this project's disposable runtime and volume.                |
| `npx rehearsal cleanup`                               | Preview conservative cleanup without removing anything.             |

When `containerRuntime.stopOwnedColimaWhenIdle` is enabled, `stop` and `discard` also
evaluate the owner-only engine receipt after all configured targets stop. Colima is
stopped only when Rehearsal started that exact VM boot and Docker has zero running
containers. Otherwise the command preserves the shared engine and prints the reason.

In a terminal, the guide displays candidate filenames and asks for confirmation. In a
script, copy the digest from `candidates` into `--confirm-candidates`. Adding, removing,
reordering, or editing a migration changes that digest.

`open` does not reset the runtime or apply migrations. It starts and verifies every
configured database target, runs dependent preparation commands, and launches
`application.startCommand` with the declared local environment mappings. It waits for
`application.readiness`, then stays attached until `Ctrl+C` or `Ctrl+Z`. On exit it stops
only the application process group it launched, then applies `lifecycle.open`. The
default `stop-on-application-exit` stops them
with database and Storage changes preserved. Likewise, `lifecycle.run` can remain
explicit `keep-until-stop`, but defaults to `stop-after-run` for bounded work. Explicit
`discard-after-run` and `discard-on-application-exit` instead remove the owned disposable
runtime and its data volumes automatically, including after a subsequent proof failure or
interruption. Protected targets refuse these destructive modes. JSON reports the selected
mode, final state and whether runtime data was preserved or removed. See
[the lifecycle contract](runtime-lifecycle.md#what-remains-after-a-command).
While the ready application or copied-account sign-in session is attached, terminal
`Ctrl+C` and `Ctrl+Z` are handled as control bytes rather than suspending npm wrappers.
Rehearsal restores the prior terminal mode after retiring its owned application; it
never resumes or signals an invoking shell, npm ancestor, or unrelated job.
Once the ready application is attached, its handled `Ctrl+C`, `Ctrl+Z`, `SIGINT`, or
`SIGTSTP` closes the session with exit `0` as before; it does not also cancel an outer
preparation owner. Nested input ownership dispatches a control byte only once.

## Clean up disk space

For a selected set of image IDs, use `cleanup --images-only --image-id=sha256:FULL_ID`.
Repeat `--image-id` for multiple images. This selects no baseline generations, runtime
containers, or data volumes. Review the digest, then rerun the identical selection with
`--write --confirm-cleanup=FULL_DIGEST`. In-use, current, outside-policy, and stale
selections are refused. Image sizes are upper-bound estimates because layers may be shared.

Image previews and writes use the selected local engine and scoped Docker configuration.
Confirmation binds the context and endpoint identity plus the daemon ID. If that binding
changes, create a fresh preview before applying cleanup.

`start`, `stop`, and `discard` can select one configured environment with
`--target=primary` or a declared dependent-target name. With no selector, the existing
whole-stack ordering applies. Protected environments refuse data replacement and discard.

Start with a preview:

```bash
npx rehearsal cleanup
```

By default, cleanup selects only old baseline generations beyond the retention setting
in `rehearsal.config.mjs`. Add options to broaden the preview:

| Command option      | Additional resources considered                                        |
| ------------------- | ---------------------------------------------------------------------- |
| `--include-runtime` | This project's disposable runtime and its database volumes.            |
| `--include-images`  | Older unused Supabase images; the newest image for each service stays. |
| `--write`           | Apply the exact freshly verified preview.                              |
| `--confirm-cleanup` | Full cleanup digest printed by the preview; required with `--write`.   |

Image cleanup never removes an image used by any running or stopped container and never
runs a global Docker prune. Images may be shared by projects and can be downloaded again,
so they remain excluded unless you explicitly add `--include-images`. Database volumes
belonging to other projects are never included. This follows
[Docker's conservative pruning guidance](https://docs.docker.com/engine/manage-resources/pruning/).

## Common options

| Option                                 | Meaning                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--help`, `-h`                         | Show the installed command reference.                                                           |
| `--version`, `-V`                      | Print the installed package version and exit.                                                   |
| `--json`                               | Return the versioned machine-readable result.                                                   |
| `--verbose`                            | Show more safe detail.                                                                          |
| `--debug`                              | Show the most diagnostic detail; still review it before sharing.                                |
| `--plain`                              | Disable decorative interactive prompts.                                                         |
| `--config=<path>`                      | Use only this config for planning and every runtime action.                                     |
| `--target=<name>`                      | Choose a setup provider or configured runtime target; impact commands require an explicit name. |
| `--confirm-candidates=<digest>`        | Confirm the exact whole-plan candidates for run, migrate or impact measurement.                 |
| `--include-runtime`                    | Include this project's runtime in a cleanup preview.                                            |
| `--include-images`                     | Include older unused Supabase images in a cleanup preview.                                      |
| `--confirm-cleanup=<digest>`           | Confirm the exact cleanup set printed by the preview.                                           |
| `--confirm-source-access=<digest>`     | Confirm one exact temporary source-access plan.                                                 |
| `--confirm-source-retirement=<digest>` | Confirm exact source-access retirement.                                                         |
| `--confirm-refresh=<digest>`           | Confirm an exact refresh, runtime reset, and old-copy removal.                                  |
| `--confirm-engine-stop=<digest>`       | Confirm the unchanged whole-VM shutdown review.                                                 |
| `--identity=<name>`                    | Choose one declared local identity association.                                                 |
| `--confirm-identity=<digest>`          | Confirm that exact local identity plan.                                                         |
| `--write`                              | Apply a setup, policy, or cleanup preview.                                                      |

Run `npx rehearsal --help` to print the command list available in your installed version.
Run `npx rehearsal --version` to print only its version number. Add `--json` when a
script also needs the package name.

When a project has more than one config, pass `--config=<path>` on every command for the
non-default one. Rehearsal keeps that exact config selected through status, run, reset,
start, migrate, verify, stop, discard, and cleanup; it will not fall back to
`rehearsal.config.mjs` during a runtime action.

When the selected config declares `dependentTargets`, the ordinary `doctor`, `explain`,
`candidates`, `run`, `start`, `migrate`, `reset`, `status`, `verify`, `stop`, `discard`,
and `cleanup` commands cover the complete runtime stack. Candidate and cleanup changes
use one combined digest, so automation approves the exact cross-target set.

### Native Drizzle review and exact source references

Unqualified candidate builds advertising `rehearsalContracts.drizzleMigrations: 1`
use explicit `{kind:"drizzle",idx,when,tag}` identities in `inspect migrations`,
`inspect plan` and static `inspect insights`. They do not manufacture timestamp-file
versions. Drizzle inspection/review targets also return `baselineHistorySha256`,
matching `inspect baseline.migrationHistorySha256`, and
`baselinePrefixVerification: "exact-native-semantic-prefix"`. A successful review
has checked the complete baseline semantic entry prefix and SQL hashes against
current native source. Historical producer journal/toolchain hashes need not equal
an appended current journal or a newly reviewed execution toolchain; compare the
historical baseline identity and pinned tool/provider contract separately.

Resolve a selected current review row with explicit identity and checksums:

```sh
npx --no-install rehearsal inspect source --target=primary --native-identity='{"kind":"drizzle","idx":2,"when":1720000002000,"tag":"m_pending"}' --source-sha256=FILE_SHA256 --candidate-sha256=ROOT_REVIEW_SHA256 --json
```

`--config=PROJECT_CONFIG` selects the owning primary configuration as usual.
`--candidate-sha256` is the **root** `inspect plan` digest, including a combined
stack digest when applicable. `--source-sha256` is that exact row's SHA-256.
The command supports represented history and candidates. It accepts no caller
filesystem path. Malformed identities, unknown targets, changed checksums/digests,
unsafe paths or symlinks are refused. The bounded native inventory is rechecked
after the installed-toolchain observation. No SDK command, SQL, engine startup or
database connection is involved.

The ordinary CLI JSON envelope's `data` is a closed source reference with exactly
these ten properties:

```json
{
  "schemaVersion": 2,
  "evidence": "reviewed_source_input",
  "target": "primary",
  "candidateSha256": "ROOT_REVIEW_SHA256",
  "nativeIdentity": {
    "kind": "drizzle",
    "idx": 2,
    "when": 1720000002000,
    "tag": "m_pending"
  },
  "filename": "m_pending.sql",
  "sha256": "FILE_SHA256",
  "workspaceRelativePath": "drizzle/m_pending.sql",
  "line": null,
  "column": null
}
```

Checksums are lowercase 64-character SHA-256 values. The initial endpoint provides
file-top navigation only. A reference describes reviewed source input; it does
not attribute an SDK failure, infer a failed statement or include SQL text. It is a
point-in-time observation, not a file lock: consumers must preserve their existing
workspace confinement, current-hash and unsaved-document checks. Legacy attempted
execution source frames remain schema 1 and retain their separate meaning.

Drizzle static Insights retains its existing schema-1 envelope, limits, findings
and safety fields; native entries replace `version` with `nativeIdentity` and keep
flat filename/hash/workspace-relative-path fields. Findings retain actual bounded
lexical line/column observations. No nested source-reference field is added.
This is a static warning capability, not SQL validity, physical schema drift,
provider conformance or permission to execute a source. The native runtime and
installed SDK qualification boundary remains in the
[configuration owner](configuration.md#native-drizzle-migrations--unqualified-development-candidate).
