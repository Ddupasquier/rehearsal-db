# CLI commands

All commands run from the consuming project root. State-reporting commands accept
`--json`; `--verbose` and `--debug` increase safe diagnostics without revealing row
values or credentials.

| Command                                                      | Mutates local state | Purpose                                                   |
| ------------------------------------------------------------ | ------------------- | --------------------------------------------------------- |
| `rehearsal init`                                             | No                  | Preview safe starter configuration.                       |
| `rehearsal init --write`                                     | Config only         | Create config without overwriting.                        |
| `rehearsal baseline create --records=<path> --ledger=<path>` | Artifact only       | Activate a baseline from explicit safe local inputs.      |
| `rehearsal doctor`                                           | No                  | Check dependencies, inputs, and safety barriers.          |
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

`run` requires the digest from the current candidate set. Any added, removed, reordered,
or edited migration changes the digest and invalidates the confirmation.

`baseline create` never extracts data. The NDJSON and migration-ledger files must already
exist inside the project and be safe to retain. Add `--assets=<manifest.json>` to include
bounded local Storage bytes; every manifest `file` must also remain inside the project.

Automation should use `--json` and inspect both exit status and the versioned envelope.
Exit-code meanings are documented in the root README. Scripts must not parse human text.
