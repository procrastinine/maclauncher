# Cheats system

Cheats are fully module-driven. A module opts in by providing:
- `supports.cheats` and optional `supports.cheatsPatcher`
- A cheat schema + defaults
- Runtime hooks (electron and/or patched NW.js)

The launcher renders the Cheats modal from the module schema and stores per-game cheat state on disk.

## Key paths
Shared cheat framework:
- `src/modules/shared/cheats/cheats.js`

MV/MZ cheat assets:
- `src/modules/shared/mvmz/cheats/schema.json`
- `src/modules/shared/mvmz/cheats/cheats.js`
- `src/modules/shared/mvmz/cheats/runtime.js`

Web cheat tooling:
- `src/modules/shared/web/cheats/patcher.js`
- `src/modules/shared/web/cheats/nwjs-inject.js`

Per-game cheat storage:
- `userData/modules/<moduleId>/cheats/<stableId>.json`

Patch logs:
- `<cheatsFile>.tools-bootstrap.log`
- `<cheatsFile>.tools-runtime.log`

## Schema and defaults
The cheat schema defines fields and defaults. Each field has:
- `key`: stable id for the field
- `type`: `boolean` or `number`
- `label`: display label in the Cheats modal
- `category`: used to group and order fields
- `min`, `max`, `step`: number field constraints

Defaults are stored in `cheats.defaults` and normalized by `cheats.normalize`.

## Launcher flow
1. The launcher loads cheats from disk when a game is added or opened.
2. The Cheats modal renders fields based on the module schema.
3. Saving cheats writes the normalized payload to disk.
4. If the game is running, the runtime applies changes immediately.

Cheat file sync and Tools patch actions are skipped when `supports.cheats` or
`supports.cheatsPatcher` are disabled.

The launcher never hard-codes per-module cheat fields. Everything is schema-driven.

## Electron runtime flow
- `src/modules/shared/web/preload/game.js` loads `electron.js` for the active module.
- The module installs the shared cheat runtime with:
  - `DEFAULT_CHEATS`
  - `normalizeCheats`
  - `cheatsFilePath`
- The cheat runtime keeps the file in sync and listens for updates.

## NW.js runtime flow (tools patching)
When `supports.cheatsPatcher` is enabled, the launcher can patch a game:
- Creates `js/plugins/MacLauncher_Tools.js` bootstrap
- Adds `js/plugins/maclauncher/` payload files
- Injects bootstrapping code into `js/main.js`

Patch state is tracked by a `patch.json` file in the maclauncher plugin folder.

The patcher is idempotent and reversible via Unpatch.

## Tools overlay UI
The shared runtime provides an in-game Tools overlay with:
- Enable toggle
- Cheats fields
- Debug and status info

Hotkey:
- Ctrl/Cmd + Shift + T toggles the Tools panel

The Tools button can be hidden with the per-game override in the Cheats modal.

## Diagnostics
If Tools do not appear, check:
- `<cheatsFile>.tools-bootstrap.log` (bootstrap stage)
- `<cheatsFile>.tools-runtime.log` (runtime stage)

The bootstrap also shows an on-screen badge when it fails to load.
