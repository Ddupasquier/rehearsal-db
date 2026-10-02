# CLI commands

All commands run from the consuming project root. State-reporting commands accept
`--json`; `--verbose` and `--debug` increase safe diagnostics without revealing row
values or credentials.

| Command                                                      | Mutates local state | Purpose                                                   |
| ------------------------------------------------------------ | ------------------- | --------------------------------------------------------- |
| `rehearsal` or `rehearsal guide`                             | No by default       | Open the guided, state-aware interactive home screen.     |
| `rehearsal setup`                                            | No                  | Preview safe config, local runtime, and ignore files.     |
| `rehearsal setup --write`                                    | Project files       | Create the previewed first-run scaffolding.               |
| `rehearsal init`                                             | No                  | Preview safe starter configuration.                       |
| `rehearsal init --write`                                     | Config only         | Create config without overwriting.                        |
| `rehearsal baseline prepare --records= --ledger=`            | No                  | Preview a fail-closed policy draft from local shape.      |
| `rehearsal baseline prepare --records= --ledger= --write`    | Policy only         | Write the draft without exposing row values.              |
| `rehearsal baseline create --records=<path> --ledger=<path>` | Artifact only       | Activate a baseline from explicit safe local inputs.      |
| `rehearsal doctor`                                           | No                  | Check dependencies, inputs, and safety barriers.          |
| `rehearsal support`                                          | No                  | Print a privacy-safe, copy-ready support report.          |
| `rehearsal explain`                                          | No                  | Print the immutable execution plan.                       |
| `rehearsal run --dry-run`                                    | No                  | Alias the same plan used by `explain`.                    |
| `rehearsal candidates`                                       | No                  | Print pending migrations and their exact digest.          |
| `rehearsal inspect baseline`                                 | No                  | Print data-free artifact provenance.                      |
| `rehearsal inspect migrations`                               | No                  | Classify each migration.                                  |
| `rehearsal run --confirm-candidates=<sha256>`                | Yes, local only     | Reset, apply exact candidates, verify, and run app proof. |
| `rehearsal start`                                            | Runtime only        | Start a verified runtime without resetting its data.      |
| `rehearsal migrate --confirm-candidates=<sha256>`            | Yes, local only     | Apply the exact suffix without resetting current data.    |
| `rehearsal verify`                                           | No data mutation    | Verify the current local runtime and receipt.             |
| `rehearsal status`                                           | No                  | Report runtime, baseline, and candidate state.            |
| `rehearsal reset`                                            | Yes, local only     | Replace runtime data with the immutable baseline.         |
| `rehearsal stop`                                             | Runtime only        | Stop this project's local services.                       |
| `rehearsal discard`                                          | Yes, local only     | Remove only this project's disposable runtime and volume. |

In an interactive terminal, `run` and `migrate` display the candidate files and ask for
confirmation before touching the runtime. In automation, they require the digest from
the current candidate set. Any added, removed, reordered, or edited migration changes
the digest and invalidates either form of confirmation.

`baseline create` never extracts data. The NDJSON and migration-ledger files must already
exist inside the project and be safe to retain. Add `--assets=<manifest.json>` to include
bounded local Storage bytes; every manifest `file` must also remain inside the project.
The guided home screen scans a bounded set of small project-local JSON and NDJSON files,
skips generated and private runtime directories, and offers structurally matching paths
so they do not need to be memorized. It never displays row values. Before activation it
validates the selected files and referenced assets, shows row, table, migration, and asset
counts, and asks for confirmation. Invalid input returns to the guide without writing.

The guide is a persistent session: after setup, policy review, baseline creation, or a
runtime action it re-reads project state and offers the next relevant action. Generated
policy drafts can be completed interactively without editing JSON. Each column still
receives explicit action, generated, identity, and foreign-key decisions. A human may
apply the displayed safe preset to a table, then review only selected exceptions; the
guide never silently applies a preset.

`baseline prepare` reads only table and column names from the NDJSON records; row values
are never included in its result. Its generated policy deliberately marks every column
decision `REVIEW REQUIRED` and cannot be activated until a human completes the metadata
and removes the `draft` marker. Rehearsal binds the reviewed policy checksum to the
baseline and rejects later policy changes during planning and restore.

Automation should use `--json` and inspect both exit status and the versioned envelope.
Exit-code meanings are documented in the root README. Scripts must not parse human text.
When standard input or output is not an interactive terminal, bare `rehearsal` prints
help instead of prompting. Use `--plain` to disable decorative terminal styling.
`NO_COLOR` also selects the plain numbered interface. Both interactive modes preserve
the same safety decisions and cancellation behavior.

At any guided prompt, `Ctrl+Z` exits the entire Rehearsal session and restores the
terminal. It does not leave a suspended process behind.

`setup` chooses an available local port block and generates a conservative Supabase
configuration with hosted access and optional networked services disabled. It does not
overwrite an existing Rehearsal config, dedicated Supabase config, or concurrently
changed `.gitignore`. After writing, it includes a Doctor readiness summary. `init`
remains available for config-only/manual onboarding.

`support` reports the Rehearsal, Node.js, npm, Supabase CLI, Docker client, and Docker
server versions plus readiness check statuses. It can run before configuration exists.
The report deliberately excludes project names and paths, row values, credentials,
migration SQL, baseline identifiers, and raw command output. It reports only the count
of quarantined hosted variables, never their names. Always review it before sharing.
