# Data model

This document describes how launcher state is stored on disk and how per-game data is normalized.

## Design rule
ALL info about an individual game in userData lives under `userData/games/<gameId>/`. Nothing per-game is stored under module or runtime roots.

## Storage locations
The root data directory is Electron `userData`. On macOS the default path is:
- `~/Library/Application Support/maclauncher/`

Common subpaths:
- `settings.json`: launcher + module + runtime manager settings (no game list)
- `games/<gameId>/`: per-game data root
- `modules/<moduleId>/`: shared module assets (not per-game)
- `runtimes/<managerId>/`: shared runtime installs (not per-game)
- `runtimes/<runtimeId>/settings.json`: global runtime defaults
- `logs/main.log`: launcher log

### Per-game directory layout
Everything specific to a game lives under `games/<gameId>/`:
- `games/<gameId>/game.json`: per-game record (authoritative game info)
- `games/<gameId>/cheats.json`: per-game cheats payload (runtime file, mirrored from `game.json`)
- `games/<gameId>/cheats.json.tools-bootstrap.log`: tools bootstrap log (when patching is used)
- `games/<gameId>/cheats.json.tools-runtime.log`: tools runtime log (when patching is used)
- `games/<gameId>/cheats.json.rgss-teleports.json`: RGSS teleport slots (if used)
- `games/<gameId>/icons/`: per-game icon cache
- `games/<gameId>/logs/`: per-game logs (MKXP-Z launch log, etc)
- `games/<gameId>/modules/<moduleId>/`: module-specific per-game data
- `games/<gameId>/runtimes/<runtimeId>/`: per-game runtime data (wrappers, profiles, staging)
- `games/<gameId>/partition/`: symlink target for the game’s Electron storage partition

### Per-game module folders (examples)
- `games/<gameId>/modules/renpy/`: `builds/`, `projects/`, `patches/`, `extracted/`, `icons/`
- `games/<gameId>/modules/godot/`: `extracted/`, `gdre-detect/`
- `games/<gameId>/modules/rgss/extracted/`: decrypted RGSS assets
- `games/<gameId>/modules/mv/extracted/`, `games/<gameId>/modules/mz/extracted/`: decrypted assets
- `games/<gameId>/modules/construct/extracted/`: extracted NW.js bundles
- `games/<gameId>/modules/tyrano/extracted/`: extracted NW.js bundles
- `games/<gameId>/modules/nscripter/extracted/`: extracted packaged assets

### Per-game runtime folders (examples)
- `games/<gameId>/runtimes/nwjs/`: `wrappers/`, `profiles/`
- `games/<gameId>/runtimes/nwjs-patched/`: `wrappers/`, `profiles/`
- `games/<gameId>/runtimes/onsyuri_mac/`: `wrappers/`
- `games/<gameId>/runtimes/onsyuri_web/`: `wrappers/`

### Shared module data (not per-game)
- `modules/rgss/assets/`: staged RTP/Kawariki/SF2 assets
- `modules/rgss/cheats/`: shared RGSS cheat runtime (`maclauncher-cheats.rb`)
- `modules/nscripter/assets/`: shared fallback font
- `modules/godot/gdre-user/`: GDRE Tools user environment

### Shared runtime installs (not per-game)
Runtime managers install shared runtimes under `userData/runtimes/<managerId>/`.
Examples:
- `runtimes/mkxpz/<version>/`
- `runtimes/nwjs/<version>/<platformKey>/<variant>/`
- `runtimes/greenworks/<nwjsVersion>/`
- `runtimes/onsyuri/mac/<version>/<arch>/`
- `runtimes/onsyuri/web/<version>/`
- `runtimes/sdk/<major>/<version>/`
- `runtimes/godot/<version>/mono/`
- `runtimes/gdsdecomp/<version>/`
- `runtimes/python/evbunpack/venv/`

Electron stores partition data under `userData/Partitions/`. MacLauncher symlinks each game partition to `games/<gameId>/partition/` so per-game deletion is enough.

Deleting `games/<gameId>/` is equivalent to forgetting the game in the UI (all userData for the game is removed).

## settings.json
`settings.json` stores only global launcher settings. Per-game data is not stored here.

Top-level keys:
- `modules`: per-module settings (by module id)
- `runtimes`: per-runtime-manager settings (by manager id)
- `launcher`: global launcher UI settings

Example:
```json
{
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
    "showNonDefaultTags": true,
    "library": {
      "version": 1,
      "order": [
        "e4f0f1e2c7f24b6aa1b4d6b1c9e5a8f2"
      ],
      "sort": {
        "mode": "recent",
        "direction": "desc"
      },
      "favorites": []
    }
  }
}
```

