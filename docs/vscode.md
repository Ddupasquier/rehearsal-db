# Rehearsal for VS Code

The Rehearsal extension turns the local CLI into a project-aware database-change
workbench. It is for developers who want the safety of exact migration plans and disposable
local runtimes without memorizing every command.

**Free Starter is available now** as a
[reviewed GitHub VSIX preview](https://github.com/Ddupasquier/rehearsal-vscode/releases/tag/v0.1.12).
All included features are free indefinitely for personal or commercial development.
No account, payment card, purchase, trial period, or license activation is required.
The CLI is separately available on [npm](https://www.npmjs.com/package/@rehearsal-db/core)
under the MIT license. There is no paid CLI tier.

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

2. Open the [Starter 0.1.12 release](https://github.com/Ddupasquier/rehearsal-vscode/releases/tag/v0.1.12).
   Under **Assets**, download `rehearsal-0.1.12.vsix` and `SHA256SUMS`. In a terminal,
   run `shasum -a 256 /path/to/rehearsal-0.1.12.vsix` on macOS or
   `sha256sum /path/to/rehearsal-0.1.12.vsix` on Linux. Compare the result with that
   release's `SHA256SUMS`; stop if they differ. Do not substitute a local rebuild.
3. In VS Code, open **Extensions → … → Install from VSIX…** and choose that file.
   If VS Code asks for a reload, save your work and choose **Reload**.
4. Review Workspace Trust, then open the Command Palette and choose
   **Rehearsal: Open Dashboard**. The Rehearsal sidebar also has a dashboard button.
5. Follow **Next best step**. Review the detected project and active configuration;
   setup, source access, migration execution and cleanup keep their own confirmations.

Install the current stable core, **1.0.0**, for the reviewed pairing with Starter 0.1.12.
The extension's minimum core is `0.1.0-rc.4`. A project that is not ready should show
setup guidance, not require you to build the extension. Opening the dashboard does not
start a database or run a migration. Use
[Getting started](getting-started.md) for the CLI and safe baseline inputs.

The public installation channel is GitHub VSIX, not VS Code Marketplace. Searching
Marketplace is not an installation step for this preview. Native Windows, browser-based
VS Code, Codespaces, SSH and Dev Containers are not yet claimed as supported.

## Updates

GitHub VSIX installations do not auto-update. Download and verify the next reviewed
release, then use **Install from VSIX…** again. Keep the previous reviewed file for
rollback. See the release's [installation guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.12/README.md#install-and-open-your-project)
for checksum commands and the optional command-line installer.

The preview offers optional, consented release checks through **Rehearsal: Check for
Updates**. Checks provide guidance; they do not install an extension or change project
dependencies automatically. The header shows the loaded extension and project core
versions separately. A newer version is shown only after a successful release check;
unknown or offline availability is not proof that you are up to date.

Updating the project's core package is separate: its manifest, lockfile and installed
metadata trigger a narrow read-only refresh automatically. You do not reload the VS Code
window after an ordinary core-package update. Replacing the VSIX may require VS Code's
one-time extension-host reload so the new extension code becomes active.

## Privacy boundary

Passive inspection stays local. The extension includes no telemetry, advertising, hosted
database access, or account. It does not read environment files, credentials, private rows,
baseline contents, or project source. User-approved package operations and external links
may use their own services.

## License, support and future Pro

Starter 0.1.12 carries the
[free Starter license](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.12/LICENSE).
Its current review, configuration, comparison and reporting tools are included; they
are not a timed evaluation or a paid feature gate. Free use does not mean the extension
is MIT-licensed: its bundled terms govern copying and redistribution. Core remains MIT.

Future optional Pro editor workflows must be separately identified. They cannot
retroactively remove Starter rights already granted for a received version. Pro pricing,
billing and entitlements are not implemented; no payment is needed to use Starter.
Database and safety capabilities stay in the free CLI. The
[edition guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.12/docs/commercial-readiness.md)
owns the detailed boundary.

Preview describes stability, not a trial countdown. Support is best effort, with no
service-level agreement, database hosting, backups or production support. Before use,
read the release's [privacy statement](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.12/PRIVACY.md)
and [support policy](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.12/SUPPORT.md).
Report editor problems in the
[Rehearsal issue tracker](https://github.com/Ddupasquier/rehearsal-db/issues), as
described in the support policy.
Use its [private security process](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.12/SECURITY.md)
for vulnerabilities; never post credentials, private rows or baseline files publicly.

Historical VSIX files retain their bundled terms. Choose a reviewed release carrying
the Starter license; a development candidate is not released merely because its version
number matches. The [release list](https://github.com/Ddupasquier/rehearsal-vscode/releases)
is the authority for downloadable artifacts and their checksums.

## Try the free engine first

Start with [Getting started](getting-started.md). A successful CLI rehearsal proves the
project and local runtime are compatible before you use the visual workflow.
