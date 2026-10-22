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

See the [shared behavior and boundaries](../README.md) before installation.
