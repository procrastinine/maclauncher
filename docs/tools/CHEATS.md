# Cheats

Cheats are available for RPG Maker MV and MZ, RPG Maker XP/VX/VX Ace and Ren'Py games, and the inspector's **Cheats** button opens them for the selected game. The cheat fields are defined by each game type, while the settings are stored separately for each game. Changes reach a running game immediately.

## Cheats window

The **Cheats** window groups the game type's number and toggle fields by category, with an enable toggle and a reset to defaults. Changes are saved automatically and apply at once when the game is running. Where the game type has an in-game Tools overlay, a per-game option hides its Tools button. That choice is also saved at once, and if the overlay is already patched into the game's files, the patch is updated to match. Should that update fail, the window shows the error, and the game keeps the last choice that its files were patched with.

For Ren'Py, the window holds only the [cheat add-ons](#renpy-cheat-add-ons), without cheat fields or save and reset buttons.

## In-game Tools overlay

RPG Maker MV and MZ games have an in-game Tools overlay, a panel that Ctrl-Shift-T or Cmd-Shift-T shows and hides. It contains:

- an enable toggle and the cheat fields
- debug and status information
- the actions Open Save, Open Load, Open Debug, Go to title and Reload game
- searchable Inventory, Teleport and Vars/Switches pages
- message skipping, held with one or more selectable keys

While results update, a search field keeps its focus and the page stays in place. Long inventory, map, variable and switch lists load in batches, with **Show more** and **Show all** controls. Holding the hotkey or composing text does not toggle the panel repeatedly. When the overlay is rebuilt, the previous panel's global listeners and timers are released, and when the cheat file is read while partly written, the next poll reads it again.

### NW.js patching

On NW.js, the launcher can add the overlay to the game with a patch. Its status is shown in a **Tools** row of the inspector's **Patches** section, with a Patch or Unpatch toggle and Refresh. Patching:

- creates the `js/plugins/MacLauncher_Tools.js` bootstrap
- adds its files under `js/plugins/maclauncher/`
- injects the bootstrap code into `js/main.js`

The patch state is recorded in a `patch.json` file in the `maclauncher` plugin folder. Patching again changes nothing, and **Unpatch** reverses the patch.

## RPG Maker XP/VX/VX Ace cheat menu

RPG Maker XP/VX/VX Ace (RGSS) games have an in-game cheat menu that F8 opens; Cmd-Shift-T and Cmd-Option-T also work when the runtime exposes those keycodes. The menu shows the same fields as the Cheats window and writes changes back to the cheat file, so the two stay in sync.

Beyond those fields, the menu has item grants, teleport slots, party and enemy tools, level, stats and gold edits, and ASAC scripts when the game has them. Teleport slots are saved next to the cheat file as `<cheatsFile>.rgss-teleports.json`. The `debugEnabled` toggle enables debug mode, which F9 opens when the game has `Scene_Debug`. The stat labels depend on the version: SP, STR, DEX, AGI and INT for RGSS1 (XP), SPI for RGSS2 (VX), and MAT, MDF and LUK for RGSS3 (VX Ace).

| Feature | XP (RGSS1) | VX (RGSS2) | VX Ace (RGSS3) |
| --- | --- | --- | --- |
| Core toggles and values (speed, encounters, EXP, audio) | Yes | Yes | Yes |
| Always dash | If `Game_Player#dash?` exists | Yes | Yes |
| Instant text | If `Window_Message#clear_flags` exists | Yes | Yes |
| Debug (F9) | If `Scene_Debug` exists | Yes | Yes |
| Event battle outcomes | Requires `command_601/602/603` | Yes | Yes |
| Selected item +/- | No | Yes | Yes |
| Item list add/remove | Yes | Yes | Yes |
| Teleport slots | Yes | Yes | Yes |

A conditional feature appears only when the game's engine scripts have the listed method.

## Ren'Py cheat add-ons

For Ren'Py, the Cheats window installs two optional community add-ons into the game folder:

- Universal Ren'Py Walkthrough System copies the five v2 `__urw/urw_*.rpy` scripts into `<game>/game/__urw/`.
- Universal Ren'Py Mod is installed from a supplied `0x52_URM.rpa`. The first copy is selected in a native file dialog, and its RPA header is checked before MacLauncher remembers a private copy of it. From then on, each installation copies the remembered file into `<game>/game/` and works offline. **Choose another Universal Ren'Py Mod file…** replaces the remembered copy.

Installing the v2 walkthrough system removes the legacy `_urw` and `_urwdisp` scripts and their compiled files, so that hooks are not installed twice. MacLauncher also replaces the add-on's own updater with an update notice, which keeps its compatibility patches in place and avoids the updater's TLS bypass and unchecked archive extraction. Each add-on's remove button is enabled only when its files are present in the game folder.

## Diagnostics

If the Tools overlay does not appear, two logs show where loading stopped:

- `<cheatsFile>.tools-bootstrap.log` for the bootstrap stage
- `<cheatsFile>.tools-runtime.log` for the runtime stage

A bootstrap that fails to load also shows a badge in the game window.

## Implementation

Cheats come entirely from modules. A module enables them with `supports.cheats`, and optionally `supports.cheatsPatcher`, and supplies a cheat schema with defaults and runtime hooks for Electron, patched NW.js or both. Because the launcher renders the Cheats window from the schema, it contains no per-module cheat fields of its own. Cheat file sync and the Tools patch actions are skipped when `supports.cheats` or `supports.cheatsPatcher` is disabled.

A game's cheats are loaded from disk when the game is added or opened. Saving writes the normalized settings back to disk, and a running game's runtime applies them immediately.

### Schema

Each field in the schema has these properties:

| Property | Meaning |
| --- | --- |
| `key` | Stable field ID |
| `type` | `boolean` or `number` |
| `label` | Label in the Cheats window |
| `category` | Groups and orders fields |
| `min`, `max`, `step` | Limits of a number field |

Defaults are stored in `cheats.defaults` and normalized by `cheats.normalize`.

### Files

| Purpose | Path |
| --- | --- |
| Shared cheat framework | `src/modules/shared/cheats/cheats.js` |
| MV and MZ cheats | `src/modules/shared/mvmz/cheats/schema.json`, `src/modules/shared/mvmz/cheats/cheats.js`, `src/modules/shared/mvmz/cheats/runtime.js` |
| Web cheat tooling | `src/modules/shared/web/cheats/patcher.js`, `src/modules/shared/web/cheats/nwjs-inject.js` |
| Per-game cheat settings | `userData/games/<gameId>/cheats.json` |
| Patch logs | `<cheatsFile>.tools-bootstrap.log`, `<cheatsFile>.tools-runtime.log` |

### Runtime hooks

In Electron, `src/modules/shared/web/preload/game.js` loads the active module's `electron.js`, which installs the shared cheat runtime with `DEFAULT_CHEATS`, `normalizeCheats` and `cheatsFilePath`. That runtime keeps the cheat file in sync and listens for updates.

For RGSS, MKXP-Z postload scripts inject `maclauncher-cheats.rb`, which reads the cheat file named by `MACLAUNCHER_RGSS_CHEATS_FILE` and applies the launcher's cheats to the RGSS classes.
