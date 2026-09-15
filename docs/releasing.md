# Release process

Rehearsal publishes from a reviewed GitHub release through the protected `npm`
environment. The workflow builds and hashes the candidate before the environment
approval gate, then publishes those exact bytes with npm provenance. A local working
tree is never the release source.

`0.1.0-beta.0` was prepared under the unavailable `@rehearsal` npm scope and was never
published. `0.1.0-beta.1` supersedes that candidate under `@rehearsal-db/core` without
rewriting the earlier Git tag or GitHub prerelease.

## Trusted publication boundary

`@rehearsal-db/core` trusts only the GitHub Actions publisher for repository
`Ddupasquier/rehearsal-db`, workflow `publish.yml`, and environment `npm`. The publish job
requests a short-lived GitHub OIDC identity after the protected environment approval;
it does not read an npm token or retain a registry credential. Package publishing access
requires 2FA and disallows bypass tokens.

The initial `0.1.0-beta.1` package creation required a one-time bootstrap credential
because npm cannot configure a trusted publisher before a package exists. That
credential is not part of the maintained release architecture: it was deleted from the
GitHub environment after publication, must remain revoked at npm, and cannot be consumed
by this workflow.

Direct `npm publish` is allowed only for this trusted publisher because the protected
GitHub `npm` environment supplies the human gate. A later switch to npm staged
publication must change and prove the workflow before narrowing that permission.

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
    installed Docker fixture. Allow up to six minutes for a first package to propagate
    through the public registry before classifying a missing packument as a release
    failure.
11. Replace consuming projects' temporary Git/archive references only on their own
    protected integration branches and rerun their complete verification.

The workflow publishes prereleases under the `beta` dist-tag and refuses a stable
version. A stable tag requires a later contract, compatibility, and release decision.

Creating the repository, passing CI, extracting the engine, merging a release branch,
or creating a tag does not authorize npm publication. Publication requires explicit
authorization for the exact packed artifact, and the protected GitHub environment
supplies the final human gate.
