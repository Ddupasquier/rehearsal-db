# Safe hands-on tutorial

This tutorial runs a complete PostgreSQL rehearsal in a temporary fictional project. It
does not use your application, production data, or a hosted database.

Allow about five minutes. You need Node.js 22, 24, or 26 and a running
Docker-compatible engine. Node.js 24 LTS is recommended.

## 1. Prepare Rehearsal

If you do not already have this repository, clone it:

```bash
git clone https://github.com/Ddupasquier/rehearsal-db.git
cd rehearsal-db
```

Then run:

```bash
npm ci --ignore-scripts
docker pull postgres:17-alpine
```

If you already have this repository open, use that checkout.

## 2. Make a temporary project

From the Rehearsal repository root, run this block exactly:

```bash
rehearsal_repo=$PWD
tutorial_dir=$(mktemp -d)
cp -R tests/fixtures/postgresql-project "$tutorial_dir/app"
cd "$tutorial_dir/app"
npm install --ignore-scripts --no-save "$rehearsal_repo"
```

The temporary project contains:

- one historical migration that creates a `widgets` table;
- one candidate migration that adds a `description` column;
- one synthetic row;
- a reviewed sanitization policy;
- an application proof that checks the migrated database.

## 3. Create the baseline

Open the guide:

```bash
npx rehearsal
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

Success ends with an application-proof message and suggests exercising the local
application before verification.

## 5. Try the runtime commands

Exit the guide, then run:

```bash
npx rehearsal status
npx rehearsal verify
npx rehearsal reset
npx rehearsal stop
npx rehearsal discard
```

`discard` removes only the labeled tutorial container and volume. The temporary project
directory remains on disk and can be deleted when you no longer need it.

## What you proved

You used the same packaged CLI a normal project installs. Rehearsal verified the baseline,
approved an exact migration, ran it in a disposable database, tested the result, and
cleaned up only its own runtime.

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
That check creates fresh Supabase and PostgreSQL consumers, verifies beta configuration
preservation, and exercises safe refusal and recovery for partial setup, occupied ports,
malformed configuration, and missing credentials.
