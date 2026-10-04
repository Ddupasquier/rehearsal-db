# CLI commands

Run commands from the project directory containing `rehearsal.config.mjs`. The examples
use `npx`, so a global install is not required.

## Guided mode

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
| `npx rehearsal init`                                              | Preview only `rehearsal.config.mjs`.                   |
| `npx rehearsal init --write`                                      | Create only `rehearsal.config.mjs`.                    |
| `npx rehearsal baseline prepare --records=<path> --ledger=<path>` | Preview a sanitization-policy draft.                   |
| Add `--write` to `baseline prepare`                               | Write the draft for human review.                      |
| `npx rehearsal baseline create --records=<path> --ledger=<path>`  | Create and activate a baseline from safe local inputs. |

Add `--assets=<manifest.json>` to `baseline create` only for approved local Supabase
Storage files. `baseline create` and `baseline prepare` are local-only.

## Optional source preparation

These commands are separate from ordinary rehearsals. Configure `preparation` only after
reviewing [the standalone security contract](standalone-workflow.md).

| Command                                                       | What it does                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `npx rehearsal privacy key`                                   | Preview the owner-only pseudonym-key path.                           |
| `npx rehearsal privacy key --write`                           | Create the key once; refuses to replace an existing key.             |
| `npx rehearsal source plan`                                   | Preview the exact temporary reader, views, columns, and asset scope. |
| `npx rehearsal source apply --confirm-source-access=<sha256>` | Create only the reviewed, time-limited source access.                |
| `npx rehearsal baseline refresh`                              | Replace only the baseline from a reviewed source.                    |
| `npx rehearsal refresh`                                       | Preview a complete safe refresh of the baseline and local runtime.   |
| Add `--confirm-refresh=<sha256>`                              | Create the replacement, reset locally, and prune listed old copies.  |
| `npx rehearsal source retire`                                 | Preview exact reader/view/credential retirement.                     |
| Add `--confirm-source-retirement=<sha256>`                    | Apply that retirement plan and verify the exact object inventory.    |

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

For a reviewed Google identity, use this sequence:

1. Run a successful rehearsal, then start the persistent app:

   ```bash
   npx rehearsal open
   ```

2. Open the printed local URL and complete the normal Google sign-in. Press `Ctrl+C`
   after the callback returns. This closes only the app; the databases and Storage stay
   running with their current data.

3. Preview and confirm the reviewed association:

```bash
npx rehearsal identity plan --identity=approved-owner
npx rehearsal identity claim --identity=approved-owner \
  --confirm-identity=<sha256>
```

4. Run `npx rehearsal open` again. Sign out and sign in again so the browser receives a
   fresh session, then check the copied account. Rehearsal does not bypass application
   role checks, account blocks, RLS, or MFA.

The first command shows only hashes and declared reference counts. The second updates
only the reviewed local relational, JSON, Storage-owner, and claim locations in one
transaction. It rejects hosted database URLs, wrong or unverified people, ambiguity, and
stale confirmation digests.

If a runtime-policy seed moves with that identity, declare its `identityAssociation` in
the runtime policy. Later `verify` calls then require the transferred row instead of the
obsolete placeholder key.

## Check and inspect

| Command                            | What it does                                          |
| ---------------------------------- | ----------------------------------------------------- |
| `npx rehearsal doctor`             | Check dependencies, inputs, and safety rules.         |
| `npx rehearsal support`            | Print a privacy-safe report for a support request.    |
| `npx rehearsal explain`            | Show the exact plan without changing anything.        |
| `npx rehearsal run --dry-run`      | Show the same non-mutating plan.                      |
| `npx rehearsal candidates`         | List pending migrations and their approval digest.    |
| `npx rehearsal inspect baseline`   | Show baseline metadata without row values.            |
| `npx rehearsal inspect migrations` | Classify every historical and candidate migration.    |
| `npx rehearsal status`             | Report baseline, candidates, and local runtime state. |

State-reporting commands accept `--json` for scripts. Scripts should use the JSON fields
and process exit code, not parse human-facing text.

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

In a terminal, the guide displays candidate filenames and asks for confirmation. In a
script, copy the digest from `candidates` into `--confirm-candidates`. Adding, removing,
reordering, or editing a migration changes that digest.

`open` does not reset the runtime or apply migrations. It starts and verifies every
configured database target, runs dependent preparation commands, and launches
`application.startCommand` with the declared local environment mappings. It waits for
`application.readiness`, then stays attached until `Ctrl+C` or `Ctrl+Z`. On exit it stops
only the application process group it launched. Use `stop` separately when you also want
to stop the databases; a later `open` preserves their database and Storage changes.

## Clean up disk space

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

| Option                                 | Meaning                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `--json`                               | Return the versioned machine-readable result.                    |
| `--verbose`                            | Show more safe detail.                                           |
| `--debug`                              | Show the most diagnostic detail; still review it before sharing. |
| `--plain`                              | Disable decorative interactive prompts.                          |
| `--config=<path>`                      | Use only this config for planning and every runtime action.      |
| `--target=supabase\|postgresql`        | Choose the setup target.                                         |
| `--include-runtime`                    | Include this project's runtime in a cleanup preview.             |
| `--include-images`                     | Include older unused Supabase images in a cleanup preview.       |
| `--confirm-cleanup=<digest>`           | Confirm the exact cleanup set printed by the preview.            |
| `--confirm-source-access=<digest>`     | Confirm one exact temporary source-access plan.                  |
| `--confirm-source-retirement=<digest>` | Confirm exact source-access retirement.                          |
| `--confirm-refresh=<digest>`           | Confirm an exact refresh, runtime reset, and old-copy removal.   |
| `--identity=<name>`                    | Choose one declared local identity association.                  |
| `--confirm-identity=<digest>`          | Confirm that exact local identity plan.                          |
| `--write`                              | Apply a setup, policy, or cleanup preview.                       |

Run `npx rehearsal --help` to print the command list available in your installed version.

When a project has more than one config, pass `--config=<path>` on every command for the
non-default one. Rehearsal keeps that exact config selected through status, run, reset,
start, migrate, verify, stop, discard, and cleanup; it will not fall back to
`rehearsal.config.mjs` during a runtime action.

When the selected config declares `dependentTargets`, the ordinary `doctor`, `explain`,
`candidates`, `run`, `start`, `migrate`, `reset`, `status`, `verify`, `stop`, `discard`,
and `cleanup` commands cover the complete runtime stack. Candidate and cleanup changes
use one combined digest, so automation approves the exact cross-target set.
