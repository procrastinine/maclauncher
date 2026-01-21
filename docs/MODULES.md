# Module system

MacLauncher is module-first. The launcher never hard-codes per-engine branches; it discovers modules at runtime and drives UI and behavior from module metadata.

This doc describes the module contract, detection pipeline, and how modules integrate into UI, settings, runtimes, saves, and cheats.

## Goals
- Extensible: adding a new module automatically appears in the UI, settings, and runtime manager lists.
- Modular: engine-specific logic and assets live inside the module directory.
- Uniform: modules follow the same file layout and data conventions.
- Safe: network access is only used behind explicit user actions (runtime catalog refresh/install).

## Standard module layout
Each module lives in `src/modules/<moduleId>/` and uses a consistent layout:
- `manifest.json` (required): metadata and UI contract.
- `main.js` (required): module hooks and runtime integrations.
- `detect.js` (optional): detection helpers (imported by `main.js`).
- `electron.js` (optional): electron runtime bootstrap (loaded by `src/modules/shared/web/preload/game.js`) for engine-specific shims and setup.
- `runtime/` (optional): runtime managers, patchers, installers, wrappers.
- `libs/` (optional): library catalog + patcher.
- `resources/` (optional): bundled assets required by the module.
  Large third-party bundles can live under `src/external/` instead of `resources/` to avoid duplication.
  If a module depends on new `src/external` assets, add the needed subpaths to `build.extraResources`.
- `resources/icon.png` (optional): default icon fallback for games in this module.

Do not reference other modules directly from a module. Share code in `src/modules/shared/` instead.
`shared/` is a special namespace for cross-module code. It is not a module (no manifest),
but the registry records its subdirectories as shared submodules for internal wiring.
Shared submodules never appear in the UI and do not need `manifest.json`.
If a shared submodule contains `runtime/*.js` files that export runtime manager objects,
they are auto-registered globally.

## Manifest reference
`manifest.json` is the module contract read by the launcher UI.

Required fields:
- `id`: stable module id (folder name, lowercase recommended).
- `family`: family label for grouping similar modules.
- `label`: full display name.
- `shortLabel`: short display name.
- `gameType`: broad type string (for grouping and UI labels).

Runtime config:
- `runtime.default`: default runtime id (for new entries).
- `runtime.supported`: runtime ids to show in the runtime dropdown.
- `runtime.entries`: optional map of runtime id -> runtime metadata.
  - `label`: display label.
  - `settings`: optional runtime settings schema (`defaults`, `fields`).
- `runtime.labels`: optional legacy map of runtime id -> display label.
- `runtime.hosted`: optional hosted-runtime config (`id`, optional `fallback`, optional `userAgent`).
  - `userAgent.suffix` supports `{nwjsVersion}` to insert the configured NW.js runtime version.
- `runtime.manager`: optional map of runtime id -> runtime manager id.
- `runtime.managerSectionBy`: optional map of runtime id -> entry field name to select a manager section.
- `runtime.managerSectionMap`: optional map of runtime id -> map of entry values to section ids.
- `runtime.preLaunch`: optional map of runtime id -> pre-launch checks.

Runtime settings schema:
- `defaults`: key/value map for global runtime settings defaults.
- `fields`: list of field definitions (`key`, `type`, `label`, optional `description`, optional `default`).
- Supported `type` values: `boolean`, `number`, `string`, `select`, `list`.
- `select` fields require `options` entries with `{ value, label }`.
- `list` fields store string arrays; the UI accepts one entry per line (commas also supported).

Supports flags:
- `supports.cheats`: module exposes a cheat schema/runtime.
- `supports.cheatsPatcher`: module supports tools patching on disk.
- `supports.saveEditing`: module supports save import/export and JSON editing.
- `supports.saveLocation`: module provides a reliable save directory for the game detail panel.

Other fields:
- `settingsDefaults`: per-module settings defaults (drives Settings UI sections).
- `ui.infoFields`: list of extra fields for the game detail panel.
- `ui.actions`: list of module actions (patch/build/probe/etc).
- `ui.actionGroups`: ordering and grouping of actions in the UI.
- `acknowledgments`: list of `{ label, url }` credits.

### UI field and action schema
`ui.infoFields` entries:
- `key`: dotted path into the game entry (for example, `moduleData.version`).
- `label`: display label.
- `format`: optional `boolean`, `date`, `path`, or `string`.
- `empty`: placeholder text when the value is missing.
- `hiddenWhen`: array of conditions to hide the field.

`ui.actions` entries:
- `id`, `label` (required)
- `kind`: `primary`, `secondary`, or `danger`.
- `confirm`: confirmation prompt text.
- `autoRun`: run on expand (status probes).
- `resultFields`: list of info fields to display after action.
- `disabledWhen` / `hiddenWhen`: array of conditions.

