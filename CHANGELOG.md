# Changelog

All notable Rehearsal package changes are documented here. The format follows Keep
a Changelog, and published versions follow Semantic Versioning.

## [Unreleased]

### Fixed

- Preserve closed host-generated Knex failure origins across manager error summaries, with separate cleanup uncertainty and no provider output, SQL or credential disclosure. Existing public error categories and exit codes are unchanged.

## [2.3.0] - 2026-10-30

### Added

- Opt-in Knex 3.3.0 / pg 8.23.1 PostgreSQL migrations with native filename identities, reviewed code/support baseline format 5 and an explicit historical-checksums-unavailable notice. Genuine SDK migration modules execute only in a bounded network-disabled Linux worker through a restricted-role fixed-target relay; unknown role/worker ownership and cleanup refuse instead of falling back to host JavaScript. Qualification targets PostgreSQL 17 on Ubuntu 24.04 x64 / Node 24; source candidates do not establish published availability or completed qualification.

## [2.2.0] - 2026-10-30

### Added

- Opt-in Drizzle Kit 0.31.11 / ORM 0.45.4 / pg 8.23.1 PostgreSQL migrations,
  with explicit native identities and byte-exact journal baseline format 4.
  Whole-journal baseline checks, native-prefix consent and bounded private execution
  preserve existing SQL/Prisma contracts. Initial SDK qualification targets
  PostgreSQL 17 on Ubuntu 24.04 x64 / Node 24; other combinations remain unqualified.

## [2.1.0] - 2026-10-30

### Added

- Opt-in pinned Prisma Migrate 7.10.1 history for PostgreSQL, preserving native
  migration paths, raw checksums and successful ledger entries in baseline format 3.
  Reviewed execution uses a private configuration and the installed local toolchain;
  native failures, cancellation and timeouts retain the data volume for explicit
  recovery. Existing SQL histories and baseline formats 1/2 keep their behavior.

### Fixed

- Advance owned SERIAL and identity sequences beyond restored integer IDs, preserving
  their configured direction, bounds and empty-table start. Explicit IDs before the
  generation range use the configured start; IDs beyond the advancing range refuse
  restoration. Non-sequence and generated columns
  are not treated as auto-incrementing values.

## [2.0.1] - 2026-10-28

### Fixed

- Keep the reviewed Docker context during repeated manager operations, including
  Supabase stop, even when the ambient default selects another context. Endpoint,
  TLS, explicit-selector and client-configuration checks remain in force.
- Automatic owned-Colima shutdown now confirms that the qualified profile is
  stopped and its captured VM has exited before retiring the startup receipt.
  An unavailable Docker daemon alone no longer counts as a stopped VM.
- Give graceful shutdown its own bounded command and pipe-close handling, while
  keeping metadata probes bounded separately. If Colima reports a command error
  but independent observations confirm the VM is off, show that warning explicitly.
  Unconfirmed outcomes preserve ownership receipts and data for recovery.

## [2.0.0] - 2026-10-25

### Added

- Configuration-independent `engine status` and exact-reviewed `engine stop`,
  separating selected-engine availability from VM state. The initial shutdown
  adapter requires a proven macOS Apple Silicon Colima 0.10.3 VZ default profile,
  shared-workload review and positive process-exit evidence; unsupported and
  uncertain outcomes remain explicit. No force or data deletion is requested.
- Machine-aware local engine options in discovery, setup and doctor, with explicit
  Docker selection preserved through runtime launch. Remote, TLS and ambiguous
  selectors refuse without switching engines or migrating existing data.

- Opt-in measured host/engine headroom admission inside the participating lifecycle
  queue. Unknown or insufficient capacity refuses a new phase without stopping
  existing workloads; this is cooperative admission, not a hard machine-wide limit.
- Optional private authenticated COPY encoding reuse with explicit retained-byte and
  free-disk budgets, exact immutable input binding and safe full-data fallback.
- Read-only `inspect sizing` reports baseline rows/bytes and existing reviewed shape
  evidence without resampling or promising equivalent fidelity.
- Synthetic-only managed protocol example, review, bounded local worker and explicit
  quarantined-workspace recovery. No upload, hosted service or paid execution is enabled.
- Public exact-ownership container retirement and automatic PostgreSQL shell retirement
  on stop, with verified data-volume reconstruction on start. Explicit disposable run/app
  completion modes remove their owned runtime automatically; protected and unknown state refuse.

### Fixed

- Doctor checks running database ports and PostgreSQL images through the same
  validated local Docker endpoint and configuration selected by the user. A
  private or nondefault connection no longer makes its own runtime appear foreign;
  remote, TLS, changed and unrelated selections still refuse.
- Supabase runtime health probes preserve that same validated Docker connection,
  so status and the editor no longer label a healthy private runtime unhealthy.

### Breaking changes

- New configurations and omitted lifecycle settings stop database targets after a run
  or application exit by default, preserving data volumes and reconstruction receipts.
  Explicit `keep-until-stop` remains available for actively owned hands-on testing.
- Upgrading from 1.x requires a deliberate major-version selection. To retain the
  previous lifecycle behavior, explicitly set both `lifecycle.run` and
  `lifecycle.open` to `keep-until-stop` before the next run. Existing explicit
  lifecycle choices remain unchanged; upgrading does not reset databases or remove
  volumes, baselines or recovery files.

## [1.3.0] - 2026-10-24

### Added

- Optional free local-user workload admission for participating `start`, `reset`,
  `run` and `migrate` lifecycle phases. Bounded waits, cancellation and explicit
  dead-holder metadata recovery do not interrupt another project or expire live
  owners. Read-only `workloads` reports participation, not available host/VM memory.
  Existing configurations and editor field metadata remain unchanged when omitted.
  Application proofs, interactive sessions and nonparticipating tools are outside
  this first lifecycle-only queue; this is not a distributed or hard-memory scheduler.

