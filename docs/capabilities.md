# What Rehearsal can do

Prepare a safe copy. Review the exact change. Prove the application still works.

The complete CLI is free and MIT-licensed. VS Code Starter adds a free visual workbench,
with no account, card or trial. The tables below describe released functionality;
each area links to its usage guide rather than asking you to trust a feature name.

## Published release snapshot

| Component           | Verified published version | Get it                                                                                       | Release details                                                                        |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Rehearsal Core**  | **2.2.0**                  | [npm](https://www.npmjs.com/package/@rehearsal-db/core)                                      | [Core 2.2.0](https://github.com/Ddupasquier/rehearsal-db/releases/tag/v2.2.0)          |
| **VS Code Starter** | **0.1.27**                 | [Marketplace](https://marketplace.visualstudio.com/items?itemName=rehearsal-db.rehearsal-db) | [Starter 0.1.27](https://github.com/Ddupasquier/rehearsal-vscode/releases/tag/v0.1.27) |

Reviewed November 2, 2026. This snapshot is reconciled with every release. Core and
Starter publish independently; a development version or source branch does not establish
availability. See [Releases and updates](updating.md) for installation, package origin
and version-specific changes.

## Core · prepare a useful, safe copy

| You can…                                    | Included now                                                                                                                            | Try it or learn more                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Set up your own project**                 | Interactive guidance, project discovery, prerequisite checks, safe configuration scaffolding, custom paths and typed configuration      | [Getting started](getting-started.md), [Configuration](configuration.md)                                                          |
| **Keep a trustworthy starting point**       | Immutable baseline generations, checksums, migration-history checks, metadata inspection and verified refresh                           | [Baselines](baselines.md)                                                                                                         |
| **Transform sensitive values**              | Stable pseudonyms, replacements, exclusions, date shifting and bounded structured-data rules                                            | [Sanitization](sanitization.md)                                                                                                   |
| **Use production-shaped data deliberately** | Separately approved preparation through restricted readers, bounded extraction and explicit source-access retirement                    | [Production-shaped preparation](production-source.md)                                                                             |
| **Keep fixtures representative**            | Optional smaller datasets with relationship preservation and measured shape or coverage evidence                                        | [Dataset configuration](configuration.md), [Baseline inspection](baselines.md#review-metadata-without-exposing-rows)              |
| **Include Supabase files and identities**   | Approved Storage-file capture and restoration, local Google/GitHub authentication and reviewed copied-account association after sign-in | [Storage and privacy](baselines.md#storage-and-privacy), [Authentication configuration](configuration.md#supabase-authentication) |

## Core · rehearse the change and the application

| You can…                                  | Included now                                                                                                                                        | Try it or learn more                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Use SQL, Prisma or Drizzle migrations** | Exact reviewed histories and pending candidates; version-pinned native PostgreSQL integrations with their own ledger semantics                      | [Supported toolchains](#supported-environments-and-toolchains)         |
| **Exercise realistic database behavior**  | Restore and check represented schema, rows, relationships and owned sequences; declare seed rows, prerequisites, triggers and security expectations | [Runtime policies](runtime-policies.md)                                |
| **Run the whole rehearsal**               | Reset from a verified baseline, apply approved candidates, verify the database and run the project's application proof                              | [Hands-on tutorial](tutorial.md)                                       |
| **Keep an existing sandbox**              | Apply approved migrations without resetting current sandbox data                                                                                    | [CLI commands](commands.md)                                            |
| **Test the product, not only the schema** | Project-owned test commands, built-in HTTP assertions, readiness checks and hands-on application sessions                                           | [Standalone workflow](standalone-workflow.md)                          |
| **Coordinate dependent databases**        | Declared target dependencies, ordered startup and migration, application proofs and reverse-order stopping                                          | [Dependent-target configuration](configuration.md)                     |
| **Review risks before execution**         | Optional static Migration Insights and supported read-only current-sandbox impact measurements                                                      | [Migration review and insights](commands.md#static-migration-insights) |

Static warnings and measured counts support a review; they do not guarantee that every
application workflow is safe. The proof command and privacy decisions remain yours.

## Core · control local resources and recovery

| You can…                                  | Included now                                                                                                                                              | Try it or learn more                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Choose a local runtime**                | PostgreSQL and Supabase, smaller application or full Supabase profiles, machine-aware engine discovery and preservation of the selected Docker connection | [Local profiles](runtime-lifecycle.md#choosing-postgresql-or-supabase)                        |
| **Keep or retire a sandbox deliberately** | Start, stop, verify, reset and explicit discard; completion policies, activity-based idle shutdown and data-preserving PostgreSQL container retirement    | [Runtime lifecycle](runtime-lifecycle.md)                                                     |
| **See what consumes resources**           | Environment, volume and image inventory; ownership, container state and available CPU, memory and disk measurements                                       | [Resource measurements](runtime-lifecycle.md#reading-resource-measurements)                   |
| **Review cleanup before confirming**      | Retained-baseline cleanup, selected runtime data and eligible unused images, with protection policies and previewed actions                               | [Local Resources manager](runtime-lifecycle.md#local-resources-manager)                       |
| **Manage the VM when supported**          | Reviewed Colima startup, owned-idle shutdown and explicit shared-VM shutdown with workload-impact review                                                  | [VM shutdown and its supported scope](runtime-lifecycle.md#shut-down-the-vm-explicitly)       |
| **Bound concurrent work**                 | Cooperative workload leases, optional measured-capacity admission and reviewed dead-holder recovery                                                       | [Capacity admission](configuration.md#measured-capacity-admission)                            |
| **Reuse prepared restore data**           | Optional verified COPY-encoding cache and baseline-size inspection                                                                                        | [Restore cache and sizing](configuration.md#verified-copy-encoding-reuse-and-baseline-sizing) |
| **Investigate and automate**              | Cancellation, retained failure state, Doctor, redacted support reports, versioned JSON, documented exit codes and ESM/TypeScript APIs                     | [CLI reference](commands.md), [TypeScript](typescript.md)                                     |
| **Stay current**                          | Opt-in release checks and update reminders in the interactive guide, with installation instructions                                                       | [Releases and updates](updating.md)                                                           |

The package also includes an **experimental synthetic-only local managed-protocol
prototype**. It is a narrow development interface, not a hosted service or a customer-data
upload path. Its [documented scope](commands.md#synthetic-managed-protocol-prototype) is
separate from the normal local rehearsal workflow.

## VS Code Starter · the visual workbench

Starter uses the project's Core package. It presents the same reviewed operations and
keeps database execution in Core.

| You can…                            | Included now                                                                                                                                                                 | Explore                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Find the next useful step**       | Seven-page dashboard, Projects sidebar, detected facts, Core compatibility, Doctor results, setup guidance and exact CLI previews                                            | [Workbench guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#what-the-workbench-shows)                          |
| **Review exact migrations**         | Search, filters, sorting, remembered checkmarks, ordering and dependencies, approval digests, SQL/Prisma/Drizzle review and file navigation                                  | [Migration review](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#what-the-workbench-shows)                         |
| **Run and explore a sandbox**       | Full rehearsals, migration without reset, database verification, application sessions, local app links and project- or target-scoped lifecycle actions                       | [Project and runtime review](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#project-setup-and-runtime-review)       |
| **Keep useful evidence**            | Baseline generations and integrity, counts, privacy and Storage summaries, opt-in shape evidence, aggregate comparisons and redacted Markdown/JSON exports                   | [Detailed extension guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md)                                          |
| **Recover with context**            | Failure explanations, unchanged attempted-input navigation, live progress, cancellation, sandbox-session states and bounded action history                                   | [Detailed extension guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md)                                          |
| **Manage local resources**          | Ownership and usage inventory, search/filter/sort, largest-first review, paging, protection settings, cleanup previews and owning-environment discard                        | [Resources and supported limits](runtime-lifecycle.md#local-resources-manager)                                                                         |
| **Shut down the VM visibly**        | Prominent shutdown action, workload-impact review, confirmation and **Back to Rehearsal** within the qualified Colima/macOS scope                                            | [VM shutdown](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#vm-shutdown)                                           |
| **Configure and organize**          | Reviewed configuration forms and exact diffs, field validation, concurrent-edit protection, named display profiles and local authentication review                           | [Project setup and runtime review](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#project-setup-and-runtime-review) |
| **Install and update deliberately** | Reviewed npm/pnpm/Yarn/Bun commands, separate version displays, consented checks, defer/skip, compatible npm Core updates and verified VSIX updates through separate opt-ins | [Installation and updates](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#keep-the-canonical-installation-current)  |
| **Control editor behavior**         | Configuration-path and inspection-timeout settings, automatic-dashboard preference, saved-state reset, diagnostics and support access                                        | [Extension guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md)                                                   |

Workspace Trust gates process execution. Passive inspection is read-only, updates never
force a reload, and Starter includes no telemetry. Included Starter features remain free
for personal and commercial development.

## Supported environments and toolchains

| Area                  | Released scope                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**           | Maintained Node 22, 24 and 26 release lines                                                                                                                                                                                     |
| **Local execution**   | macOS and Linux; Windows through the WSL 2 compatibility preview on its Linux filesystem                                                                                                                                        |
| **Database families** | PostgreSQL and Supabase; normal rehearsal commands use a local target                                                                                                                                                           |
| **Native Prisma**     | Prisma Migrate 7.10.1; initially qualified on PostgreSQL 17 / Ubuntu 24.04 x64 / Node 24                                                                                                                                        |
| **Native Drizzle**    | Drizzle Kit 0.31.11, ORM 0.45.4 and pg 8.23.1; initially qualified on PostgreSQL 17 / Ubuntu 24.04 x64 / Node 24                                                                                                                |
| **Editor**            | Desktop VS Code 1.101+ with a compatible project-local Core package; see the [extension compatibility guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/extension-guide.md#core-compatibility-and-upgrades) |
| **VM shutdown**       | Qualified macOS Apple Silicon / Colima 0.10.3 / VZ / default-profile path; other engine controls are not implied                                                                                                                |

[Compatibility](https://github.com/Ddupasquier/rehearsal-db/blob/main/COMPATIBILITY.md)
and the linked guides own the exact limits. Use the documentation bundled with an older
release when its behavior differs.

## Where Rehearsal is heading

The **[public roadmap](roadmap.md)** separates queued enhancements, planned directions
and paused work. A roadmap entry becomes a released capability here only after its
actual public distribution has been verified.
