# Getting started

This guide creates a safe local Rehearsal project from synthetic data. It does not
connect to production, request hosted credentials, or require an existing baseline.

## Prerequisites

- Node.js 24
- npm
- Supabase CLI 2.117 or newer
- Docker Desktop, Colima, or another Docker-compatible engine
- a Supabase project with timestamped SQL migrations

Confirm the tools first:

```bash
node --version
npm --version
supabase --version
docker info
```

## 1. Install and initialize

```bash
npm install --save-dev @rehearsal/db
npx rehearsal init
```

`init` is a preview. Read the generated configuration, then explicitly write it:

```bash
npx rehearsal init --write
```

Rehearsal never overwrites an existing configuration.

## 2. Add the project-owned inputs

Create the paths named by `rehearsal.config.ts`:

- a dedicated local Supabase `config.toml`;
- a sanitization policy describing every exported field;
- an active baseline below `.rehearsal/`;
- an application proof command that exits nonzero when the restored app is wrong.

Start with synthetic rows shaped like your schema. Do not start onboarding with
production data. Create one NDJSON record per row:

```json
{ "table": "widgets", "row": { "id": 1, "name": "safe example" } }
```

Create a JSON migration ledger containing the exact statements represented by the
baseline. For a first synthetic project, this is normally the initial migration only:

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

Then activate the safe input:

```bash
npx rehearsal baseline create \
  --records=rehearsal/synthetic-data.ndjson \
  --ledger=rehearsal/migration-ledger.json
```

The independent fixture in this repository is the executable reference example.

## 3. Check readiness

```bash
npx rehearsal doctor
```

Do not continue until it ends with `READY`. Doctor checks the local-only boundary,
dependencies, artifact integrity, migration lineage, ports, and project commands.

## 4. Review pending work

```bash
npx rehearsal explain
npx rehearsal candidates
npx rehearsal inspect baseline
npx rehearsal inspect migrations
```

The plan prints an exact candidate digest. It does not start services or change data.

## 5. Run the rehearsal

```bash
npx rehearsal run --confirm-candidates=<sha256>
```

Rehearsal restores the immutable baseline, applies only the confirmed migration suffix,
verifies the runtime, and runs the project-owned application proof. The resulting local
database is writable, so you can test real application changes without mutating the
baseline.

## 6. Work, verify, and reset

```bash
npx rehearsal status
npx rehearsal start
npx rehearsal verify
npx rehearsal reset
npx rehearsal stop
```

Changes persist in the disposable runtime until `reset` or runtime removal. `start`
resumes that runtime without resetting it. `reset` restores the exact baseline. `stop`
stops only this project's runtime.

## Next steps

- Follow [the full tutorial](tutorial.md).
- Read [the security model](security-model.md) before designing a production export.
- Define an exhaustive [sanitization policy](sanitization.md).
- Learn the [baseline lifecycle](baselines.md).

## Generated files

- `rehearsal.config.ts` is written only by `init --write`.
- `.rehearsal/generations/<id>/` contains one immutable baseline generation.
- `.rehearsal/current` selects the active generation atomically.
- `.rehearsal/runtime/` contains the disposable local Supabase project and receipts.
- `.rehearsal/runtime.env` contains generated loopback-only application credentials.

Ignore all of `.rehearsal/`. Do not commit it even when its inputs were synthetic.
