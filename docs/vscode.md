# Rehearsal for VS Code

The Rehearsal extension turns the local CLI into a project-aware database-change
workbench. It is for developers who want the safety of exact migration plans and disposable
local runtimes without memorizing every command.

## What you can do

- See what Rehearsal detected, what it suggests, and what still needs your decision.
- Review, filter, sort, and check off the exact pending migration set.
- Inspect targets, runtime state, retained baseline generations, local ports, and app URLs.
- Review safe configuration changes as an exact diff before writing them.
- Launch the same public CLI operations with their exact command and confirmation intact.
- Export a privacy-safe verification report and review bounded local activity.
- Keep the sidebar and open workbench current when another terminal changes the project's
  Rehearsal package, lockfile, manifest, or known configuration.

The extension does not become a second database engine. Rehearsal core still owns data
boundaries, baselines, migration digests, runtime isolation, locks, rollback, and cleanup.

## Privacy boundary

Passive inspection stays local. The extension includes no telemetry, advertising, hosted
database access, or account. It does not read environment files, credentials, private rows,
baseline contents, or project source. User-approved package operations and external links
may use their own services.

## Commercial preview

The free MIT-licensed CLI remains fully usable without the extension. The extension is a
separate commercial preview with a 14-day evaluation and per-user licensing. Private VSIX
installations do not auto-update, so each reviewed delivery includes its exact version,
compatible core range, checksum, privacy statement, license, and support policy.

The extension requires `@rehearsal-db/core@0.1.0-rc.4` or newer. Use the exact extension
version and checksum in your reviewed delivery; a development candidate is not a new
release merely because it has the same version number. Once active, project dependency
and configuration changes trigger a narrow, debounced, read-only refresh automatically;
users do not reload the VS Code window after an ordinary core-package update. Installing a
new private VSIX may still require VS Code's normal one-time extension-host reload so the
new extension code can become active.

The current preview supports desktop VS Code on macOS and Linux with Node.js 22, 24, or 26.
Native Windows, browser-based VS Code, Codespaces, SSH, and Dev Containers are not yet
claimed as supported.

Public purchase and download instructions will appear here only after the seller identity,
checkout/refund route, legal terms, support contact, and exact release artifact are reviewed.
Do not send payment based on an unofficial download or message.

## Try the free engine first

Start with [Getting started](getting-started.md). A successful CLI rehearsal proves the
project and local runtime are compatible before you evaluate the visual workflow.
