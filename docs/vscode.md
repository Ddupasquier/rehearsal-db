# Rehearsal for VS Code

The Rehearsal extension turns the local CLI into a project-aware database-change
workbench. It is for developers who want the safety of exact migration plans and disposable
local runtimes without memorizing every command.

**Free Starter 0.1.18 is available now** as a
[reviewed GitHub VSIX preview](https://github.com/Ddupasquier/rehearsal-vscode/releases/tag/v0.1.18).
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
- Browse resource inventories in independent pages of 5, 10 or 25 cards, rather than
  one unbounded list.
- Read a configuration diff before choosing **Apply changes** or **Cancel**, then
  return to the project from the saved result.
- Choose independent, initially off automatic-update options for the extension and CLI.

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

2. Open the [Starter 0.1.18 release](https://github.com/Ddupasquier/rehearsal-vscode/releases/tag/v0.1.18).
   Under **Assets**, download `rehearsal-0.1.18.vsix` and `SHA256SUMS`. In a terminal,
   run `shasum -a 256 /path/to/rehearsal-0.1.18.vsix` on macOS or
   `sha256sum /path/to/rehearsal-0.1.18.vsix` on Linux. Compare the result with that
   release's `SHA256SUMS`; stop if they differ. Do not substitute a local rebuild.
3. In VS Code, open **Extensions → … → Install from VSIX…** and choose that file.
   If VS Code asks for a reload, save your work and choose **Reload**.
4. Review Workspace Trust, then open the Command Palette and choose
   **Rehearsal: Open Dashboard**. The Rehearsal sidebar also has a dashboard button.
5. Follow **Next best step**. Review the detected project and active configuration;
   setup, source access, migration execution and cleanup keep their own confirmations.

Install the current stable core, **1.0.0**, for the reviewed pairing with Starter 0.1.18.
The extension's minimum core is `0.1.0-rc.4`. A project that is not ready should show
setup guidance, not require you to build the extension. Opening the dashboard does not
start a database or run a migration. Use
[Getting started](getting-started.md) for the CLI and safe baseline inputs.

The verified GitHub VSIX provides a direct installation path. The release's
[official installation guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/README.md#install-and-open-your-project)
identifies available distribution channels. Native Windows, browser-based
VS Code, Codespaces, SSH and Dev Containers are not yet claimed as supported.

## Everyday editor workflow

Use **Overview** for the next safe step, **Migrations** to review the complete ordered
candidate set, and **Environments** for local resource inventory. Filters and sorting
apply to the full inventory before pagination. Each list has its own **Previous/Next**
controls and **5/10/25** page size. Paging preserves drafts and selections; bulk image
selection selects safe candidates on the current page only. Off-page selections remain
counted and can be cleared before the exact cleanup review. Display filters never narrow
database cleanup ownership or the required migration set.

For configuration, change only the values you intend to change, then choose
**Review exact configuration diff** or **Review name & protection**. The review tab
keeps the full diff readable. **Cancel** makes no changes; **Apply changes** saves the
reviewed change. Wait for **Saved**, then choose **Return to project**. Concurrent edits
refuse safely instead of overwriting someone else's work; a saved confirmation is tied
to the exact bytes read back from disk, not merely a completed write request.

Commands reuse the same Rehearsal terminal for a project only after its previous command
has a confirmed exit and its directory still matches. A running sandbox or manually
entered foreground command is never interrupted to make room for another action. If
shell integration or completion evidence is unavailable, finish the command and close
that terminal before retrying. An idle database lock is not proof that a terminal is free.

**Open sandbox** is a persistent hands-on session, not a task that should finish while
you browse. Overview distinguishes **Opening sandbox**, **Sandbox running** and
**Closing sandbox** from core phase evidence. Missing evidence says **Sandbox session
open**, not ready. Project inspection waits for that session; the app itself is not
paused. Use the local address shown by the owning terminal. **Open application** opens
that address without running another CLI command. Press **Ctrl+C** once in the owning
terminal when done, then wait for its shell prompt and the configured lifecycle result.

## Optional automatic updates

Open **Rehearsal: Check for Updates** from the Command Palette, or use the dashboard's
**Check for updates** action. The prompt has two independent, initially unchecked choices:

- **Automatically keep the Rehearsal extension up to date**
- **Automatically keep Rehearsal CLI dependencies up to date**

Check the options you want, then choose **Save preferences**. Checking a box alone does
not save consent: **Later**, **Skip versions**, or closing the tab do not opt you in.
These choices are stored only in machine-scoped VS Code user settings, not your
repository or Settings Sync. A project cannot authorize automatic installation. You can
also edit the user setting directly:

```json
"rehearsal.automaticUpdates": { "extension": true, "cli": false }
```

Extension updates download only the official GitHub release, verify the checksum,
package identity and engine compatibility, and hand the local VSIX to VS Code's
installer. Rehearsal never forces a window reload; VS Code may ask you to reload when
you are ready to activate installed code. Keep the previous reviewed VSIX for rollback.

CLI updates require the separate CLI opt-in. They update compatible registry-backed npm
dependencies in trusted, idle projects, preserve the dependency group, pin the exact
checked version and update the lockfile with install scripts disabled. Busy or
unknown-completion terminals, dirty dependency files, another window's update, offline
services and unverifiable artifacts defer the update rather than guessing. Breaking
upgrades, unsupported package managers and local/candidate provenance remain manual.
No migration, database lifecycle action or forced editor reload is requested.

Enabled automatic options check at project opening and daily while the editor stays
open; there is no separate background daemon. npm/GitHub receive ordinary connection
information and requested public releases, not project files, database data, credentials
or installed-version reports. Metadata-only advisory checks keep their separate consent.

Turn either option off to revoke its future automatic work. **Rehearsal: Configure
Update Checks → Disable updates** turns both automatic options off on this computer and
stops this project's release checks. Existing installations are not rolled back. An
interrupted package-manager update with unknown completion requires the support recovery
route; do not delete its coordination lock while a package manager may still be running.

Manual updating stays available: download and verify the next reviewed VSIX, then repeat
**Install from VSIX…**. See the release's
[installation guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/README.md#install-and-open-your-project).
An ordinary core-package update is detected from its manifest, lockfile and installed
metadata without reloading VS Code. The header shows loaded extension and core versions
separately; installed → newest appears only after a successful release check. Unknown or
offline availability is not proof that you are up to date.

## Privacy boundary

Passive inspection stays local. The extension includes no telemetry, advertising, hosted
database access, or account. It does not read environment files, credentials, private rows,
baseline contents, or project source. User-approved package operations and external links
may use their own services.

## License, support and future Pro

Starter 0.1.18 carries the
[free Starter license](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/LICENSE).
Its current review, configuration, comparison and reporting tools are included; they
are not a timed evaluation or a paid feature gate. Free use does not mean the extension
is MIT-licensed: its bundled terms govern copying and redistribution. Core remains MIT.

Future optional Pro editor workflows must be separately identified. They cannot
retroactively remove Starter rights already granted for a received version. Pro pricing,
billing and entitlements are not implemented; no payment is needed to use Starter.
Database and safety capabilities stay in the free CLI. The
[edition guide](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/docs/commercial-readiness.md)
owns the detailed boundary.

Preview describes stability, not a trial countdown. Support is best effort, with no
service-level agreement, database hosting, backups or production support. Before use,
read the release's [privacy statement](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/PRIVACY.md)
and [support policy](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/SUPPORT.md).
Report editor problems in the
[Rehearsal issue tracker](https://github.com/Ddupasquier/rehearsal-db/issues), as
described in the support policy.
Use its [private security process](https://github.com/Ddupasquier/rehearsal-vscode/blob/v0.1.18/SECURITY.md)
for vulnerabilities; never post credentials, private rows or baseline files publicly.

Historical VSIX files retain their bundled terms. Choose a reviewed release carrying
the Starter license; a development candidate is not released merely because its version
number matches. The [release list](https://github.com/Ddupasquier/rehearsal-vscode/releases)
is the authority for downloadable artifacts and their checksums.

## Try the free engine first

Start with [Getting started](getting-started.md). A successful CLI rehearsal proves the
project and local runtime are compatible before you use the visual workflow.
