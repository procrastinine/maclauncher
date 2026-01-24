# Development guide

This document covers local development, debugging, and useful scripts.

## Requirements
- Node.js + npm
- macOS (Mac-first launcher and runtime behavior)

## Install
- `npm install`

## Run the launcher
- `npm run dev` (Vite + Electron)
- `npm run dev:debug` (extra logging)
- `npm run dev` defaults `MACLAUNCHER_DEVTOOLS=1`. Set `MACLAUNCHER_DEVTOOLS_AUTO=1` to auto-open DevTools in Electron windows.

## Electron runner notes
- `scripts/run-game.mjs` uses the Electron binary from the `electron` package when available.
- On macOS it clears quarantine on the Electron.app bundle to avoid SIGABRT.
- On macOS it re-signs the Electron.app bundle if code signing is invalid.
- Set `MACLAUNCHER_SKIP_ELECTRON_XATTR=1` to skip the quarantine step.
- Set `MACLAUNCHER_SKIP_ELECTRON_CODESIGN=1` to skip the code signing fix.
- Set `MACLAUNCHER_ELECTRON_PATH=/path/to/Electron` to override the binary.

## Build and preview
- `npm run build`
- `npm run preview`

## Packaging (macOS)
MacLauncher ships the same codebase in two modes:
- Dev mode (`npm run dev`) loads the renderer from Vite (`ELECTRON_START_URL`).
- Packaged mode loads the built renderer from `dist/renderer/index.html` and bundled resources.
- Packaging keeps most module resources inside `app.asar` for faster signing; only the MKXP-Z app bundle is unpacked. If you add executable resources, update `build.asarUnpack` in `package.json`.
- Packaged builds only include the external subpaths listed in `build.extraResources`. If a module needs new `src/external` assets, update that filter.

Build a macOS app bundle:
- `npm run package:mac` (outputs to `dist/app/`)
- Add `--arm64`, `--x64`, or `--universal` to target a specific build.
- Signing uses `CSC_LINK` or `CSC_NAME` + `CSC_KEY_PASSWORD` when available.
- If no Developer ID Application identity is found in the keychain and no signing env is set, packaging builds an unsigned app.
- Notarization runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are set.
- Packaging runs `scripts/after-pack.js` to normalize bundled MKXP-Z app contents and remove the redundant `Z-universal.app` copy from build output.

## Shortcuts (.command)
Use the Shortcut button on a game card to generate a `.command` launcher.
- In dev, it runs `node scripts/run-game.mjs --game <path>`.
- In packaged builds, it opens the MacLauncher.app bundle with `--maclauncher-game=<path>`.
- Shortcuts launch with the same runtime selection and settings as the UI play action.

## Logs and debug
- Main log: `userData/logs/main.log`
- MKXP-Z log (per game): `userData/games/<gameId>/logs/rgss-mkxpz.log`
- MKXP-Z launch snapshot: `userData/games/<gameId>/logs/rgss-mkxpz.json`
- `MACLAUNCHER_DEBUG=1` enables extra logging and auto-opens DevTools for Electron windows.
- `MACLAUNCHER_DEVTOOLS=1` enables the DevTools shortcut in supported runtimes.
- `MACLAUNCHER_DEVTOOLS_AUTO=1` auto-opens DevTools for Electron launcher and game windows.

## Development tips
- Prefer adding features via modules, not hard-coded branches.
- Keep the launcher offline by default and require explicit UI actions for network access.
- Update docs whenever behavior changes.

## Embedded Python runtime
For evbunpack tooling, MacLauncher can bundle a self-contained Python runtime under `src/resources/python/`. (already exists locally)
To download and install Python 3.12 with required dependencies:
- `node scripts/setup-python-runtime.mjs`

This script downloads a macOS build from `indygreg/python-build-standalone` and installs
`pefile` + `aplib` into the embedded environment.
- It also normalizes entrypoint scripts under `src/resources/python/bin/` to run the
  bundled `python3` via a relative path.

## Embedded MKXP-Z updates
Use the autoupdate scripts to refresh the bundled MKXP-Z runtime under `src/modules/rgss/resources/mkxpz`:
- `node scripts/autoupdate-mkxpz.js` updates MKXP-Z and rewrites `src/modules/rgss/runtime/mkxpz-runtime-manager.js`.
- `node scripts/autoupdate-all.js` runs all embedded resource updates (currently MKXP-Z only).

Both scripts require the GitHub CLI (`gh`) and an authenticated session (`gh auth status`).
If the latest MKXP-Z build matches the embedded version, the script is a no-op.
