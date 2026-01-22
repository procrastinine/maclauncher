# Data model

This document describes how launcher state is stored on disk and how per-game data is normalized.

## Storage locations
The root data directory is Electron `userData`. On macOS the default path is:
- `~/Library/Application Support/maclauncher/`

Common subpaths:
- `settings.json`: launcher state (recents, module settings, runtime settings)
- `logs/main.log`: main process log
- `modules/<moduleId>/`: module-specific data
- `runtimes/<managerId>/`: runtime manager installs
- `runtimes/nwjs/`: NW.js runtime installs
- `runtimes/greenworks/`: Greenworks builds keyed by NW.js version
- `runtimes/mkxpz/`: MKXP-Z installs
- `runtimes/onsyuri/`: onsyuri mac/web runtime installs
- `runtimes/sdk/`: Ren'Py SDK installs (by major/version)
- `runtimes/python/evbunpack/`: optional Python venv for evbunpack tooling
- `icons/`: cached launcher icons (app/exe extractions)
- `modules/rgss/assets/`: staged RTP, Kawariki, and soundfont assets
- `modules/renpy/builds/`: Ren'Py built app bundles
- `modules/renpy/projects/`: Ren'Py SDK wrapper projects
- `modules/renpy/patches/`: Ren'Py patch metadata
- `modules/renpy/extracted/`: Ren'Py extracted/decompiled output
- `modules/godot/extracted/`: Godot GDRE Tools output
- `modules/<moduleId>/nwjs/`: NW.js wrapper roots + profiles per game
- `modules/<moduleId>/nwjs-patched/`: patched NW.js wrapper roots + profiles
- `modules/construct/extracted/`, `modules/tyrano/extracted/`, `modules/nscripter/extracted/`: extracted packaged game roots
- `modules/nscripter/onsyuri-mac/wrappers/`, `modules/nscripter/onsyuri-web/wrappers/`: onsyuri staging wrappers

## settings.json
`settings.json` is the only persistent launcher state. All other data is derived from it at runtime.

Top-level keys:
- `recents`: ordered list of recent games
- `modules`: per-module settings (by module id)
- `runtimes`: per-runtime-manager settings (by manager id)
- `launcher`: global launcher UI settings

Example:
```json
{
  "recents": [
    {
      "gamePath": "/Games/MyGame",
      "name": "MyGame",
      "moduleId": "example",
      "runtimeId": "electron",
      "moduleData": {},
      "runtimeData": {},
      "runtimeSettings": {},
      "saveDirOverride": null,
      "defaultSaveDir": "/Games/MyGame/save",
      "cheats": {},
      "iconPath": "/Users/me/Library/Application Support/maclauncher/icons/abcd1234-app.png",
      "iconSource": "app"
    }
  ],
  "modules": {
    "example": {
      "defaultRuntime": "electron",
      "runtimeSettings": {
        "electron": {
          "enableProtections": true
        }
      }
    }
  },
  "runtimes": {
    "nwjs": {
      "defaultVersion": "0.107.0",
      "greenworksDefaultVersion": "0.103.1"
    },
    "onsyuri": {
      "mac": {
        "defaultVersion": "0.7.5",
        "defaultVariant": "arm64"
      },
      "web": {
        "defaultVersion": "0.7.5"
      }
    }
  },
  "launcher": {
    "showIcons": true,
    "showNonDefaultTags": true
  }
}
```

The launcher normalizes missing fields on load.

## Recent entry normalization
Every entry is normalized by `normalizeRecentEntry` in `src/main/main.js`.

Normalized fields (not exhaustive):
- `gamePath`: absolute path to the game root
- `name`: display name (from detection or fallback; prefers exe base name before folder name)
- `moduleId`: module id used for settings and hooks
- `moduleLabel`, `moduleShortLabel`, `moduleFamily`: module metadata
- `gameType`: module game type label
- `contentRootDir`: path used for runtime content
- `indexDir`, `indexHtml`: resolved web index paths (if any)
- `runtimeId`: selected runtime
- `runtimeData`: per-runtime overrides (version, variant when supported, etc)
- `runtimeSettings`: per-runtime settings overrides for this game (when set)
- `moduleData`: module-specific overrides (library versions, tools button overrides)
- `defaultSaveDir`: module-detected save directory
- `saveDirOverride`: per-game save override
- `cheats`: normalized cheat payload (if supported)
- `lastPlayedAt`: timestamp of last play
- `lastBuiltAt`: timestamp of last build/patch action
- `moduleRuntimeSupport`: runtime ids supported for this game
- `moduleSupports`: supports flags (`cheats`, `cheatsPatcher`, `saveEditing`, `saveLocation`)
- `importPath`: original import path when available (file or folder)
- `iconPath`: absolute path to the cached or module-provided icon image
- `iconSource`: `module`, `app`, `exe`, or `module-default`

## Module settings
- Stored under `settings.modules[<moduleId>]`.
- Defaults are derived from `manifest.settingsDefaults`.
- If a module has no settings, the UI still shows an empty section.
- Runtime settings defaults live under `settings.modules[<moduleId>].runtimeSettings`.

## Runtime manager settings
- Stored under `settings.runtimes[<managerId>]`.
- The runtime manager defines how settings are normalized and updated.
- NW.js settings store `greenworksDefaultVersion` for the Greenworks section; the patched runtime
  uses it when Greenworks is detected.
- Onsyuri settings live under `settings.runtimes.onsyuri.mac` and `settings.runtimes.onsyuri.web`.
- Ren'Py SDK settings live under `settings.runtimes.sdk.v7` (Ren'Py 7 and earlier / Python 2) and `settings.runtimes.sdk.v8`.

