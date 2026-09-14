# Tutorial: rehearse a migration in a new project

This walkthrough uses a fictional `widgets` application. It demonstrates the complete
consumer workflow without importing private or hosted data.

## Create the application migration history

The project begins with one historical migration:

```sql
create table public.widgets (
  id bigint generated always as identity primary key,
  name text not null
);
```

Place it at `supabase/migrations/20260101000000_create_widgets.sql`. Add a second,
candidate migration:

```sql
alter table public.widgets add column description text;
```

Place that at `supabase/migrations/20260101000100_add_widget_description.sql`.

## Configure the isolated runtime

Run `npx rehearsal init --write`, then edit the result. Give the runtime unique local
ports and a unique project ID. Its `rehearsalConfig` must point at a dedicated, unlinked
Supabase config. Never reuse a hosted project reference or production environment file.

Keep the generated `.rehearsal` directory ignored. It contains local artifacts and
runtime state, not source code.

## Build a synthetic baseline

The baseline contains the historical migration bundle, a one-row sanitized data stream,
and a manifest binding their checksums. Baseline construction is deliberately separate
from runtime execution: the application owns extraction and policy; the engine accepts
only a completed, verified artifact.

Write the safe rows to `rehearsal/synthetic-data.ndjson` and the exact represented
statements to `rehearsal/migration-ledger.json`, then run:

```bash
npx rehearsal baseline create \
  --records=rehearsal/synthetic-data.ndjson \
  --ledger=rehearsal/migration-ledger.json
```

For an executable sample, inspect `tests/fixtures/rehearsal-project` in the repository.
The maintained fixture proof invokes this public command through the packed npm tarball
and never contacts a hosted service.

## Prove planning is non-mutating

```bash
npx rehearsal doctor
npx rehearsal explain
npx rehearsal run --dry-run
npx rehearsal candidates --json
```

`explain` and `run --dry-run` return the same execution plan. At this point no local
database has been restored.

## Run and inspect

Copy the exact digest from `candidates`:

```bash
npx rehearsal run --confirm-candidates=<sha256>
npx rehearsal inspect migrations
npx rehearsal status
```

The historical migration should be `represented_by_baseline`; the description migration
should be `applied_to_current_runtime`. Test normal creates, updates, and deletes through
your local application. They affect only this disposable database.

## Prove failure behavior

Add a timestamped migration containing invalid SQL, rerun `candidates`, and use its new
digest. The command must fail with `migration_candidate_failure`, remove the untrusted
runtime, and never produce a successful receipt.

Then restore the valid migration set and rerun:

```bash
npx rehearsal reset
npx rehearsal verify
npx rehearsal stop
```

That cycle—plan, confirm exact bytes, run, exercise the app, reset—is the normal Rehearsal
workflow.
