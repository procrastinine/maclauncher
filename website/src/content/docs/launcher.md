---
title: The launcher
description: "MacLauncher's game library on the Mac: search, filters and sorting, selecting several games, and every part of a game's inspector."
head:
  - tag: title
    content: "The launcher: game library, search and inspector | MacLauncher"
---

MacLauncher is a Mac app with one main window, the **library**, which holds a list of your games on the left and the **inspector** for the selected game on the right. Settings, Runtimes, External and Credits each open in their own window.

## The library

The library opens straight away with the details MacLauncher saved last time, and each game is checked again in the background. A game whose files haven't changed reuses what MacLauncher already knows about it, and a slow game doesn't hold up the list or other imports. Selecting a game moves its checks to the front of the queue, and its last known details stay on screen until the new result arrives. [Library loading](https://github.com/procrastinine/maclauncher/blob/master/docs/library/GAME_PREPARATION.md#library-loading) describes how those updates work.

### Adding games

**Add game…** opens a file picker for game folders and launchable files such as `.app`, `.exe`, `.jar`, `.swf` and `.love`. You can also drag folders and files onto the window, including Android `.apk` packages and iOS `.ipa` archives. MacLauncher detects what kind of game each one is and adds it to the library.

Several games dragged in at once import as one batch, with **Adding N of M** and a progress bar. A failed item doesn't stop the rest. Instead, a summary lists each item that didn't import, with the reason, a **Choose game file…** button and **Retry**.

The window also accepts dropped shaders (`.fx`, `.glsl`, `.hook`, `.slang`, `.slangp`) and neural models (`.dlssmodel`). These go into the [shader library](/maclauncher/graphics/shaders/#the-shader-library) and the [model library](/maclauncher/graphics/neural-restoration/#getting-models) instead of the game list.

### Search, filters and sorting

A toolbar above the list filters and sorts it:

- **Search** (Cmd+F) matches titles and paths as you type.
- **Game types** shows or hides whole kinds of game, such as [RPG Maker](https://www.rpgmakerweb.com/) MV, [Ren'Py](https://www.renpy.org/) or Nintendo Switch. A game is listed under its game type whichever runtime plays it, so Prosper games, for example, appear under PlayStation 5.
- **Show games** picks All games, Favorites or Running.
- **Sort** orders the list by Default, Last played, Date added, Alphabetical or Game type, with a button to reverse the direction.

Your sort and favorites are remembered between launches. Searching and filtering never change the order you've arranged by hand.

### Favorites and order

A star beside each game marks it as a favorite. In the **Default** sort, favorites sit together at the top, and you can drag games into any order with the handle or move the selected game with Option-Up and Option-Down. New games arrive at the top of the list, just below the favorites, and playing a game doesn't move it.

### Selecting several games

To act on several games at once, click **Select**, which turns the list into checkboxes. Shift-click selects a range, and Cmd+A selects every visible game. A selection offers these actions:

- **Forget selected** removes the games from the library and deletes MacLauncher's own data for them. The game files stay where they are.
- **Move to Trash…** also moves the games' files to the Trash.
- **Select all missing** checks the visible games on disk and selects the ones whose files are gone, ready to forget. **Detect all missing** marks them without selecting them. Games on an unplugged drive count as missing too, so connect your drives first if you only want to clear out games you've deleted.

Both removals ask for confirmation once, in a macOS dialog.

### Each row

Every row shows the game's name, game type, last-played time and path. A **runtime** tag appears when the game uses a runtime other than its game type's default, and **Modified** appears when that runtime's settings differ from the defaults. A save label also shows whether the game uses a custom save folder. **Play**/**Stop**, **Shortcut** and **Forget** work directly from the row, without opening the inspector. When a game's files can't be found, its row says **Unavailable** and its icon is dimmed; hover over the label to see why.

To find the icon of a Windows game in a folder, MacLauncher skips installers and crash reporters and tries the game before configuration tools or launchers. A packaged game whose file name looks like an installer's can still supply its own artwork, however.

### Games on an external drive

Games are big, so many people keep them on an external drive that isn't always plugged in. When a game's files aren't on disk, because the drive is disconnected or the folder has moved, MacLauncher leaves the game exactly as it was. It stays in the library with its saves, settings, runtime versions, snapshots and effects. Nothing is detected again, rebuilt or deleted, and MacLauncher doesn't go looking through the missing folder. An icon kept in the game's folder appears only once MacLauncher has checked that the files are available.

While a game is unavailable, **Play** explains why it can't start, and patches and tools that need the game's files are switched off. Favorites, notes, launch arguments, runtime choices and settings, network access, effects and **Forget** still work. Saves that MacLauncher keeps in its own storage stay usable, while saves stored inside the game folder wait for the drive.

When the drive comes back at the same location, the game is ready again, with no restart or new import. MacLauncher notices the next time you switch to its window, press **Play** or use **Detect all missing**, and then refreshes the game's details as it does at startup. If the drive disappears while a game is running and the game stops, MacLauncher keeps running and tells you the game's files became unavailable.

If a game has moved for good, to another folder or another drive, press **Locate…** beside the **Files unavailable** notice in the game's inspector and choose the new location. MacLauncher checks that the game there is the same kind of game, then points the library entry at it. The game keeps its saves, snapshots, settings, notes, favorite, runtime choices and effects, and shortcuts you saved for it keep opening it. A location without a game of the same kind, or one that another library entry already uses, is refused with the reason, and the entry stays as it was. [Unavailable game files](https://github.com/procrastinine/maclauncher/blob/master/docs/library/GAME_PREPARATION.md#unavailable-game-files) has the full rules, including [what Locate… updates](https://github.com/procrastinine/maclauncher/blob/master/docs/library/GAME_PREPARATION.md#locating-moved-files).

## The inspector

Click a game to open its inspector, and click it again to close it. The inspector's sections always come in the same order, and a section appears only when the game has something to show in it.

### Files

- **Game** shows where the game is, with a folder button that reveals it in Finder.
- Some game types add a launch choice here. Videos, for example, have **Video**, which picks the playlist entry that plays first.
- **Saves** shows the save folder, with **Change** to point the game at another folder and **Reset** to go back to the default. Saves kept inside MacLauncher's own storage read **Managed by MacLauncher**.
- **Remove quarantine** appears for imported Mac apps that macOS refuses to open because they were downloaded.
- **Detection** holds the detected format, where the version came from, how confident the detection is, and the full detection trace.

### Launch

This section holds the runtime, its version and settings, launch arguments, network access and, for [Steam](https://store.steampowered.com/) games, whether to start the Steam client. [Per-game choices](/maclauncher/tools/versions-and-settings/#per-game-choices) describes each one.

**Play** prepares and starts the game. While it prepares, **Cancel** stops the launch, and **Stop** is available as soon as the game's process starts. If the selected runtime can only inspect a game, the inspector explains why in place of Play and keeps the inspection tools.

### Patches

Some game types support reversible patches to the game's files. For example, RPG Maker MV games can swap in an updated graphics library, and games with in-game cheat tools can have those tools injected. Each patch shows its status (Not patched, Patched or Partial) with **Patch** and **Unpatch** buttons, and asks before changing anything.

### Tools

This section holds the game type's own tools, such as extractors, decompilers, plugin installers, app builders and video export. Each group shows its main action first, with related actions under **More…**, and results appear right below. See [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/) and [Saves and cheats](/maclauncher/tools/saves-and-cheats/).

### Graphics

This section holds the game's effect chain. While the section is closed, its heading summarizes the active effects. See [Graphics and effects](/maclauncher/graphics/).

### Notes

Notes are plain text of your own, kept with the game in the library. They're saved with **Save notes**, with Cmd-S or by clicking elsewhere, and they're deleted when the game is forgotten.

## Windows and menus

- **Settings** (Cmd+,) holds preferences: appearance, defaults and each game type's runtime settings. See [Settings](/maclauncher/tools/versions-and-settings/#settings).
- **Runtimes** installs and manages versions of every runtime, tool and graphics component. See [Runtimes](/maclauncher/tools/versions-and-settings/#the-runtimes-window).
- **External** finds games installed from stores and downloads ones you own. See [Stores and downloads](/maclauncher/tools/stores-and-downloads/).
- **Credits** lists every project MacLauncher builds on, with links. See [Credits](/maclauncher/about/credits/).

Each window opens once, and opening it again brings the existing window forward. Closing the library leaves the other windows open, and the Dock icon or **View → Library** brings it back. **Help → Show Log in Finder** reveals MacLauncher's log for troubleshooting.

MacLauncher's [UI guide](https://github.com/procrastinine/maclauncher/blob/master/docs/development/UI_GUIDE.md) describes every control in full, including the [library](https://github.com/procrastinine/maclauncher/blob/master/docs/development/UI_GUIDE.md#library) and the [inspector](https://github.com/procrastinine/maclauncher/blob/master/docs/development/UI_GUIDE.md#inspector).