## [1.2.0] - 2026-10-24

### Added

- An optional `migrationImpact: 1` contract: offline `inspect impact` and explicitly
  confirmed `measure impact` for one selected, already-verified disposable local
  sandbox. Bounded read-only snapshot aggregates cover narrow supported row,
  populated/NULL, duplicate and foreign-key orphan counts; unsupported or incomplete
  evidence stays unknown. No pending migration is executed, no runtime is started
  or repaired, and no SQL, object names or row contents are returned. Counts are
  not sequential simulation, production prediction or a safety verdict. Existing
  project locking/cancellation is reused without adding a rehearsal gate or CLI fee.
- An optional versioned `inspect insights` contract for bounded, read-only static
  migration warnings. Findings bind to exact pending file bytes and the complete
  existing candidate digest, with fixed explanations and lexical locations.
  Unsupported, malformed or truncated analysis remains unknown; no detected
  warning is never SQL validity, database verification or a safety verdict.
- Project-local input bounds, unchanged leaf/directory identity checks and shared
  input hash binding. Inspection neither executes SQL nor starts an engine or
  contacts a database. Existing migration-plan v1 and failure diagnosis remain
  separate, unchanged contracts.

### Documentation

- Clarify reviewed PostgreSQL/application/full service dependencies and resource
  measurement limits without adding service exclusions or a new acceptance gate.
- Distinguish project runtime hooks from native migration-tool history support.

## [1.1.0] - 2026-10-21

### Added

- Optional read-only runtime privilege expectations for reviewed schemas, tables,
  sequences and exact function signatures. Required and forbidden effective access is
  separate from RLS, includes inherited and column-only permissions, and never repairs
  grants automatically. Existing policies without this field keep their behavior.
- Document explicit least-privilege Data API grants, forward-only correction and
  positive/negative API proofs for Supabase's October 30 opt-in table-exposure change.

### Fixed

- Record the Supabase provider in newly written runtime receipts, so inventory can
  distinguish recorded format/provider compatibility from unknown legacy provenance.
  Older receipts remain unknown rather than being silently rewritten or reverified.
- Bound newly generated Supabase project IDs to the provider's 40-character limit
  with a deterministic suffix. Preserve valid existing identities; reject invalid
  configured IDs without renaming or adopting resources.
- Align OS setup helpers with core's Node.js 22, 24 and 26 support. macOS/Linux
  helpers accept an explicit `REHEARSAL_NODE_PATH`, and missing-Node guidance points
  to version-manager selection or the official installer without installing an OS tool.
- Update compatible older CLI installations to the helper's exact current target
  instead of treating every 1.0.1-or-newer installation as already current.

## [1.0.2] - 2026-10-20

### Fixed

- Explain recognized PostgreSQL/Supabase migration failures with bounded native
  SQLSTATE evidence and safe syntax, schema, constraint, permission, connectivity
  and timeout guidance. Unsupported or ambiguous evidence remains unknown; raw
  SQL, provider details, credentials and private rows are not exposed.
- Preserve the original diagnosis across cleanup and bounded operation history so
  the CLI and editor can show the same failure after refresh. Failed operations
  never claim verification or unconditional rollback success.
- Optionally identify the exact approved PostgreSQL input file by hash, without
  inventing a failing SQL origin, line or column. Reject invalid UTF-8 before
  execution rather than submitting replacement-decoded bytes.
- Point recognized bind failures at the configured local ports, including safe
  Windows/WSL exclusion-inspection guidance. Do not infer a reservation from every
  denial or suggest terminating unknown listeners.
- Keep database-only command guidance separate from optional application launch.

### Documentation and distribution

- Add a main-tutorial existing-row constraint failure, reviewed backfill/fix and
  verification sequence, plus a same-project VS Code handoff and safe local-copy
  recovery for unsupported external npm links.
- Pair with Starter 0.1.22 for actionable persistent failures, safe exact-byte
  source opening, distinct command/database states and truthful recorded proof.
- Refresh the separate macOS, Linux and Windows/WSL 2 setup bundles to exact core
  1.0.2. Native Windows database execution remains unsupported.

## [1.0.1] - 2026-10-19

### Platform compatibility

- Keep macOS Intel/Apple Silicon and Linux execution distinct from Windows desktop
  access through WSL 2. Require the WSL project's Linux filesystem; document the
  preview's actual component and runtime limits rather than claiming every OS works.
- Verify installed package version/discovery on real desktop OS runners and exercise
  PostgreSQL/dependent targets in an owned Windows 2025 WSL2 Ubuntu distribution.
  Provision checksum-verified official Node and signed Docker Engine packages without
  Docker Desktop, a daemon TCP endpoint or new branch-protection requirements.
- Document native Windows runtime refusal and the Linux/Remote-WSL setup path; version,
  help and project discovery remain distinct from database-runtime support.

## [1.0.0] - 2026-10-17

### Stable compatibility

- Establish the documented CLI, configuration, policy, baseline, TypeScript and
  JSON contracts as the 1.x compatibility boundary. This preserves rc.10's database,
  authentication and restore behavior.
- Keep the complete MIT CLI free. The separately distributed Free Starter editor,
  future Pro plans and additional database families do not expand the core support
  matrix or change its safety boundaries.

### Fixed

- Report unknown CLI commands and options as invalid input (exit 2), rather than
  letting words in the input or help text misclassify them as migration or baseline
  failures. The command remains refused and supported-command help is retained.

## [0.1.0-rc.10] - 2026-10-17

### Fixed

- Interactive Ctrl+C and Ctrl+Z retire owned work without leaving an invoking npm
  job suspended. Terminal mode and input consumption are restored after cleanup;
  startup and unanswered migration confirmations cancel safely, and unrelated jobs
  are untouched.

### Documentation

