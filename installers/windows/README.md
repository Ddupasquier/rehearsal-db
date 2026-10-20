# Windows: WSL 2, not native Windows runtime

Requires an existing WSL 2 distribution with Linux Node.js 24 or 26 and an existing
application inside that distribution's Linux home directory. The helper does not
install/convert WSL, move a project, install Node/Docker, request administrator access
or bypass PowerShell execution policy. Use scripts only under your existing policy.

In PowerShell, inspect prerequisites and available distributions:

```powershell
.\setup.ps1
```

Then check a selected existing project (the quoted path is a Linux path):

```powershell
.\setup.ps1 -Distribution Ubuntu -Project "/home/you/projects/my app"
```

This executes only the Node prerequisite/setup checks inside the selected distro;
an existing stopped distro may start. No Docker engine, container or database is
started. Save work, then add `-InstallCli` to explicitly install exact core 1.0.1.
If Linux Node is managed by nvm and is absent from WSL's non-login PATH, pass its
absolute path with `-NodePath "/home/you/.nvm/versions/node/v24.21.0/bin/node"`.
The helper does not load shell startup files or install/change Node versions.

For extension installation, open that same project with **VS Code: Remote - WSL**.
Install **Rehearsal DB** / `rehearsal-db.rehearsal-db` in that window's Extensions
view. The helper refuses `-InstallExtension` and `-Install`, even inside a terminal
with a VS Code IPC variable: that variable alone does not prove the editor host.
No CLI install is started when those combined/extension flags are refused.

See the [shared behavior and boundaries](../README.md). Native Windows Node runtime,
WSL 1 and Windows-mounted project folders are not promoted to database support.
