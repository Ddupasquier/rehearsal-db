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
Storage files. Baseline commands never extract data or connect to another database.

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

## Run and manage the local database

| Command                                               | What it does                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| `npx rehearsal run --confirm-candidates=<sha256>`     | Reset, apply the exact candidates, verify, and run the app proof.   |
| `npx rehearsal migrate --confirm-candidates=<sha256>` | Apply the exact candidates without resetting existing runtime data. |
| `npx rehearsal start`                                 | Start an existing verified runtime.                                 |
| `npx rehearsal verify`                                | Verify the current runtime and receipt.                             |
| `npx rehearsal reset`                                 | Discard runtime edits and restore the baseline.                     |
| `npx rehearsal stop`                                  | Stop the runtime but keep its local state.                          |
| `npx rehearsal discard`                               | Remove this project's disposable runtime and volume.                |

In a terminal, the guide displays candidate filenames and asks for confirmation. In a
script, copy the digest from `candidates` into `--confirm-candidates`. Adding, removing,
reordering, or editing a migration changes that digest.

## Common options

| Option                          | Meaning                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| `--json`                        | Return the versioned machine-readable result.                    |
| `--verbose`                     | Show more safe detail.                                           |
| `--debug`                       | Show the most diagnostic detail; still review it before sharing. |
| `--plain`                       | Disable decorative interactive prompts.                          |
| `--config=<path>`               | Use a specific config file inside the project.                   |
| `--target=supabase\|postgresql` | Choose the setup target.                                         |

Run `npx rehearsal --help` to print the command list available in your installed version.
