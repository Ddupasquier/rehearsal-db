# Release process

Rehearsal publishes from a reviewed GitHub release through the protected `npm`
environment. The workflow builds and hashes the candidate before the environment
approval gate, then publishes those exact bytes with npm provenance. A local working
tree is never the release source.

`package.json` currently contains `"private": true`, so an accidental tag or GitHub
release cannot publish the package while the first beta is being prepared.

## One-time first-package bootstrap

npm trusted publishing and staged publishing are package-level settings, so they cannot
be configured until `@rehearsal/db` exists in the registry. The first public version has
a deliberately narrower bootstrap path:

1. The npm owner enables 2FA and creates or confirms the public `@rehearsal` organization
   scope. Do not send a password, OTP, recovery code, or access token to another person.
2. After the reviewed release change reaches protected `main`, the owner creates the
   exact `v0.1.0-beta.0` GitHub release and marks it as a prerelease. The prepare job runs without npm credentials,
   packs the tag, and uploads its versioned tarball plus SHA-1 and SHA-256 metadata. The
   publish job waits at the protected environment and cannot run yet.
3. The owner downloads or inspects that prepared artifact, confirms its version and
   checksum, and explicitly authorizes those exact bytes.
4. Only then, the owner creates a short-lived granular npm token with read/write access
   limited to the `@rehearsal` scope and **Bypass 2FA** enabled. npm requires that bypass
   for a non-interactive first publish; the environment approval remains the human
   release gate. Store the token only as the `NPM_TOKEN` secret in the protected GitHub
   `npm` environment.
5. The owner approves the waiting `npm` deployment. GitHub Actions publishes the exact
   uploaded tarball with provenance. The workflow
   refuses to use the bootstrap secret for any version other than `0.1.0-beta.0`.
6. Immediately after the registry verification passes, the owner deletes the GitHub
   environment secret and revokes the temporary npm token.
7. From the new package's npm settings, configure the trusted GitHub Actions publisher
   for repository `Ddupasquier/rehearsal-db`, workflow `publish.yml`, and environment
   `npm`. Allow direct `npm publish` for this workflow because the protected GitHub
   environment supplies the human gate. A later switch to npm staged publication must
   change and prove the workflow before narrowing the trusted publisher permission.
8. Set package publishing access to require 2FA and disallow traditional tokens.

This bootstrap token is a one-release compromise imposed by npm's package-creation
boundary. It is never committed, printed, copied into a ticket, or retained for later
versions.

## Every release candidate

1. Start from protected `main` on a dedicated ticketed release branch.
2. Verify the exact version, changelog, compatibility notes, and packed file list.
3. Run unit and contract tests, formatting, package-content and secret audits,
   dependency audit, clean tarball installation, and the installed Docker fixture.
4. Have a developer unfamiliar with the implementing project follow the clean-project
   onboarding. Correct and retest the first confusing, missing, or wrong instruction.
5. Change `private` to `false` only in the reviewed release change.
6. Record the exact tarball filename, SHA-1, SHA-256, allowlisted files, unpacked size,
   executable, and zero-runtime-dependency result.
7. Obtain explicit publication authorization for that exact version and artifact.
8. Merge the approved release commit through protected `main` and create the exact
   `v<package-version>` tag and GitHub release.
9. Review and approve the protected `npm` deployment only after its prepare job matches
   the approved version and checksum.
10. Verify public visibility, ownership, provenance, registry SHA-1, README rendering,
    exact-version clean installation, CLI execution, signatures, and the unrelated
    installed Docker fixture.
11. Replace consuming projects' temporary Git/archive references only on their own
    protected integration branches and rerun their complete verification.

The workflow publishes prereleases under the `beta` dist-tag and refuses a stable
version. A stable tag requires a later contract, compatibility, and release decision.

Creating the repository, passing CI, extracting the engine, merging a release branch,
or creating a tag does not authorize npm publication. Publication requires explicit
authorization for the exact packed artifact, and the protected GitHub environment
supplies the final human gate.
