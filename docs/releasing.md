# Maintainers: publishing Rehearsal

**Audience: Rehearsal maintainers publishing a release.** To install or update
Rehearsal in your own project, use [Releases and updates](updating.md).
The publisher controls below are not steps that ordinary users need to perform.

This page defines required release controls, not a certification that a publisher is
currently ready. Verify the live repository, trusted-publisher identity and approval
settings before publishing; making a repository public does not prove those controls.

Rehearsal releases require reviewed **public release source**, a verified human
approval gate, and publication of the exact tested bytes with npm provenance.
Uncommitted engineering work is not a publication source. A workflow's `environment: npm`
line alone does not establish an approval gate.

Before publication, verify the live repository protections and environment settings.
Missing, private, inaccessible or ambiguous settings must stop publication, not fall
back to a token or disable provenance. The release preflight described below enforces
that refusal; an actual held approval and the npm account settings still need direct
verification. A local working tree is never the release source.

This runbook describes the current controls. Historical candidates and release incidents
belong in [release history](https://github.com/Ddupasquier/rehearsal-db/releases) and
[issues](https://github.com/Ddupasquier/rehearsal-db/issues), not the installation path.

## Trusted publication boundary

The package repository URL, npm trusted publisher and workflow must identify the
same reviewed public repository, `Ddupasquier/rehearsal-db`, `publish.yml` workflow and
`npm` environment. Do not assume account settings or protections remain valid after
a visibility or repository change.

The publish job uses a short-lived GitHub OIDC identity after human approval. It
does not read an npm token or retain a registry credential. Verify the live npm
settings require 2FA and reject bypass credentials. The absence of a token in GitHub
does not prove an older token was revoked.

Public npm packages can be installed while their source repository is private, but
npm does not support provenance generation from a private repository. Moving source
private therefore cannot preserve this release contract unchanged. Keep the reviewed
release source public; never silently remove provenance. See
[npm's trusted-publisher guidance](https://docs.npmjs.com/trusted-publishers/).

Bootstrap credentials are not part of the maintained release architecture. Any historical
bootstrap credential must remain removed from GitHub and revoked at npm; this workflow
cannot consume it. Do not replace a failing trusted publisher with a stored token.

A failed candidate does not permit moving or deleting its release tag. If its pinned
workflow needs a source correction, prepare a new version and artifact through the same
checks; preserve the failed candidate's history and clearly distinguish GitHub assets
from an npm-published version. A workflow rerun cannot acquire a later main-only fix.

Direct `npm publish` is allowed only through the verified trusted publisher and human
gate. A later switch to npm staged publication must change and prove the workflow first.

## Required control checks

The release workflow must check live controls before preparing a candidate and again before
publishing or repairing dist-tags. It must verify:

- the exact repository, workflow, event, commit and release/main reference;
- public, active source with an enforced main-branch review/check ruleset and
  protected release tags;
- the `npm` environment's configured human reviewer and exact allowed branch/tag
  policies; and
- complete, bounded API responses, with no unaccounted-for control accepted.

These checks use read-only metadata and the workflow's short-lived GitHub token, not
an administrative PAT. They cannot prove that a human actually inspected an artifact,
that a deployment waited for approval, or that npm's external trust configuration is
correct. Demonstrate a held approval, refusal without approval, and successful exact
artifact verification before enabling a new publisher. For a solo maintainer, the
configured owner can approve a deployment; do not call this independent two-person
review or require an unavailable second person without a separate decision.

After proving the immutable source tag, exact equality with the verified protected-main
commit establishes ancestry without a comparison request. Older source commits require
an unpaged, bounded GitHub comparison reporting ahead, zero behind and that exact source
as the merge base. This checks ancestry summary facts, not an unlimited list of commits;
pagination, unavailable metadata and ambiguous ancestry remain refusals.

### Hidden ruleset metadata and owner attestation

GitHub omits ruleset `bypass_actors` for a read-only workflow token. Granting it
`contents: write` does not solve this limitation, and the release does not use an
administrative token. Instead, `.github/release-controls.json` records a bounded,
unsigned owner observation of the two required rulesets. To refresh it, run
`node scripts/release/observe_controls.mjs` with the existing owner-authenticated
GitHub CLI, review its public JSON output, and explicitly replace the tracked file.
This command changes no GitHub settings. It refuses hidden or nonempty bypass actors
and requires that the repository owner is a configured npm reviewer.

CI compares live repository/environment identities, required public controls, ruleset
IDs, creation/update timestamps and hashes with that record. This is a drift check,
not authenticated human approval. Release preparation also rejects observations older
than seven days or in the future. Public fields and timestamps must still match when
bypass metadata is hidden; an explicitly malformed or nonempty bypass list always
refuses publication.

The prepare job displays the exact package version, SHA-256, source commit and run
in its summary. Review the candidate and passed checks, then choose **Review
deployments → npm → Approve and deploy**. That ordinary GitHub approval is the
publication authorization: no separate chat approval, secret phrase or pasted block
is required. Comments are optional.

GitHub's enforced, no-bypass `npm` environment admits the publishing job only after
its protection rules pass. The workflow also reads this run's actual review history
to corroborate the configured human owner's approval for the exact npm environment.
That history does not identify an approval's run attempt or verify artifact bytes;
the workflow independently checks the prepared tarball's hashes before publication,
and freshly downloads/checks registry bytes before tag repair. Reruns keep the same
source/ref and remain subject to GitHub's environment controls; old review text is
never presented as proof of new bytes or a fresh attempt.

The unsigned settings record remains a bounded drift check, not authorization or
cryptographic proof of current hidden bypass settings. Refresh its owner observation
when stale or changed; never advance its timestamp without reading the settings.
No settings check eliminates a later administrator change or check-to-use race.
See [GitHub's deployment review](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments),
[ruleset metadata boundary](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)
and [workflow approval history](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run).

Keep customer evidence, credentials, runtime data and the internal tracker out of public
source and package artifacts. Preserve existing MIT notices and source/build inputs
needed to reproduce the released package. Repository privacy does not withdraw MIT
rights or recall downloaded npm/VSIX files.

Documentation is built from `docs/` in this repository and hosted at
<https://ddupasquier.github.io/rehearsal-db/>. There is no separate public mirror or
release-source migration.

## Every release candidate

1. Start from protected `main` on a dedicated ticketed release branch.
2. Verify the exact version, changelog, compatibility notes, and packed file list.
   Reconcile the core, VS Code extension and Test Lab READMEs and affected guides with
   their actual published versions and contracts. Keep candidate availability explicit,
   link to the owning installation/update guide instead of duplicating version lists,
   and retain dated historical evidence without presenting it as current acceptance.
3. Run `npm run release:verify`. It performs the package checks and every
   installed-consumer scenario against one tarball, then records the exact package
   version, SHA-256, environment, commands, timings, and results in
   `test-results/release-gate/`. Run the dependency audit separately.
4. When an unfamiliar developer is available, have them follow clean-project onboarding.
   Correct and retest the first confusing, missing, or wrong instruction. Record when
   this human observation was unavailable; automated checks must not impersonate it.
5. Confirm package metadata keeps `private: false` for this public npm package. Any
   metadata change belongs in the reviewed release change; do not toggle visibility
   or package privacy as an incidental publishing step.
6. Record the exact tarball filename, SHA-1, SHA-256, allowlisted files, unpacked size,
   executable, declared runtime dependency inventory, and dependency audit result.
7. Review the release change and its exact artifact evidence.
8. Merge the reviewed release commit through protected `main` and create the exact
   `v<package-version>` tag and GitHub release.
9. Authorize publication once, in the protected `npm` deployment review, after its
   prepare job matches the tested version and checksum. No comment or chat approval
   is required.
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

### Optional remote verification

When local resource guards refuse a heavy run, the existing full release check can
run on an isolated GitHub-hosted runner instead:

```bash
gh workflow run verify.yml --ref YOUR_REVIEWED_RELEASE_BRANCH -f exact_release=true
```

This manual-only option runs `npm run release:verify` and the production dependency
audit. It adds no required branch check and has no publishing permission or npm
environment. It does not bypass a local resource guard or start local services.
The other existing verification jobs still run normally.

Download the run's `exact-release-<commit>-<attempt>` artifact within seven days.
It contains only the frozen tarball and release reports. Require a successful job
and all nine passed stages in `acceptance.json`, match the reviewed source commit
and tarball SHA-256, then use those exact bytes for consumer checks and publication
authorization. Reports retained after failure are failure evidence, not approval.
This is an execution option for the same release requirements, not a substitute for
consumer acceptance, supported-platform observations or human publication approval.

The workflow publishes beta and release-candidate versions under the `beta` dist-tag.
While Rehearsal has no stable release, it also moves `latest` to the same reviewed
prerelease. This keeps the npm package page and the ordinary
`npm install @rehearsal-db/core` command current. A stable version publishes under
`latest` without changing `beta`; after that point, later prereleases update only `beta`
and cannot replace the stable `latest` line. The GitHub prerelease setting must agree
with the package version or preparation fails.

The reviewed workflow must serialize publication and tag repair in one non-cancelling mutation concurrency group, so
different versions cannot overwrite a stable channel using an overlapping stale read.
This is mutual exclusion, not a guaranteed ordered queue: reconcile a superseded
pending workflow before deliberately requesting another run.

The objective promotion checklist and compatibility boundary live in
[Stability and release verification](stability.md).

The trusted publisher allows `npm dist-tag` only so this workflow can maintain those two
tags without a stored npm token. A manual workflow run from `main` can repair the correct
channel for the exact version currently recorded in `package.json`; it cannot publish a
package or select a different version. The `npm` environment must supply the verified
human approval gate; a workflow reference to that environment is not sufficient.

Creating the repository, passing CI, extracting the engine, merging a release branch,
or creating a tag does not authorize npm publication. The protected GitHub deployment
review supplies the single human authorization for the exact displayed artifact.
