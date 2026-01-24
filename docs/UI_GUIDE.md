# Launcher UI guide

This guide documents every major UI surface in the launcher and how it maps to module-driven data.
For styling and code locations, see `docs/UI_STYLES.md`.

## Layout overview
The launcher UI is composed of:
- Header actions (top bar)
- Game list (left/main column)
- Game detail panel (expands inline per game)
- Modals for saves, cheats, settings, runtimes, acknowledgments

All game-specific UI uses module metadata and state. There are no per-engine UI branches.

## Header actions
Top-level buttons and their behavior:
- Add game: opens a file dialog, runs module detection for each selection, and adds to recents.
- Settings: opens the Settings modal with one section per module.
- Runtimes: opens the Runtime manager modal (tabs for each runtime manager).
- Logs: reveals the main process log in Finder.
- Acknowledgments: aggregates module credits and provides external links.

## Game list
Each recent entry shows:
- Game icon (module override or app/exe extraction with fallback).
- Game name and module badge (short label + full label fallback).
- Runtime badge when the game's runtime differs from the game type default.
- Modified badge when runtime settings differ from the game type default and the runtime is non-default.
- Save badge for custom vs default save location.
- Last played timestamp and game path.

Interactions:
- Drag handle to reorder entries (updates recents ordering).
- Drag and drop folders/files onto the window to add games.
- Play/Stop button reflects running state (multiple sessions supported).
- Saves and Cheats buttons open their respective modals.
- Shortcut creates a macOS .command launcher that opens MacLauncher with this game using the same runtime selection and settings as Play.
- Forget removes the entry from recents and clears per-game launcher data stored in userData.
- Delete (trash) moves the game to the Trash and clears per-game launcher data.

Search and filters:
- Search bar filters the list by game name or file path in real time.
- Game types are hidden behind a dropdown toggle inside the search bar.
- Game type checkboxes (module short labels like MV, MZ, Ren'Py) restrict the list.
- Clear filters resets the search query and re-selects all game types.
- All game types are enabled by default; reordering is disabled while filtering.

## Game detail panel
Expanding a game entry reveals module-driven details:

### Game path
- Shows the detected game path.
- Reveal button opens the path in Finder.

### Save path
- Shown only when `supports.saveLocation` is enabled.
- Shows the active save path (default or override).
- Reveal opens the save folder.
- Change allows picking a custom save folder.
- Reset clears the override and returns to default.

### Runtime selection
- Dropdown shows `manifest.runtime.supported` entries.
- Labels come from `manifest.runtime.entries[<id>].label` (fallback to `runtime.labels`).
- The launcher resolves the effective runtime using module support and availability.
- Settings button opens the runtime settings window for this game.

### Runtime version overrides
Shown when the selected runtime maps to a runtime manager:
- Version dropdown: per-game override or default version from settings.
- Variant dropdown: per-game override when the manager exposes multiple variants.
- Runtimes button opens the runtime manager modal.

### Runtime settings
- Runtime settings open in a dedicated window.
- Per-game runtime settings default to the game type defaults unless overridden.

### Module info fields
`manifest.ui.infoFields` render as read-only rows and can show:
- Build metadata
- Module-specific flags
- Runtime status values
Fields can be hidden when entry conditions match `hiddenWhen`.

### Library patching
Shown when a module exposes managed libraries:
- Patch status (Not patched / Patched / Partial) and warnings.
- Patch, Unpatch, and Refresh actions.
- Per-library version overrides (stored in `moduleData.libVersions`).
MV uses this for the PixiJS 5 patch set.

### Tools patching
Shown when `supports.cheatsPatcher` is enabled:
- Patch status for Tools injection.
- Patch, Unpatch, and Refresh actions.

### Module actions
`manifest.ui.actionGroups` render tool actions in ordered groups:
- Each action can be primary, secondary, or danger.
- Actions can be hidden or disabled based on entry data.
- Action results are rendered inline when returned (modules can show a single concise field).
Examples:
- RGSS: refresh setup status, restage bundled assets, remove staged assets, decrypt/reconstruct, reveal/delete decrypted files.
- Ren'Py: patch status/patch/unpatch, build app bundles, and extract/reveal/delete actions.
- MV/MZ: plugin actions to install/remove the clipboard and save slot plugins, decrypt/reconstruct, reveal/delete decrypted files.
- Tyrano/Construct: extract packaged bundles and reveal extracted roots.

## Save tools modal
Available only when `supports.saveEditing` is enabled.

Features:
- Reveal active save directory.
- Import/save folder to replace current saves.
- Export save folder to a destination.
- Import individual save files.
- List save files with size and timestamp.
- Edit save JSON with:
  - Format button
  - Open in external editor
  - Reload from external editor
  - Save (writes backup files)

## Cheats modal
Available only when `supports.cheats` is enabled.

Features:
- Schema-driven fields (numbers and toggles).
- Enable toggle and reset to defaults.
- Changes apply immediately if the game is running.
- Optional Tools button override when the module exposes the setting.
- Optional cheat add-on actions when the module defines cheat patches.

## Settings modal
- Launcher section for global toggles (icons and non-default tags).
- One section per module (always present).
- Fields are derived from `settingsDefaults`.
- Supported input types: boolean, number, string, and default runtime select.
- Modules with no settings show "No settings available yet".
- Runtime settings buttons open per-runtime settings windows for that game type and show "Modified"
  when they differ from global defaults.

## Runtime manager modal
- Tabs for runtime managers (deduped across modules).
- Tabs for manager sections (if the manager exposes multiple sections).
- Remote catalog:
  - Refresh button triggers network fetch.
  - Shows source URL and version list.
- Installed versions:
  - Install/uninstall actions per version.
  - Set default version (and variant when supported).
- Progress chip appears during installs.
- Info callouts surface runtime-specific dependencies (for example MKXP-Z requires `gh` for downloads,
  and Onsyuri mac needs Homebrew libraries).

## Acknowledgments modal
- Aggregates acknowledgments from all module manifests.
- Opens external links via `openExternal`.

## Error handling
- Errors are surfaced inline in modals and detail panels.
- Module action errors show a badge in the detail panel.
- Runtime manager errors show an inline error banner.
- Save and cheat operations show error text in their modals.
