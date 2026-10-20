# OS-specific setup helpers

Choose the Windows / WSL 2, macOS or Linux folder and read its README. A source
checkout contains all three folders; each release ZIP contains only its named OS.
These are readable setup scripts, not native application installers or a bundled
database engine. One shared Node helper owns setup behavior.

By default they check an existing application's `package.json` and whether npm,
the current host's `code` command and the Docker CLI are available. They do not
start Docker, a database, a container or Rehearsal; install Node/WSL/OS packages;
change security settings; create a project; or overwrite Rehearsal configuration.

Use maintained Node.js **24 or 26**. The setup target is exactly
`@rehearsal-db/core@1.0.2`; the canonical extension is
`rehearsal-db.rehearsal-db` (**Rehearsal DB**). A checked-in helper or generated
bundle does not mean that npm version or a release asset is already published.
An unavailable version stops the explicit install rather than selecting another.

Explicit `--install-cli` uses npm with scripts disabled and an exact version,
preserving a single existing dependency group or using devDependencies for a new
declaration. npm can modify `package.json`, `package-lock.json` and `node_modules`;
save your work and review that diff. Compatible installed versions at or above the
target are kept. Other package managers, local sources, ambiguous declarations and
breaking/newer requested versions require manual review; no downgrade is attempted.
No global npm installation is performed. Setup does not run the install hook or
generate config: use the normal guided setup separately when ready.

`--install-extension` explicitly installs the current Marketplace release through
the current host's `code` command, without `--force`, then checks its canonical ID.
It refuses a legacy `rehearsal-db.rehearsal` installation instead of silently removing
or migrating it. WSL refuses `--install-extension` and `--install` **before any
installation** because an unqualified `code` command cannot prove the editor host;
use `--install-cli`, then that Remote - WSL window's Extensions view. Outside WSL,
`--install` requests both steps. A failed later step does not roll back an earlier successful
install; inspect the diagnostic and dependency diff before retrying.

Maintainers, from a source checkout, can generate deterministic, separate OS ZIPs
without building product code: `node installers/build-bundles.mjs`. Each contains only its platform wrapper,
shared setup logic, these instructions and the MIT license. The generated output
is local until attached to a reviewed release. Compare `SHA256SUMS` before use.

The [getting-started guide](https://ddupasquier.github.io/rehearsal-db/getting-started/)
owns subsequent project setup and baseline/runtime safety. These helpers never
grant database access or certify every OS, architecture or WSL editor workflow.
