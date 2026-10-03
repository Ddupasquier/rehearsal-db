# Baselines

A baseline is the locked starting point for every rehearsal. It combines safe rows with
the exact historical migrations that created their schema. Resetting the runtime always
returns to this point.

## Required inputs

### Records

Records use NDJSON: one complete JSON object per line. Each object names a table and one
safe row.

```json
{ "table": "widgets", "row": { "id": 1, "name": "Synthetic Widget" } }
```

`public` is the default schema. Name another schema explicitly when needed:

```json
{
  "schema": "app_api",
  "table": "publication_products",
  "row": { "id": 1 }
}
```

Use the same optional `schema` on that table in the sanitization policy. Rehearsal keeps
same-named tables in different schemas separate. An undeclared schema or table is
rejected.

Use synthetic or reviewed sanitized values. A `.json` array is not NDJSON and will be
rejected.

### Migration ledger

The ledger is a JSON array in migration order:

```json
[
  {
    "version": "20260101000000",
    "name": "create_widgets",
    "statements": [
      "create table public.widgets (id bigint primary key, name text not null)"
    ]
  }
]
```

Each entry must match the version, name, order, and SQL represented by the historical
migration. Equivalent-looking SQL is not enough. Generate this evidence with reviewed
project tooling for a real migration history; do not reconstruct a large ledger by hand.

### Sanitization policy

The policy records the approved treatment of every included table and column. The guide
can create a shape-only draft from the records and walk you through its review. A draft
with undecided fields cannot become a baseline. See [Sanitization](sanitization.md).

### Storage manifest (optional)

Supabase projects may include a bounded set of approved local Storage files. Plain
PostgreSQL projects do not support Supabase Storage. Every file is checksum-verified and
must remain inside the project.

## Create a baseline

The guided action is recommended:

```bash
npx rehearsal
```

For automation, use explicit safe local paths:

```bash
npx rehearsal baseline create \
  --records=rehearsal/sanitized-data.ndjson \
  --ledger=rehearsal/migration-ledger.json
```

Add `--assets=rehearsal/assets.json` only when using approved Supabase Storage files.
Rehearsal validates everything and shows counts before activation. These commands read
project-local files only.

The separately enabled `baseline refresh` command can stream a reviewed source through
privacy policy version 2. It stages a private generation, verifies capacity, counts,
checksums, source schema, migration evidence, privacy coverage, and drift, then switches
the active symlink atomically. Failure or interruption removes the staged generation and
preserves the prior active baseline and edited runtime.

## Why historical migrations are locked

The baseline records the exact ordered historical migration files. If a file keeps the
same timestamp but its bytes change, Rehearsal reports modified history instead of
treating it as a new candidate. New migrations must form an ordered suffix after the
baseline cutoff.

## What reset does

`reset` removes only the exactly labeled local runtime, rebuilds the represented schema,
loads the safe rows, restores approved Storage files when present, and verifies counts and
relationships. A failed restore cannot produce a successful receipt.

The baseline itself never changes during normal use. Runtime edits persist until you
reset or discard that runtime.

## Storage and privacy

Baseline files can still be sensitive after sanitization. Rehearsal stores them under the
ignored `.rehearsal/` directory with checksums and read-only files. Keep them off shared
drives, use encrypted disks, retain them only as long as needed, and never commit them.
