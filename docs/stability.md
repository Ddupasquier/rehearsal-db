# Stability and the first stable release

Rehearsal leaves beta when the workflow it already promises is dependable. Stable
`0.1.0` does not require every planned database, desktop interface, or paid feature.

## What becomes a compatibility promise

Starting with `0.1.0`, Rehearsal treats these documented surfaces as public:

- CLI command names, flags, JSON result fields, and exit categories in
  [CLI commands](commands.md);
- `rehearsal.config.mjs` schema version 1 and the policy formats documented in
  [Configuration](configuration.md), [Sanitization](sanitization.md), and
  [Runtime and identity policies](runtime-policies.md);
- package entry points and generated declarations listed in
  [TypeScript](typescript.md);
- supported Node.js, operating-system, Docker, Supabase, and PostgreSQL boundaries in
  [COMPATIBILITY.md](https://github.com/Ddupasquier/rehearsal-db/blob/main/COMPATIBILITY.md);
- non-destructive ownership, confirmation, credential, and hosted-access guarantees in
  [Security model](security-model.md).

Patch releases may fix defects and improve messages without changing those contracts.
A future breaking contract change requires a version that clearly communicates it under
Semantic Versioning. Internal source files, terminal decoration, exact prose, temporary
file names, and undocumented package paths are not compatibility promises.

## What blocks a release candidate

An issue blocks the active release candidate when it can cause any of the following within a supported
configuration:

- data loss, credential exposure, hosted-system access, or mutation outside resources
  that Rehearsal can prove it owns;
- an incorrect baseline, migration set, verification result, or successful status;
- failure of clean installation, supported-version upgrade, restore, reset, cleanup, or
  interruption recovery;
- a documented CLI, configuration, policy, or TypeScript contract behaving differently
  from its reference;
- a supported Node.js, Supabase, PostgreSQL, macOS, or Linux path failing its maintained
  automated gate.

Cosmetic improvements, new database families, production-shaped sampling, the VS Code
extension, desktop work, and commercial capabilities do not block the first stable
release.

## Promotion sequence

1. Ship beta.18 with only stability, release-safety, upgrade, and documentation work.
2. Freeze broad feature development on the release branch.
3. Publish a release candidate from protected `main` through the reviewed npm environment.
4. Run the complete Rehearsal Test Lab gate twice from clean isolated workspaces.
5. Perform one final package-only upgrade in a real consumer. The consumer must use the
   published package rather than duplicate Rehearsal machinery.
6. Keep the current candidate available for at least seven calendar days. Restart the
   window if a blocking package change is required. The container-lifecycle correction
   in `0.1.0-rc.2` restarts this observation window.
7. Publish `0.1.0` only when no blocking issue remains and the accepted registry artifact
   matches the tested artifact exactly.

Test Lab is the primary verification system. A real consumer is the final compatibility
check, not a replacement for package-owned coverage. Real Google or GitHub consent does
not need to run on every build unless authentication behavior changes.

## npm channels

Beta and release-candidate versions publish under the `beta` tag. Before a stable
release exists, `latest` follows that reviewed prerelease so the ordinary install command
remains useful. Once stable `0.1.0` exists, `latest` stays on the stable line and `beta`
continues to identify the newest prerelease. Stable publication never rewrites the
`beta` tag.
