# Runtime system

This doc explains how runtime selection, runtime managers, and pre-launch checks work.

## Runtime types
Modules declare their runtime ids in `manifest.runtime.supported`. Most modules use the common set:
- `electron`: the game runs inside the launcher-hosted runtime (set by `manifest.runtime.hosted.id`).
- `nwjs`: the launcher runs a NW.js runtime with a wrapper.
- `nwjs-patched`: NW.js wrapper with a patch overlay (case-insensitive assets, user scripts, module-gated engine patches).
- `native`: a native app bundle or executable is launched directly.

Modules can also define custom runtime ids that map to module-specific launchers or managers, including:
- `mkxpz` (RGSS)
- `onsyuri_mac` / `onsyuri_web` / `external` (NScripter)
- `patched` / `sdk` (Ren'Py)

## Runtime selection flow
1. Module detection populates `moduleId` and metadata.
2. `normalizeRecentEntry` selects a runtime:
   - If the entry has a runtime override, use it when supported.
   - Otherwise use `settings.modules[<id>].defaultRuntime` or `manifest.runtime.default`.
3. If the requested runtime is not supported, fallback to the first supported runtime.
4. If a runtime is supported but unavailable (for example missing a native path), the module can reject it via `canLaunchRuntime`.

## Runtime managers
Runtime managers provide:
- A list of installed versions
- A remote catalog for downloads
- Default runtime settings
- Install/uninstall actions

Runtimes are never auto-downloaded on game launch. If a runtime is missing, the launcher will ask you
to install it from the Runtimes modal.

Runtime managers are declared by modules via `runtimeManagers` and are deduped by id.
Shared submodules can also expose runtime managers by exporting manager objects from
`src/modules/shared/<submodule>/runtime/*.js`.

### MKXP-Z (RGSS)
The RGSS module registers the `mkxpz` runtime manager:
- Remote catalog uses the GitHub CLI (`gh`) against `mkxp-z/mkxp-z` Actions autobuilds.
- Runtime refresh defaults to the most recent build; use "All versions..." to load the full list.
- Install uses `gh` when available and authenticated (`gh auth status`).
- If `gh` is missing or unauthenticated, installs fall back to the bundled runtime without network calls.
- Bundled runtime source: `src/modules/rgss/resources/mkxpz/<version>/Z-universal.app`.
- Install destination: `userData/runtimes/mkxpz/<version>/`.

### Ren'Py SDK
The Ren'Py module registers the `sdk` runtime manager:
- Two sections: Ren'Py (Python 2) for Ren'Py 7 and earlier, and Ren'Py 8 (selected by `entry.moduleData.major`).
- Remote catalog uses `https://www.renpy.org/dl/` plus latest-stable hints from `https://renpy.org/latest.html` and `https://renpy.org/latest-7.html`.
- Install downloads the SDK DMG and mounts it via `hdiutil`, then copies with `ditto`.
- Install destination: `userData/runtimes/sdk/<major>/<version>/`.
- Per-game overrides live under `runtimeData.sdk.version` for the SDK runtime.

Ren'Py patching uses a separate SDK zip download (`renpy-<version>-sdk.zip`) when the user runs the Patch action.
This is not stored under `userData/runtimes/sdk/`; it is a temporary download used to stage macOS runtime files into the game.

### Godot
The Godot module registers the `godot` runtime manager:
- Remote catalog parses `https://godotengine.org/download/archive/`.
- Default remote list shows the latest release per base version; use "All versions..." to load every variant.
- Install downloads the macOS .NET zip from the archive detail page and extracts the `.app`.
- Install destination: `userData/runtimes/godot/<version>/mono/`.
- The same runtime panel includes a GDRE Tools section that downloads macOS zips from
  `https://github.com/GDRETools/gdsdecomp/releases` and installs to
  `userData/runtimes/gdsdecomp/<version>/`.
Per-game Godot runtime overrides default to the detected engine version (from PCK headers or project configs).
Detected base versions are resolved against the archive catalog on install (for example, `3.4.1` maps to the
latest `3.4.1-*` slug when available). If only a major version is detected, the launcher picks the latest
available version for that major. On launch, missing required versions trigger a pre-launch install prompt;
declines are remembered per game and per version/major bucket via `moduleData.runtimePromptSuppressedFor`.

### NW.js (Greenworks section)
The NW.js runtime manager includes a Greenworks section for Steamworks support:
- Remote catalog uses GitHub releases from `greenheartgames/greenworks`.
- Versions are keyed by the NW.js version they target.
- Install destination: `userData/runtimes/greenworks/<nwjsVersion>/`.
- When the patched NW.js runtime detects Greenworks usage, it switches to the selected Greenworks
  version automatically (no per-game toggle).

### NW.js (Patched)
The `nwjs-patched` runtime shares the NW.js manager installs but adds a patch overlay:
- Case-insensitive asset loader and offline guards are available via runtime settings.
- MV/MZ can opt into Kawariki modules (remap/fixes/vars) and decrypted asset loaders.
- Other modules only load engine-agnostic helpers unless they explicitly opt in.
- Greenworks is injected automatically when detected in the game files.
- User scripts load from `*.maclauncher.js` and `*.maclauncher.mjs` in the game root when enabled.

NW.js installs always use the SDK variant (no runtime variant toggle); the manager defaults to `0.107.0`.

### Onsyuri (NScripter)
The onsyuri runtime manager provides mac and web builds:
- Remote catalog uses GitHub releases from `YuriSizuku/OnscripterYuri`.
- Mac installs live under `userData/runtimes/onsyuri/mac/<version>/<arch>/`.
- Web installs live under `userData/runtimes/onsyuri/web/<version>/`.
- Web downloads are auto-extracted on install (expects `onsyuri.html` or `index.html` in the install root or subfolder).
Mac installs track an `arm64` or `x64` variant; defaults follow the host architecture.
- Mac builds rely on extra Homebrew libraries (`lua`, `sdl2`, `sdl2_ttf`, `sdl2_image`, `sdl2_mixer`);
  launch errors list missing dylibs with hints.

### Python tooling (evbunpack)
Some extraction helpers rely on a Python runtime:
- Managed venv path: `userData/runtimes/python/evbunpack/venv/`.
- Embedded runtime path: `src/resources/python/` (preferred when present).
- If the managed venv is missing, the launcher falls back to `python3` on PATH.
- Dependencies are expected to be present (`aplib`, `pefile`).

### Manager interface
Each manager can export:
- `id` and `label`
- `normalizeSettings(settings)`
- `applySettingsUpdate(action, payload, settings)`
- `refreshCatalog({ logger, force })`
- `getState({ settings, userDataDir })`
- `installRuntime({ userDataDir, version, variant?, logger, onProgress })`
- `uninstallRuntime({ userDataDir, version, platformKey, variant?, installDir? })`
- `updateSettingsAfterInstall(settings, installed)`
- `updateSettingsAfterUninstall(settings, payload, context)`

`getState` should return:
- `installed`: list of installed runtimes
- `catalog`: catalog state and versions
- `sections`: optional section list for the runtime modal
- `notice`: optional callout data (title + lines) surfaced in the runtime modal

## Runtime manager UI
The Runtimes modal uses manager state to render:
- Manager tabs (one per manager)
- Section tabs (if the manager reports multiple sections, e.g. NW.js Greenworks, Onsyuri mac/web, Ren'Py (Python 2)/Ren'Py 8)
- Remote versions (with refresh)
- Installed versions and uninstall actions
- Default version selection (and variant when supported)

## Per-game runtime overrides
Per-game overrides live under `runtimeData[<runtimeId>]`:
- `version` (string or null)
- `variant` (string or null, only for runtimes that support variants)

The UI exposes these overrides when the selected runtime maps to a manager.

## Runtime settings
Runtime settings are separate from runtime managers and installs.

Sources (most specific wins):
- Global defaults: `userData/runtimes/<runtimeId>/settings.json`
- Game type defaults: `settings.modules[<moduleId>].runtimeSettings[<runtimeId>]`
- Per-game overrides: `recents[].runtimeSettings[<runtimeId>]`

Runtime settings are edited from:
- Settings modal (per game type)
- Runtime settings button next to the per-game runtime selector

The Runtimes modal only exposes runtime managers and downloads.

## Pre-launch checks
Modules can define pre-launch checks per runtime:
- `manifest.runtime.preLaunch[<runtimeId>]`
- `statusAction` is invoked to inspect readiness
- `readyWhen` lists conditions that must be met
- `fixAction` is invoked when the user accepts the prompt
- `declineAction` is invoked when the user declines the prompt (optional)

This allows modules to require patching or setup before launch.

## Launch integration
- Hosted runtime uses `electron.js` in the module and `src/modules/shared/web/preload/game.js`.
- `manifest.runtime.hosted.fallback` can declare a runtime id offered when the hosted runtime fails.
- NW.js runtime uses the module's launcher helper and runtime manager settings.
- Native runtime uses `nativeAppPath` or module-specific resolution.
- Module `launchRuntime` handlers are used for custom runtimes such as Ren'Py (`sdk`/`patched`) and NScripter (`onsyuri_*`).
- On macOS, hosted Electron launches set the Dock label and icon from the game's cached icon.

## DevTools access
Web runtimes install a DevTools keybinding helper:
- macOS: Cmd+Option+I (Cmd+Shift+I also works)
- Other platforms: Ctrl+Shift+I
NW.js runtimes call `nw.Window.get().showDevTools()`, while hosted Electron runtimes ask the main process to open DevTools.
Set `MACLAUNCHER_DEVTOOLS=1` to force-enable the shortcut in supported runtimes. Use
`MACLAUNCHER_DEVTOOLS_AUTO=1` to auto-open DevTools on Electron launcher and game windows.

## Offline protections
The runtime setting labeled "Enable protections" controls offline mode for supported runtimes:
- Electron uses request blocking plus Node module guards in the game preload.
- NW.js uses injected runtime guards to block browser networking and adds
  Chromium flags (background network disables plus a loopback proxy) to suppress outbound traffic.
  Node-level guards still block `http`/`https`/`net`/`tls` modules in the background script.

## Network policy
Runtime catalogs and installs are the only built-in network operations.
These actions are always user-initiated from the Runtimes modal.
