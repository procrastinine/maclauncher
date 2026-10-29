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
- Add game: opens a file dialog (folders plus common launchable files including `.app`, `.exe`, `.x86_64`, `.x86`, `.jar`, `.swf`, `.love`, `.AppImage`, `.sh`, `.py`), runs module detection for each selection, and adds to recents. Several selections, or several dropped items, import as one batch: the library toolbar shows **Adding N of M** with a progress bar, and a failure does not stop the remaining items. The summary reads **Added N of M** and lists every failed item with its reason, a **Choose game file…** button and **Retry**; resolving one item updates the counts and keeps the other failures. **Dismiss** closes the summary.
- Settings: opens a separate window with a searchable sidebar for Launcher and module settings.
- External: opens a separate window with distinct offline Installed and Downloaded tables plus Steam, Epic, GOG, itch.io and Android tabs for accounts, versions and downloads. Downloaded versions stay independent of store installations. [External libraries](EXTERNAL.md) describes selection, refresh, Finder shortcuts and import behavior.
- Runtimes: opens a separate window with a searchable sidebar and section-specific subtabs. Wine contains Sikarugir and CrossOver. Godot 3 and 4 offer Standard and .NET variants; earlier Godot families use Standard. LÖVE separates compatible release families and Nightlies, while its included LuaSteam bridge needs no management.
- Runtimes → Graphics has one **Shaders** tab. Its **Library** tab lists imported shaders with search and a type filter; **Collections** selects a shader collection with independent download and version controls. Other Graphics tabs remain available while browsing shaders.

The app menu holds the remaining launcher-wide actions. **Credits** opens a separate window
of module and shared project credits with external links; [attributions](ATTRIBUTIONS.md)
describes roles and license notices. **Help → Show Log in Finder** reveals the main process log.

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
- Game name and game-type label on the first line; runtime and modified labels appear on the metadata line beside last-played information and the path.

Interactions:
- The game title, icon and row background open its details.
  Clicking the same game again closes the inspector; another click reopens it.
  Tab focuses the title/icon button; Enter or Space performs the same action.
- The selected row has an accent marker and exposes `aria-pressed`. Favorite,
  reorder, checkbox, and quick-action controls retain their own behavior.
  Cmd-click starts or adds to multiple selection, and Shift-click selects a range
  while selection mode is active.
- In Default sort, drag the reorder handle or use Option–Up / Option–Down. Reorder within
  the Favorites or Games group; moving a game across the separator keeps its favorite status.
  This also works with search or filters active, preserving hidden games' relative order.
- Import errors name the selected item and its next step. A folder with more than one possible
  game asks for the game file or a more specific folder; an unrecognized file asks for the game's
  application, main game file or complete folder; a missing or unreadable item asks to locate it or
  check its permissions in Finder; an incomplete search asks for the main game file; and an
  unreadable installer points to an unencrypted offline installer, its companion data files or
  Runtimes → Tools → Installer reader. A successful import clears the error.
- Drag and drop imports folders and files into the library. An empty library shows
  **Drop a game to get started**, and dragging over the window shows **Drop games, shaders
  or neural models**. Both hints list two groups: **Games**, with Game folder and the
  standalone formats declared by the available game types, including Android APK packages
  and iOS IPA archives; and **Shaders and models**, with `.fx` / `.glsl` / `.hook`,
  `.slang` / `.slangp` and `.dlssmodel`. Select and the sort and filter toolbar appear
  once the library contains a game.
- Play/Stop, Shortcut, and Forget are available directly on every row without opening or
  changing the inspector. Save tools and Cheats are in the inspector.
- Reordering and state updates preserve selection by game path.

Search, filters, favorites, and sorting:
- The global toolbar sits above both panes. Cmd+F focuses search; search matches titles and
  paths in real time. Clear search resets only the query.
