# Launcher UI guide

This guide documents every major UI surface in the launcher and how it maps to module-driven data.
For styling and code locations, see `docs/UI_STYLES.md`.

## Layout overview

The launcher UI is composed of:
- Logo/identity, large search field, selection-mode control and header actions
- Global backend filters, scope, result count and sort toolbar
- Game library (left pane)
- Selected game details and tools (stable right pane)
- Separate Settings, Runtimes and Credits windows; dedicated save and runtime-settings editors
- Modal cheat controls

The default window is up to 1440 × 900, fitted to the usable desktop with a 900 × 560 minimum. The library initially uses the
full width. Selecting a game opens a generous inspector on the right; switching games keeps
row heights stable. Close details or toggle Details to reclaim the space. Closing the inspector
returns keyboard focus to the selected row. The panes scroll independently. Windows at 1080
CSS pixels or narrower stack the library above the inspector. Short windows can also scroll
the layout so controls remain reachable. Rows and inspector fields use dividers rather than
nested rounded cards.

All game-specific UI uses module metadata and state. There are no per-engine UI branches.

## Header actions
Top-level buttons and their behavior:
- Add game: opens a file dialog (folders plus common launchable files including `.app`, `.exe`, `.x86_64`, `.x86`, `.jar`, `.swf`, `.love`, `.AppImage`, `.sh`, `.py`), runs module detection for each selection, and adds to recents.
- Settings: opens a separate window with a Launcher tab and one backend tab per module.
- Runtimes: opens a separate window with compact grouped tabs.
- Logs: reveals the main process log in Finder.
- Credits: opens a separate window of module and shared project credits with external links. See [attributions](ATTRIBUTIONS.md) for roles and license notices.

Closing the library leaves other windows usable. The Dock icon, **View → Library**, or
adding a game through **File → Open…** reopens the library.

## Game list
The library displays all saved games.
Each entry shows:
- Game icon (module override or default app/exe extraction).
- Game name and module badge (short label + full label fallback).
- Runtime badge when the game's runtime differs from the game type default.
- Modified badge when runtime settings differ from the game type default and the runtime is non-default.
- Save badge for custom vs default save location.
- Last played timestamp and game path.
- A star button beside the identity, filled gold for favorites.
- Non-default runtime labels before the game-type label, followed by save-location metadata.

Interactions:
- Click a game's title/icon or the row's padding and open space to show its details.
  Clicking the same game again closes the inspector; another click reopens it.
  Tab focuses the title/icon button; Enter or Space performs the same action.
- The selected row has an accent marker and exposes `aria-pressed`. Favorite,
  reorder, checkbox, and quick-action controls retain their own behavior.
  Cmd-click starts or adds to multiple selection, and Shift-click selects a range
  while selection mode is active.
- In Default sort, drag the reorder handle or use Option–Up / Option–Down. Reorder within
  the Favorites or Games group; moving a game across the separator keeps its favorite status.
  This also works with search or filters active, preserving hidden games' relative order.
- Drag and drop folders/files onto the window to add games.
- Play/Stop, Saves, Cheats, Shortcut, and Forget are available directly on every row without
  opening or changing the inspector. Unsupported Saves/Cheats controls remain disabled.
- Reordering and state updates preserve selection by game path.

Search, filters, favorites, and sorting:
- The global toolbar sits above both panes. Cmd+F focuses search; search matches titles and
  paths in real time. Clear search resets only the query.