- Stable promotion is evidence-based after owner review: complete the release and
  consumer acceptance checks rather than waiting a fixed number of calendar days.
  Exact-artifact, security, data-preservation and human publishing approvals remain.

## [0.1.0-rc.9] - 2026-10-17

### Fixed

- Wrong or stale source-access approval and review-required privacy drafts report
  actionable configuration refusals instead of internal failures. Source access,
  privacy review and baseline-preservation requirements are unchanged.

## [0.1.0-rc.8] - 2026-10-17

### Added

- Optional interactive update reminders, with explicit network consent, daily
  opening-session checks, defer/skip/disable choices and exact-version guidance.
  Machine commands remain network-free, custom installations stay manual-only,
  and no update installs automatically.

### Fixed

- Invalid positive-integer configuration settings and rejected configuration proposals
  report configuration failures rather than baseline or internal failures. Review
  remains non-writing, and unexpected faults retain their original failure category.

### Documentation

- Separate released VSIX installation, dashboard access, and updates from contributor
  setup and separately approved commercial launch requirements.
- Clarify that configured database and Storage data remain persistent and that no
  separate temporary Docker-helper ownership or cleanup capability exists today.
- Explain profile startup and resource measurements without equating cached-image
  container checks with a cold VM or whole-machine memory benchmark.

## [0.1.0-rc.7] - 2026-10-15

### Fixed

- Release approval checks accept GitHub form line endings without changing the exact
  owner, environment, operation, run, attempt, source or checksum bindings. Other text
  changes and stale or ambiguous approvals remain refused.

rc.6's tag and failed GitHub publication history are preserved; it was not published
to npm. rc.7 does not add or change database, application or environment behavior.

### Documentation

- The shared GitHub/npm README visibly links to both the source repository and npm
  package page.

## [0.1.0-rc.6] - 2026-10-15

### Fixed

- Release ancestry verification no longer requests a paginated comparison when the
  immutable source tag already points to the exact verified main commit. Older source
  commits still require bounded, unpaged ancestry evidence; incomplete responses remain
  refused. Human approval, provenance and immutable-tag protections are unchanged.

rc.5's GitHub candidate and tag are retained, but its npm publication stopped at the
read-only preflight. rc.6 carries the same product features and a new tested artifact;
no runtime or environment behavior was added during this publisher correction.

## [0.1.0-rc.5] - 2026-10-15

### Added

- Project-owned resource inventory, exact long-running-environment stop review, and
  individually selected unused-image cleanup. Volumes remain tied to reviewed runtime
  discard; other projects and the shared engine are protected.
- Friendly environment labels, protection, named display profiles, resource quotas and
  review schedules, with validated configuration metadata and fingerprint-bound proposals.
- Ordered migration review, baseline/privacy/authentication summaries, and bounded
  operation stages and recent receipts through public JSON contracts.
- Optional target-local resource provenance reports recorded baseline and migration
  digests, restore-writer version, and configured ports without claiming fresh
  verification, listening services or activity. Legacy receipts remain explicitly unknown.
- Environment classification separately reports ownership-proven creation, recorded
  format/provider compatibility, and age-based review due status. Missing verification
  does not mean a database was never created; differing writer versions do not imply
  incompatible data. Configured sandbox volumes remain persistent after workload stop.
- Opt-in, bounded graph sampling and measured distribution goals, with immutable
  post-sanitization fidelity evidence and required-goal refusal before activation.
- Lightweight Supabase service profiles and explicit required-service checks.
- Opt-in foreground sandbox idle shutdown using an explicit application-owned activity
  contract. Unknown or busy activity preserves workloads; no background daemon is added.
- A disposable PostgreSQL regression demo showing an empty-database migration pass,
  populated-data refusal, and verified recovery with a reviewed backfill.

### Fixed

- Partial startup and interrupted work clean up only workloads proved owned by the
  operation, preserving existing running environments, data and shared engines.
- Opted-in owned-engine shutdown checks for newly appeared workloads immediately before
  stopping and preserves a replacement ownership receipt from a later operation.
- Application startup refuses occupied local ports without replacing another process.
- Application and profile ports are checked across the complete configured topology;
  configuration proposals can explicitly bind a dependent edit to its parent graph.
- Application teardown retires its owned process group even after the launcher exits.
- Supabase startup diagnostics preserve safe service/health categories while withholding
  logs, credentials, URLs and private paths. Unknown causes stay unknown.
- Public JSON retains strictly false privacy attestations without exposing credentials;
  normalized shape policies can be safely validated repeatedly.
- Failed migrations retain their baseline/candidate phase instead of inferring it from
  earlier progress; summaries omit Node source excerpts and provider SQL output.
- Release preparation, publication and tag repair now refuse missing or ambiguous live
  repository/environment controls; prereleases preserve a stable `latest` version even
  when that version has build metadata.
- Read-only release CI drift-checks an owner-observed settings record when GitHub hides
  bypass metadata. Publication still requires an actual owner deployment review bound
  to the exact run, attempt, source, artifact and settings-record checksums.

These changes belong to rc.5, not the existing rc.4 artifact. Scheduled review is
not unattended cleanup, and container age is not proof of user inactivity.

## [0.1.0-rc.4] - 2026-10-11

### Added

- `discover --json` exposes a versioned, read-only Project Profile for editor clients,
  separating proven facts, evidence-backed suggestions, and decisions that remain with
  the user.
- Project discovery reports bounded application, package-manager, migration, target,
  runtime, baseline-retention, configuration, and local-address metadata without reading
  environment files, contacting databases, starting containers, or executing project code.
- Public TypeScript contracts now cover discovery results, retained baseline generations,
  application readiness, cleanup policy, and structured PostgreSQL and Supabase runtime
  state consumed by the Rehearsal VS Code extension.

### Changed

