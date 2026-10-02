# Changelog

All notable Rehearsal package changes will be documented here. The format follows Keep
a Changelog, and versions will follow Semantic Versioning after the package exists.

## Unreleased

### Added

- Scalable policy review with explicit table-level safe defaults, suggested structural
  exceptions, per-table summaries, and real-PTY coverage of the bulk-review journey.

### Changed

- Guided policy review can classify ordinary columns in bulk as synthetic replacements
  while keeping likely identifiers, relationships, and timestamps selected for
  individual review. The saved policy still records every required column decision.

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

[Unreleased]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.4...HEAD
[0.1.0-beta.4]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v0.1.0-beta.0
