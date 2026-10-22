# Keep Rehearsal up to date

The CLI and VS Code extension update separately. Their version numbers do not need to
match. Updating a package does not run migrations or reset your database.

## VS Code extension

Open **Extensions**, find **Rehearsal DB** (`rehearsal-db.rehearsal-db`), and choose
**Update** when available. Save your work and reload only when you are ready, if VS Code
asks. For a direct download, follow the [verified VSIX instructions](vscode.md#direct-github-installation).

Prefer automatic updates? Open **Rehearsal: Check for Updates** and save the extension
and/or CLI options you want. They are independent, initially off, and can be disabled
later. An unavailable network, busy project or incompatible update may defer installation.
See [automatic updates](vscode.md#optional-automatic-updates) for consent and privacy details.

Using the legacy preview through 0.1.18? Follow the [one-time identity migration](vscode.md#move-from-a-preview-through-0118)
instead of installing both extension identities together.

## Project CLI package

Finish active Rehearsal commands first. Read the [release notes](https://github.com/Ddupasquier/rehearsal-db/releases),
then use your project's existing package manager and dependency location. For an npm
project that keeps Rehearsal in development dependencies, the current stable version is:

```bash
npm install --save-dev --save-exact @rehearsal-db/core@1.1.0
npx --no-install rehearsal --version
```

Review the package and lockfile changes. Do not delete keys, baselines or sandbox data
to update. A breaking upgrade or a local source/tarball installation needs deliberate
review rather than an automatic switch. See the [compatibility promise](stability.md)
and [troubleshooting](troubleshooting.md) if an update is refused.

You do not need publisher credentials, GitHub deployment approvals or the maintainer
release checklist to install or update Rehearsal. Those belong to the
[maintainer release process](releasing.md).