- Plans and status results expose the additional bounded metadata required for a
  project-aware editor experience while retaining core ownership of all safety checks and
  mutating operations.
- Documentation now includes the supported VS Code integration boundary, privacy model,
  compatibility floor, and safe automatic-refresh behavior.

## [0.1.0-rc.3] - 2026-10-10

### Added

- `status --json` now exposes bounded, target-scoped runtime state without requiring
  editor clients to parse human-formatted process output.
- `activity --json` reports idle, busy, stale, invalid, and unavailable project-operation
  state without exposing lock tokens, process arguments, credentials, or private paths.
- Supported mutating operations now have an explicit cancellation contract: owned child
  groups receive one bounded shutdown request, rollback and lock cleanup complete before
  exit `130`, and unrelated processes and Docker resources remain untouched.
- Root configuration can now choose `stop-after-run` for bounded automated checks and
  `stop-on-application-exit` for bounded hands-on sessions. Both modes stop only the
  configured Rehearsal targets while preserving database and Storage volumes, applied
  migrations, and sandbox edits for the next `start` or `open`.
- Plans, JSON results, terminal receipts, generated configuration comments, and the
  lifecycle guide now report the selected persistence mode and resulting runtime state.

### Changed

- Transient application and helper processes are cleaned up before an opted-in runtime
  stop after success, proof failure, readiness timeout, or supported interruption. The
  compatibility default remains `keep-until-stop` for both `run` and `open`.

### Fixed

- Read-only runtime inspection now works when a VS Code extension launches the CLI
  through Electron's executable in Node mode. That mode is preserved only for
  Rehearsal's nested runtime manager and is not exposed to project-owned commands.

## [0.1.0-rc.2] - 2026-10-09

### Changed

- Container-engine startup is now explicit by default. Rehearsal starts Colima only
  when a project deliberately enables `containerRuntime.autoStartColima`, reports that
  action, and never silently stops the shared engine.
- Package-managed Supabase containers use Docker's non-resuming restart policy after
  each start, preventing stopped Rehearsal stacks from waking merely because Docker or
  Colima restarts. Exact Supabase project labels keep the change inside the selected
  disposable target.
- Runtime diagnostics and a new lifecycle guide explain which commands need Docker,
  what remains running, and how to finish a low-memory local session without pruning or
  deleting persistent data.

### Fixed

- A stopped Colima VM no longer restarts from a default Rehearsal configuration.
- Independent Test Lab acceptance now reaps exact workspace-owned interactive children
  after success, failure, interruption, and timeout.

## [0.1.0-rc.1] - 2026-10-08

### Changed

- Promotes the exact beta.18 behavior and documented compatibility surface to the first
  release candidate. No runtime, configuration, policy, CLI, or public TypeScript
  capability changed after beta.18.
- Broad feature work is frozen while the release candidate completes two independent
  Test Lab passes, one final package-only consumer upgrade, and its observation window.

## [0.1.0-beta.18] - 2026-10-08

### Added

- A concise stability contract now defines the supported public surface, defects that
  block the first stable release, and the exact beta-to-RC-to-stable promotion gate.
- Automated release-policy tests cover beta, release-candidate, stable, malformed, and
  mismatched GitHub release metadata.

### Changed

- Protected OIDC publication now supports both prerelease and stable versions. Beta and
  release-candidate versions update `beta`; once a stable version exists they cannot
  replace `latest`. Stable publication updates `latest` without rewriting `beta`.
- npm channel selection lives only in the protected release workflow instead of static
  package metadata, and missing beta.16 and beta.17 changelog comparisons are restored.
- Vitest's locked patch release is updated from 5.0.2 to 5.0.3 after the complete CI
  matrix passed.

## [0.1.0-beta.17] - 2026-10-08

### Added

- `rehearsal identity connect` and the guided home screen now keep the sandbox app
  available during ordinary provider sign-in, detect exactly one approved verified local
  identity, show a redacted copied-account preview, and apply the existing exact claim
  after one deliberate confirmation. The app is reopened automatically with an honest
  fresh-session instruction; explicit `identity plan` and `identity claim` commands remain
  available for scripts.

## [0.1.0-beta.16] - 2026-10-08

### Changed

- The CLI now routes guided and scripted requests through focused typed command
  handlers and one result/output contract. The executable retains only process
  lifecycle, project locking, guided-loop coordination, and top-level error handling;
  command-session caches no longer live in public parsed flags.
- Configuration now passes through separate discovery, raw-schema validation,
  normalization, project-root path resolution, project detection, and starter-rendering
  modules behind the existing import path. Public declarations come from the same
  TypeScript source, including the new `NormalizedRehearsalConfig` type.
- Installed-consumer verification now shares one scenario catalog, artifact installer,
  isolated workspace boundary, process boundary, and persistent application-session
  helper. The complete release gate runs every scenario against one immutable tarball
  and records its exact version, SHA-256, tool environment, commands, timings, and
  results.
- Identity policy validation, deterministic claim planning, SQL generation, local Auth
  lookup, pure verification, and transactional execution now live in separate typed
  stages behind the unchanged public claim API. Generated reference SQL is independently
  testable, while only the executor can mutate the local database or Storage runtime.
- PostgreSQL and Supabase now share one typed runtime lifecycle engine for command
  dispatch, active-baseline loading, migration confirmation and receipts, runtime
  markers, and rollback. Candidate receipts are bound to their exact database target,
  while each driver retains its own ownership proof and database-specific behavior.
- Privacy policy types, recipe normalization, dependency validation, deterministic
  transforms, structured JSON, rule dispatch, row execution, and key handling now live
  in focused typed stages behind the unchanged public privacy import. An explicit closed
  registry covers every supported action and derivation without widening policy v2.

## [0.1.0-beta.15] - 2026-10-08

### Added

