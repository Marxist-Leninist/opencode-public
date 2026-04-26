# OpenCode Desktop

Native OpenCode desktop app, built with Electron.

## Development

From the repo root:

```bash
bun install
bun run dev:desktop
```

## Low-Resource Mode

The desktop app defaults to low-resource mode for lower-RAM machines. In this mode
the sidecar disables full-tree file watching and icon discovery, and Electron caps
renderer V8 heap growth.

Set this to restore the heavier default behavior:

```bash
OPENCODE_DESKTOP_LOW_RESOURCE=false bun run dev:desktop
```

## Fast Local Builds

Use the fast scripts for local iteration. They skip sourcemaps and minification in
the Electron build:

```bash
bun run --cwd packages/desktop-electron build:fast
bun run --cwd packages/desktop-electron package:win:fast
```

The OpenCode sidecar build used by the desktop package already avoids embedding
the web UI; the standalone CLI build can also use `--skip-embed-web-ui` for faster
local binaries.
