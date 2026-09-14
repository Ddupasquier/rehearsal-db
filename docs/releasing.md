# Release process

The repository uses npm trusted publishing with GitHub Actions provenance. It does not
store or request a long-lived npm token.

The publication workflow is intentionally dormant during extraction: `package.json`
contains `"private": true`, so even an accidental GitHub release cannot publish it.

For an explicitly authorized release:

1. verify the exact version, changelog, compatibility notes, and packed file list;
2. run the complete supported-platform CI and installed-fixture proof;
3. configure the `@rehearsal` npm scope and trusted publisher for this repository and
   workflow;
4. protect the GitHub `npm` environment with required reviewers;
5. change `private` to `false` only in the reviewed release change;
6. merge the approved release commit and create its exact signed tag;
7. publish a GitHub release for that tag;
8. verify npm provenance, tarball contents, CLI installation, and package ownership;
9. restore the release ticket to blocked or failed if any post-publication check differs.

Creating the repository, passing CI, or extracting the engine does not authorize an npm
release. Publication requires separate approval for the exact version and artifact.