- Game types opens global backend checkboxes (module short labels like MV, MZ, Ren'Py).
  Select all and Deselect all change only these checkboxes. All backends start enabled.
- Show games offers All games, Favorites, and Running.
- Sort offers Default, Last played, Date added, Alphabetical, and Game type. Non-default
  sorts have a reverse-direction control. Alphabetical sorting uses natural, case-insensitive
  ordering; games with unknown dates or no play history remain last in either direction.
- Default preserves dragged order and separates Favorites at the top. New games enter at
  the top of Games; playing or re-importing an existing game does not move it.
- Other sorts place favorites normally, marked with a star, and hide reorder controls.
- Favorites and sort preferences are saved in launcher settings and survive restarts.
- Search and all filters apply after sorting. They neither change the selected sort nor
  overwrite the underlying manual order. Clear search and filters retains the sort too.
- If the selected game is filtered out or removed, the inspector closes and selection clears.
  Clearing a filter does not restore a hidden selection.

### Selection and bulk removal

- Select beside search opens selection mode; Done or Escape exits it. Checkboxes replace
  reorder handles, and the inspector yields its space to the list. Clicking a game's identity
  toggles selection instead of opening details.
- Shift-click or Shift-Space extends selection across the current visible, sorted range.
  Cmd+A selects visible games when focus is outside a text field; search retains normal text shortcuts.
- Select all, missing-file selection, and bulk actions respect search, backend filters, and scope.
  Changing filters clears hidden selections; clearing filters does not resurrect them.
- Detect all missing explicitly checks the current result set on disk and marks missing paths.
  Select all missing runs the same check and selects the visible missing games. No background
  filesystem scans or network requests run. Permission errors are reported, not treated as missing.
- Forget selected asks once and removes library entries and per-game launcher data, retaining
  original game files. Move to Trash asks once in a native macOS dialog, moves selected paths
  to the Trash and removes their library data. Already-missing paths are forgotten.
- Partial Trash failures leave failed games available for retry and report each error.

## Game detail panel

The inspector opens on selection, showing the name and engine plus a known version on one line. Technical
provenance and module metadata sit inside collapsed **Details**; MV/MZ have no unknown-version or
confidence placeholders. Switching
games starts the detail scroll at the top while leaving the library scroll in place.

### Game tools

- Play/Stop, **Edit saves** or **Save tools**, Cheats, Shortcut and Forget are available in the inspector as well as the row. Save and cheat controls follow each module's capabilities.
- Games without an available launch backend disable Play and Shortcut with a compact
  explanatory hover title; their inspection and export actions remain available.
- While preparing a launch, Play shows **Installing** with a reported percentage
  when available, then **Starting**. Stop becomes available when the process starts;
  the game may continue loading in its own window.
- Shortcut creates a macOS `.command` launcher using the same runtime selection and settings as Play.
- Forget removes the entry and clears per-game launcher data under `userData/games/<gameId>/`;
  original game files stay on disk. Its trash-shaped icon represents Forget.

The inspector contains paths, runtime choices, patching,
and engine-specific actions. Files, Runtime, Patches, and Tools headings group
related controls; optional groups appear only when supported. The controls retain their
existing capabilities, confirmations, and conditions.
Only the selected game mounts detail controls and runs the existing detail status actions;
opening the library does not fetch remote runtime catalogs.

### Game path
- Shows the detected game path.
- Folder icon reveals the path in Finder.

### Save path
- Shown only when `supports.saveLocation` is enabled.
- Shows the active save path (default or override).
- Folder icon reveals the save folder.
- Change allows picking a custom save folder.
- Reset clears the override and returns to default.

### Runtime selection
- Dropdown shows `manifest.runtime.supported` entries.
- Labels come from `manifest.runtime.entries[<id>].label`.
- The launcher resolves the effective runtime using module support and availability.
- Gear icon opens the runtime settings window for this game.
- Flash entries expose the included universal Flash Player and managed Ruffle choices. Flash Player runs offline without Rosetta; Ruffle prompts for a missing download.
- LÖVE entries expose `LÖVE` (managed releases/nightlies) and `Native app` for imported `.app` bundles.

### Runtime version overrides
Shown when the selected runtime maps to a runtime manager:
- Version dropdown: per-game override or default version from settings.
- Variant dropdown: per-game override when the manager exposes multiple variants.
- Manager-specific selectors can appear when needed (for example Java line/major selection or the LÖVE release/nightly channel selector).
- Runtimes opens version management when that runtime has a managed download or automated build flow.
  Fixed built-ins retain their name, version choices and Runtime settings without this link.

### Runtime settings
- Runtime settings open in a dedicated window.
- Runtime settings save automatically as fields change; reset clears overrides.
- Per-game runtime settings default to the game type defaults unless overridden.

### Module info fields
`manifest.ui.infoFields` render as read-only rows inside **Details** and can show:
- Build metadata
- Module-specific flags
- Runtime status values
- LÖVE uses these rows for detected engine version and AppImage extraction state.
Fields can be hidden when entry conditions match `hiddenWhen`.

### Library patching
Shown when a module exposes managed libraries:
- Patch status (Not patched / Patched / Partial) and warnings.
- Patch/Unpatch toggle and Refresh actions.
- Per-library version overrides (stored in `moduleData.libVersions`).
MV uses this for the PixiJS 5 patch set.

### Tools patching
Shown when `supports.cheatsPatcher` is enabled:
- Patch status for Tools injection.
- Patch/Unpatch toggle and Refresh actions.

### Module actions
`manifest.ui.actionGroups` render tool actions in ordered groups:
- Each action can be primary, secondary, or danger.
- Actions can be hidden or disabled based on entry data.
- Action results are rendered inline when returned (modules can show a single concise field).
Examples:
- RGSS: reload/reveal staged assets, restage/remove staged assets, extract, reveal/remove extracted files.
- Java: extract with Vineflower, reveal extracted output, and remove extracted output.
- Ren'Py: patch status/patch/unpatch, build app bundles, reveal/remove built apps, and extract/reveal/remove actions.
- MV/MZ: plugin actions to install/remove the clipboard and save slot plugins, extract, reveal/remove extracted files.
- Tyrano/Construct: extract packaged bundles, reveal extracted roots, and remove extracted data.

## Save editor window
Available from the inspector and row when save-location support is enabled. The
launcher opens a dedicated macOS window with native window controls; opening it
again focuses the existing editor for that game. Engines with editing
support call this **Save editor**; metadata-only and recovery tools remain available to other engines.

Features:
- Folder icon reveals the active save directory.
- Engines with multiple detected locations expose a folder selector. Ren'Py lists the configured
  `~/Library/RenPy/<name>` primary directory and its game-local `saves` mirror, even before creation.
- Import/save folder to replace current saves.
- Export save folder to a destination.
- Import individual save files.
- List save files with size and timestamp.
- Structured MV/MZ editing with game-defined labels; JSON remains available for advanced edits.
- Save-file and recovery-snapshot tabs share the same window.
- Save views use their tab names for identity; snapshot instructions open from
  the circular help button beside Create snapshot.
- Edit save JSON with:
  - Format button
  - Open in external editor
  - Reload from external editor
  - Save (writes backup files)

## Live-variable editor

Modules with live-variable editing open a dedicated macOS window. Pause to edit;
closing the window resumes the game. Scope tabs use Arrow keys, Home and End,
scroll horizontally and keep keyboard focus while an edit is applied.

## Cheats modal
Available only when `supports.cheats` is enabled.

Features:
- Schema-driven fields (numbers and toggles).
- Enable toggle and reset to defaults.
- Changes save automatically and apply immediately if the game is running.
- Optional Tools button override when the module exposes the setting.
- Optional cheat add-on actions when the module defines cheat patches.

## Settings window
- Settings opens a separate, nonmodal macOS window. Cmd+, opens or focuses the
  same window from any launcher view. Native close controls or Cmd-W close it.
  The library stays usable and keeps its selection, inspector, filters and scroll position.
  Settings changes appear immediately in all launcher windows.
- Launcher tab for global toggles (icons and non-default tags).
- One actual tab per backend, generated from manifests and sorted by module label.
  Tabs scroll horizontally when needed. Left and right edge controls scroll without
  changing the selected tab; Arrow keys, Home and End switch tabs.
  Only the selected tab's settings are rendered.
- Fields are derived from `settingsDefaults`.
- Supported input types: boolean, number, string, and default runtime select.
- Modules without configurable fields show an empty settings section.
- Runtime tabs show per-runtime settings inline for that game type and show
  "Modified" when they differ from global defaults. The inline form uses the
  selected tab's label rather than repeating a window heading and scope subtitle.
  Optional instructions and protection details are available through a small **?** button.

## Runtime manager window
- Runtimes opens a separate, nonmodal macOS window. Reopening it focuses the
  same window and preserves its tabs and version choices. An inspector's
  Runtimes action selects the relevant manager. Native close controls or Cmd-W
  close the window; the library remains usable during runtime operations.
- Compact runtime tabs scroll horizontally. Arrow keys switch tabs; Home and End
  select the first or last tab, and the selected tab scrolls into view.
  Left and right edge controls appear when needed and scroll without changing selection.
- Engine groups keep related backends together, with common runtimes first.
  Labels, ordering and management availability come from runtime-manager metadata.
- Managed downloads, automated builds and registered local applications appear here. Fixed built-ins keep
  their engine/runtime options in Settings and their name/version in the inspector.
  An included fallback does not hide a manageable runtime: MKXP-Z retains its tab
  and optional GitHub authentication. Mixed backends can expose only managed sections,
  such as Yuri Web. GameMaker groups Official, Butterscotch and UMT.
- Tab levels join without a gap. Active tabs retain their top and side borders,
  share the following panel's background, and have no separating line below.
  Tab strips have no vertical scrolling.
- Panels rely on their selected tabs for identity. Default and latest-version
  summaries omit values already shown in the selector or a Default badge.
  The local list distinguishes Included and Installed versions.
- Local applications show their versions and existing paths in a Registered applications
  list. Add application opens the native application picker, and Find installed applications
  refreshes local discovery without a download. Multiple copies remain separate choices,
  including copies with the same version. Remove unregisters a copy and keeps its application
  files. Defaults and per-game version choices use the same controls as downloaded runtimes.
- Existing section selectors remain available, including LÖVE Releases/Nightlies
  and Java runtime lines/Vineflower. Switching groups remembers the chosen
  section while the view is open.
- Groups, labels, ordering, and section labels come from runtime metadata. Each
  subtab retains its own version settings, installation actions, and downloads.
- Available versions appear immediately when already known. The same icon-only
  Reload button fetches versions for empty and populated catalogs. It spins and
  disables immediately during the request, then confirms the update. Source,
  counts, check time and setup guidance are behind the **?** beside Versions. Ordinary release catalogs load bounded history;
  only slow artifact catalogs expose a separate All versions action. Downloads
  and source builds start only after an explicit action.
  Source-only runtimes expose Build when supported, with prerequisites and
  Setup instructions in the same help popover. Unavailable versions show the supplied reason.
- Included immutable resources show Included without Install or Remove; versions and variants remain selectable. Download/copy paths do not show source-build setup links. Official GameMaker
  offers Import runtime directory and an optional independent Igor installation;
  runtime Install also installs the required Igor tool automatically.
- Installed versions:
  - Install/uninstall actions per version.
  - Set default version (and variant when supported).
- Download manager dropdown (down arrow) shows active downloads with progress bars and cancel actions.
- Info callouts describe dependencies for the selected runtime: optional authenticated `gh`
  downloads for MKXP-Z updates and LÖVE nightlies, or Rosetta for compatible Intel Java builds.
  Included MKXP-Z and native ONScripter-Yuri need no Homebrew or `gh` setup for Play.

## Credits window
- Credits opens a separate, nonmodal macOS window. Reopening it focuses the
  same window. Native close controls or Cmd-W close it.
- Aggregates acknowledgments from all module manifests and shared launcher/tool/library metadata, deduped by URL and sorted by project name.
- Separate projects have separate links; a credit can describe a runtime, an optional tool or a format reference, without implying compatibility.
- Opens external links via `openExternal`.

## Error handling
- Errors are surfaced inline in modals and detail panels.
- Module action errors show a badge in the detail panel.
- Runtime manager errors show an inline error banner.
- Native game failures received after Play returns show the game and exit reason
  in the launcher's existing error banner. Normal exits and Stop stay quiet.
- Save and cheat operations show error text in their modals.
- Error displays remove repeated `Error:` and Electron IPC prefixes while retaining the reason, paths and diagnostic details. Stored errors and backend logs retain their original messages.

## Engine tools, save recovery and detection

The inspector header displays the engine and known version. Collapsed **Details** contains format,
version source, confidence and the optional probe trace/refresh. MV/MZ omit inapplicable version and
confidence rows. Instructions and limitations appear behind **?** buttons. Imported native app bundles
also offer **Remove quarantine**, which explicitly runs `xattr -dr com.apple.quarantine` on the identified app.

**Notes** stores plain text in the game's library record, preserving line breaks and Unicode across launches and detection. Save explicitly with **Save notes** or Cmd-S; leaving the text field also saves changes. Pending changes finish saving when another game is selected. Notes stay in launcher data and are removed when the game is forgotten.

Runtime settings under Settings → game type are editable inline below actual runtime tabs, with automatic persistence and no nested window or inner Close button. Per-game settings continue to use their existing dedicated editor.

**Save tools** is available for save-location-only engines as well as JSON-codec engines. The Files/Snapshots tabs support declared-file import/export, recovery snapshots and restore previews. MV/MZ Edit values has typed fields, database labels, search/pagination and Cmd-S; raw JSON editing retains its external-editor workflow and rejects stale saves. See [save recovery](SAVE_SNAPSHOTS.md) and [MV/MZ editing](MVMZ_SAVE_EDITOR.md).

Native backends retain explicit versions in the inspector and Settings. Manageable runtimes also provide Runtimes tabs. Included immutable bundles run directly; writable runtime copies are prepared automatically. Supported automated builds provision build dependencies when available. Corrupt/incomplete owned records stay removable, while app resources remain read-only. Read the [engine compatibility guide](README.md#engine-compatibility) for supported formats and runtime requirements.
