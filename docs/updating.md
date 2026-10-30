# Releases and updates

The CLI and VS Code extension update separately. Their version numbers do not need to
match. Updating a package does not run migrations or reset your database.

## What changed?

Read the [CLI release notes](https://github.com/Ddupasquier/rehearsal-db/releases) or
[extension release notes](https://github.com/Ddupasquier/rehearsal-vscode/releases)
for the version you plan to install. Each component has its own release history.

## Is my environment supported?

Rehearsal supports Node.js 22, 24 and 26 on macOS and Linux. On Windows, run database
commands in a WSL 2 Linux workspace; native PowerShell and Command Prompt are not
supported database runtimes. The WSL route remains a preview, not a claim of native
Windows database support. See [supported environments and limitations](https://github.com/Ddupasquier/rehearsal-db/blob/main/COMPATIBILITY.md)
and the [Windows setup guide](getting-started.md#windows-use-a-wsl-2-linux-workspace)
before installing.

## How do I update?

### VS Code extension

Open **Extensions**, find **Rehearsal DB** (`rehearsal-db.rehearsal-db`), and choose
**Update** when available. Save your work and reload only when you are ready, if VS Code
asks. For a direct download, follow the [verified VSIX instructions](vscode.md#direct-github-installation).

Prefer automatic updates? Open **Rehearsal: Check for Updates** and save the extension
and/or CLI options you want. They are independent, initially off, and can be disabled
later. An unavailable network, busy project or incompatible update may defer installation.
See [automatic updates](vscode.md#optional-automatic-updates) for consent and privacy details.

Using the legacy preview through 0.1.18? Follow the [one-time identity migration](vscode.md#move-from-a-preview-through-0118)
instead of installing both extension identities together.

### Project CLI package

Finish active Rehearsal commands first. Read the [release notes](https://github.com/Ddupasquier/rehearsal-db/releases),
then use your project's existing package manager and dependency location. For an npm
project that keeps Rehearsal in development dependencies, update to the reviewed 2.3.0
release only after it appears in the official registry:

```bash
npm install --save-dev --save-exact @rehearsal-db/core@2.3.0
npx --no-install rehearsal --version
```

Review the package and lockfile changes before the next Rehearsal command.

### Moving from core 1.x to 2.0

Version 2.0 changes omitted lifecycle settings: database targets stop after a run
or application exit, while their data volumes and reconstruction receipts remain.
Explicit lifecycle choices keep their behavior. This is a breaking upgrade and
requires deliberate review; compatible automatic updates do not cross this boundary.

If an actively owned hands-on workflow needs the previous behavior, add these
settings to your existing configuration before the next run:

```js
lifecycle: {
  run: "keep-until-stop",
  open: "keep-until-stop",
},
```

Stopping project targets does not shut down a shared VM. The separate reviewed
VM shutdown control identifies affected workloads and has its own capability and
confirmation requirements. Keep databases, volumes, keys, baselines and recovery
files when upgrading; no reset or discard is required.

## Breaking changes or known limitations?

Check the target release notes before upgrading. Breaking upgrades, the move from a
0.x preview to stable core, and local source/tarball installations need deliberate
review rather than an automatic switch. See the [compatibility promise](stability.md#what-becomes-a-compatibility-promise)
or [troubleshooting](troubleshooting.md) when an update is refused.

Do not delete keys, baselines or sandbox data to update. Updating does not authorize
production access or make an unsupported database or platform supported. Keep the
[data-safety boundaries](security-model.md) and explicit reset/discard warnings in
force; a successful rehearsal is not a guarantee that deployment is safe.

## Where can I verify the package's origin?

Use the official [npm package](https://www.npmjs.com/package/@rehearsal-db/core),
[VS Code Marketplace listing](https://marketplace.visualstudio.com/items?itemName=rehearsal-db.rehearsal-db)
or linked GitHub releases. npm provenance links the CLI package to its public release
source and build. For a direct VSIX download, follow the [SHA-256 verification steps](vscode.md#direct-github-installation).
Origin verification does not replace reviewing a release's compatibility or safety limits.

You do not need publisher credentials, GitHub deployment approvals or the maintainer
release checklist to install or update Rehearsal. Those belong to the
[maintainer publishing guide](releasing.md).
