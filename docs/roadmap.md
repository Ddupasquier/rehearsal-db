# Where Rehearsal is heading

The **[shipped-capability catalog](capabilities.md)** describes what you can install and
use today. This page describes intended outcomes and their current availability.

The complete MIT CLI and all features included in free VS Code Starter stay free.
Core and Starter publish independently; consult [Releases and updates](updating.md)
for actual availability and compatibility.

## Read the status, not a promise

| Status       | What it means                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------- |
| **Queued**   | A defined enhancement has implementation work or a draft ready to continue; it is not released. |
| **Planned**  | A product direction or integration is intended, with design or verification still ahead.        |
| **Paused**   | Work is preserved but is not in active delivery.                                                |
| **Research** | Feasibility and a support contract must be established before a product commitment.             |

These are availability labels, not delivery dates. Release notes and the capability
catalog are updated when a feature actually ships. The linked discussions and pull
requests provide detail; a passing build or an open pull request is not a release.

## Intended improvements

The current order is **reliability and bug fixes → database targets → more container
engines → further ORM integrations**. The status below describes availability;
priority does not mean a feature has shipped.

| Intended outcome                                                   | Status      | What must be finished before availability                                                                                      | Follow the work                                                                                                                                     |
| ------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **See an update reminder in ordinary CLI commands**                | **Queued**  | Complete the concise terminal notice while preserving silent JSON/CI output, compatibility checks and update opt-outs          | [CLI update notice](https://github.com/Ddupasquier/rehearsal-db/pull/230)                                                                           |
| **Keep useful editor review when runtime readiness is missing**    | **Queued**  | Finish capability-driven Core/editor behavior and exact installed-pair offline acceptance                                      | [Core capabilities](https://github.com/Ddupasquier/rehearsal-db/pull/221), [editor review](https://github.com/Ddupasquier/rehearsal-vscode/pull/29) |
| **Rehearse MongoDB projects**                                      | **Planned** | Establish document-native baseline, restore, migration and safety contracts, then verify the driver independently              | [MongoDB](https://github.com/Ddupasquier/rehearsal-db/issues/164)                                                                                   |
| **Use more local container engines**                               | **Planned** | Qualify discovery, lifecycle, cleanup and resource behavior across supported operating systems                                 | [Container qualification](https://github.com/Ddupasquier/rehearsal-db/issues/167)                                                                   |
| **Support Knex's native JavaScript migration workflow safely**     | **Paused**  | Resolve isolated execution and recovery verification; complete independent exact-package qualification before claiming support | [Native migration integrations](https://github.com/Ddupasquier/rehearsal-db/issues/174)                                                             |
| **Understand Django, Alembic and Rails / Active Record histories** | **Planned** | Define and verify framework versions, dependencies, applied history and isolated execution independently                       | [Native migration integrations](https://github.com/Ddupasquier/rehearsal-db/issues/174)                                                             |
| **Run demanding rehearsals away from your laptop**                 | **Planned** | Establish upload consent, tenant isolation, credential boundaries, retention, cleanup and bounded spending                     | [Managed-execution direction](#efficient-local-execution-and-optional-managed-runs)                                                                 |
| **Offer optional Pro editor workflows**                            | **Planned** | Define the additional workflows, licensing, pricing and supported entitlement behavior before a paid launch                    | [Commercial-readiness direction](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/commercial-readiness.md)                            |

Quality, compatibility and usability improvements continue within the supported local
journey. They do not imply that the integrations or services above are available.
[Compatibility](https://github.com/Ddupasquier/rehearsal-db/blob/main/COMPATIBILITY.md)
owns the supported environments; [Troubleshooting](troubleshooting.md) covers known
setup and runtime problems.

## Efficient local execution and optional managed runs

Efficient local profiles, data-preserving lifecycle controls, essential safety and the
complete CLI stay free. Resource improvements must preserve the services and
representative data needed for the chosen scenario. See [choosing a local
profile](runtime-lifecycle.md#choosing-postgresql-or-supabase).

Optional managed execution is the paid-service direction: demanding rehearsals without
a local database stack. It is not currently available. Its design must establish explicit
upload consent, isolated execution, credential and retention boundaries, verifiable
cleanup and bounded costs before a hosted launch. Sanitization does not automatically
authorize uploading a baseline. Pricing and commercial terms remain separate decisions.

The shipped synthetic-only [managed-protocol prototype](commands.md#synthetic-managed-protocol-prototype)
is a limited development interface, not that hosted service. Experimental upstream native
runtimes are likewise not supported Rehearsal replacements merely because they omit Docker.

## Database and engine qualification

Additional database, runtime, identity-provider and migration-tool integrations require
their own reviewed capability contracts and independent acceptance. Research or a roadmap
ticket is not a support claim. Beyond the released [SQLite workflow](sqlite.md),
intended database work includes MongoDB, [MySQL](https://github.com/Ddupasquier/rehearsal-db/issues/161),
[MariaDB](https://github.com/Ddupasquier/rehearsal-db/issues/162) and
[SQL Server](https://github.com/Ddupasquier/rehearsal-db/issues/163). Each family needs
its own [capability contract](https://github.com/Ddupasquier/rehearsal-db/issues/159)
and evidence before it appears in the released catalog.

Broader container support follows database targets and precedes further ORM expansion.
Cross-platform behavior and measured resource use will guide engine choices; detecting
a vendor alone does not establish compatibility or lower VM pressure.

The current [standalone workflow](standalone-workflow.md) already covers the released
source-to-sandbox journey. Its source-access, privacy, Storage, identity and application
proof boundaries remain in force as future integrations are added.

## Follow releases and shape the direction

Use [Releases and updates](updating.md) for changes, installation, compatibility and
package origin. New availability is reflected in the [capability catalog](capabilities.md)
after publication is verified; each component retains its own release history.

For a concrete missing workflow, [open a feature request](https://github.com/Ddupasquier/rehearsal-db/issues)
describing the outcome you need. Maintainer publishing and qualification details belong
to the [release verification policy](stability.md), not the getting-started journey.
