# Troubleshooting

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

## A port is already in use

Rerun `rehearsal setup` to select a different available block. Setup checks both active
listeners and whether every selected port can be bound, then checks again before writing.
For an existing configuration, choose unique non-privileged ports and mirror them in the
dedicated Supabase config. Do not stop an unrelated database to make defaults fit.

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

## Local authentication fails

Confirm the provider is enabled in the dedicated local Supabase config, the allowlisted
service environment file exists with owner-only permissions, and the provider callback
is the local Auth callback. Do not paste provider secrets into config or terminal output.

## Runtime changes disappeared

`reset` deliberately restores the immutable baseline. `stop` should preserve Docker
state, but runtime removal or a failed migration discards untrusted state.

Use `--debug` only after ordinary output is insufficient. Diagnostics are redacted, but
you should still review output before sharing it publicly.