- Game types opens global checkboxes for the game types that own detected games (short labels
  such as RPG Maker MV, Ren'Py and Nintendo Switch), independently of the selected execution
  backend: 32-bit Mac games appear under Mac and Prosper games under PlayStation 5. Select all and Deselect all change only these checkboxes.
  All game types start enabled.
  The menu closes on an outside click or Escape.
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
- Forget selected asks once in a native macOS dialog and removes library entries and per-game
  launcher data, retaining original game files. Move to Trash asks once, moves selected paths
  to the Trash and removes their library data. Already-missing paths are forgotten.
- Partial Trash failures leave failed games available for retry and report each error.

## Game detail panel

The inspector opens on selection, showing the name, engine and detected version
on one line. Collapsed **Details** contains format, version source, confidence and
the optional detection trace with an explicit refresh. MV/MZ omit inapplicable
version and confidence rows. Switching games starts the detail scroll at the top
while leaving the library scroll in place.

### Game tools

- Play/Stop, **Saves** (**Edit saves** when the game type supports save editing), Cheats, **Create shortcut…** and Forget are available in the inspector. Rows provide the same launch-file action as **Shortcut**. Save and cheat controls follow each module's capabilities. Play is the only primary-styled button.
- When the selected runtime only inspects the game, the inspector shows the format or
  compatibility explanation in place of Play. Launch arguments, network access,
  Create shortcut…, save and cheat controls and Graphics are omitted; runtime selection,
  inspection tools and Notes remain, and library rows omit Shortcut. A launchable game
  whose runtime is not installed keeps every control, and Play installs the runtime after consent.
- During preparation, **Cancel** stops the pending launch. Installation progress
  and **Starting** remain visible beside the action. **Stop** becomes available
  as soon as the owned game process starts, including before its first window.
- A launch notice from the latest Play, such as a Steam client that did not finish
  signing in, appears below the inspector actions until the next Play.
- Steam games that can start the Mac client show **Steam client on Play** after Network access. The per-game choice is Default, which follows Settings and names its current value, or Ask, Start automatically or Don't start. When Steam is not running, Ask shows a prompt with **Start Steam** and **Launch without Steam**; the second launches the game without starting or waiting for the client.
- **Create shortcut…** appears beside Play at the top of every game inspector; its tooltip reads "Save a .command file that starts this game when opened". It saves a macOS `.command` launcher with a custom name and location, using the game's current saved runtime and settings without opening the library window. Rows provide the same action as Shortcut.
- Launch arguments is a common inspector field for every game and runtime. It saves on Return, focus loss or Save, retains quoted values, and remains unchanged when the selected runtime changes. Its `?` control explains argument syntax; saved launchers use the same value.
- Imported native apps offer **Remove quarantine**, which runs `xattr -dr com.apple.quarantine` on the identified app.
- Forget removes the entry and clears per-game launcher data under `userData/games/<gameId>/`;
  original game files stay on disk. Its trash-shaped icon represents Forget.

The inspector contains paths, runtime choices, patching,
and engine-specific actions in a fixed order: **Files**, **Launch**, **Patches**, **Tools**,
**Graphics** and **Notes**. Files holds the game path, entry selectors, the save location,
quarantine removal and the Details disclosure. Graphics is a collapsible section; while
closed, its heading summarizes the active effects. Optional groups appear only when supported. Field
labels share one column and stay on one line; long labels supplied by a game type truncate
and show their full text on hover. Every control row starts its controls at the value column,
and a lone checkbox such as Network access sits at the column's start. Graphics menus without
an Options or Edit button extend to the same right edge as the other inspector controls. Tool
groups show their main action first as an ordinary button. Reveal buttons in tool results use
the interface font, while printed paths stay monospaced.
The controls retain their existing capabilities, confirmations, and conditions.
Confirmations use native macOS dialogs with Cancel and a button naming the action, such as
Forget, Patch or Remove.
Only the selected game mounts detail controls and runs the existing detail status actions;
opening the library does not fetch remote runtime catalogs.

### Game path
- Shows the detected game path. Long paths shorten their leading folders and keep the final
  name visible; the complete path is in the tooltip.
- Folder icon reveals the path in Finder.

### Save path
- Shown only when `supports.saveLocation` is enabled.
- Shows the active save path (default or override). A save folder inside MacLauncher's own data
  reads **Managed by MacLauncher**, with the full path in its tooltip.
- Folder icon reveals the save folder.
- Change allows picking a custom save folder.
- Reset clears the override and returns to default.

Inspector actions operate on the selected game. Runtime and tool installation, imports, builds, catalog checks and removal belong in **Runtimes**. Game inspection, decompilation, extraction, patches and exports remain in the inspector; required preparation runs automatically after consent.

### Runtime selection
- Dropdown shows `manifest.runtime.supported` entries.
- Labels come from `manifest.runtime.entries[<id>].label`, the same runtime names used in
  Settings and Runtimes. Game types and runtimes keep distinct names, such as RPG Maker 2000/2003
  and EasyRPG Player, or Java and Java (Temurin).
- The launcher resolves the effective runtime using module support and availability.
- Gear icon opens the runtime settings window for this game.
- Flash entries expose managed universal Flash Player and Ruffle choices. Play prompts for a missing download; installed versions run offline, and Flash Player needs no Rosetta.
- LÖVE entries expose `LÖVE` (managed releases/nightlies) and `Native app` for imported `.app` bundles.

### Runtime version overrides
Shown when the selected runtime maps to a runtime manager:
- Version dropdown: per-game override or default version from settings. Its first entry reads
  **Recommended (vX)** when the game's data recommends a version, otherwise **Default (vX)**.
  When the recommended version is not installed, **Install** beside the menu installs it.
- Variant dropdown: per-game override when the manager exposes multiple variants.
- Manager-specific selectors can appear when needed (for example Java line/major selection or the LÖVE release/nightly channel selector).
- Runtimes opens version management when that runtime has a managed download or automated build flow.
  Fixed built-ins retain their name, version choices and Runtime settings without this link.

### Runtime settings
- Runtime settings open in a dedicated window. Settings only changes preferences and uses local state; downloads, catalog queries and tool acquisition belong in Runtimes.
- Runtime settings save automatically as choices change. Text and number fields save on Enter
  or when focus leaves the field, and Escape discards an edit. Reset clears overrides.
- Fields a game type marks as advanced follow the common fields inside one collapsed
  **Advanced** group, which shows how many fields it holds. The group appears only when a
  runtime has both kinds of field; otherwise all fields are listed together. For RPG Maker
  XP/VX/VX Ace (MKXP-Z), the common fields are RTP source and path, RGSS version, Start
  fullscreen, Preserve aspect ratio, Resizable window, Display FPS, VSync, the default window
  size, F12 reset and F1 settings.
- Long field labels wrap. Menus use the available width and place adjacent actions on the
  next line when space runs out. A long selected label is shortened with an ellipsis; the
  menu's tooltip shows the full label and its exact saved ID.
- Dependent settings appear only when their controlling option applies. Hiding a field preserves its saved value. Field descriptions and runtime preparation or data details open through adjacent question-mark help buttons; platform requirements remain visible.
- Local account, device and runtime choices load independently. Refresh preserves the saved selection and existing choices while each provider updates; game launch uses the saved selection without requiring the settings window to be open.
- Per-game runtime settings open for the game's current saved runtime and default to the game type defaults unless overridden.

### Effects
- The Graphics heading opens and closes the section; the open state applies to every game until the launcher quits. While closed, the heading shows a one-line summary of the enabled effects, a game resolution set on its own, live state and warnings. The heading row also holds the checkbox that turns the whole chain on or off without changing its settings, the help button, the application status and one **⋯** menu with saved presets, **Save as preset…**, **Manage presets…** and **Clear effects**.
- The open section starts with the Simple and Advanced view choice. Both views edit the same saved graph; changing views preserves order, effects and settings. The chosen view stays selected for other games until the launcher quits. Games start without scaling; imported videos select native Lanczos Sharp filtering.
- Simple groups implementations by input and output: Image filter, Downsample, Upscale, Temporal upscaling and Frame generation. Advanced adds ordering and repeated rows using the same categories. Downsample and Upscale menus list shaders with a fixed direction before shaders that take the row's size, which appear under Any size; Image filter entries and built-in resize methods carry no size tag. Each menu leads with **Recommended** choices; specialised variants, including libplacebo copies of the native kernels and unnamed files from an installed collection, follow **More** and appear directly in search results; once shown, each joins its group's heading. Shaders from an installed collection are listed under a heading with the collection's name, and each is named after its shader file. Rows needing scene inputs that the game's frame source does not supply follow under **Needs scene inputs**. Ordinary shaders appear under purpose headings such as Sharpen, Colour and tone, CRT and retro and Depth. A pack name is omitted from an effect's displayed name where the menu already names it, and search by the pack name still finds the effect. Availability notes such as Needs depth appear as muted text beside the name. libplacebo filters have readable names, including filters the provider lists only by identifier. A closed implementation menu shows only the selected name. Options appear only for enabled operations; help buttons hold longer explanations, including why a selected implementation is unavailable.
- The **Output** disclosure holds motion clarity, tone mapping, frame pacing, adaptive quality and comparison. It opens automatically when any of them is set. Automatic motion clarity follows a selected subframe shader and reads **Automatic (Off)** while no shader is enabled.
- Number fields save on Enter or when focus leaves the field; Escape restores the saved value, and empty or invalid text is never saved. Sliders save after a short pause.
- An effect's Options show its observed input and output resolution only while the game runs. **Status details** lists the processing the running game reports.
- Shaders join these categories by their declared output geometry; a shader selected or dropped on a row stays in that row. Shader size options reuse the resize controls: Output size for a shader that renders at a requested size, offering only sizes in the row's direction when the shader accepts both, and the declared scale with its owned window fit for a fixed-scale shader.
- Simple Upscale supplies a half-resolution input request and presentation fit when sizing has not been customized. Simple neural reconstruction chooses a compatible local model, automatic working size and output fit. Each action enables its own operation. Manual sizing and unrelated effects retain their saved choices. These sizing rows belong to their effect: Simple lists only the owning effect, while Advanced shows each row in order, and editing one there makes it an ordinary row. Removing an effect's input row also removes the game resolution requested for it.
- Large implementation dropdowns include local search by name and descriptive tags. Arrow keys navigate matches, Enter selects, and Escape closes. Off and **Manage filters…** remain available. Manage filters opens the Graphics library; imported filters appear immediately in open selectors.
- **Save as preset…** stores the current graph. Applying a preset copies its settings; later preset edits do not change entries that already use a copy. **Clear effects** removes every effect together with the game resolution an effect requested; a game resolution set on its own stays. Applying a preset or **Clear effects** shows **Effects replaced** with **Undo** beside the heading until the next edit.
- A shader replacing a row keeps the row's explicit factor or pixel size, even when that size changes the row's resize category; window fits and automatic sizing follow the new row.
- Saved graphics settings that cannot be read as a whole, or that come from a newer launcher version, are not applied. The section shows the reason with **Clear effects** in place of the effect controls until they are cleared. An unreadable row, source resolution or output setting is left out and listed with its reason; the remaining settings stay in use and editable, and the next save stores them. A saved effect that cannot run as saved, such as one with a missing shader file or a retired method, stays off, and its row shows **Needs attention** with the reason.
- A save that leaves out part of an edit lists each part under **Some changes were not saved** until the next save. An effect skipped while a running game prepares the chain, such as one placed after an effect that removes its scene inputs, shows **Needs attention** on its row, and the status reads **Partly applied** while the other effects run.
- NW.js and patched NW.js use the same per-game effects setting. Effects apply through the runtime's graphics API while retaining the selected NW.js version and game profile.
- Ren'Py and native app bundles keep supplied shell launcher scripts and interpreters when enabling effects. Custom NScripter app runtimes start through their bundle executable when effects are enabled, allowing the game process to receive the effects configuration.
- Effects include CRT, Grayscale, Colour, Sharpen, CAS Sharpen and imported ReShade `.fx`, RetroArch `.slangp`/`.slang`, MPV/libplacebo `.glsl`/`.hook`, LUT `.cube` and ISF `.fs`/`.isf` files. Color, CRT and restoration are searchable descriptions; they do not add top-level controls. The selected filename is compact, with its full path available on hover.
- Running games accept live provider, filter, parameter, ordering and size changes through the shared graphics layer, retaining their original window and native fullscreen behavior. A source-allocation or native player change follows its producer's actual live-update contract. Missing scene inputs leave the affected row pending while compatible independent rows continue.
- The effect layer and shader compiler include Apple Silicon and Intel versions. Intel games use the same graphics controls through Rosetta. The [graphics guide](GRAPHICS.md) covers presentation adapters and the extra inputs needed by temporal and video-plane effects.
- The inspector explains an unavailable effect and keeps its existing setting editable.

Inspection and other game-tool results appear below their action buttons when
complete. Running actions show a busy state. Passive metadata can remain in a
Details disclosure; viewing a newly requested result requires no extra click.

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
- A group can set `inlineActions` to display its related actions together;
  ordinary groups retain the primary action and **More…** menu.
- Actions can be hidden or disabled based on entry data.
- Action results are rendered inline when returned (modules can show a single concise field).
Examples:
- RGSS: reload/reveal staged assets, restage/remove staged assets, extract, reveal/remove extracted files.
- Java: extract with Vineflower, reveal extracted output, and remove extracted output.
- Ren'Py: patch status/patch/unpatch, build app bundles, reveal/remove built apps, and extract/reveal/remove actions.
- MV/MZ: plugin actions to install/remove the clipboard and save slot plugins, extract, reveal/remove extracted files.
- Tyrano/Construct: extract packaged bundles, reveal extracted roots, and remove extracted data.
- Video: preview saved graphics settings or export compatible effects to a separate video file.

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
- Save-folder export copies the selected saves to a destination.
- Save-file import accepts individual files.
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
- A left sidebar starts with Search settings. Launcher contains **Appearance** (System, Light or
  Dark; System by default), which applies immediately to every open launcher window and its native
  controls and is restored at startup. Game windows keep their black background. Launcher also
  contains global toggles for icons and non-default tags, and the **Steam client on Play** choice, which defaults to Ask. App follows the Launcher section and exposes the native
  macOS app runtime; other sections follow alphabetically from module manifests.
  The shader library and presets are in Runtimes → Graphics, and a settings link
  to Graphics opens that view.
  Search matches section labels, runtime names and runtime IDs while keeping
  the selected settings open. An empty result shows No matching sections.
- Cmd-F focuses search. Up/Down, Home and End navigate sidebar choices; Up/Down
  from search focuses a result and Enter opens the first result. Escape clears
  search. Only the selected section's settings are rendered.
- Each settings row, in the Settings window, runtime settings windows and plugin cards, has a
  label column and a control column of bounded width. Controls start at the control column's
  edge: menus, text fields, number fields and text areas fill the column and end on one line,
  and checkboxes sit at its start.
- Fields are derived from `settingsDefaults`. Text and number fields save on Enter or
  when focus leaves the field; Escape discards an edit, and an empty number is not saved.
  Every boolean field uses the same checkbox presentation with the launcher accent.
- Supported input types: boolean, number, string, and default runtime select.
- Modules without configurable fields show an empty settings section.
- Runtime tabs show per-runtime settings inline for that game type and show
  "Modified" when they differ from global defaults. A game type with a single runtime shows a
  heading naming that runtime, such as Java (Temurin), instead of one tab, and has no Default
  runtime menu. The menu remains when the saved default is not one of the game type's runtimes;
  that value is listed as saved, with a prompt to choose a compatible runtime. The inline form uses the
  selected tab's label rather than repeating a window heading and scope subtitle.
  Optional instructions and protection details are available through a small **?** button.
- Runtimes with descriptive metadata keep an information tab even when they have
  no configurable fields. Runtime details and automatic preparation are available
  for the selected runtime.

## Runtime manager window
- Runtimes opens a separate, nonmodal macOS window. Reopening it focuses the
  same window and preserves its selection and version choices. An inspector's
  Runtimes action selects the relevant manager. Native close controls or Cmd-W
  close the window; the library remains usable during runtime operations.
- A left sidebar starts with Search runtimes. Search matches group labels,
  runtime names and runtime IDs while keeping the current panel open. Cmd-F
  focuses search; Up/Down, Home and End navigate the sidebar. Escape clears
  search. An empty result shows No matching sections.
- Sidebar entries appear under headings, in order:
  - **Game engines**, listed alphabetically.
  - **Consoles and mobile**: PS5 (AnyPS5), Prosper, Switch (nxnative), MacLauncher Android,
    Mac.apk, AIM and PlayCover.
  - **Compatibility**: CrossOver, Sikarugir, DOSBox and 32-bit Mac.
  - **Graphics** and **Tools**, single entries set apart by a divider line rather than a
    heading that repeats their name.

  Each module classifies its runtime groups in its manifest; an unclassified group appears
  under Game engines. Search filters entries under every heading and shows only headings with
  matches. The Settings sidebar remains a single list without headings.
- A panel that fails to render shows its error inside that panel; the sidebar and runtime
  sub-tabs stay usable.
- An engine's entry keeps its backends and its engine-specific tools together as tabs, with
  common runtimes first. For example, Unity holds Unity Mono, Cpp2IL and AssetRipper; GameMaker
  holds Official, Butterscotch, Classic (OpenGMK), GM8Decompiler, UMT and Graphics helper; and
  WOLF RPG holds Browser Woditor, WolfTL and UberWolf. **Tools** holds the cross-engine tools:
  Installer reader, ILSpy, RPGMakerDecrypter, JADX, Apktool, msg-tool and Rizin / Ghidra.
  [Managed tools and their locations](GAME_TOOLS.md#managed-tools-and-their-locations) lists
  every tool's entry. Labels, ordering and management availability come from runtime-manager
  metadata.
- Managed game runtimes, tools and registered local applications appear here.
  MKXP-Z, Flash Player and native/web NScripter versions have their own managed
  sections. Core graphics and invisible internal helpers remain separate from
  game-runtime choices.
- Runtime sub-tabs stay inside the right panel. Arrow keys, Home and End select
  them; overflowing strips have left and right scroll controls. Active tabs
  retain top and side borders and share the following panel's background.
  Sub-tabs scroll horizontally without vertical overflow.
- When an entry has tabs, the selected tab names its panel. Hovering a tab shows the
  backend's full name when it differs from the tab label, for example UndertaleModTool CLI for
  UMT. An entry without tabs shows the backend name as its panel title. A tab for a group
  member's section that already begins with the member's name is not prefixed with it again.
  Default and latest-version
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
- **Register custom…** follows the Installed list and opens a native file and folder picker
  for the current compatible runtime list. Custom executables, applications and complete runtime
  directories join its installed choices. Download sources share the same
  registration control. **Remove registration** leaves the selected files intact.
  [Custom runtime layouts](runtimes/CUSTOM_RUNTIME_LAYOUTS.md) describes required resources.
- Opening a specific runtime reveals its sidebar group and selects the matching
  sub-tab, clearing a search that would hide it. Navigation and search do not
  fetch runtime catalogs.
- Groups, labels, ordering, and section labels come from runtime metadata. Each
  subtab retains its own version settings, installation actions, and downloads.
- Available download lists are empty until an explicit Refresh, Install or consented Play; previously
  discovered results load from the local cache without a network request.
  Each source has a separate version dropdown, link and Install action.
  MacLauncher Builds and upstream downloads never share a dropdown.
  Incompatible runtime families use separate subtabs.
  Each source shows a short description of what it publishes. A source without listed
  versions shows **Load versions**, which reads **Loading versions…** during the request; a
  failed request keeps the button available for another attempt, and a source with no
  downloadable versions reports **No downloadable versions found at this source.** Once
  versions are listed, an icon-only refresh control fetches them again. It spins and
  disables immediately during the request, then confirms the update. Source
  links remain visible; counts, check time and setup guidance are behind the **?** beside Versions. Ordinary release catalogs load bounded history;
  GitHub Actions histories that span many pages refresh with a bounded scan for the
  newest successful build and add an **All versions** button for the broader history. Its tooltip reads **All versions**
  (**Refreshing all versions** while running), or **Reload all <source> versions** for a
  named download source. Downloads
  start only after an explicit action. Unavailable versions show the supplied reason.
- Included immutable resources show Included without Install or Remove; versions and variants remain selectable. Download/copy paths do not show source-build setup links. Official GameMaker
  offers Import runtime directory and an optional independent Igor installation;
  runtime Install also installs the required Igor tool automatically.
- Installed versions:
  - Install/uninstall actions per version.
  - Set default version (and variant when supported).
- Download manager dropdown (down arrow) shows active downloads with progress bars and cancel
  actions. It closes on an outside click or Escape.
- Graphics → **Providers** lists the components under **Upscaling and frame generation**,
  each with its availability. Lossless Scaling shows two lines with separate availability:
  LS1 spatial upscaling and LSFG frame generation, derived from the imported model files.
  Components with managed files have **Manage**, which shows their management card below;
  each imported Lossless Scaling file names the families it provides.
- Graphics → **Shaders** → **Library** is a table of Name, Input → output, Origin / status
  and Actions. **Source** expands a row to show its file path with a **Replace file…**
  chooser; Remove leaves the files in place. Names save on Enter or when focus leaves the
  field, and Escape discards an edit. **Import filter…** adds ReShade `.fx` effects,
  RetroArch `.slangp` presets or `.slang` shaders, and MPV/libplacebo `.glsl` or `.hook`
  shaders, which then appear in each game's graphics menus. Dragging supported shader files
  into the launcher or using Finder **Open With** follows the same import route; local
  `.dlssmodel` packages enter the managed neural model library. **Collections** holds the
  managed shader packs; it always lists every collection, since the Library search
  filters only imported shaders. **Manage filters…** in the inspector opens this library.
- Graphics → **Presets** selects, renames, edits, copies and deletes saved presets. **Delete…**
  asks for confirmation in a native dialog; games that applied the preset keep their own copies.
  With no saved presets, the editor opens empty.
- Info callouts describe dependencies for the selected runtime, such as optional
  authenticated `gh` downloads for LÖVE nightlies or Rosetta for compatible Intel
  Java builds. Managed MKXP-Z and native NScripter packages need no Homebrew or
  `gh` setup for ordinary Play.

## Credits window
- Credits opens a separate, nonmodal macOS window. Reopening it focuses the
  same window. Native close controls or Cmd-W close it.
- Aggregates acknowledgments from all module manifests and shared launcher/tool/library metadata, deduped by URL and sorted by project name.
  The acknowledgment table comes first; **Game port resources**, with a link to the Awesome
  Decomp Games list, follows it.
- Separate projects have separate links describing their role as a runtime, tool or format reference.
  Entries with different sources stay separate, such as **MoltenVK, Sikarugir build** and
  **MoltenVK**. OpenBGI and FelineSystem2 are labelled **format reference**. Long titles wrap, and each link's full URL is in its tooltip.
- Opens external links via `openExternal`.

## Error handling
- Errors are surfaced inline in modals and detail panels.
- Module action errors show a badge in the detail panel.
- Runtime manager errors show an inline error banner.
- Native game failures received after Play returns show the game and exit reason
  in the launcher's existing error banner. Normal exits and Stop stay quiet.
- Save and cheat operations show error text in their modals.
- Error displays remove repeated `Error:` and Electron IPC prefixes while retaining the reason, paths and diagnostic details. Stored errors and backend logs retain their original messages.

## Notes

**Notes** stores plain text in the game's library record, preserving line breaks and Unicode across launches and detection. Save explicitly with **Save notes** or Cmd-S; leaving the text field also saves changes. Pending changes finish saving when another game is selected. Notes stay in launcher data and are removed when the game is forgotten.