- A strict, no-emit TypeScript gate now checks the first shared runtime utilities and
  verifies that consumers can compile against Rehearsal's public configuration types.
- The documentation site now explains the supported TypeScript surface with examples
  that are compiled and checked against their rendered documentation source.
- All shipped implementation and executable-helper source now uses TypeScript. Clean
  builds emit Node-compatible ESM and declarations into the reviewed package boundary,
  and tests exercise that compiled output rather than an alternate source path.
- The published build omits repository-only JavaScript source maps while retaining
  runtime JavaScript and declarations, keeping the installed package compact.

### Fixed

- Packed onboarding chooses an available local port block for preserved configuration
  fixtures, so unrelated running Rehearsal projects cannot make the isolation test fail.

## [0.1.0-beta.14] - 2026-10-05

### Added

- Packed-package onboarding is now a required CI job. It covers fresh Supabase and
  PostgreSQL installs, beta.7 configuration preservation, missing credentials, occupied
  ports, malformed configuration, and non-destructive partial-setup recovery.
- The independent test lab can run the same first-install boundary against an exact
  candidate tarball before either database lifecycle.
- Installation and setup now report the exact active Rehearsal configuration path and
  explain when a supported existing nested config prevents root-file generation.
- Packed-package onboarding covers fresh, nested, existing-root, and repeated installs
  while proving reviewed configuration bytes are preserved.
- Privacy policy version 2 can explicitly treat nullable owners as non-matches and match
  an approved owner through any of a bounded list of pseudonymized identity columns.
- Bounded JSON unions classify each permitted root type, while JSON dictionaries require
  reviewed runtime-key formats, key actions, value recipes, and item/depth/byte limits.
- JSON dictionaries can restrict runtime keys to canonical signed integers within an
  explicit safe-integer range, preserving positive, negative, and reviewed zero keys
  without widening numeric maps to arbitrary text.
- Date shifting can explicitly preserve numeric epoch-millisecond representation,
  including inside structured JSON, while sharing a stable grouped offset with related
  epoch or ISO-string dates.
- Bounded scalar enums retain only explicitly reviewed structural strings, finite
  numbers, or booleans inside ordinary fields and nested JSON declarations, rejecting
  out-of-domain values without echoing them in diagnostics.
- Validated strings preserve bounded, case-sensitive structural codes from open domains
  using a package-owned portable alphabet, refusing credential-shaped and malformed
  text without consumer regexes, callbacks, or static identifier lists.
- Keyed hexadecimal and GTIN pseudonyms preserve reviewed database constraints, while
  fixed-width digest recipes derive fingerprints only from explicitly named sanitized
  columns and reject missing, excluded, duplicate, or cyclic inputs.
- A single GTIN recipe can declare reviewed `allowedLengths`, preserving each source
  value's 8-, 12-, 13-, or 14-digit shape and check digit even inside structured JSON.
- Keyed URL pseudonyms replace private HTTPS URLs with deterministic, bounded HTTPS
  loopback paths without retaining source hosts, paths, credentials, queries, or tokens.
- Bounded binding substitution can retain permitted surrounding text while replacing
  exact occurrences of a reviewed UUID with its corresponding keyed UUID pseudonym.
- External PostgreSQL readers can declare a bounded exact allowlist of provider-owned
  permission groups. Rehearsal verifies safe membership options, group attributes,
  nesting, view ownership, and the complete effective privilege surface.

### Documentation

- First-time users now have a short recovery table for interrupted setup, failed
  upgrades, port conflicts, missing OAuth credentials, and low Docker capacity.
- The configuration guide documents a safe manual move to the project root, separating
  config-file-relative JavaScript imports from project-root-relative Rehearsal paths.
- The sanitization guide documents nullable and multi-column ownership, heterogeneous
  JSON values, runtime-keyed dictionaries, keyed HTTPS replacements, bounded identity
  substitution, and their fail-closed boundaries.

### Fixed

- Source preparation now stores and reads each target's access receipt and owner-only
  reader credential under its configured baseline artifact directory. Nested and
  multi-target state roots no longer collide, and retirement refuses a receipt from a
  different target root.
- Supabase Storage source preparation now recursively traverses real folder placeholder
  entries while keeping the approved prefix, path, depth, object-count, per-object, and
  total-byte boundaries fail closed.
- Approved-owner selection now rejects non-finite numeric values in every declared
  owner column before choosing a privacy branch, including when another column already
  matches the approved owner.
- Pseudonymized canonical integer dictionary keys now share the same keyed identity
  mapping as numeric columns and nested numeric values using the same namespace, so
  runtime maps keep their reviewed cross-representation joins.
- External-reader membership mismatches now return a redacted, actionable source
  authorization refusal instead of an internal-failure diagnostic.
- All external-reader privilege, expiration, readable-surface, and security-definer
  denials now use the same `SOURCE_AUTHORIZATION_REFUSED` diagnostic and exit code 3.
- Identity claims now sequence PostgreSQL reads on their single transaction client,
  avoiding deprecated overlapping queries and remaining compatible with pg 9.

## [0.1.0-beta.13] - 2026-10-05

### Added

- Runtime and CI compatibility now cover maintained Node.js 22, 24, and 26 releases;
  Node.js 24 LTS remains the recommended default and release-build runtime.
- Source access policies can use an externally provisioned, database-expiring
  PostgreSQL reader without administrator credentials. Rehearsal binds canonical export
  view definitions, verifies the complete approved read surface and deny controls, and
  never changes or retires provider-owned source objects.
- `rehearsal --version`, its conventional `-V` alias, and `rehearsal version` now
  report the installed package version without requiring project configuration.
- Privacy policy version 2 can use one reviewed identity-aware path mapping for both
  database references and physical Storage destinations. Owner prefixes stay in the
  environment, review plans retain only their hashes, and unsafe or mismatched paths
  fail closed.
