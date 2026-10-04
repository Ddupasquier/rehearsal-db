# Getting started

This guide sets up Rehearsal in an existing project. It creates a disposable database on
your computer. Normal setup and rehearsal commands never connect to a hosted database.

Want to experiment first? Use the [safe hands-on tutorial](tutorial.md).

## 1. Check the required tools

You need Node.js 24, npm, and a running Docker-compatible engine:

```bash
node --version
npm --version
docker info
```

`node --version` must begin with `v24`. If `docker info` fails, start Docker Desktop,
Colima, or your usual Docker engine.

Choose the extra requirement for your project:

- **Supabase:** install Supabase CLI 2.117.0 and run `supabase --version`.
- **PostgreSQL:** download the local database image once:

  ```bash
  docker pull postgres:17-alpine
  ```

Rehearsal will use that image with downloads disabled.

## 2. Install and open the guide

Run these commands from the directory containing your project's `package.json`:

```bash
npm install --save-dev @rehearsal-db/core@beta
npx rehearsal
```

With npm, a normal application install creates `rehearsal.config.mjs`, the dedicated
local runtime config, and the required `.gitignore` entries when Rehearsal can prove the
application root. It never replaces an existing file. Review the generated config,
especially:

- the migration directory;
- the application start and proof commands;
- the local ports.

If lifecycle scripts were disabled, a global/cache install was used, or a workspace has
more than one possible application, no project files are created automatically. Run
`npx rehearsal` inside the intended application, choose **Set the stage**, select
Supabase or PostgreSQL, and approve the same safe setup preview.

The proof command should check behavior changed by the migration. A test that only checks
whether the home page loads is usually too weak.

If the sandbox needs Google or GitHub sign-in, uncomment
`supabase.authentication` in `rehearsal.config.mjs`. Add the named credentials to
`.env.rehearsal-service.local`, run `chmod 600 .env.rehearsal-service.local`, and
register the local callback printed in the config. See
[Supabase authentication](configuration.md#supabase-authentication). Rehearsal keeps the
values out of tracked files and generates the disposable provider configuration for you.

## 3. Prepare safe baseline inputs

A **baseline** is the locked starting point restored before each rehearsal. Start with a
small synthetic dataset. Do not use raw production data.

Rehearsal needs:

| Input               | What it contains                                     |
| ------------------- | ---------------------------------------------------- |
| Records             | Safe rows in NDJSON format: one JSON object per line |
| Migration ledger    | The historical migrations represented by those rows  |
| Sanitization policy | A decision for every included table and column       |
| Storage manifest    | Optional Supabase Storage files only                 |

A record looks like this:

```json
{ "table": "widgets", "row": { "id": 1, "name": "Synthetic Widget" } }
```

Put your safe records and ledger inside the project. Conventional names such as
`rehearsal/sanitized-data.ndjson` and `rehearsal/migration-ledger.json` are discovered
automatically. The guide inspects their structure but does not print row values.

Follow the guide's recommended actions:

1. **Prepare the script** creates a draft sanitization policy.
2. **Review the script** asks you to classify every table and column.
3. **Create the baseline** validates and activates the reviewed inputs.

Rehearsal will not activate a policy containing undecided fields.

The ledger must describe the exact historical SQL included in the baseline. Do not type
years of migration history by hand for a real project. Generate it through reviewed
project tooling. The [tutorial](tutorial.md) contains a complete synthetic example, and
[Baselines](baselines.md) explains the file formats.

## 4. Reach READY

The guide displays four setup stages. Continue with its recommended action until all
checks are complete and the project reports `READY`.

You can run the same check directly:

```bash
npx rehearsal doctor
```

If it reports `NOT READY`, fix the listed item and run it again. Do not bypass a check or
add a hosted connection string.

## 5. Run the rehearsal

Choose **Run a rehearsal**. Rehearsal shows the exact candidate migrations and asks for
confirmation before it changes the disposable runtime.

A successful run:

1. restores the baseline;
2. applies only the migrations you approved;
3. verifies the local database;
4. launches the ordinary application when readiness is configured;
5. runs the ordinary test command and declared positive/negative HTTP proofs;
6. stops only the application process it launched.

Your original baseline remains unchanged.

If a source owner later approves a production-shaped copy, use the separate workflow in
[Optional production-shaped preparation](production-source.md). Do not add source
credentials to the normal config or runtime environment.

Once temporary source access is ready, `npx rehearsal refresh` previews the safe
replacement workflow. It means “get a newly verified copy.” By contrast, `reset` means
“discard local edits and restore the copy I already have.”

## 6. Use the sandbox and clean up

Choose **Open the sandbox app**, or run:

```bash
npx rehearsal open
```

Open the local URL printed by Rehearsal. The app stays available for hands-on testing
until you press `Ctrl+C`. Only the app stops; your local database and Storage changes are
kept. Run `npx rehearsal open` again to continue where you left off.

Use the guide for normal runtime tasks:

- **Verify** checks the current runtime.
- **Reset** discards runtime edits and restores the baseline.
- **Stop** stops the runtime but keeps its local state.
- **Discard** removes this project's disposable runtime and volume.

Press `Ctrl+Z` at any prompt to exit the entire guide. It will not leave a suspended
process behind.

## Command-line setup

The guide is recommended for people. Scripts and CI can use explicit commands:

```bash
npx rehearsal setup --target=postgresql --write
npx rehearsal doctor
npx rehearsal candidates
npx rehearsal run --confirm-candidates=PASTE_DIGEST_HERE
```

Replace `postgresql` with `supabase` when needed. See [CLI commands](commands.md) for the
complete reference and [Troubleshooting](troubleshooting.md) when a check fails.

Running setup again is safe: existing configuration and runtime files are reported as
unchanged. Rehearsal only adds missing ignore entries. It never refreshes an existing
config during an upgrade. After upgrading, run `npx rehearsal init` to see important
optional settings you have not enabled and compare your file with the installed
release's current template.

## Files Rehearsal creates

- `rehearsal.config.mjs` — reviewed project configuration
- `.rehearsal/` — ignored baselines, runtime files, and receipts
- `.rehearsal/runtime.env` — generated local-only application variables
- `infrastructure/rehearsal/supabase/config.toml` — Supabase-only local configuration

Keep `.rehearsal/` out of source control, even when its data is synthetic.