Conditions:
- `key`: dotted path in the game entry or action result.
- `equals`, `notEquals`, `truthy`, `falsy`, `endsWith`.

`ui.actionGroups` entries:
- `id`, `label`
- `actions`: ordered list of action ids.
- `note`: optional text displayed in the detail panel.

## Module hooks (main.js)
A module can implement any subset of these hooks:

- `detectGame(context, helpers)`
  - Returns a detection object or `null`.
  - `context` includes `inputPath`, `rootDir`, `isAppBundle`, and `stat`.
  - `helpers.findIndexHtml` is provided by the registry.

- `migrateSettings(settings)`
  - Moves legacy settings into `settings.modules[<id>]` or `settings.runtimes`.

- `migrateEntry(entry)`
  - Returns `{ moduleData, runtimeData, runtimeId }` for legacy per-game fields.

- `mergeEntry(existing, incoming, settings)`
  - Optional hook to merge per-game data before normalization.

- `onImport(entry, context)`
  - Called when a game is first added to recents.
  - `context` includes `userDataDir`, `settings`, and `logger`.
  - Use for one-time setup like staging bundled assets (no background network).

- `cleanupGameData(entry, context)`
  - Called when a game is removed from the launcher.
  - Use to delete per-game data stored under `userData` (extracted bundles, wrappers, builds, etc).
  - `context` includes `userDataDir`, `settings`, `logger`, `gamePath`, and `moduleId`.

- `filterRuntimeSupport(entry, supported, moduleSettings)`
  - Returns a filtered runtime list for a specific game.

- `normalizeRuntimeId(runtimeId)`
  - Maps legacy runtime ids into current runtime ids.

- `canLaunchRuntime(runtimeId, entry, moduleSettings, context)`
  - Returns true if the runtime is eligible to launch.

- `launchRuntime(runtimeId, entry, context)`
  - Launches module runtimes that are not handled by hosted/native flows (returns handle or null).

- `resolveNativeLaunchPath(entry, context)`
  - Returns a native app bundle path when the module supports native launches.

- `resolveGameIcon(entry, context)`
  - Optional custom icon extraction hook; return a module-specific icon path when available.
  - The launcher prefers this over app/exe extraction and the module default icon.

- `getState(context)`
  - Returns module state exposed to the UI as `moduleStates[<id>]`.

- `runtimeManagers`
  - Array of runtime manager objects (deduped globally by id).

- `save`
  - Save codec support: `extensions`, `decode`, `encode`.

- `cheats`
  - Cheat schema, defaults, normalization, equality, and patcher.

- `libs`
  - Library catalog + patcher for managed runtime files.

## Detection pipeline
`src/modules/registry.js` runs detection as:
1. Normalize input path and build context.
2. Call `detectGame` for each module (in manifest label order).
3. If none match, fall back to generic web detection (index.html in root or www/).
4. If the input is an app bundle and no module matches, error lists supported modules.

Web module detection handles:
- NW.js app bundles at `Contents/Resources/app.nw`.
- Electron-style layouts at `Contents/Resources/app` (using `dist/index.html`) and `resources/app` roots.

This means new modules automatically show up in detection and error messaging with no launcher changes.

## Runtime integration
- Runtime selection is derived from `manifest.runtime.supported`.
- Default runtime uses `settings.modules[<id>].defaultRuntime` or `manifest.runtime.default`.
- Hosted runtime behavior is defined by `manifest.runtime.hosted` (id, optional fallback, optional UA hints).
- Runtime managers are declared per-module and shown in the Runtimes modal.
- `manifest.runtime.preLaunch` can gate launch on module-specific readiness checks.
- Modules can add `nwjs-patched` to opt into the shared patched wrapper; engine-specific patches remain module-gated.

## RGSS module
- Uses MKXP-Z as the RGSS runtime.
- Stages RTP/Kawariki/SF2 assets into `userData/modules/rgss/assets/`.
- Runs pre-launch setup checks to ensure assets are staged before launch.
- Loads the MKXP patch/port set from `src/external/rpgmakermlinux-cicpoffs/Kawariki-patches` (staged as `kawariki/preload.rb`) and applies the local overlay in `src/modules/rgss/overlays/kawariki/patches-extra.rb`.

