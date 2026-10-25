# macOS

Requires macOS and an existing Node.js 22, 24 or 26 installation. Open Terminal in this
folder. Check your existing application without installing anything:

```sh
sh setup.command "/Users/you/Projects/my app"
```

After saving work, explicitly request installation with
`sh setup.command "/Users/you/Projects/my app" --install`, or use just
`--install-cli` / `--install-extension`. A release ZIP also marks the `.command`
file executable; invoking it from Terminal keeps results visible. This helper does
not bypass Gatekeeper, install a container engine or change OS security settings.

The helper targets exact core 2.0.0 once published. It refuses existing 1.x
projects rather than adopting a breaking major automatically; review the
[shared behavior and upgrade boundaries](../README.md) before installation.