- Related timestamps can share a named deterministic date-shift group, preserving their
  ordering and duration without consumer callbacks.
- The baseline verification corpus now exercises two unrelated target schemas, a
  10,003-row packed-package stream, concurrent row/schema/ledger changes, malformed and
  truncated results, connection loss, low disk, interruption, and deterministic
  fixed-key output.

### Fixed

- Baseline preparation now rejects missing, negative, overflowing, malformed, or
  oversized PostgreSQL estimate and cursor results before activation. Every preparation
  failure preserves the active baseline, removes private staging, and leaves an edited
  runtime untouched.
- Approved-owner UUID columns are no longer confused with PostgreSQL sequence-backed
  identities. Restore checks the actual local schema before resetting a sequence, while
  genuine numeric identity columns retain correct next-value behavior.
- A failed Storage transfer now recursively restores write permission only within its
  owned staging tree, removes that incomplete generation, and preserves the original
  safe preparation error instead of replacing it with a cleanup error.
- Storage preparation now records a canonical media type from reviewed object metadata,
  removing response-only parameters such as a text charset that local bucket MIME
  allowlists reject during restore.
- Container startup and health failures are now classified as runtime dependency
  failures and include safe Docker/Colima capacity context instead of being mislabeled
  as migration verification failures.

## [0.1.0-beta.12] - 2026-10-04

### Added

- Supabase projects can declaratively configure local Google or GitHub OAuth in
  `rehearsal.config.mjs`. Rehearsal derives the credential allowlist, injects only the
  ignored owner-only environment values, and generates the exact loopback callback in
  the disposable runtime without tracking secrets. Local signup requires an explicit
  acknowledgment and is enabled only in that generated runtime copy.
- Branded, responsive documentation is now hosted on GitHub Pages with searchable
  navigation, light and dark themes, and automatic deployment from `main`.
- The documentation home page and packaged README show the live monthly npm download
  count and link directly to the npm package.
- Packed-package onboarding acceptance now proves both fresh root-config creation and a
  real beta.11 upgrade that preserves the user's existing configuration byte for byte.

### Changed

- The packaged README now links prominently to the hosted documentation, npm package,
  and issue tracker. Package homepage metadata also points to the hosted documentation.
- GitHub Pages publishing uses the current Node.js 24 action generations without legacy
  runtime warnings.
- `rehearsal init` now calls out important optional settings that are available but not
  enabled before showing the current installed-release template.

### Fixed

- Existing Google or GitHub provider sections can transition to declarative ownership
  without editing the tracked Supabase template. Rehearsal replaces only a compatible
  section in the disposable runtime copy, while `doctor` refuses ambiguous or
  safety-weakening provider settings before reset.
- Multi-target plain-text plans now print each declarative OAuth callback, and `init`
  advertises the declarative replacement even when a project still uses legacy provider
  fields.

## [0.1.0-beta.11] - 2026-10-03

### Added

- Privacy policy version 2 now supports hashed approved-owner bindings, conditional
  approved/other-owner transformations, bounded JSON arrays, nested recipes, and
  explicitly optional object fields without consumer sanitizer callbacks.
- Local npm installs now create a validated, commented project-root
  `rehearsal.config.mjs`, dedicated local runtime configuration, and additive safe ignore
  entries when exactly one consumer application can be proven. Guided setup remains the
  tested recovery path when lifecycle scripts are disabled or a workspace is ambiguous.
- Copied-account association accepts explicit verified-email provider allowlists and
  hashed provider-subject matchers for supported Supabase identities. Google, GitHub,
  and email sign-in now share one review-and-confirm claim workflow.

### Changed

- Setup is idempotent, supported custom config paths are preserved, `.gitignore` updates
  use an exclusive lock and atomic replacement, and `rehearsal init` shows the current
  release template without replacing an existing config.

### Fixed

- Identity plan JSON no longer serializes the raw approved email or provider subject;
  only the environment-variable name and reviewed SHA-256 receipt leave the process.

## [0.1.0-beta.10] - 2026-10-03

### Added

- `rehearsal open` starts and verifies the configured runtime stack, launches the normal
  application with declared local environment mappings, and keeps it available for
  hands-on testing until interrupted.
- The guide now offers **Open the sandbox app** after a runtime exists.

### Changed

- Persistent application sessions stop only their owned application process group on
  `Ctrl+C`, `Ctrl+Z`, terminal close, or termination. The database and Storage runtime
  stay running with local changes preserved across later sessions.

### Fixed

- `rehearsal open` keeps interruption handling active throughout application teardown,
  so an npm-forwarded `Ctrl+C` cannot terminate the CLI early or orphan the app.

## [0.1.0-beta.9] - 2026-10-02

### Added

- Primary configurations may declare isolated dependent database targets. Rehearsal
  validates unique ownership boundaries, combines migration approval, orders lifecycle
  actions, runs project-owned preparation and proofs, and previews cleanup across the
  complete stack.
- A packed-package two-target PostgreSQL fixture proves source-to-read-model preparation,
  positive and negative assertions, reverse shutdown, and exact cleanup without a
  project-owned container engine.
- A separately opted-in, exact-digest PostgreSQL source-access lifecycle with scoped
  temporary roles/views, deny checks, owner-only credentials, and exact retirement.
- Bounded coherent baseline refresh with executable privacy policy version 2, stable
  keyed pseudonyms, atomic activation, capacity limits, and drift/interruption safety.
- Approved Supabase Storage inventory/transfer with bucket-prefix, size, path, version,
  and exact-byte controls.
- Declarative runtime prerequisites and structural checks, plus exact local identity
  association without application callback patches.
- Package-owned application startup, local environment mapping, readiness, child-process
  teardown, and meaningful positive/negative HTTP proof orchestration.
- An exact-preview `refresh` command that builds a verified replacement first, resets the
  complete local runtime stack, rolls back on runtime failure, and only then prunes the
  specifically reviewed old baseline generations.

