# Stability and release verification

Rehearsal core **1.1.0 is published** on
[npm](https://www.npmjs.com/package/@rehearsal-db/core). This page defines its
compatibility promise and the verification policy for releases; it is not an
unfinished launch checklist. Stable core does not require every planned database,
editor interface, or paid feature.

The compatibility promise began with **1.0.0**. The separate
[VS Code Starter 0.1.23 preview](vscode.md) has its own editor acceptance and does
not turn a core release into a completed accessibility or provider walkthrough.

## What becomes a compatibility promise

Starting with `1.0.0`, Rehearsal treats these documented surfaces as public:

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

Promotion is evidence-based, not a calendar countdown. The initial seven-day RC
wait was replaced after owner review; passing time alone cannot make a candidate
ready. The sequence below is policy, not a claim that its checks have passed.

1. Freeze broad feature development on the release branch.
2. Select one immutable candidate from the reviewed release branch. A release candidate
   may be published from protected `main` through the reviewed npm environment; another
   prerelease is not required solely to verify the final stable tarball.
3. Run the complete Rehearsal Test Lab gate twice from clean isolated workspaces.
4. Perform one final package-only check in a real consumer using the exact frozen
   stable tarball, not duplicate Rehearsal machinery. Preserve its reviewed settings
   and persistent data; a package check does not require resetting its databases.
5. Review reports and existing scheduled Test Lab results for unresolved blockers.
   A blocking correction needs its affected acceptance repeated against the exact
   corrected candidate. Reuse sufficient unchanged evidence with its original scope;
   do not relabel old or unavailable manual checks as new results. No minimum number
   of calendar days replaces these checks.
6. Publish the selected stable version only when no blocking issue remains and the exact tarball has passed
   the required release checks and consumer acceptance. The protected GitHub npm
   review is the single human authorization for its displayed exact version and
   checksum; no separate chat approval or pasted phrase is required.
7. Independently verify registry bytes, provenance, signatures and channels, then
   confirm the published package in the real consumer. Promotion is complete only
   when the published artifact matches the tested tarball and these checks pass.

Test Lab is the primary verification system. A real consumer is the final compatibility
check, not a replacement for package-owned coverage. Real Google or GitHub consent does
not need to run on every build unless authentication behavior changes.

## npm channels

Beta and release-candidate versions publish under the `beta` tag. Before a stable
release exists, `latest` follows that reviewed prerelease so the ordinary install command
remains useful. Once stable `1.0.0` exists, `latest` stays on the stable line and `beta`
continues to identify the newest prerelease. Stable publication never rewrites the
`beta` tag.

## Upgrading from a 0.1 release candidate

The first stable release preserves rc.10's database runtime and schema formats and
corrects invalid-command diagnostics. A package upgrade
does not require resetting a sandbox or replacing its reviewed configuration, key or
baseline. Automatic compatible updates do not cross the 0.x-to-1.x version boundary;
review the changelog and deliberately select the stable version:

```bash
npm install --save-dev --save-exact @rehearsal-db/core@1.1.0
npx --no-install rehearsal --version
npx --no-install rehearsal doctor
```

Use the project's existing package manager and dependency location. Review its lockfile
and readiness output before the next sandbox operation; do not reset data just to update.
