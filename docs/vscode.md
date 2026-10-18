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

## Install and open your project

Use desktop VS Code 1.101 or newer on macOS or Linux and a supported Node.js release
(22, 24, or 26). You do not need the extension source repository or Test Lab.

1. Open your application's folder in VS Code—the one containing `package.json` and
   your migrations. Install Rehearsal there if it is missing:

   ```bash
   npm install --save-dev @rehearsal-db/core
   ```

2. Open the [reviewed GitHub prereleases](https://github.com/Ddupasquier/rehearsal-vscode/releases).
   Download the chosen release's `.vsix` and `SHA256SUMS`. Compare the file's SHA-256
   with that release's checksum; do not substitute an unreviewed rebuild.
3. In VS Code, open **Extensions → … → Install from VSIX…** and choose that file.
   Reload the extension host if VS Code asks.
4. Review Workspace Trust, then open the Command Palette and choose
   **Rehearsal: Open Dashboard**. The Rehearsal sidebar also has a dashboard button.
5. Follow **Next best step**. Review the detected project and active configuration;
   setup, source access, migration execution and cleanup keep their own confirmations.

The extension needs `@rehearsal-db/core@0.1.0-rc.4` or newer. A project that is not ready
should show setup guidance, not require you to build the extension. Use
[Getting started](getting-started.md) for the CLI and safe baseline inputs.

## Updates

GitHub VSIX installations do not auto-update. Download and verify the next reviewed
release, then use **Install from VSIX…** again. Keep the previous reviewed file for
rollback. See the extension's [installation guide](https://github.com/Ddupasquier/rehearsal-vscode#install-and-open-your-project)
for checksum commands and the optional command-line installer.

Updating the project's core package is separate: its manifest, lockfile and installed
metadata trigger a narrow read-only refresh automatically. You do not reload the VS Code
window after an ordinary core-package update. Replacing the VSIX may require VS Code's
one-time extension-host reload so the new extension code becomes active.

## Privacy boundary

Passive inspection stays local. The extension includes no telemetry, advertising, hosted
database access, or account. It does not read environment files, credentials, private rows,
baseline contents, or project source. User-approved package operations and external links
may use their own services.

## Licensing and planned editions

The approved direction is a complete free MIT CLI, a useful free VS Code Starter, and
optional paid Pro editor workflows. The [extension's edition guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/main/docs/commercial-readiness.md)
owns that planned split. Database and safety capabilities stay in the free CLI.

The split is not implemented yet: current preview artifacts retain their bundled 14-day
evaluation and per-user license, without a technical trial countdown or feature paywall.
GitHub VSIX installations do not auto-update, so each reviewed delivery includes its exact
version, compatible core range, checksum, privacy statement, license, and support policy.

Technical GitHub prereleases are already public; they are not a Marketplace listing or
an announcement of paid availability. A development candidate is not a released artifact
merely because it has the same version number. Read the release's license, privacy and
support documents before evaluation.

Starter/Pro license terms and Marketplace distribution still need approval. Paid Pro
availability also needs reviewed seller identity, checkout/refund arrangements and support
ownership. Do not send payment based on an unofficial download or message. Native Windows,
browser-based VS Code, Codespaces, SSH and Dev Containers are not yet claimed as supported.

## Try the free engine first

Start with [Getting started](getting-started.md). A successful CLI rehearsal proves the
project and local runtime are compatible before you evaluate the visual workflow.
