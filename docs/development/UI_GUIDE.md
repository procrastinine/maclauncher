# Launcher UI guide

This guide describes every window and control in the launcher and the module metadata that each one follows. All game-specific UI comes from module metadata and state, so the UI itself has no per-engine branches. The [module system](MODULES.md#manifest-reference) defines the manifest fields named here, and [UI styles](UI_STYLES.md) maps the styles and components to their source files.

## Layout overview

The main window, called the library window, lists the games and shows the details of the selected one. It contains:

- a header with the MacLauncher logo, a large search field, the selection-mode control and the header actions;
- a global toolbar with the game-type filter, scope, result count and sort;
- the game library on the left;
- the selected game's inspector on the right.

Settings, Runtimes, External and Credits open in separate windows. Save editing, runtime settings and live-variable editing also have their own dedicated windows, while cheat controls open in a modal.

By default the window is up to 1440 × 900, fitted to the usable desktop, and it has a minimum size of 900 × 560. At first the library uses the full width. Selecting a game opens a wide inspector on the right, and switching games keeps row heights stable. When the inspector is closed, or Details is turned off in the toolbar, its space goes back to the library; closing the inspector also returns keyboard focus to the selected row. Each pane scrolls on its own.

In a window 1080 CSS pixels wide or narrower, the library stacks above the inspector, and a short window can scroll the whole layout so that every control stays reachable. Dividers separate the rows and the inspector fields, without nested rounded cards.

Closing the library window leaves the other windows usable. The Dock icon, **View → Library** and adding a game through **File → Open…** reopen it. The remaining launcher-wide actions are in the menus. In the app menu, **Check for Updates…** comes right after **About MacLauncher**; it runs the [update check](../UPDATES.md) and answers in native dialogs. **Credits** opens the [Credits window](#credits-window), and **Help → Show Log in Finder** reveals the main process log.

## Library

### Header actions

The header's actions add games and open the launcher's other windows:

- **Add game** imports games; see [adding games](#adding-games).
- **Settings** opens the [Settings window](#settings-window).
- **External** opens the [External window](#external-window).
- **Runtimes** opens the [Runtimes window](#runtimes-window).

### Adding games

Games are added to the library by importing their folders or files. **Add game** opens a file dialog that accepts folders and common launchable files, including `.app`, `.exe`, `.x86_64`, `.x86`, `.jar`, `.swf`, `.love`, `.AppImage`, `.sh` and `.py`. Module detection runs on each selection, and each game is then added to the library.

Dragging folders and files onto the window imports them too. An empty library shows **Drop a game to get started**, and dragging over the window shows **Drop games, shaders or neural models**. Both hints list what can be dropped, in two groups. **Games** covers Game folder and the standalone formats that the available game types declare, including Android APK packages and iOS IPA archives. **Shaders and models** covers `.fx` / `.glsl` / `.hook`, `.slang` / `.slangp` and `.dlssmodel`. Select and the sort and filter toolbar appear once the library contains a game.

Several selected or dropped items import as one batch. While it runs, the library toolbar shows **Adding N of M** with a progress bar, and a failed item does not stop the rest. When the batch finishes, a summary reads **Added N of M** and lists each failed item with its reason, a **Choose game file…** button and **Retry**. Resolving one item updates the counts, and the other failures stay listed.

**Dismiss** closes the summary, and a summary that lists failed items otherwise stays until they are resolved. Once no failed items remain, it closes on its own 30 seconds after the batch finishes or its last failure is resolved. The countdown, however, waits while the pointer is over the summary and starts again when the pointer leaves.

When an import fails, its error names the selected item and the next step:

- A folder that contains more than one possible game asks for the game file or a more specific folder.
- An unrecognized file asks for the game's application, main game file or complete folder.
- A missing or unreadable item asks the user to locate it or check its permissions in Finder.
- An incomplete search asks for the main game file.
- An unreadable installer points to an unencrypted offline installer, its companion data files, or **Runtimes → Tools → Installer reader**.

A successful import clears the error.

### Game list

The game list holds every saved game. Each row shows:

- the game icon, from the module or extracted from the app or executable;
- the game name and the game-type label on the first line (the module's short label, or its full label when there is no short label);
- a metadata line with the last-played time and the game path;
- a runtime label on the metadata line when the game's runtime differs from the game type's default, and a Modified label when that non-default runtime's settings differ from the game type's defaults;
- a save label that tells a custom save location from the default one;
- an **Unavailable** label on the metadata line, with a dimmed icon, when the game's files are not on disk, for example on a disconnected drive; hovering over the label shows the reason;
- a star button beside the name, filled gold for favorites.

Every row also carries **Play**/**Stop**, **Shortcut** and **Forget**, which work without opening or changing the inspector. Rows for [window graphics](#window-graphics) have only Play/Stop. Save tools and Cheats are in the inspector instead.

A game's inspector opens when its title, icon or row background is clicked, and a second click on the same game closes it. From the keyboard, Tab focuses the title and icon button, and Enter or Space does the same as a click. The selected row has an accent marker and sets `aria-pressed`. The favorite, reorder, checkbox and quick-action controls keep their own behavior.

Cmd-click starts or extends a multiple selection, and Shift-click selects a range while selection mode is active. Because the selection follows the game path, reordering and state updates keep it.

In the Default sort, games can be reordered by hand. The reorder handle, or Option-Up and Option-Down, moves a game within the Favorites or Games group, and a game moved across the separator keeps its favorite status. Reordering also works while a search or filter is active, and hidden games keep their relative order.

### Search, filters and sorting

The global toolbar sits above both panes and narrows and orders the game list.

- **Search**: Cmd-F focuses the search field, which matches titles and paths as the user types. Clear search resets only the query.
- **Game types** opens checkboxes for the game types of the games in the library, with short labels such as RPG Maker MV, Ren'Py and Nintendo Switch. A game is listed under its game type whatever its selected backend, so 32-bit Mac games appear under Mac and Prosper games under PlayStation 5. All game types start enabled, and Select all and Deselect all change only these checkboxes. The menu closes on an outside click or Escape.
- **Show games** offers All games, Favorites and Running.
- **Sort** offers Default, Last played, Date added, Alphabetical and Game type. Every sort except Default has a reverse-direction control. Alphabetical sorting is natural and case-insensitive. Games with unknown dates or no play history stay last in either direction.

The Default sort keeps the dragged order and separates Favorites at the top. New games enter at the top of Games, and playing or re-importing a game does not move it. The other sorts, by contrast, place favorites among the other games, mark them with a star and hide the reorder controls. Favorites and sort preferences are stored in the launcher settings and survive restarts.

Search and filters apply after sorting. They never change the selected sort or overwrite the manual order, and clearing them keeps the sort. If the selected game is filtered out or removed, the inspector closes and the selection clears. Clearing the filter afterwards does not restore the hidden selection.

### Selection and bulk removal

Selection mode applies one action to several games at once, such as finding missing files or removing entries. **Select**, beside the search field, turns it on, and **Done** or Escape turns it off. In this mode, checkboxes replace the reorder handles, the inspector gives its space to the list, and clicking a game's name or icon toggles its selection instead of opening the inspector.

- Shift-click or Shift-Space extends the selection across the visible range in its current order. Cmd-A selects the visible games when focus is outside a text field; search keeps the usual text shortcuts.
- Select all, missing-file selection and bulk actions respect the search, the game-type filter and the scope. Changing filters clears selections that become hidden, and clearing the filters does not bring them back.
- **Detect all missing** checks the current results on disk and marks missing paths, including games on a disconnected drive. **Select all missing** runs the same check and selects the visible missing games. Neither starts a background file system scan or a network request. Games whose files cannot be read or whose location does not respond show **Unavailable** with the reason and are not marked missing.
- **Forget selected** asks once in a native macOS dialog, then removes the library entries and their per-game launcher data while leaving the original game files in place. **Move to Trash** asks once, moves the selected paths to the Trash and removes their library data. Paths that are already missing are forgotten.
- When some Trash moves fail, the failed games stay in the library for another attempt and each error is reported.

### Window graphics

Besides games, MacLauncher can apply a graphics chain to another app's window, to one display or to all displays. [Window entries](../game-types/WINDOW.md) describes these window graphics in full. Their controls appear only on macOS 15.2 or later, with a graphics runtime that includes window graphics.

Window graphics start from **File → Apply Graphics…** or the Dock menu's **Apply Graphics…**. Either item opens the Apply Graphics window, a separate nonmodal window with a single instance, and choosing the item again brings that window forward.

While sessions run, the File and Dock menus also have a **Stop Window Graphics** submenu for ending them. Each entry has an item named after it that ends that entry, and separators divide the entries. An All Displays entry with several displays has a **Remove** item per display instead, followed by a separator and **Stop**. Each window or app entry is also followed by a **Toggle pointer in window graphics** item with the entry's name as its secondary label. After a separator, the submenu ends with **Toggle Graphics for Front App** and **Toggle pointer in window graphics**. Of these two, an assigned item is disabled and shows its shortcut as a native accelerator, while an unassigned item has the secondary label **Assign in Settings…** and opens the Launcher section of Settings.

The Apply Graphics window offers the displays, apps and windows that a new session can process. Its header holds its title and a search field, which filters displays, apps and windows by name, title or detail. The list below it is grouped into sections:

- **Displays** shows a tile per display, named as macOS names it, plus **All Displays** when there are several.
- **Windows** shows window tiles grouped under each app's icon and name. Without a search, it shows at most 96 windows. A search also finds the windows left out and shows them under their app, with the app's icon in place of a preview.

Each tile has a preview that refreshes every few seconds, a one-line title and, where useful, a short detail such as a display's size or **Other Space or minimized**. A window, display or All Displays that already has an entry shows **Has window graphics** in its detail, joined to any other detail with " · ". Choosing such a tile starts nothing. Instead, the library reports that it could not start because its library entry controls it.

Clicking a tile, or pressing Return or Space on the selected tile, starts a session with a new library row each time and closes the window. Within the window, the arrow keys move between tiles by position, Down Arrow in the search field moves to the tiles, Command-F or / returns to the search field, and Escape clears the search or closes the window.

The previews need the Screen & System Audio Recording permission. Without it, a notice with **Open Privacy Settings** replaces them, and the window lists running apps by icon and name instead; choosing one opens the macOS window picker for that app. The **Displays** section then says that it needs the permission.

Once a window or display is chosen, a library row named after the app or display shows **Stop**. The row lasts as long as its session, which ends when its window closes or is removed, sharing stops, **Stop** is chosen or MacLauncher quits. Cancelling the macOS window picker for a new session leaves no row.

In the row's inspector, the Graphics tab edits that row's own chain live. The **Applied to** section names the row's window, app or display, with a remove button, and for All Displays it lists each display. Above that section, two **Keyboard shortcut** rows name **Toggle Graphics for Front App** and **Toggle pointer in window graphics**. Each is followed by its assigned shortcut in menu symbols or by an **Assign in Settings…** button that opens the Launcher section of Settings.

Unlike game rows, window rows have no **Shortcut** or **Forget** button, save tools or cheats. Their **Window capture** runtime settings hold **Output** (**In place**, **Fit screen**, **1.5×**, **2×**, **2.5×**, **3×**, **4×**, **5×**, **6×**, **8×** or **10×**), **Include pointer in capture** and **Show pointer in picture**. Choosing **Fit screen** or a scale factor without the Accessibility permission shows the macOS request, and the control returns to **In place**.

Two graphics shortcuts in Settings also act on window graphics. **Toggle Graphics for Front App** starts a session for the frontmost app, or ends that app's rows when it already has window graphics. **Toggle pointer in window graphics** turns the drawn pointer of a scaled output off or on in the frontmost app's rows.

## Inspector

The inspector acts on the selected game. Game inspection, decompilation, extraction, patches and exports live here, whereas installing runtimes and tools, imports, builds, catalog checks and removal belong in the Runtimes window.

Selecting a game opens its inspector, whose header shows the game's name, engine and detected version on one line. Switching games scrolls the inspector back to the top and leaves the library's scroll position alone. Only the selected game's controls are mounted, and only its detail status actions run.

The inspector has these sections, in order: **Files**, **Launch**, **Patches**, **Tools**, **Graphics** and **Notes**. Optional sections appear only when the game type supports them.

All sections share one row layout. Field labels share one column and stay on one line, and a long label supplied by a game type is truncated, with its full text shown on hover. Every row starts its controls at the value column, where a lone checkbox, such as Network access, sits at the start. Graphics menus without an Options or Edit button extend to the same right edge as the other controls. For confirmations, the inspector uses native macOS dialogs with Cancel and a button naming the action, such as Forget, Patch or Remove.

### Game actions

The game actions at the top of the inspector start and stop the game and manage its saves, cheats, shortcut and library entry. They are **Play**/**Stop**, **Saves** (**Edit saves** when the game type supports save editing), Cheats, **Create shortcut…** and **Forget**. Which save and cheat controls appear follows the module's capabilities, and Play is the only button with the primary style.

- **Create shortcut…** sits beside Play at the top of every inspector, with the tooltip "Save a .command file that starts this game when opened". It saves a macOS `.command` launcher with a chosen name and location. The launcher uses the game's saved runtime and settings and starts the game without opening the library window. **Shortcut** on a library row does the same.
- During preparation, **Cancel** stops the pending launch, and installation progress and **Starting** stay visible beside it. **Stop** becomes available as soon as the game process starts, before its first window appears.
- A notice from the latest Play, such as a Steam client that did not finish signing in, appears below the actions until the next Play.
- When the game's files are not on disk, a notice below the actions gives the reason, with **Locate…** beside it for choosing the files' new location; a location that is refused shows its reason below the notice. **Play** stays enabled. It checks again, then starts normally if the files have returned or reports the reason. Patch controls and tools that read the game's files are disabled until the files return, and their hover text gives the same reason. [Unavailable game files](../library/GAME_PREPARATION.md#unavailable-game-files) lists what keeps working.
- **Forget** removes the library entry and clears the per-game launcher data under `userData/games/<gameId>/`. The original game files stay on disk. Its icon is shaped like a trash can.

When the selected runtime can only inspect the game, a format or compatibility explanation replaces Play. Launch arguments, network access, Create shortcut…, save and cheat controls and Graphics are then hidden, and the library row has no Shortcut. Runtime selection, inspection tools and Notes remain. A game that can launch but whose runtime is not installed keeps every control.

### Files

The Files section shows where the game and its saves are and how the game was detected.

- **Game path** shows the detected path. A long path shortens its leading folders and keeps the final name visible, with the complete path in the tooltip. The folder icon reveals the path in Finder.
- Module launch choices (`ui.entrySelectors`) follow the game path.
- **Saves** shows the active save folder, default or override, when the module declares `supports.saveLocation`. A folder inside MacLauncher's own data reads **Managed by MacLauncher**, with the full path in its tooltip. The folder icon reveals the save folder, **Change** picks a custom folder, and **Reset** removes the override.
- Imported native apps offer **Remove quarantine**, which runs `xattr -dr com.apple.quarantine` on the app.
- The collapsed **Detection** disclosure holds the format, version source, confidence and an optional detection trace with its own refresh button. MV and MZ games omit the version and confidence rows, which do not apply to them. Module info fields (`ui.infoFields`) also appear here as read-only rows, such as build metadata, module flags and runtime status values. LÖVE, for example, uses them for the detected engine version and AppImage extraction state. A field is hidden when its `hiddenWhen` conditions match.

### Launch

The Launch section sets how Play starts the game: its arguments, runtime, network access and runtime version.

- **Launch arguments** is available for every game and runtime. It saves on Return, when focus leaves the field or on Save, keeps quoted values, and stays the same when the runtime changes. Its `?` button explains the argument syntax, and saved shortcuts use the same value.
- **Runtime** lists the module's `runtime.supported` entries, labeled with `runtime.entries[<id>].label`, which are the same runtime names used in Settings and Runtimes. Game types and runtimes keep distinct names, such as RPG Maker 2000/2003 and EasyRPG Player, or Java and Java (Temurin). The launcher resolves the effective runtime from module support and availability. The gear icon opens the [runtime settings window](#runtime-settings-window) for this game.
- Flash games offer the universal Flash Player, which needs no Rosetta, and Ruffle. LÖVE games offer **LÖVE**, with downloadable releases and nightlies, and **Game's macOS app** for imported `.app` bundles.
- **Network access** is a per-game checkbox.
- **Steam client on Play** appears after Network access for Steam games that can start the Mac client. The choices are Default, which follows Settings and names its current value, Ask, Start automatically and Don't start. When Steam is not running, Ask shows a prompt with **Start Steam** and **Launch without Steam**, and the second launches the game without starting or waiting for the client.

When the selected runtime has a runtime manager, version controls follow:

- **Version** holds the per-game override or the default version from Settings. Its first entry reads **Recommended (vX)** when the game's data recommends a version, and **Default (vX)** otherwise. The other entries are the installed versions and the game's saved choice, while versions that are only available to download are listed in Runtimes. A damaged or incomplete installation stays in the menu, marked **Needs repair**. An installed build that this Mac cannot run, such as a build for an unsupported processor, one that requires a newer macOS or a registration whose files are missing, is left out unless it is the game's saved choice, which is marked **Unavailable**. When the recommended version is not installed, **Install** beside the menu installs it. When the game's choice, or the version that the first entry names, needs repair, **Repair** beside the menu removes the damaged copy and installs the same version and build again, as **Reinstall** does in Runtimes.
- **Variant** holds the per-game override when the manager offers several variants. Its first entry, **Default (X)**, names the variant Play uses without an override: the variant the module recommends, such as the Godot build that the game's files and installed builds select, and otherwise the manager default. When the game requires a variant, the menu shows it as the selection, the other variants are disabled, and the reason appears under the menu; a saved choice that does not apply stays saved. **Install** installs the variant that Play uses.
- Manager-specific selectors appear where needed, such as the Java line or major version, or the LÖVE release or nightly channel.
- **Runtimes** opens version management when the runtime has a download or an automated build. Fixed built-in runtimes keep their name, version choices and runtime settings without this link.

### Patches

The Patches section applies and removes the patches that a module offers for the game. **Libraries** appears when a module manages library versions. It shows the patch status (Not patched, Patched or Partial) with any warnings, a Patch or Unpatch toggle, Refresh, and per-library version overrides stored in `moduleData.libVersions`. MV uses it for the PixiJS 5 patch set.

**Tools** appears when the module declares `supports.cheatsPatcher`. It shows the status of the in-game Tools injection, again with a Patch or Unpatch toggle and Refresh.

### Tools

The Tools section runs a module's actions on the game, such as extraction, decompilation and builds. The module's `ui.actionGroups` arrange these actions in ordered groups. An action is primary, secondary or danger, and entry data can hide or disable it. Each group shows its main action first as an ordinary button and puts supporting actions in **More…**, unless it sets `inlineActions` to show related actions together. [UI field and action schema](MODULES.md#ui-field-and-action-schema) describes the full rules.

A running action shows a busy state, and its result appears below the buttons when it finishes, without another click. A module can limit a result to one concise field, and passive result fields stay in the group's collapsed **Details** disclosure. **Reveal** buttons in results use the interface font, and printed paths stay monospaced.

Examples of module actions:

- RGSS: reload, reveal, restage or remove staged assets; extract; reveal or remove extracted files.
- Java: extract with Vineflower, then reveal or remove the extracted output.
- Ren'Py: check patch status, patch and unpatch; build app bundles and reveal or remove them; extract, then reveal or remove the output.
- MV and MZ: install or remove the clipboard and save slot plugins; extract, then reveal or remove the extracted files.
- Tyrano and Construct: extract packaged bundles, reveal the extracted roots and remove the extracted data.
- Video: preview the saved graphics settings, or export compatible effects to a separate video file.

### Graphics

The collapsible Graphics section edits the game's effect chain, the ordered effects that process its picture. The [graphics guide](../graphics/README.md) explains the chain, providers and the extra inputs that temporal and video-plane effects need.

#### Heading and presets

The section's heading summarizes the chain and holds the controls that act on it as a whole. Clicking the heading opens or closes the section, and that state applies to every game until the launcher quits. While the section is closed, the heading shows a one-line summary of the enabled effects, a game resolution set on its own, the live state and warnings. The heading row also holds a checkbox that turns the whole chain on or off without changing its settings, a help button, the application status and a **⋯** menu with the saved presets, **Save as preset…**, **Manage presets…** and **Clear effects**.

**Save as preset…** stores the current chain. Applying a preset copies its settings, so later edits to the preset do not change games that already use a copy. **Clear effects** removes every effect, together with any game resolution an effect requested, although a game resolution set on its own stays. After a preset is applied or the effects are cleared, **Effects replaced** with **Undo** appears beside the heading until the next edit.

#### Simple and Advanced views

The open section starts with a choice between the Simple and Advanced views. Both edit the same saved chain, and switching keeps the order, the effects and their settings. The chosen view stays selected for other games until the launcher quits. Games start without scaling, and imported videos start with native Lanczos Sharp filtering.

Simple groups implementations by what they take in and produce: Image filter, Downsample, Upscale, Temporal upscaling and Frame generation. Advanced uses the same categories and adds ordering and repeated rows, each with its own enable, move, remove and settings controls.

Some Simple choices also set up sizing. Simple Upscale requests a half-resolution input and a presentation fit when the sizing has not been customized, and Simple neural reconstruction chooses a compatible local model, an automatic working size and an output fit. Each of these turns on only its own operation, so manual sizing and unrelated effects keep their saved choices.

The sizing rows that such an effect adds belong to it. Simple lists only the effect, whereas Advanced shows each row in order, and editing a sizing row there turns it into an ordinary row. Removing an effect's input row also removes the game resolution requested for it.

#### Effect menus

Effects are picked from menus, and each menu leads with **Recommended** choices. Specialized variants, including libplacebo copies of the native kernels and unnamed files from an installed collection, follow under **More** and appear directly in search results; once shown, each joins its group's heading.

- Downsample and Upscale menus list shaders with a fixed direction first, then shaders that take the row's size under Any size. Image filter entries and built-in resize methods carry no size tag.
- Shaders from an installed collection are listed under the collection's name, each named after its shader file. Other shaders appear under purpose headings such as Sharpen, Colour and tone, CRT and retro, and Depth.
- An effect's name omits its pack name where the menu already shows it, and searching for the pack name still finds it. Availability notes such as Needs depth appear as muted text beside the name.
- Rows that need scene inputs the game's frame source does not supply are listed last, under **Needs scene inputs**.
- libplacebo filters have readable names, including filters that the provider lists only by identifier.

A closed menu shows only the selected name. Large menus have a local search by name and descriptive tags, in which arrow keys move through the matches, Enter selects and Escape closes. Off and **Manage filters…** are always available. **Manage filters…** opens the shader library in Runtimes, and filters imported there appear at once in open menus.

The built-in effects include CRT, Grayscale, Colour, Sharpen and CAS Sharpen. Imported effects can be ReShade `.fx`, RetroArch `.slangp` or `.slang`, MPV/libplacebo `.glsl` or `.hook`, LUT `.cube` and ISF `.fs` or `.isf` files. Color, CRT and restoration work as searchable descriptions and add no top-level controls. The selected file name is shown compactly, with the full path on hover.

Options appear only for enabled operations. Help buttons hold longer explanations, including why a selected implementation is unavailable. While the game runs, an effect's Options show its observed input and output resolution.

#### Sizes

A shader's declared output geometry decides which resize category it joins, although a shader selected or dropped on a row stays in that row. Shader size options reuse the resize controls. A shader that renders at a requested size gets Output size, offering only sizes in the row's direction when the shader accepts both. A fixed-scale shader shows its declared scale with its own window fit. A shader that replaces another in a row keeps the row's explicit factor or pixel size, even when that size moves the row to another resize category; window fits and automatic sizing follow the new row.

#### Output and live changes

An **Output** disclosure holds motion clarity, tone mapping, frame pacing, adaptive quality and comparison, and it opens automatically when any of them is set. Automatic motion clarity follows a selected subframe shader and reads **Automatic (Off)** while no shader is enabled. **Status details** lists the processing the running game reports.

A running game accepts live changes to providers, filters, parameters, order and sizes through the shared graphics layer, and keeps its original window and native fullscreen behavior. A change to the game's render size or to the native player follows what that renderer or player supports for live updates. When scene inputs are missing, the affected row waits while compatible rows that do not depend on it keep running.

#### Saving and errors

Number fields save on Enter or when focus leaves the field, and Escape restores the saved value; empty or invalid text is never saved. Sliders save after a short pause.

The launcher does not apply saved graphics settings that cannot be read as a whole or that come from a newer launcher version. Instead, the section shows the reason, and **Clear effects** takes the place of the effect controls until the settings are cleared.

A problem in one part has a narrower effect. An unreadable row, source resolution or output setting is left out and listed with its reason, while the remaining settings stay in use and editable and are stored on the next save. A saved effect that cannot run as saved, such as one with a missing shader file or a retired method, stays off, and its row shows **Needs attention** with the reason. The inspector explains why an effect is unavailable and keeps its setting editable.

Turning Graphics off keeps the chain. While it is off and an effect is enabled, a line above the effects reads **Graphics are off. Saved effects are kept and inactive.** with **Turn On**, and each enabled row in Advanced reads **Inactive**.

A row can also be inactive because of its frame source. A source that can never supply a method's inputs does not list that method; video playback, for example, lists no method that needs renderer depth, motion or camera. A saved row that already holds such a method reads **Inactive** with the reason and offers the working method of its kind, such as **Use MetalFX image interpolation**.

If a save leaves out part of an edit, each part is listed under **Some changes were not saved** until the next save. If a running game skips an effect while preparing the chain, for example one placed after an effect that removes its scene inputs, the row shows **Needs attention**, and the status reads **Partly applied** while the other effects run.

#### Runtime support

The effects are available across these runtimes and on both processor types:

- NW.js and patched NW.js use the same per-game effects setting. Effects apply through the runtime's graphics API, and the selected NW.js version and game profile stay in use.
- Ren'Py and native app bundles keep their own shell launcher scripts and interpreters when effects are on. Custom NScripter app runtimes start through their bundle executable when effects are on, so the game process receives the effects configuration.
- The effect layer and shader compiler come in Apple Silicon and Intel versions, and Intel games get the same graphics controls through Rosetta.

### Notes

The Notes section keeps free-form notes for the game. **Notes** stores them as plain text in the game's library record, with line breaks and Unicode kept across launches and detection. **Save notes** or Cmd-S saves explicitly, and leaving the text field also saves; pending changes finish saving when another game is selected. Because notes stay in launcher data, they are removed when the game is forgotten.

## Windows

### Settings window

Settings holds the launcher's preferences and the default settings of each game type. It opens in a separate, nonmodal macOS window. Cmd-, opens or focuses it from any launcher view, and the native close controls or Cmd-W close it. Meanwhile, the library stays usable and keeps its selection, inspector, filters and scroll position, and changes appear at once in every launcher window.

The sidebar starts with **Search settings**, followed by the sections. The first, Launcher, holds:

- **Appearance**: System (the default), Light or Dark. It applies immediately to every open launcher window and its native controls and is restored at startup. Game windows keep their black background.
- global toggles for game icons and non-default tags;
- **Steam client on Play**, which defaults to Ask;
- the [graphics shortcut](#graphics-shortcuts) recorders and **Screenshot folder**;
- **Updates**: the **Check for Updates…** button, with the result of the latest check beside it. While an update downloads, the button becomes **Cancel Download** and the result shows the progress; once the update is ready, it becomes **Restart to Update**. The button opens the same native dialogs as the menu command;
- **Check for updates at launch**, which is off by default.

The macOS Game section follows Launcher and holds the native macOS app runtime. The other sections come from the module manifests and follow in alphabetical order. The shader library and presets, however, are in Runtimes → Effects.

**Search settings** matches section labels, runtime names and runtime IDs and keeps the selected section open. When nothing matches, the sidebar shows **No matching sections**. Cmd-F focuses search. Up, Down, Home and End move through the sidebar, Up or Down from the search field moves to the results, and Enter opens the first result. Escape clears the search. Only the selected section's settings are rendered.

Each module's section is built from its `settingsDefaults`. The supported input types are boolean, number, string and the default runtime menu, and a module without configurable fields shows an empty section. Text and number fields save on Enter or when focus leaves the field, Escape discards an edit, and an empty number is not saved. Every boolean field uses the same checkbox, in the launcher accent color.

Settings rows have the same layout in the Settings window, the runtime settings windows and plugin cards: a label column and a control column of limited width. Controls start at the edge of the control column. Menus, text fields, number fields and text areas fill that column and end on the same line, and checkboxes sit at its start.

Within a game type's section, runtime tabs show each runtime's settings for that game type inline, marked "Modified" when they differ from the global defaults. A game type with a single runtime shows a heading naming it, such as Java (Temurin), instead of one tab, and has no Default runtime menu. Even then, the menu stays when the saved default is not one of the game type's runtimes, and it lists the saved value with a prompt to choose a compatible runtime.

The inline form uses the selected tab's label and does not repeat the window heading and scope subtitle. Optional instructions and protection details open from a small **?** button. A runtime with descriptive metadata keeps an information tab even without configurable fields, showing its details and automatic preparation.

#### Graphics shortcuts

Graphics actions can have keyboard shortcuts that work from any app. The Launcher section has a shortcut recorder for **Bypass graphics effects** and **Save processed screenshot** and, where [window graphics](../game-types/WINDOW.md) are available, for **Toggle pointer in window graphics** and **Toggle Graphics for Front App**. [Shortcuts and screenshots](../graphics/README.md#shortcuts-and-screenshots) describes what each action does.

- Clicking **Record Shortcut** changes the button to **Press Shortcut…**, and the next key combination becomes the shortcut; Escape on its own cancels the recording. An assigned shortcut appears in menu symbols, such as ⌃⌥⌘B, with a **Clear** button beside it.
- A shortcut combines Control and at least two of Option, Shift and Command with a letter, a digit, F1 to F20, Space, Tab, Backspace, Delete, Return, Escape, an arrow key or a punctuation key. macOS and app menu commands leave these modifier combinations free.
- The recorder refuses three kinds of combination, each with a message: any other set of modifiers ("Use Control with two of Option, Shift and Command. macOS and most apps leave these combinations free."), a macOS shortcut of that form ("Control-Shift-Command-3 is a macOS shortcut: Copies a screenshot of the screen.") and a combination that another action already uses ("This shortcut is already assigned to Bypass graphics effects."). The refused macOS shortcuts are Control-Shift-Command-3, -4 and -5, Control-Option-Command-8, -comma and -period, and Control-Option-Command-Escape and -Space. Only valid, distinct assignments are saved.
- MacLauncher registers the bypass, screenshot and pointer shortcuts only while a game or window graphics session runs, and the window graphics shortcut whenever window graphics are available, so each works from any app. When another app already uses a shortcut, its row shows "Another app is using this shortcut."
- When one game is running, the bypass and screenshot shortcuts act on it. With several running, they act on the game whose process or captured app is frontmost, then on the game whose process started the frontmost app (such as the wine process of a Wine game), and otherwise on the most recently started one. The window graphics and pointer shortcuts, by contrast, act on the frontmost app.
- **Screenshot folder** follows the screenshot recorder. Screenshots go to ~/Pictures/MacLauncher until **Choose…** selects another folder; once a folder is chosen, **Default** appears and returns to ~/Pictures/MacLauncher. Each file is named after the game and the local time, in the form macOS uses for screenshots, such as `Example Game 2026-10-31 at 14.05.09.png`; another screenshot in the same second adds ` 2`, ` 3` and so on before the extension. Characters that a file name cannot hold become spaces, and the title is limited to 96 characters.

### Runtime settings window

The runtime settings window holds one game's own settings for its runtime. The gear beside a game's runtime opens it as a dedicated window for the game's saved runtime, and every field starts at the game type's default unless the game overrides it. Because the window changes only preferences and uses local state, downloads, catalog queries and tool acquisition belong in the Runtimes window.

- Choices save automatically. Text and number fields save on Enter or when focus leaves the field, and Escape discards an edit. **Reset** clears the game's overrides.
- Fields a game type marks as advanced follow the common fields inside one collapsed **Advanced** group, which shows how many fields it holds. The group appears only when a runtime has both kinds of field, and otherwise all fields are listed together. For RPG Maker XP/VX/VX Ace (MKXP-Z), the common fields are RTP source and path, RGSS version, Start fullscreen, Preserve aspect ratio, Resizable window, Display FPS, VSync, the default window size, F12 reset and F1 settings.
- Long field labels wrap. Menus use the available width and move adjacent actions to the next line when space runs out. A long selected label ends in an ellipsis, and the menu's tooltip shows the full label and its exact saved ID.
- A dependent setting appears only when its controlling option applies, and hiding it keeps its saved value. Field descriptions and the runtime's preparation and data details open from question-mark buttons beside them, while platform requirements stay visible.
- Local account, device and runtime choices load independently. Refresh keeps the saved selection and the existing choices while each provider updates, and a game launch uses the saved selection without the window being open.

### Runtimes window

The Runtimes window is where runtimes and tools are installed and managed. It shows downloadable game runtimes, tools and registered local applications, and it keeps core graphics components and the internal helpers that ship with the app apart from the game-runtime choices.

Like Settings, Runtimes opens in a separate, nonmodal macOS window. Reopening it focuses the same window and keeps its selection and version choices, and a game's **Runtimes** action selects the relevant manager. The native close controls or Cmd-W close it, and the library stays usable during runtime operations.

#### Sidebar and search

The window's sidebar lists its entries and starts with **Search runtimes**, which matches group labels, runtime names and runtime IDs and keeps the current panel open. Cmd-F focuses the search, Up, Down, Home and End move through the sidebar, and Escape clears the search. With no matches, the sidebar shows **No matching sections**.

Sidebar entries are grouped under headings, in this order:

- **Game engines**, listed alphabetically.
- **Consoles and mobile**: PS5 (AnyPS5), Prosper, Switch / Switch 2 (nxnative), MacLauncher Android, Mac.apk, AIM and PlayCover.
- **Compatibility**: CrossOver, Sikarugir, DOSBox and 32-bit Mac.
- **Graphics**: the Effects, DirectX → Vulkan, DirectX → Metal, Vulkan drivers and Video codecs entries.
- **Tools**, a single entry set apart by a divider line, without a heading that would repeat its name.

Each module classifies its runtime groups in its manifest, and an unclassified group appears under Game engines. Search filters the entries under every heading and shows only the headings with matches. The Settings sidebar, by contrast, is a single list without headings.

Opening a specific runtime from elsewhere reveals its sidebar group and selects the matching subtab, clearing a search that would hide it. If a panel fails to render, it shows its error inside the panel, and the sidebar and subtabs stay usable.

#### Entries and subtabs

An engine's entry keeps its backends and its engine-specific tools together as subtabs, with the common runtimes first. For example, Unity holds Unity Mono, Cpp2IL and AssetRipper; GameMaker holds Official, Butterscotch, Classic (OpenGMK), GM8Decompiler, UMT and Graphics helper; and WOLF RPG holds Browser Woditor, WolfTL and UberWolf. **Tools** holds the tools shared by several engines: Installer reader, ILSpy, RPGMakerDecrypter, JADX, Apktool, msg-tool and Rizin / Ghidra. [Where tools appear in Runtimes](../tools/README.md#where-tools-appear-in-runtimes) lists the entry for every tool. MKXP-Z, Flash Player and the native and web NScripter players have their own sections.

Under the Graphics heading, the managed translator components are grouped by what they produce. **DirectX → Vulkan** holds DXVK, Wine vkd3d and vkd3d-proton, **DirectX → Metal** holds D3DMetal and DXMT, **Vulkan drivers** holds MoltenVK, KosmicKrisp and MacLauncher KosmicKrisp, and **Video codecs** holds GStreamer codecs. Each component keeps its own version controls and installation identity. In the Windows runtime settings, named engines and versions are selected separately for each Direct3D version from 8 to 12, the Vulkan driver and video codecs, and the inspector reports the effective choices and any fallback. [Graphics translators](../runtimes/TRANSLATORS.md) specifies how these components are loaded and their compatibility behavior.

Groups, labels, order, section labels and whether a runtime can be managed all come from runtime-manager metadata. Each subtab keeps its own version settings, installation actions and downloads. Some groups also have section selectors, such as the LÖVE release lines and nightly builds or the Java runtime lines with Vineflower, and the window remembers the chosen section of each group while it is open.

Subtabs stay inside the right panel and scroll horizontally, never vertically. Arrow keys, Home and End select them, and an overflowing strip has left and right scroll controls. The active subtab keeps its top and side borders and shares the panel's background.

The selected subtab names its panel, whereas an entry without subtabs shows the backend name as its panel title. Hovering a subtab shows the backend's full name when it differs from the label, such as UndertaleModTool CLI for UMT. A subtab for a group member's section whose name already begins with the member's name is not prefixed with it again.

#### Versions and downloads

Each subtab lists the versions its sources offer for download and the versions already on this Mac. Available downloads stay empty until a catalog is loaded by **Refresh**, **Install** or Play, and results found earlier load from the local cache. [Release catalogs](../runtimes/RUNTIME_CATALOGS.md) describes when catalogs load.

- Each source has its own version menu, link and Install action, and a short description of what it publishes. MacLauncher Builds and upstream downloads never share a menu, and incompatible runtime families use separate subtabs.
- Each version is labeled with the upstream version it packages, and its tooltip holds the exact version. For an upstream without releases, a MacLauncher Builds package is labeled with the date of its upstream code instead, such as **Development build (Oct 28)**, while a version with neither an upstream version nor a date, such as a package named **MCLv8**, shows its exact version. When versions would read the same, each label adds its MacLauncher Builds package revision, such as **v2.4.2 · MCLv8** and **v2.4.2 · MCLv7**. A package listed beside the publisher's own file of that version also names **MacLauncher Builds**.
- A source without listed versions shows **Load versions**, which reads **Loading versions…** during the request. After a failed request, the button stays available for another attempt, and a source with nothing to download reports **No downloadable versions found at this source.**
- Once versions are listed, an icon-only refresh button fetches them again. During the request it spins and is disabled, and afterwards it confirms the update. Source links stay visible, while counts, the time of the last check and setup guidance are behind the **?** beside Versions.
- Ordinary release catalogs load a limited history. For GitHub Actions histories that span many pages, a refresh scans a limited number of pages for the newest successful build and adds an **All versions** button for the full history. Its tooltip reads **All versions** (**Refreshing all versions** while running), or **Reload all <source> versions** for a named download source.
- A version that cannot be installed shows the reason supplied for it.
- A version whose installation is damaged or incomplete reads **Needs repair** in the version menu, and its Install button reads **Reinstall**. Reinstall installs the version again. As in any installation of a damaged version, the first step of its download task removes the damaged copy.

The local list tells Included versions from Installed ones. Included versions ship with the app and cannot be changed, so they show Included, without Install or Remove; their versions and variants still stay selectable. Download and copy paths show no source-build setup links. Each installed version, on the other hand, has install and uninstall actions and can be set as the default version, and as the default variant where variants exist. Default and latest-version summaries leave out values already shown in the selector or by a Default badge.

A sort menu in the Installed header orders the local list. **Newest first** and **Oldest first** compare the version that each row's label leads with, leaving out build qualifiers such as async: the component version for graphics translators, and the release version for other runtimes. Rows with equal versions are ordered by the version of the CrossOver application or Sikarugir Template that supplies them, and then by label. Graphics translator rows whose component version is not known, such as a registered folder without version metadata, come after all versioned rows in either order, sorted by label and then by location. **Path** orders rows by location, and **Default first**, offered where a runtime has a default version, places that version first.

Official GameMaker offers **Import runtime directory** and an optional, independent Igor installation; installing the runtime also installs the Igor tool it needs.

Info callouts describe the selected runtime's dependencies, such as Rosetta for compatible Intel Java builds, or the two MKXP-Z download sources. The MKXP-Z and native NScripter packages need no Homebrew or `gh` setup for ordinary Play.

The download manager menu (the down arrow) shows active downloads with progress bars and cancel actions, and closes on an outside click or Escape.

#### Local applications and custom runtimes

Besides downloads, a runtime can come from an application already on the Mac or from custom files. Local applications, such as CrossOver, are listed under **Registered applications** with their versions and paths. **Add application** opens the native application picker, and **Find installed applications** refreshes local discovery without downloading anything. Each copy is a separate choice, even when two copies have the same version. **Remove** unregisters a copy and keeps its files. Defaults and per-game version choices use the same controls as downloaded runtimes.

For custom files, **Register custom…** follows the Installed list and opens a native file and folder picker for the current list of compatible runtimes. Custom executables, applications and complete runtime folders then join its installed choices, and download sources use the same registration control. **Remove registration** leaves the selected files in place. [Custom runtime layouts](../runtimes/CUSTOM_RUNTIME_LAYOUTS.md) describes the files each runtime needs.

#### Effects

The Effects entry manages what the inspector's graphics menus can offer: upscaling and frame-generation components, imported shaders and saved presets. Its subtabs include **Providers**, **Shaders** and **Presets**.

- **Providers** lists the components under **Upscaling and frame generation**, each with its availability. Lossless Scaling shows two lines with separate availability, LS1 spatial upscaling and LSFG frame generation, derived from the imported model files. Components whose files MacLauncher stores have **Manage**, which shows their management card below; each imported Lossless Scaling file names the families it provides.
- **Shaders** holds the shader library, which **Manage filters…** in the inspector opens, and has two tabs. **Library** is a table of imported shaders with Name, Input → output, Origin / status and Actions columns, a search field and a type filter. In this table, **Source** expands a row to show its file path with a **Replace file…** chooser, and **Remove** leaves the files in place. Names save on Enter or when focus leaves the field, and Escape discards an edit.

  **Import filter…** adds ReShade `.fx` effects, RetroArch `.slangp` presets or `.slang` shaders, and MPV/libplacebo `.glsl` or `.hook` shaders, which then appear in every game's graphics menus. Supported shader files that are dragged onto the launcher, or opened with Finder's **Open With**, are imported the same way, while local `.dlssmodel` packages go to the neural model library. **Collections** selects a downloadable shader collection, with its own download and version controls. It always lists every collection, because the Library search filters only imported shaders. The other Graphics tabs stay available while browsing shaders.
- **Presets** selects, renames, edits, copies and deletes saved presets. **Delete…** asks for confirmation in a native dialog, and games that applied the preset keep their own copies. With no saved presets, the editor opens empty.

### External window

The External window is for games that stores have installed and for store downloads. It opens as a separate window with separate **Installed** and **Downloaded** tables, plus Steam, Epic, GOG, itch.io and Android tabs for accounts, versions and downloads. Downloaded versions stay independent of store installations. [External libraries](../library/EXTERNAL.md) describes selection, refresh, Finder shortcuts and importing.

### Credits window

The Credits window acknowledges the projects that MacLauncher uses. It opens in a separate, nonmodal macOS window; reopening it focuses the same window, and the native close controls or Cmd-W close it.

The window combines the acknowledgments of every module manifest with the shared launcher, tool and library metadata, removes duplicate URLs and sorts the entries by project name. The acknowledgment table comes first, followed by **Game port resources** with a link to the Awesome Decomp Games list. Each project has its own link describing its role as a runtime, tool or format reference. Entries with different sources stay separate, such as **MoltenVK, Sikarugir build** and **MoltenVK**, and OpenBGI and FelineSystem2 are labeled **format reference**. Long titles wrap, each link's full URL is in its tooltip, and links open through `openExternal`. [Attributions](../ATTRIBUTIONS.md) describes the roles and license notices.

### Save editor window

The save editor manages a game's save files and recovery snapshots. It opens from the inspector and from the library row when the module supports a save location. The editor is a dedicated macOS window with native window controls, and opening it again focuses the existing editor for that game. Game types with save editing call it **Save editor**; the others still get the metadata-only and recovery tools.

- The folder icon reveals the active save folder. Game types with several detected locations show a folder selector; Ren'Py lists the configured primary folder, `~/Library/RenPy/<name>`, and its `saves` mirror inside the game, even before either exists.
- Save files are listed with their size and timestamp. Importing a save folder replaces the current saves, folder export copies the selected saves to a destination, and file import accepts individual files.
- MV and MZ saves get structured editing with labels defined by the game, and JSON stays available for advanced edits. The JSON editor has Format, Open in external editor, Reload from external editor, and Save, which writes backup files.
- Save files and recovery snapshots are tabs in the same window, identified by their tab names. Snapshot instructions open from the round help button beside **Create snapshot**.

### Live-variable editor

The live-variable editor changes the variables of a running game. Modules with live-variable editing open it in a dedicated macOS window. Pausing the game allows editing, and closing the window resumes the game. The scope tabs respond to the arrow keys, Home and End, scroll horizontally and keep keyboard focus while an edit is applied.

### Cheats

The Cheats modal adjusts the cheat values that a module defines for its games, and it is available only when the module declares `supports.cheats`. Its fields come from the module's cheat schema (numbers and toggles). Besides them, it has an enable toggle and a reset to defaults. Changes save automatically and apply at once if the game is running. When the module exposes the setting, a per-game option hides the in-game Tools button, and modules that define cheat patches add cheat add-on actions.

## Error handling

Each part of the launcher reports its own errors:

- Modals and the inspector show errors inline, and a failed module action shows a badge in the inspector.
- Runtime manager errors appear in an inline banner.
- A native game failure received after Play returns appears in the launcher's error banner with the game and its exit reason. A game that stopped because its files became unavailable, such as on a removed drive, is reported with that reason instead of an exit code, without a runtime recovery offer. Normal exits and Stop show nothing.
- Save and cheat operations show error text in their modals.
- Displayed errors drop repeated `Error:` and Electron IPC prefixes and keep the reason, paths and diagnostic details. Stored errors and backend logs keep the original message.
