# SQLite rehearsals

This guide covers SQLite in **Core 2.3.0**, with **Starter 0.1.29** for its editor
workflow. Confirm the version in your official installation channel before using it;
[released capabilities](capabilities.md) records verified publication. Core 2.2.1
and Starter 0.1.28 do not include this target.

SQLite runs directly in the selected Node executable. Rehearsal snapshots a reviewed
local source, builds a fresh sanitized baseline, and restores it into a separate
owned file. It does not need a database server, Docker, or a VM.

| Find your next step     |                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------- |
| Set up                  | [Requirements](#requirements) · [Configuration](#configuration)                   |
| Prepare data            | [Privacy decisions](#privacy-decisions) · [Migration history](#migration-history) |
| Use the sandbox         | [Run](#run) · [Keep or remove data](#keep-or-remove-data)                         |
| Understand the boundary | [Supported scope](#supported-scope) · [Failure recovery](#failure-recovery)       |

## Requirements

- An executable with the **SQLite 3.53.4** binding, native backup,
  authorizer and defensive APIs. The qualified local tuple is **macOS arm64 /
  Node 24.21.0 / SQLite 3.53.4**; support for the package's other Node lines does not qualify
  their SQLite binding automatically.
- A local filesystem supporting SQLite locks and stable file-creation identities.
  Other operating systems, including native Windows, remain unqualified for this SQLite slice.
- The documented system `lsof` inspector for exact open-handle checks before
  reset/discard. Unknown inspection results refuse those operations.
- The system `ps` inspector for bounded observations of the owned worker's memory.
- A project-local SQLite source, an explicit SQL migration directory, reviewed
  privacy decisions, and an application proof command.

`rehearsal database capabilities --json` reports this target's capabilities separately
from backend availability. `rehearsal doctor` checks the executable actually running
the command. Neither command installs a runtime. VS Code inspection uses its own
executable, which must pass the same binding checks.

## Configuration

Create an explicit `rehearsal.config.mjs`. The source path names the original input;
Rehearsal never uses it as the application sandbox. Review every example path and
command for your project. Existing container setup templates do not generate SQLite
source or privacy decisions.

```js
export default {
  schemaVersion: 1,
  project: { name: "sqlite-example" },
  runtime: { target: "sqlite", projectId: "sqlite-example-rehearsal" },
  sqlite: {
    sourceDatabase: "data/development.sqlite",
    migrationDirectory: "migrations",
    expectedVersion: "3.53.4",
    maximumBytes: 64 * 1024 * 1024,
    timeoutSeconds: 10,
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "rehearsal/sqlite-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
    requiredServices: ["database"],
    environmentVariables: { DATABASE_PATH: "primary:SQLITE_DATABASE_PATH" },
  },
};
```

The application must read `DATABASE_PATH` in this example; replace the destination
name with your application's file-path variable. The source reference
`primary:SQLITE_DATABASE_PATH` selects Rehearsal's private connection export.
Do not map the source database or inherit a production connection instead.

The initial target is standalone: no dependent targets, database ports, container
settings, project runtime adapters, hosted access, Auth or Storage. SQLite source,
version and budget fields require manual configuration review in the editor.

## Privacy decisions

The SQLite policy is engine-specific. It must list every ordinary table and column
in the snapshot exactly once. A missing decision refuses baseline creation.

```json
{
  "policyVersion": 1,
  "engine": "sqlite",
  "tables": [
    {
      "name": "accounts",
      "columns": [
        { "name": "id", "action": "KEEP" },
        {
          "name": "email",
          "action": "REPLACE",
          "value": "redacted@example.test"
        }
      ]
    }
  ]
}
```

`KEEP` is an explicit decision to retain a value. `REPLACE` uses a reviewed constant
string, number or null; constraints still apply. This slice does not implement
SQLite pseudonymization, derivation, source shaping or ORM-specific privacy rules.
Review source data and schema before preparation. Schema definitions, including
defaults and trigger bodies, are retained; column decisions do not rewrite SQL
literals.

Snapshotting uses SQLite's [native backup API](https://www.sqlite.org/backup.html),
including committed data in an active [WAL](https://www.sqlite.org/wal.html).
A raw snapshot is private and temporary; the activated baseline is rebuilt into a
new database from the reviewed logical values. Deleting a sensitive value from a
copied database would not establish that its old pages were sanitized. Read-only
WAL access can update SQLite shared-memory bookkeeping; it does not promise
byte-identical source `-shm` contents.

## Migration history

Use ordered `YYYYMMDDHHMMSS_name.sql` files. Supply a JSON ledger containing the
exact filename and SHA-256 of each current file represented by the source, in order:

```json
[
  {
    "filename": "20260101000000_create_accounts.sql",
    "sha256": "REPLACE_WITH_THE_REVIEWED_CURRENT_FILE_SHA256"
  }
]
```

This is **owner-declared history with current-input checksums**. It does not recover
the historical bytes originally applied by another tool. Do not guess a represented
prefix. An empty array declares that no current migration file is represented.
ORM history import and automatic source-ledger discovery are not included.

Rehearsal records its own subsequent migration history transactionally in the
reserved `_rehearsal_sqlite_history` table. Source databases containing that reserved
name and migrations accessing it refuse. Changed baseline-prefix files also refuse.

## Run

Using the matching reviewed installation, prepare the reviewed source and ledger:

```sh
rehearsal baseline create --records=data/development.sqlite --ledger=rehearsal/sqlite-ledger.json
rehearsal doctor
rehearsal explain
rehearsal candidates --json
```

Review the returned candidate digest and exact files. Pass that digest explicitly:

```sh
rehearsal run --confirm-candidates=REVIEWED_DIGEST
```

`run` restores the verified baseline, applies the confirmed SQL suffix, verifies
integrity and foreign keys, and uses the existing application proof/readiness flow.
The SQL suffix and its native history update share one transaction. User SQL cannot
disable the required settings, load extensions or attach another database.

## Keep or remove data

| Command                          | SQLite meaning                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `open`                           | Enable the verified owned file and launch the configured application.    |
| `start`                          | Verify and restore the private connection export without resetting data. |
| `stop`                           | Retire Rehearsal's connection export and preserve the database file.     |
| `verify`                         | Check the actual owned file, native history, schema and constraints.     |
| `reset --confirm-candidates=…`   | Replace only the proven sandbox with its verified baseline.              |
| `discard --confirm-candidates=…` | Remove only the proven owned sandbox files. Baselines remain.            |

Get a current digest with `rehearsal candidates --json` before reset/discard, including
when no migration is pending. Close applications holding the sandbox before destructive
actions. Rehearsal refuses unknown files, replaced identities, aliases and unproven
open-handle state.

SQLite has no separate database daemon to stop. File-enabled/paused status describes
Rehearsal's connection export, not every connection another application might hold.
Application code remains trusted project code; mapping a database path is not an OS
sandbox against another process running as the same user.

## Supported scope

The initial slice covers ordinary tables, foreign keys on Rehearsal connections,
transactions, indexes, triggers, integer/real/text/blob/null values, consistent source
WAL snapshots and the declared SQL history. Applications must enable foreign keys
on their own connections too. Snapshot rebuilding preserves `user_version` and
`application_id`; both participate in the schema binding. User migration SQL may
not change these values through a PRAGMA.

Addressable implicit rowids are preserved. A rowid table that shadows all three
rowid aliases and has no `INTEGER PRIMARY KEY` is refused rather than silently
renumbered.

Unsupported: encrypted databases, loadable extensions, attached databases, virtual
tables or generated columns, ORM-native migration adapters, PostgreSQL static SQL analysis,
Supabase services and mixed/dependent targets. Source WAL snapshots are supported
within this slice, but changing the sandbox to WAL mode is not qualified.
Unexpected runtime sidecars are retained
rather than adopted by filename. Moving or replacing owned files invalidates their
receipt; source and unproven files are preserved.

Source and sandbox files plus known sidecars are checked against the configured
byte budget (default and maximum 64 MiB), with a database-page limit on writes.
These checks are not a continuous filesystem quota. Migration inputs, row counts,
schema size, output and native-job execution time also have finite bounds; the job
deadline is not a completion promise for the entire CLI workflow.

**Worker memory is supervised, not hard-capped.** The selected binding disables
SQLite memory accounting, so `hard_heap_limit` readback cannot enforce a native
ceiling. Rehearsal instead uses sampled process-memory supervision. Its fixed
worker RSS budget is 256 MiB, with 100 ms between
bounded system observations and one observation at a time. An excess or an unreadable live
observation interrupts the owned worker and retains recovery. Allocation can
overshoot between observations; this is not an OS memory quota or a whole-machine
budget. The separate 128 MiB JavaScript heap setting also excludes native allocations.

## Failure recovery

Before dispatch, the manager exclusively creates a rollback journal and records its
held file identity in a dirty receipt. A failed or interrupted migration keeps that
receipt; ordinary start/migrate/verify refuse it. After confirmed worker closure,
SQLite may have removed the original journal during commit or rollback. If it remains,
it must still match the preclaimed identity. A real interrupted write can leave a hot
journal; its presence is not permission to adopt another file with that name.

Review the failure and current digest before an explicit reset. Rehearsal verifies a
staged baseline copy and rechecks old-file ownership and open handles before replacing
the sandbox. Source databases and baselines remain untouched. Discard likewise removes
only proven owned leaves. Unknown files or sidecar replacements refuse deletion.

A pending or unconfirmed worker prevents automatic reset/discard even when a process
or open handle is not currently observed. Preserve the receipt and files for separate
closure/recovery review. Unexpected corruption of a supposedly healthy journal or
database also remains a refusal, not automatic corruption repair. No failure message
by itself proves SQL rollback or successful cleanup.

SQLite format **6** and status schema **2** are negotiated through
`sqliteTarget: 1` and `databaseCapabilities: 1`. Existing PostgreSQL/Supabase formats
and status schema 1 retain their meanings; format 5 remains separately reserved.
Public status exposes an opaque embedded-file binding, not the database's absolute
path. See [compatibility](../COMPATIBILITY.md) and [security](security-model.md).
