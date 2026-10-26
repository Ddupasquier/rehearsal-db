# Linux

Requires Linux and an existing Node.js 22, 24 or 26 installation. Check an existing
application without installing anything:

```sh
sh setup.sh "/home/you/projects/my app"
```

After saving work, explicitly request installation with
`sh setup.sh "/home/you/projects/my app" --install`, or use just
`--install-cli` / `--install-extension`. No sudo, system packages, Docker startup,
containers or database operation is requested. Docker CLI presence does not prove
the engine is running or that your account has access.

For WSL use WSL 2 and a project inside its Linux home filesystem. Windows-mounted
projects such as `/mnt/c/...`, Windows-backed bind mounts and unknown filesystems
are refused. In WSL request only `--install-cli`, then install the editor component
from the Remote - WSL window's Extensions view; `--install` and
`--install-extension` refuse before installing anything.

The helper targets exact core 2.0.0 once published. It refuses existing 1.x
projects rather than adopting a breaking major automatically; review the
[shared behavior and upgrade boundaries](../README.md) before installation.
