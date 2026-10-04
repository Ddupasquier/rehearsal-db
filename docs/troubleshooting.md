# Troubleshooting

Start with:

```bash
npx rehearsal doctor
```

Doctor names each missing or unsafe item. If you still need help, run
`npx rehearsal support`, review the report, and attach it to a GitHub issue.

## `npx rehearsal` cannot find the command

Confirm you are in the project directory and install the beta locally:

```bash
npm install --save-dev @rehearsal-db/core@beta
npx rehearsal --help
```

Do not use `sudo` or require a global install.

## Installation did not create `rehearsal.config.mjs`

Rehearsal intentionally skips automatic creation when install scripts are disabled, the
install is global or temporary, or more than one workspace application could own the
config. From the intended application directory, run:

```bash
npx rehearsal
```

Choose **Set the stage** and approve the preview. For pnpm and Yarn, use this guided path;
automatic root generation is currently tested with npm. An existing supported config is
kept in place, including `infrastructure/rehearsal/rehearsal.config.mjs`.

## Setup says Node.js 24 is required

Rehearsal intentionally supports one maintained Node.js major in its first beta. Switch
the current shell before installing or running it. With nvm:

```bash
nvm install 24
nvm use 24
node --version
```

Then reinstall Rehearsal in the consuming project. The guided CLI checks this before it
writes setup files.

## Doctor says Docker is unavailable

Start Docker Desktop or Colima, confirm `docker info`, then rerun `rehearsal doctor`.
Restarting the computer is rarely necessary.

## Docker or Colima is out of disk space

Preview what Rehearsal can safely remove:

```bash
npx rehearsal cleanup --include-images
```

Review the list, then add `--write` and the printed `--confirm-cleanup` digest. Rehearsal
keeps the newest Supabase image for each service, refuses images used by any running or
stopped container, and never runs a global Docker or volume prune. Add
`--include-runtime` only when this project's disposable database may also be removed.

For example, copy the full digest from your preview:

```bash
npx rehearsal cleanup --include-images --write --confirm-cleanup=PASTE_FULL_DIGEST_HERE
```

For Colima, disk capacity belongs to the user rather than the project. Increase it with
`colima stop` followed by a larger `colima start --disk <GiB>` value. Rehearsal respects
that configuration and does not choose a disk size.

## The guide does not show styled menus

Rehearsal uses numbered menus when terminal styling is unavailable, `NO_COLOR` is set, or
`--plain` is used. Enter the number beside your choice. This is the same workflow and has
the same safety checks.

If bare `npx rehearsal` prints help, the command is not connected to an interactive
terminal. Run it directly in a terminal rather than through a pipe or background task.

## Doctor says the PostgreSQL image is unavailable

Rehearsal will not download an image during a rehearsal. Pull and review the exact image
declared in `rehearsal.config.mjs`, then rerun Doctor:

```bash
docker pull postgres:17-alpine
npx rehearsal doctor
```

## A port is already in use

Rerun `rehearsal setup` to select a different available block. Setup checks both active
listeners and whether every selected port can be bound, then checks again before writing.
For an existing configuration, choose unique non-privileged ports and mirror them in the
dedicated Supabase config when using Supabase. Do not stop an unrelated database to make
defaults fit.

## Baseline checksum mismatch

Do not edit the checksum or manifest. The artifact is no longer the reviewed input.
Rebuild the generation through the project-owned baseline process.

## Historical migration changed

Restore the exact represented bytes or intentionally build and review a new baseline.
Renaming edited history into the candidate suffix does not repair lineage.

## Candidate confirmation mismatch

Run `rehearsal candidates` again. Review every filename, then confirm the new digest only
if the exact set is intended.

## Migration failed

The runtime is untrusted and should be removed automatically. Correct the candidate SQL,
rerun doctor and candidates, then execute with the new digest.

## Application proof failed

Run the project proof directly against the generated local environment. Fix the app,
adapter, fixture expectation, or migration; do not weaken the proof to obtain a pass.

## The local application loads a hosted value from `.env`

Rehearsal removes undeclared hosted credentials from the child process environment, but
frameworks such as Vite may independently read project `.env` files after the process
starts. Give the configured `startCommand` or framework test mode an explicit safe local
override for the affected value. Do not delete or rewrite a developer's normal `.env`
file as part of a rehearsal.

## `rehearsal open` cannot start the app

`open` requires `application.readiness` in `rehearsal.config.mjs`. Confirm that its URL
uses `localhost`, `127.0.0.1`, or `::1`, matches the app's sandbox port, and returns the
configured status after startup. Rehearsal leaves the verified database runtime running
when application startup fails, so retrying does not discard local database or Storage
changes.

## Local authentication fails

Confirm the provider is enabled in the dedicated local Supabase config, the allowlisted
service environment file exists with owner-only permissions, and the provider callback
is the local Auth callback. Do not paste provider secrets into config or terminal output.

If `identity plan` refuses the matcher, read the message literally:

- **Provider or matcher type is unsupported:** use only the combinations documented in
  [Runtime and identity policies](runtime-policies.md).
- **No verified identity matches:** complete an ordinary local sign-in, confirm the
  correct environment value is present, then run the plan again.
- **More than one identity matches:** narrow the provider allowlist or use a hashed
  provider-subject matcher. Rehearsal will not guess between accounts.
- **Provider subject conflicts:** the local Auth identity disagrees with itself; remove
  and recreate that disposable local sign-in instead of forcing a claim.

## Runtime changes disappeared

`reset` deliberately restores the immutable baseline. `stop` should preserve Docker
state, but runtime removal or a failed migration discards untrusted state.

## `Ctrl+Z` exits instead of suspending

This is intentional inside the guided interface. It exits the entire Rehearsal session
and restores the terminal. Choose **Exit** for the same result.

Use `--debug` only after ordinary output is insufficient. Diagnostics are redacted, but
you should still review output before sharing it publicly.
