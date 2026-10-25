/** Stable version and help handlers with no project-side effects. */

import { REHEARSAL_VERSION } from "../shared/diagnostics.mjs";
import { exactCommands, textCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";

export const usage = () => `Usage: rehearsal <command> [options]

Commands:
  version                     Print the installed Rehearsal version
  guide                       Open the interactive, state-aware home screen
  setup [--target=] [--write] Preview or create safe first-run scaffolding
  init [--write]              Preview or explicitly write safe starter config
  baseline prepare --records= --ledger= [--write] Create a fail-closed policy draft
  baseline create --records= --ledger= [--assets=] Create a baseline from safe local inputs
  privacy key [--write]       Preview or create the owner-only pseudonym key
  source plan                 Preview exact, temporary source access
  source apply --confirm-source-access= Apply the reviewed source-access plan
  source retire [--confirm-source-retirement=] Preview or retire exact source access
  baseline refresh            Replace only the baseline from a reviewed source
  refresh [--confirm-refresh=] Replace the database copy, reset locally, and remove old copies
  identity plan --identity=   Preview an approved local identity association
  identity claim --identity= --confirm-identity= Apply the exact local association
  identity connect [--identity=] Keep the app open, detect sign-in, and connect once
  doctor                     Check whether Rehearsal is safe and ready
  discover                   Inspect project metadata and explain setup suggestions
  configuration              Inspect the exact active config and editable field metadata
  configuration review --proposal= Validate a fingerprint-bound proposal without writing
  support                    Print a safe, copy-ready support report
  activity                   Report idle, busy, stale, or invalid operation state
  environments               List owned runtimes and Docker capacity without starting it
  resources                  Browse individual images, volumes, and other local resources
  managed example            Print a synthetic-only managed protocol request
  managed plan --proposal=    Review synthetic request, quota and consent digest
  managed prototype --proposal= --confirm-managed= Exercise bounded local worker and cleanup
  managed recover --proposal= --confirm-managed= Recover one exactly owned quarantined synthetic workspace
  workloads                  Inspect participating local lifecycle queue metadata
  workloads recover --confirm-workloads= Recover reviewed dead-holder metadata only
  explain                    Show the immutable execution plan
  run --dry-run              Alias the exact explain plan without mutations
  run --confirm-candidates=  Execute reset, migration, and verification locally
  open                       Start the runtime and keep the application open
  candidates                 Show the exact pending migration digest
  inspect baseline           Show verified baseline provenance
  inspect sizing             Review baseline size, shape fidelity and COPY cache policy
  inspect migrations         Classify represented, applied, and candidate migrations
  inspect plan               Review ordered migrations, required dependencies, and warnings
  inspect insights           Review bounded static SQL warnings; never a safety verdict
  inspect impact             Preview aggregate measurements for one explicit --target
  measure impact             Measure reviewed aggregates on that running local sandbox
  start                      Start an existing verified local runtime
  migrate --confirm-candidates= Apply the exact candidate suffix without resetting
  reset                      Restore and verify the immutable local baseline
  status                     Report the disposable local runtime state
  stop                       Stop only this project's local runtime
  stop-stale [--confirm-stop=] Preview or stop exact long-running owned environments
  discard                    Remove only this project's disposable runtime
  cleanup [--include-runtime] [--include-images] [--write] [--confirm-cleanup=]
                             Preview or apply conservative disk cleanup
  cleanup containers --proposal= [--write] [--confirm-cleanup=]
                             Retire exact completed containers while preserving volumes
  verify                     Verify the current local Rehearsal runtime

Options: --help, -h --version, -V --json --verbose --debug --plain
         --config=<path> --target=<provider for setup; configured name for runtime>
         --confirm-candidates=<whole-plan digest for run, migrate, or measure impact>
         --confirm-source-access=<digest> --confirm-source-retirement=<digest>
         --confirm-refresh=<digest>`;

export const createBasicCommandHandlers = (): readonly CommandDefinition[] => [
  {
    id: "version",
    matches: ({ command, flags }) => command === "version" || flags.version,
    handle: async ({ flags }) =>
      textCommand(
        flags.json
          ? JSON.stringify(
              { name: "@rehearsal-db/core", version: REHEARSAL_VERSION },
              null,
              2,
            )
          : REHEARSAL_VERSION,
      ),
  },
  {
    ...exactCommands("help", ["help"], async () => textCommand(usage())),
    matches: ({ command, flags }) => command === "help" || flags.help,
  },
];