### Changed

- Shipped source, runtime adapters, repository-only verification, and tests now use a
  domain-based layout with documented placement rules and contract checks.
- Generated configs include a commented dependent-target example, and the documentation
  explains that avoiding server errors is not a sufficient positive-path proof.
- Generated configs explain the optional standalone policy paths, direct local runtime
  environment mappings, and application readiness contract.
- Source, privacy, runtime, identity, onboarding, and security documentation now describe
  the package-owned declarative workflow and its separate authorization boundaries.

### Fixed

- Supabase restores now install declared schemas and extensions before restoring
  extension-dependent objects, preserve the original `public` schema privilege baseline,
  and add declared triggers only after their functions exist.
- Supabase runtime environments now include a validated loopback-only database URL and
  standard PostgreSQL variables for package-owned commands.
- Identity claims can safely replace complete signup defaults, require application role
  references, remap declared text/JSONB and Storage object paths, and verify token-hook
  claims while refusing edited or independent local account data.
- Baselines and restore checks now identify relations by schema and table, default old
  records to `public`, and restore same-named tables in separate schemas independently.
- Identity claims can preserve immutable audit authorship while transferring the active
  account, and retain only the synthetic Auth actor required by that history.
- Storage path transfer now copies through the local Supabase API, verifies exact bytes,
  rolls back staged copies on database failure, and removes the old physical objects
  only after the database commit succeeds.
- Identity Storage scopes now accept restored objects whose owner is unset, refuse
  conflicting owners, and verify the destination owner before rewriting application
  paths.
- Runtime-policy seeds may explicitly follow a named identity association, so later
  verification checks the transferred key without recreating an obsolete placeholder
  role.
- Failed project proofs always report their exit status and bounded output byte counts
  without echoing arbitrary project logs.
- State-changing commands now use a project-wide operation lock and detect replacement
  of the installed Rehearsal package while an operation is running.
- Identity claims now refuse to rewrite copied Storage paths when referenced physical
  objects are missing.

## [0.1.0-beta.8] - 2026-10-02

### Fixed

- Lifecycle commands now preserve an explicit `--config=<path>` through runtime
  selection and execution. A command cannot silently operate on the default config's
  baseline, runtime identity, ports, or cleanup target instead.

## [0.1.0-beta.7] - 2026-10-02

### Added

- A concise roadmap prioritizes real-project acceptance, easier baseline onboarding,
  and another ordinary PostgreSQL project before further database expansion.
- A preview-first cleanup command for old baseline generations, the current project's
  disposable runtime, and explicitly selected older unused Supabase images. Applying a
  cleanup requires the exact digest from its preview.
- First-run setup now generates a fully populated, commented configuration that explains
  safe defaults, project-specific checks, and optional local-only settings in place.

### Changed

- Rehearsal now respects user-owned Colima CPU, memory, and disk settings. Projects may
  configure Colima auto-start and baseline retention in `rehearsal.config.mjs`.

### Fixed

- Beta publishing now updates both npm's `beta` and `latest` tags after registry
  verification, keeping the package page and default install on the newest reviewed
  beta. A protected manual repair path fixes existing tag drift without storing an npm
  token or choosing an arbitrary version.

## [0.1.0-beta.6] - 2026-10-02

### Changed

- Beginner documentation now follows one guided path, defines unfamiliar terms where
  they first appear, provides a disposable PostgreSQL tutorial, and keeps advanced detail
  in focused reference pages.
- Pressing `Ctrl+Z` at an interactive guide prompt now exits Rehearsal cleanly instead
  of suspending the process and leaving it attached to the terminal.
- Database lifecycle selection now goes through a closed runtime-driver boundary while
  preserving Supabase as the backward-compatible default. This created the safe,
  testable seam used by the PostgreSQL target without changing existing configurations.
- The installed-package proof now chooses an available local port block and a unique
  project identity, so local verification does not collide with another Rehearsal run.

### Added

- An ordinary PostgreSQL runtime target with guided setup, loopback-only Docker
  isolation, exact migration receipts, baseline restore, application proof, lifecycle
  commands, and a separate installed-package integration proof.
- PostgreSQL setup refuses implicit image downloads and Supabase-only Storage baselines,
  uses a fresh random local password per runtime, and requires exact Rehearsal ownership
  labels before removing resources.

### Fixed

- Plain-terminal nested menus now print their choices before asking for a number,
  including database selection, discovered baseline inputs, and runtime management.

## [0.1.0-beta.5] - 2026-10-01

### Added

- Scalable policy review with explicit table-level safe defaults, suggested structural
  exceptions, per-table summaries, and real-PTY coverage of the bulk-review journey.
- Bounded project-local discovery for baseline records, migration ledgers, and optional
  Storage manifests, plus a value-free structural preflight before activation.
- A guided `Get help` action and scriptable `rehearsal support` report with tool
  versions, readiness statuses, privacy guarantees, and a direct bug-report link.

### Changed

- Guided policy review can classify ordinary columns in bulk as synthetic replacements
  while keeping likely identifiers, relationships, and timestamps selected for
  individual review. The saved policy still records every required column decision.
- The baseline guide offers detected inputs instead of requiring memorized paths,
  validates referenced Storage files up front, previews counts without row values, and
  returns to the guide with an actionable message when validation fails.
- Beta support no longer requires users to assemble environment details by hand; the
  generated report omits project paths, row values, credentials, migration SQL, and
  baseline identifiers and remains available before setup is complete.

## [0.1.0-beta.4] - 2026-10-01

### Added

- A persistent guided session with polished terminal prompts, interactive policy review,
  concise runtime receipts, expandable technical details, and real-PTY regression tests.

### Changed

- Guided menus now place the next recommended action first and automatically re-inspect
  project state after every completed step while preserving plain and non-TTY modes.

