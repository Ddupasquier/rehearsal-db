# Contributing

Thank you for helping make database migration rehearsal safer.

Before opening a pull request:

1. use Node.js 24 and install with `npm ci`;
2. keep the engine generic—project table names, policies, credentials, and fixtures do
   not belong in the package;
3. preserve fail-closed behavior and add a regression test for every safety change;
4. run `npm run check`;
5. run `npm run test:fixture` when Docker is available;
6. update public contracts and the changelog when behavior changes.

Never use real production data in an issue, test, fixture, or pull request. Use small
synthetic examples. Security findings belong in private vulnerability reporting, not a
public issue.

Changes to configuration, baseline formats, CLI behavior, JSON envelopes, verification
order, or exit codes are compatibility changes. Explain the migration path.
