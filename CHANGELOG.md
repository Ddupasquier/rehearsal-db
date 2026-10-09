# Changelog

All notable Rehearsal package changes will be documented here. The format follows Keep
a Changelog, and versions will follow Semantic Versioning after the package exists.

## Unreleased

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

[Unreleased]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-rc.2...HEAD
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