## Module data
`moduleData` stores module-specific overrides:
- Library version overrides (`libVersions`)
- Module UI overrides (for example, tools button visibility)
- Any other module-owned data

RGSS module fields:
- `rgssVersion`: `RGSS1`, `RGSS2`, or `RGSS3` (detected)
- `rtpId`: `Standard`, `RPGVX`, or `RPGVXAce` (detected)
- `execName`: Windows exe base name (detected)
- `assetsStaged`: whether bundled assets are staged
- `runtimeSource`: `GitHub Actions` or `Bundled` (installed runtime source)

MV/MZ module fields:
- `clipboardPluginInstalled`: whether Clipboard_llule is installed/enabled
- `saveSlotsPluginInstalled`: whether CustomizeMaxSaveFile is installed/enabled

Ren'Py module fields:
- `version`: detected Ren'Py runtime version
- `major`: normalized major (7 for Ren'Py 7 and earlier, 8 for Ren'Py 8)
- `baseName`: launcher script base name
- `gameOnly`: true for game-only imports
- `patched` / `partial`: patch status
- `builtSdkVersion`: SDK used for the last build
- `extractedRoot`: extracted output root in userData
- `extractedReady`: whether extraction output exists
- `extractedAt`: timestamp for the last extraction
- `extractedIconPath`: cached icon path from extracted sources

Godot module fields:
- `packagedType`: `app-bundle`, `pck`, `exe-embedded`, `exe-sibling-pck`, `project-dir`
- `packagedPath`: input path that was detected
- `packPath`: PCK or executable path when applicable
- `packOffset` / `packSize`: embedded pack metadata for executables
- `projectRoot`: project directory for `project-dir` inputs
- `detectedVersion`: detected engine version (`4.2.1`, `3.1.x`, etc)
- `detectedMajor` / `detectedMinor`: detected engine major/minor
- `detectedSource`: `PCK header`, `Project config`, or `GDRE Tools`
- `detectedLabel`: derived display string for version detection (`3.4.1 (PCK header)`)
- `detectedBytecodeRevision` / `detectedBytecodeVersion`: last GDRE Tools detection
- `runtimePromptSuppressedFor`: suppression key (`version:<ver>` or `major:<major>`)
- `extractedRoot`: GDRE Tools output root
- `extractedReady`: whether extraction output exists
- `extractedAt`: timestamp for the last extraction
- `gdreInstalled`: whether GDRE Tools is installed
- `gdreVersion`: installed GDRE Tools version
- `gdreLabel`: derived display string for GDRE Tools status (`GDRE Tools (2.4.0)`)
- `gdreLastAction`: last GDRE Tools action id
- `gdreLastActionAt`: timestamp for last GDRE Tools action
- `gdreLastActionStatus`: `success` or `error`
- `gdreLastActionTarget`: last GDRE Tools input path
- `gdreLastActionOutput`: last GDRE Tools output path
- `gdreLastActionError`: last GDRE Tools error string

Tyrano module fields:
- `version`: detected Tyrano version
- `packagedType`: `zip-exe`, `package.nw`, or `asar`
- `packagedPath`: path to packaged payload
- `extractedRoot`: extracted bundle root in userData
- `extractedReady`: whether extraction is ready
- `bundleRevealPath`: path used by the Reveal action

Construct module fields:
- `constructRuntime`: detected Construct runtime (2 or 3)
- `packagedType`: `zip-exe` or `package.nw`
- `packagedPath`: path to packaged payload
- `extractedRoot`: extracted bundle root in userData
- `extractedReady`: whether extraction is ready

NScripter module fields:
- `packagedType`: `zip-exe` or `7z-exe`
- `packagedPath`: path to packaged payload

## Runtime data
`runtimeData` stores per-runtime overrides:
- `runtimeData[<runtimeId>].version`: runtime version override
- `runtimeData[<runtimeId>].variant`: runtime variant override when the manager supports variants

Runtime managers interpret these values when launching a game.
The Onsyuri manager also reads `runtimeData.onsyuri` as a shared override for NScripter runtimes.

## Runtime settings
Runtime settings are stored in three layers (most specific wins):
- Global defaults: `userData/runtimes/<runtimeId>/settings.json`
- Game type defaults: `settings.modules[<moduleId>].runtimeSettings[<runtimeId>]`
- Per-game overrides: `recents[].runtimeSettings[<runtimeId>]`

If a game has no per-game override, it uses the game type defaults.
Overrides that match higher-level defaults are omitted so changes cascade down automatically.

## Stable ids
Per-game files are keyed by a stable hash derived from `gamePath`:
- `stableId = sha256(gamePath).slice(0, 12)`

Stable ids are used for:
- Per-game cheat files
- Module build caches
- Runtime wrapper folders

## Cheats storage
Cheat state is stored per module and per game:
- `userData/modules/<moduleId>/cheats/<stableId>.json`

When tools patching is used, logs are written next to the cheat file:
- `<cheatsFile>.tools-bootstrap.log`
- `<cheatsFile>.tools-runtime.log`

## Runtime installs
Runtime managers store installs under:
- `userData/runtimes/<managerId>/`

Exact layout is manager-specific but should be stable and deterministic.

Examples:
- `userData/runtimes/mkxpz/<version>/`
- `userData/runtimes/nwjs/<version>/<platformKey>/<variant>/`
- `userData/runtimes/greenworks/<nwjsVersion>/`
- `userData/runtimes/onsyuri/mac/<version>/<arch>/`
- `userData/runtimes/onsyuri/web/<version>/`
- `userData/runtimes/sdk/<major>/<version>/`
- `userData/runtimes/python/evbunpack/venv/` (if created)

## Logs
- Main process logs: `logs/main.log`
- Module patch logs: next to the modified files or per-game module folders
- NW.js runtime logs: stored by the runtime manager (if any)
