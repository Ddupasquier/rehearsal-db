# Project runtime adapters

Adapters are an advanced escape hatch for project-specific restore behavior. They live
in the consuming repository and are loaded only from the path declared in config.

An adapter may export:

- `prepareSchema({ baseline, runSql })` for local schema preparation before data restore;
- `configureRuntime({ baseline, environment, runSql })` to create synthetic identities
  or return explicit application environment values;
- `verifyRuntime({ baseline, environment, runSql })` for project-owned invariants.

Each hook must return the documented status shape expected by the engine. It receives a
local SQL executor; it should not open another connection or perform network access.

Good adapter responsibilities include mapping sanitized application identities to local
Auth users and verifying a domain-specific relationship after restore. Bad responsibilities
include extracting production data, embedding credentials, contacting hosted services,
or weakening the engine's local-only checks.

Keep adapters small, deterministic, tested, and visibly project-owned. If a behavior is
generic across unrelated projects, propose it for the engine instead of copying it into
every adapter.
