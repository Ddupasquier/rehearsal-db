# Baselines

A baseline is an immutable, digest-addressed starting point for a disposable runtime.
It binds sanitized rows, represented migration bytes, optional Storage assets, schema
evidence, policy identity, and verification metadata.

## Generation lifecycle

New content is written to a private building directory. Individual files are checksummed
and made read-only. A complete manifest is verified before an atomic `current` symlink
selects the generation. An interrupted build cannot replace the active baseline.

## Migration lineage

The manifest records the exact ordered historical prefix. A migration with the same
timestamp but different bytes is modified history, not a candidate. New migrations must
form an ordered suffix. Candidate confirmation binds the exact filenames and checksums.

## Restore lifecycle

`reset` destroys only the explicitly labelled local runtime, replays the represented
schema, streams sanitized rows, restores checksummed local Storage assets, reapplies
normal enforcement, and verifies counts and foreign keys. A failure removes trust and
cannot leave a successful receipt.

## Persistence model

The baseline never changes during normal use. The restored runtime is writable and its
changes persist across application restarts while the local containers remain. Run
`reset` to discard sandbox changes and return to the exact baseline.

Treat baseline files as sensitive even after sanitization: owner-only permissions,
ignored paths, encrypted disks, bounded retention, and explicit deletion are prudent.
