# Safe hands-on tutorial

This tutorial runs a complete PostgreSQL rehearsal in a temporary fictional project. It
does not use your application, production data, or a hosted database.

Allow about ten minutes after downloading the database image. You need Git, Node.js 22,
24, or 26, npm, and a running Docker-compatible engine. Node.js 24 LTS is recommended.

## 1. Prepare Rehearsal

If you do not already have this repository, clone it:

```bash
git clone https://github.com/Ddupasquier/rehearsal-db.git
cd rehearsal-db
```

Then run:

```bash
npm ci --ignore-scripts
npm run build
docker pull postgres:17-alpine
```

If you already have this repository open, use that checkout. The build prepares its
local package for the temporary project. Downloading the database image is explicit;
Rehearsal will not download it for you.

## 2. Make a temporary project

From the Rehearsal repository root, run this block:

```bash
rehearsal_repo=$PWD
tutorial_dir=$(mktemp -d)
cp -R tests/fixtures/postgresql-project "$tutorial_dir/app"
cd "$tutorial_dir/app"
npm install --ignore-scripts --no-save --install-links "$rehearsal_repo"
```

`--install-links` installs a local package copy in this temporary project instead of
linking to the separate source checkout. Both the CLI and VS Code can use this copy;
the extension deliberately refuses a package that resolves outside the project or its
containing Git repository. Installation does not start or change a database.

The temporary project contains:

- one historical migration that creates a `widgets` table;
- one candidate migration that adds a `description` column;
- one synthetic row;
- a reviewed sanitization policy;
- an application proof that checks the migrated database.

The fixture uses runtime ID `rehearsal-postgresql-fixture` and PostgreSQL port `59422`.
Run only one copy at a time, or choose a distinct `runtime.projectId` and free
`runtime.databasePort` in `rehearsal.config.mjs` before continuing. Rehearsal will not
replace another listener.
On Windows, run this tutorial inside WSL 2 on its Linux filesystem, with Linux Node
and Docker integration enabled. A Windows-excluded port can fail even without a
listener. If `59422` cannot be bound, inspect the Windows host's excluded TCP ranges
with `netsh interface ipv4 show excludedportrange protocol=tcp` in PowerShell,
then choose a different available `runtime.databasePort` before starting. Do not remove
reservations or stop unrelated services. See [port troubleshooting](troubleshooting.md#a-port-is-already-in-use-or-cannot-be-bound).
This is a database-only example, not a full application with a browser interface.

## 3. Create the baseline

Open the guide:

```bash
npx --no-install rehearsal
```

The project begins at Stage 3 of 4. Choose **Create the baseline**. Accept the detected
record and ledger files, review the summary, then confirm creation.

The project should advance to Stage 4 of 4 with every item checked.

## 4. Run the migration

Choose **Run a rehearsal**. The guide should show exactly one candidate:

```text
20260101000100_add_widget_description.sql
```

Confirm it. Rehearsal creates a loopback-only PostgreSQL container, restores the baseline,
applies the candidate, and runs the fixture proof.

Success ends with the fixture's project-proof message. Here, the configured proof
checks the migrated database; it does not start a browser application. The rehearsal
command has finished even though its database can remain running. Continue with the
deliberate failure below, or use `rehearsal verify` to check the runtime.

## 5. Break a migration on existing data

This is the useful failure: the SQL is valid, but the synthetic row's new `description`
is NULL. Making that column required would work on an empty table and fail on this row.

Exit the guide. From the temporary app directory, copy the deliberately unsafe example
into a **new, unapplied** candidate:

```bash
cp demo/require-description.sql database/migrations/20260101000200_require_widget_description.sql
npx --no-install rehearsal
```

Choose **Run a rehearsal** again. Review the two candidates, including the new
`20260101000200_require_widget_description.sql`, and confirm the exact plan.
The expected result is a failure, not a successful rehearsal:

```text
Migration SQLSTATE: 23502.
Rows do not satisfy a NOT NULL requirement.
```

The safe explanation recommends reviewing NULL values and backfilling incompatible
rows. SQL and provider row details remain private. A constraint failure is **not** a
syntax error: PostgreSQL reported that the data violates the requirement.

Rehearsal must not report the failed runtime as trusted. Its owned failure cleanup may
remove the disposable runtime; a cleanup warning means resources may remain. The
immutable baseline remains available. Do not infer a transaction rollback or preserved
sandbox edits from a failure message alone. No production database is involved.

## 6. Fix it, review again, and pass

Exit the guide. Replace **only this new, never-successfully-applied tutorial candidate**
with its data-preserving fix:

```bash
cp demo/backfill-and-require-description.sql database/migrations/20260101000200_require_widget_description.sql
npx --no-install rehearsal
```

The fix first fills missing descriptions with a synthetic value, then enforces NOT NULL.
Choose **Run a rehearsal**, review the changed candidate and its **new digest**, and
confirm again. Rehearsal restores the same baseline and applies the corrected plan.
The application proof should now pass. Do not reuse an earlier confirmation or alter a
historical migration that was already deployed; real deployed history needs a forward
migration instead.

## 7. Continue in VS Code, or verify from the terminal

To continue in the editor, leave the guide, open this temporary `app` folder in VS Code,
and install [Rehearsal DB](vscode.md). On Windows, open the folder through **Remote -
WSL**, not in a native Windows extension host. Trust only this project after reviewing
its files, then choose **Rehearsal: Open Dashboard**. Refresh if the dashboard was
already open. Opening or refreshing the dashboard performs read-only inspection; it
does not rerun the rehearsal or reset its database.

If an earlier tutorial install reports that the package resolves outside its repository,
run the following from the same temporary `app` directory, using the source checkout
you built in step 1, then refresh the dashboard:

```bash
npm install --ignore-scripts --no-save --install-links "$rehearsal_repo"
```

This replaces the external package link with a project-local copy. Do not edit
Rehearsal's manifest or CLI paths to bypass the check. The baseline, project
configuration, privacy key and database do not need to be reset. If the original shell
was closed, set `rehearsal_repo` to the absolute path of that reviewed source checkout
first. A copy does not track later source edits; rebuild and explicitly reinstall it
when testing a changed checkout.

## 8. Verify and clean up

Exit the guide, then run:

```bash
npx --no-install rehearsal status
npx --no-install rehearsal verify
npx --no-install rehearsal reset
npx --no-install rehearsal stop
npx --no-install rehearsal discard
```

`discard` removes only the labeled tutorial container and volume. The temporary project
directory remains on disk and can be deleted when you no longer need it.

## What you proved

You saw valid SQL fail against existing data, used a safe database explanation to fix
the unapplied migration, reviewed the changed plan, and proved the correction against
the same baseline. Rehearsal verified the result and cleaned up only its own runtime.

Next, follow [Getting started](getting-started.md) in your own project. Start with synthetic
rows until the workflow and application proof are reliable.

## Supabase check

If Supabase CLI 2.117.0 is installed, the repository also has a fully automated Supabase
proof:

```bash
cd "$rehearsal_repo"
npm run test:fixture
```

The PostgreSQL equivalent is `npm run test:fixture:postgresql`.

The release workflow also runs `npm run test:fixture:onboarding` from the packed package.
That check creates fresh Supabase and PostgreSQL consumers, verifies reviewed configuration
preservation, and exercises safe refusal and recovery for partial setup, occupied ports,
malformed configuration, and missing credentials.