The launcher normalizes missing fields on load.

## game.json
Each game has a unique `gameId` and a dedicated folder under `games/<gameId>/`.
`game.json` is the unified per-game record stored there.

Example:
```json
{
  "schemaVersion": 1,
  "gameId": "e4f0f1e2c7f24b6aa1b4d6b1c9e5a8f2",
  "order": 0,
  "createdAt": 1717000000000,
  "updatedAt": 1717000100000,
  "gamePath": "/Games/MyGame",
  "importPath": "/Games/MyGame",
  "name": "MyGame",
  "moduleId": "renpy",
  "gameType": "scripted",
  "indexDir": null,
  "indexHtml": null,
  "contentRootDir": "/Games/MyGame",
  "defaultSaveDir": "/Users/me/Library/RenPy/MyGame",
  "saveDirOverride": null,
  "nativeAppPath": null,
  "runtimeId": "sdk",
  "runtimeData": {},
  "runtimeSettings": {},
  "moduleData": {},
  "cheats": {},
  "iconPath": "/Users/me/Library/Application Support/maclauncher/games/e4f0.../icons/icon-app.png",
  "iconSource": "app",
  "lastPlayedAt": 1717000100000,
  "lastBuiltAt": null
}
```

Key fields:
- `gameId`: unique id for the game (directory name).
- `order`: legacy UI ordering (derived from the launcher library order list).
- `createdAt`, `updatedAt`: timestamps for record maintenance.
- `name`: display name (normalized and persisted).
- `iconPath`, `iconSource`: resolved icon and its source (`module`, `module-default`, `app`, `exe`; null when unset).
- `runtimeData`: per-runtime overrides (version/variant).
- `runtimeSettings`: per-runtime settings overrides for this game.
- `moduleData`: module-specific per-game metadata and overrides.
- `cheats`: normalized cheat payload (also mirrored to `cheats.json`).

The launcher hydrates cheats from `cheats.json` when present and mirrors updates back to it so
runtime helpers can read a stable per-game cheats file.

## Cheats storage
Cheat data is per game (not per module):
- `games/<gameId>/cheats.json`: authoritative cheat payload
- `games/<gameId>/cheats.json.tools-bootstrap.log`: tools bootstrap log (patched runtimes)
- `games/<gameId>/cheats.json.tools-runtime.log`: tools runtime log (patched runtimes)
- `games/<gameId>/cheats.json.rgss-teleports.json`: RGSS teleport slots (if used)

## Game entry normalization
Every entry is normalized by `normalizeGameEntry` in `src/main/main.js`.

Normalized fields (not exhaustive):
- `gameId`: unique per-game id (directory name)
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
- `iconSource`: `module`, `module-default`, `app`, `exe` (null when unset)

The launcher derives the UI recents list from the library order (mirrored into ordered `game.json` entries).

## Launcher library state
Library ordering and future library metadata are stored under `settings.launcher.library`.
This structure is the authoritative order for the launcher list and is designed to support
future sorting and favorites without changing per-game records.

Fields:
- `version`: schema version for the library state.
- `order`: ordered array of `gameId` entries (current list order).
- `sort`: reserved for future sort mode metadata (`mode`, `direction`).
- `favorites`: reserved for future favorite/star metadata (array of `gameId`).

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
- `archivePath`: detected RGSS archive path for decryption
- `decryptedRoot`: decryption output root in userData
- `decryptedReady`: whether decrypted output exists
- `decryptedAt`: timestamp for the last decryption run
- `decryptedMode`: `decrypt` or `reconstruct`

MV/MZ module fields:
- `clipboardPluginInstalled`: whether Clipboard_llule is installed/enabled
- `saveSlotsPluginInstalled`: whether CustomizeMaxSaveFile is installed/enabled
- `decryptedRoot`: decryption output root in userData
- `decryptedReady`: whether decrypted output exists
- `decryptedAt`: timestamp for the last decryption run
- `decryptedMode`: `decrypt` or `reconstruct`

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
- Per-game overrides: `games/<gameId>/game.json` -> `runtimeSettings[<runtimeId>]`

If a game has no per-game override, it uses the game type defaults.
Overrides that match higher-level defaults are omitted so changes cascade down automatically.

## Game IDs
Each game gets a unique `gameId` on import. It is stored in `game.json` and used as the
filesystem key for per-game data under `userData/games/<gameId>/`.

`gameId` values are random hex identifiers (not derived from `gamePath`). Stable hash ids are no longer used.