## [0.1.0-beta.3] - 2026-10-01

### Added

- A state-aware interactive home screen that guides setup, baseline preparation,
  migration review, runtime management, verification, and cleanup without requiring
  users to memorize commands.
- A safe `setup` workflow that previews and creates a dedicated local Supabase config,
  chooses an available port block, updates protective ignore rules, and summarizes
  readiness without overwriting project files.
- A schema-only `baseline prepare` workflow that generates a fail-closed policy draft
  with explicit `REVIEW REQUIRED` decisions and never prints source row values.
- Interactive confirmation of the exact candidate migration set plus friendly progress
  and timing while a rehearsal runs.

### Changed

- Human output now recommends the next useful action, uses compact first-run readiness
  summaries, respects `NO_COLOR` and `--plain`, and renders singular counts correctly.
- Bare `rehearsal` opens the guide only in a terminal and remains noninteractive and
  script-safe when standard input or output is redirected.

### Fixed

- Setup detects unsupported Node.js versions before writing, ignores ports occupied by
  Docker or SSH forwarding, and rechecks its selected ports immediately before commit.
- Generated project identifiers are bounded to values accepted by the local runtime.

### Security

- Reviewed sanitization policy bytes are checksum-bound to the active baseline and are
  revalidated during planning and runtime restore.
- Draft or incomplete sanitization policies cannot be activated as baselines.

## [0.1.0-beta.2] - 2026-09-15

### Fixed

- Generate `rehearsal.config.mjs` so first-time initialization works in both CommonJS
  and ESM projects instead of failing when a fresh npm project declares CommonJS.
- Report the exact table and represented-migration counts after creating a synthetic
  baseline instead of rendering missing result fields as `undefined`.
- Keep the copyable getting-started migration bytes identical to its migration-ledger
  example so the documented runtime replay passes exact-history verification.
- Install the current prerelease through npm's `beta` tag so new projects do not resolve
  the superseded bootstrap release from npm's historical `latest` tag.

### Security

- Removed the completed first-package bootstrap credential path. All future publication
  uses the package's trusted GitHub Actions OIDC publisher and cannot read an npm token.

## [0.1.0-beta.1] - 2026-09-14

### Changed

- Moved the unpublished beta package from the unavailable `@rehearsal` organization to
  the project-owned `@rehearsal-db/core` package name.
- Limited the one-time first-package credential to `0.1.0-beta.1`; `0.1.0-beta.0`
  remains an unpublished, superseded GitHub release record.

## [0.1.0-beta.0] - 2026-09-14

### Added

- Versioned strict configuration and safe initializer contract.
- Doctor, immutable explain/dry-run plan, baseline inspection, and migration inspection.
- Verified run, start, migrate, reset, status, stop, discard, and runtime verification
  commands with exact candidate confirmation.
- Versioned human/machine result model, stable exit categories, and recursive redaction.
- Independent synthetic Supabase fixture with valid and deliberately invalid migrations.
- Deny-by-default sanitization coverage validation and generic KEEP, PSEUDONYMIZE,
  REPLACE, EXCLUDE, and DERIVE operation primitives.
- Public baseline, migration, schema, diagnostic, process-environment, and local-service
  library entry points for project-owned tooling.
- Approachable quick start, tutorial, configuration, security, sanitization, source,
  baseline, adapter, command, troubleshooting, release, support, and contribution guides.
- Protected verification CI, dependency updates, issue templates, package auditing, and
  dormant tokenless trusted-publishing configuration.
- Two-stage release preparation that hashes and uploads the exact npm tarball before a
  protected human approval gate, then verifies the same registry bytes and executable.
- A copyable synthetic onboarding path with matched migration, policy, data, and ledger
  examples plus explicit expected output and recovery guidance.
- A direct comparison with backups, staging, seed data, database branches, and
  migration-only tools, plus explicit beta support, typing, cost, and storage boundaries.
- Standalone repository language that removes source-project history, activates the
  security and compatibility policies, and matches the repository's available support
  channels.
- GitHub Actions upgraded to their Node.js 24 runtime generations before publication.

### Security

- Version 1 permits loopback targets only and cannot enable hosted access or outbound
  networking.
- Child processes use allowlisted environments rather than ambient hosted credentials.
- Package contents are scanned for runtime artifacts, source data, private application
  identifiers, credential formats, and hosted connection strings.
- The one-time first-package credential is limited to the first publishable beta; future
  publication uses short-lived trusted OIDC, and every release tag must already exist on
  protected `main`.

[Unreleased]: https://github.com/Ddupasquier/rehearsal-db/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/Ddupasquier/rehearsal-db/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/Ddupasquier/rehearsal-db/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Ddupasquier/rehearsal-db/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.10...v1.0.0
[0.1.0-rc.10]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.9...v0.1.0-rc.10
[0.1.0-rc.9]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.8...v0.1.0-rc.9
[0.1.0-rc.8]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.7...v0.1.0-rc.8
[0.1.0-rc.7]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.6...v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.5...v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.18...v0.1.0-rc.1
[0.1.0-beta.18]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.17...v0.1.0-beta.18
[0.1.0-beta.17]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.16...v0.1.0-beta.17
[0.1.0-beta.16]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.15...v0.1.0-beta.16
[0.1.0-beta.15]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.14...v0.1.0-beta.15
[0.1.0-beta.14]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.13...v0.1.0-beta.14
[0.1.0-beta.13]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.12...v0.1.0-beta.13
[0.1.0-beta.12]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.11...v0.1.0-beta.12
[0.1.0-beta.11]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.10...v0.1.0-beta.11
[0.1.0-beta.10]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.9...v0.1.0-beta.10
[0.1.0-beta.9]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.8...v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.7...v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.6...v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.5...v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.4...v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v0.1.0-beta.0
