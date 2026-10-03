# Project runtime adapters

These project-owned hooks are different from Rehearsal's database runtime drivers. A
database driver starts and manages a kind of local database, such as Supabase or plain
PostgreSQL. A project
runtime adapter adds narrowly scoped application behavior after that database is ready.

Adapters are a backward-compatible advanced escape hatch for project-specific restore
behavior. New projects should first use `runtimePolicy`, `identityPolicy`, application
environment mappings, HTTP proofs, and dependent targets. Those package-owned paths are
portable and reject executable declarations.

If the application needs another database, use
[`dependentTargets`](configuration.md#dependent-databases) instead of opening a second
connection or managing another container from a runtime adapter. Rehearsal owns that
database's identity, ports, lifecycle, verification order, and cleanup preview; the
project declares its baseline and proof. `prepareCommand` remains available for legacy
schema-specific transformations.

An adapter may export:

- `prepareSchema({ baseline, runSql })` for local schema preparation before data restore;
- `configureRuntime({ baseline, environment, runSql })` to create synthetic identities
  or return explicit application environment values;
- `verifyRuntime({ baseline, environment, runSql })` for project-owned invariants.

Each hook must return the documented status shape expected by the engine. It receives a
local SQL executor; it should not open another connection or perform network access.

Use an adapter only when the documented declarative formats clearly reject a required
local behavior. Extracting production data, embedding credentials, contacting hosted
services, weakening local-only checks, or reimplementing container lifecycle is never an
adapter responsibility.

Keep adapters small, deterministic, tested, and visibly project-owned. If a behavior is
generic across unrelated projects, propose it for the engine instead of copying it into
every adapter.
