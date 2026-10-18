# Rehearsal compatibility policy

Starting with `1.0.0`, documented public contracts are backward compatible throughout
the `1.x` line. Minor releases may add compatible capabilities; patch releases fix
defects. An intentional breaking change requires a new major version, a changelog
entry and a migration path.

Historical `0.x` releases allowed intentional breaking changes in minor versions,
with changelog and migration guidance. Their patch releases remain compatible within
their minor line. Existing artifacts and granted license rights are unchanged.

The following are compatibility contracts for published releases:

- configuration property names, types, defaults, validation, and schema version;
- baseline format and checksum meaning;
- ordered migration digest semantics and classifications;
- CLI command names, flags, state-changing behavior, and exit codes;
- versioned JSON result and error envelopes;
- the meaning and ordering of verification gates.

A change to any of those requires either a compatible extension or a deliberate version
transition. Rehearsal must never silently reinterpret an old config, baseline, digest,
or successful verification receipt.

The first `1.0.0` release requires external beta evidence, a support policy and the
settled public API described in [the stability policy](docs/stability.md). Supporting
additional database families, package managers or operating systems is not implied.

Rehearsal supports maintained even-numbered Node.js release lines that pass its CI
matrix. Rehearsal 1.0 supports Node.js 22, 24, and 26; Node.js 24 LTS is the recommended
default and the release-build runtime. End-of-life and odd-numbered Node.js releases are
not supported. A future release may remove a Node.js line after its upstream end-of-life
date, with that change called out in the changelog.

The npm install hook may create project scaffolding only when it proves one application
root. Ordinary npm application installs are covered. A workspace is automatic only when
one declaring consumer is already visible in its manifest or lockfile; npm can save a
new `--workspace` declaration after dependency hooks run, so a first workspace install
may use the guided fallback. pnpm and Yarn install layouts are not yet an
automatic-generation contract. Run `npx rehearsal` from the application directory for
all skipped cases. Global, cache, temporary `npx`, and ambiguous multi-application
workspace installs do not receive files.

The PostgreSQL target covers timestamped SQL migrations running in a dedicated local
`postgres` Docker image. Runtime commands reject hosted connection strings and existing
unmanaged servers. The separately opted-in PostgreSQL preparation boundary may use a
reviewed, short-lived source reader; this does not make a hosted database a runtime
target. ORM-specific nested migration formats remain unsupported. Supabase Storage and
Auth behavior apply only to the Supabase runtime.

A primary config may declare flat dependent PostgreSQL or Supabase targets. Each target
must have its own complete config, immutable baseline, project ID, ports, environment
file, and artifact directory. Nested dependency graphs and shared runtime ownership are
not supported.

Executable privacy policy version 2, source-access policy version 1, runtime policy
version 1, and identity policy version 1 are strict declarative contracts. Unknown
fields fail closed. They do not imply support for arbitrary transformations, SQL,
provider administration, consent decisions, or every PostgreSQL extension.
