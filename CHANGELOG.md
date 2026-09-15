# Changelog

All notable Rehearsal package changes will be documented here. The format follows Keep
a Changelog, and versions will follow Semantic Versioning after the package exists.

## Unreleased

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

[Unreleased]: https://github.com/Ddupasquier/rehearsal-db/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v0.1.0-beta.0
