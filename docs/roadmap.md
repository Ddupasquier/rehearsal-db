# Next steps

Rehearsal core **1.0.2 is available on
[npm](https://www.npmjs.com/package/@rehearsal-db/core)** for guided Supabase and
ordinary PostgreSQL migration rehearsals. The [free VS Code Starter 0.1.23 preview](vscode.md)
adds a visual workbench. Neither requires a purchase or account.

The standalone workflow keeps the rehearsal engine in the package while application
meaning and privacy decisions remain project-owned. The sequence below explains its
dependencies, not a list of features withheld from the published release.

## Standalone workflow

The implementation sequence is dependency-driven:

1. exact temporary source access and retirement;
2. bounded coherent extraction and executable privacy rules;
3. approved Storage assets and declarative restore prerequisites;
4. verified local identity association;
5. ordinary application launch and meaningful positive/negative proofs;
6. onboarding, upgrade safety, and exact packaged-artifact acceptance.

These capabilities stay behind separate review boundaries. Normal runtime commands never
receive source credentials. Source-side writes, package publication, consumer cleanup,
and real provider observation each require their own authorization.

See the [standalone workflow](standalone-workflow.md) for the supported contract.
Track the full breakdown in
[standalone roadmap issue #38](https://github.com/Ddupasquier/rehearsal-db/issues/38).
For questions or feature requests, use
[GitHub issues](https://github.com/Ddupasquier/rehearsal-db/issues).

## Acceptance still required

These are verification requirements, not a live checklist of unfinished releases or
consumer migrations. Record the observed results for each exact candidate separately.

- Install the exact packed candidate in clean Supabase and PostgreSQL consumers.
- Exercise two unrelated synthetic schemas, bounded large data, interruption, drift,
  invalid migrations, identities, images, persistence, reset, and cleanup.
- Run the released package in the real reporting consumer and record positives and
  negatives.
- Directly observe any claimed Google account-picker/callback. Record
  unfamiliar-developer onboarding behavior when a tester is available; automation cannot
  invent either kind of human evidence.
- Remove consumer integration code only after its replacement passes and that deletion
  is separately approved.

## Later database targets

After the PostgreSQL family is stable in real projects, evaluate individual PostgreSQL
services. MySQL, MongoDB, and unrelated database families require different migration,
restore, and safety behavior and remain out of scope.
