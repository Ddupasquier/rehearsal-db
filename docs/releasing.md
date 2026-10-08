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
3. Run `npm run release:verify`. It performs the package checks and every
   installed-consumer scenario against one tarball, then records the exact package
   version, SHA-256, environment, commands, timings, and results in
   `test-results/release-gate/`. Run the dependency audit separately.
4. When an unfamiliar developer is available, have them follow clean-project onboarding.
   Correct and retest the first confusing, missing, or wrong instruction. Record when
   this human observation was unavailable; automated checks must not impersonate it.
5. Change `private` to `false` only in the reviewed release change.
6. Record the exact tarball filename, SHA-1, SHA-256, allowlisted files, unpacked size,
   executable, declared runtime dependency inventory, and dependency audit result.
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

The independent Rehearsal Test Lab is the primary pre-release consumer environment.
Real product integrations provide additional compatibility evidence; they do not
replace the package-owned release gate or Test Lab.

The workflow publishes prereleases under the `beta` dist-tag and refuses a stable
version. While Rehearsal has no stable release, the workflow also moves `latest` to the
same reviewed beta. This keeps the npm package page and the ordinary
`npm install @rehearsal-db/core` command current. When Rehearsal gains a stable release,
`latest` must switch to the stable line while `beta` continues to identify prereleases.

The trusted publisher allows `npm dist-tag` only so this workflow can maintain those two
tags without a stored npm token. A manual workflow run from `main` can repair the tags
for the exact prerelease version currently recorded in `package.json`; it cannot publish
a package or select a different version. The protected `npm` environment still supplies
the human approval gate.

Creating the repository, passing CI, extracting the engine, merging a release branch,
or creating a tag does not authorize npm publication. Publication requires explicit
authorization for the exact packed artifact, and the protected GitHub environment
supplies the final human gate.
