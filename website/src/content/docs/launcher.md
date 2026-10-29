---
title: The launcher
description: The library, its search, filters and sorting, selecting several games, and every part of a game's inspector.
---

MacLauncher has one main window, the **library**, with a list of your games on the left and the **inspector** for the selected game on the right. Settings, Runtimes, External and Credits each open in their own window.

## The library

### Adding games

**Add game** opens a file picker for game folders and launchable files such as `.app`, `.exe`, `.jar`, `.swf` and `.love`. Dragging folders and files onto the window works too, including Android `.apk` packages and iOS `.ipa` archives. MacLauncher looks at each one, works out its engine and runtime, and adds it to the library.

Drag in several games at once and they import as one batch, with **Adding N of M** and a progress bar. One failure doesn't stop the rest: the summary lists each item that didn't import, why, and a **Choose game file…** or **Retry** button to sort it out.

The same drop target accepts shaders (`.fx`, `.glsl`, `.hook`, `.slang`, `.slangp`) and neural models (`.dlssmodel`). Those go to the [shader library](/maclauncher/graphics/shaders/#the-shader-library) instead of the game list.

### Search, filters and sorting

The toolbar above the list narrows it down without changing anything:

- **Search** (Cmd+F) matches titles and paths as you type.
- **Game types** shows or hides whole kinds of game, such as [RPG Maker](https://www.rpgmakerweb.com/) MV, [Ren'Py](https://www.renpy.org/) or Nintendo Switch.
- **Show games** picks All games, Favorites or Running.
- **Sort** orders the list by Default, Last played, Date added, Alphabetical or Game type, with a button to reverse the direction.

Your sort and favorites are remembered between launches, and neither searching nor filtering changes the order you've arranged by hand.

### Favorites and order

The star beside a game makes it a favorite. In the **Default** sort, favorites sit together at the top, and you can drag games into any order with the handle, or move the selected game with Option–Up and Option–Down. New games arrive at the top of the list; playing a game doesn't move it.

### Selecting several games

**Select** turns the list into checkboxes. Shift-click selects a range, and Cmd+A selects everything visible. With a selection you can:

- **Forget selected**: remove the games from the library and delete MacLauncher's own data for them. The game files stay where they are.
- **Move to Trash**: move the games' files to the Trash as well.
- **Select all missing**: check the visible games on disk and select the ones whose files are gone, ready to forget. **Detect all missing** marks them without selecting.

Both removals ask once in a macOS dialog first.

### Each row

Every row shows the game's name, type, last-played time and path. A **runtime** tag appears when the game uses something other than its type's usual runtime, and **Modified** when its runtime settings differ from the defaults. **Play**/**Stop**, **Shortcut** and **Forget** work straight from the row, without opening the inspector.

## The inspector

Click a game to open its inspector. Its sections always come in the same order, and a section only appears when the game has something to show in it.

### Files

- **Game path**, with a folder button that shows the game in Finder.
- **What to start**, for games with more than one entry point, such as a playlist's first video.
- **Save location**, with **Change** to point the game at another save folder and **Reset** to go back to the default. Saves kept inside MacLauncher's own storage read **Managed by MacLauncher**.
- **Remove quarantine** for imported Mac apps that macOS refuses to open because they were downloaded.
- **Details**: the detected format, where the version came from, how confident the detection is, and the full detection trace.

### Launch

The runtime, its version and settings, launch arguments, network access and, for [Steam](https://store.steampowered.com/) games, whether to start the Steam client. Each is described under [Per-game choices](/maclauncher/tools/versions-and-settings/#per-game-choices).

**Play** prepares and starts the game. While it prepares, **Cancel** stops the launch, and **Stop** is available as soon as the game's process starts. If the selected runtime can only inspect a game, the inspector explains why in place of Play and keeps the inspection tools.

### Patches

Some game types can be patched in place, always reversibly: RPG Maker MV games can swap in an updated graphics library, and games with cheats can have their tools injected. Each patch shows its status (Not patched, Patched or Partial) with **Patch** and **Unpatch** buttons, and asks before changing anything.

### Tools

The game type's own tools: extractors, decompilers, plugin installers, app builders, video export and so on. Each group's main action comes first, and results appear right below it. See [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/) and [Saves and cheats](/maclauncher/tools/saves-and-cheats/).

### Graphics

The game's effect chain. The heading summarizes the active effects while the section is closed. See [Graphics and effects](/maclauncher/graphics/).

### Notes

Plain text of your own, kept with the game in the library. **Save notes** or Cmd-S saves them, and so does clicking elsewhere. Notes go away when the game is forgotten.

## Windows and menus

- **Settings** (Cmd+,) holds preferences: appearance, defaults and each game type's runtime settings. See [Settings](/maclauncher/tools/versions-and-settings/#settings).
- **Runtimes** installs and manages versions of every runtime, tool and graphics component. See [Runtimes](/maclauncher/tools/versions-and-settings/#runtimes-one-place-for-every-version).
- **External** finds games installed from stores and downloads ones you own. See [Stores and downloads](/maclauncher/tools/stores-and-downloads/).
- **Credits** lists every project MacLauncher builds on, with links. See [Credits](/maclauncher/about/credits/).

Each opens once; asking again brings the existing window forward. Closing the library leaves the other windows open, and the Dock icon or **View → Library** brings it back. **Help → Show Log in Finder** reveals MacLauncher's log for troubleshooting.

The [UI guide](https://github.com/procrastinine/maclauncher/blob/master/docs/UI_GUIDE.md) describes every control in full.