## NScripter module
- Detects roots by script files (`0.txt`, `00.txt`, `nscript.dat`, `nscript.___`, `nscr_sec.dat`, `onscript.nt2`, `onscript.nt3`, `0.utf`) or archive/config markers (`*.nsa`/`*.sar` with `pns.cfg` or `ons.cfg`).
- When given a packaged Windows `.exe`, it inspects the archive first and extracts matches under `userData/modules/nscripter/extracted/` (zip overlay, 7-Zip, or evbunpack fallback) before launching.
- When only `0.utf` is present, it stages a wrapper root with a `0.txt` alias and launches with `--enc:utf8`.
- Stages a fallback font under `userData/modules/nscripter/assets/umeplus-gothic.ttf` when `default.ttf` is missing; override with the module setting `defaultFontPath`.
- Web runtime generates `onsyuri_index.json` inside the wrapper so the web build can mount game files.
- Web runtime patches `onsyuri.js` to force the web path (avoids `__dirname` in browser contexts), injects a DevTools keybinding helper, and swaps the remote JSZip tag for a local `jszip.min.js` copy (falls back to a stub if missing).
- Default runtime is Onscripter Yuri (mac) with optional web runtime and external runtime path support.

## Ren'Py module
- Detects Ren'Py roots via `renpy/vc_version.py` + `game/` and supports game-only imports (a `game/` folder by itself).
- Captures runtime metadata (`renpyVersion`, `renpyMajor`, `renpyBaseName`) and resolves saves under `~/Library/RenPy/`.
- Runtimes: `sdk`, `patched`, and `native`.
  - `sdk` runs the game via an installed Ren'Py SDK and a wrapper project stored under `userData/modules/renpy/projects/<id>/<sdkVersion>/`.
  - `patched` stages macOS runtime libs into `lib/<platform>` and launches `<baseName>.sh` in the game root.
  - `native` launches an app bundle built by the module's Build action (stored under `userData/modules/renpy/builds/<id>/`).
- Patch status is tracked under `userData/modules/renpy/patches/<id>.json` and enforced by a pre-launch check.

## RPG Maker MV/MZ modules
- Shared implementation lives under `src/modules/shared/mvmz/`.
- Detects MV vs MZ by the presence of `js/rpg_core.js` (MV) or `js/rmmz_core.js` (MZ).
- Supports `electron`, `nwjs`, `nwjs-patched`, and `native` runtimes; hosted Electron uses the configured NW.js version for the UA suffix (`nwjs/<version>`).
- Patched NW.js can enable case-insensitive assets, user scripts, decrypted asset loaders, remap + fixes, and vars inspector.
- MV exposes a PixiJS 5 library catalog with patch/unpatch actions (from the cicpoffs bundle).
- Plugin actions install/remove Clipboard_llule and CustomizeMaxSaveFile by editing `js/plugins.js`.

## Tyrano module
- Detects Tyrano KAG via `tyrano/plugins/kag/kag.js`, including app bundles (`app.nw`/`app.asar`), `package.nw`, and Windows `.exe` payloads.
- Packaged sources are extracted into `userData/modules/tyrano/extracted/<id>/` (zip/asar/pe-overlay/evbunpack) before NW.js launch.
- Extraction patches `tyrano/libs.js` to force `jQuery.userenv()` to `pc`.
- The patched NW.js runtime uses an empty module patch set (no engine-specific injections).

## Construct module
- Detects Construct 2/3 via `c2runtime.js` / `c3runtime.js` or generator metadata in `index.html`.
- Supports app bundles, `package.nw`, and Windows `.exe` payloads; packaged bundles are extracted into `userData/modules/construct/extracted/<id>/`.
- Pre-launch checks require extraction for Electron/NW.js runtimes.
- NW.js launch injects a WebView2 shim (`maclauncher-construct-webview2.js`) when needed.

## Web module
- Generic HTML game fallback (index.html in root, `www/`, or `dist/`).
- Supports `electron`, `nwjs`, `nwjs-patched`, and `native` runtimes.

## Settings integration
- `settingsDefaults` defines the Settings UI fields for the module.
- The launcher always creates a section for every module, even if empty.
- Runtime settings are defined per runtime in `runtime.entries[<id>].settings` and surfaced via runtime settings windows.

## Icon handling
- Modules can optionally override icon extraction with `resolveGameIcon`.
- If no module icon is resolved, the launcher extracts app/exe icons and falls back to `resources/icon.png` when present.

## Save and cheat integration
- The save path row is shown only when `supports.saveLocation` is true.
- Save tools are shown only when `supports.saveEditing` is true.
- Cheats are shown only when `supports.cheats` is true.
- Tools patching is available only when `supports.cheatsPatcher` is true.

## Uniform file scheme
Follow these conventions for new modules:
- Per-module data is stored under `userData/modules/<moduleId>/`.
- Per-game files should use a stable hash id derived from the game path.
- Runtime installations live under `userData/runtimes/<managerId>/`.
- Runtime settings defaults live under `userData/runtimes/<runtimeId>/settings.json`.
- Bundled assets live under `resources/` inside the module.
- Scripts and patchers should write logs next to the files they modify.

## Adding new modules
