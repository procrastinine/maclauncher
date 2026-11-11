---
title: Patching games
description: "How to patch games on macOS with MacLauncher, step by step: Ren'Py Patch for the Mac runtime, the Ren'Py console and community add-ons, the PixiJS 5 library patch for RPG Maker MV, MV and MZ plugins, and the in-game Tools overlay on NW.js. What each one changes, and how to undo it."
head:
  - tag: title
    content: "Patch Ren'Py and RPG Maker games on Mac, and undo it | MacLauncher"
sidebar:
  order: 2.5
---

MacLauncher plays most games without touching their files: it runs them from where they are, and private copies, caches and settings live in its own storage. A few fixes and extras only work from inside the game folder, though, and for those MacLauncher has patches, plugins and add-ons. Each one can be removed again.

Most of them live in the game's inspector. Ren'Py's patch has its own group, RPG Maker's patches sit in the **Patches** section and its plugins under **Plugins**, and Ren'Py's add-ons are in the **Cheats** window. In the **Patches** section, each row shows its state:

- **Not patched**: the game's files are as they came.
- **Patched**: every file of the patch is in place.
- **Partial**: some of the patch's files are in place and others aren't.

Patches need the game's files, so while a game sits on a disconnected drive, its patch buttons stay off until the drive is back.

## Ren'Py Patch

[Ren'Py](https://www.renpy.org/) games normally run on the matching Ren'Py SDK, which MacLauncher installs in its own storage and points at the game. **Ren'Py Patch** is the other way to play them: it copies the macOS runtime files from the matching SDK into the game itself, so the game runs from its own folder the way a Mac build would.

1. Select the game, open the runtime menu in its inspector and choose **Ren'Py Patch**.
2. Press **Play**. If the game isn't patched yet, MacLauncher asks whether to patch it now.
3. Agree. MacLauncher downloads the SDK release that matches the game's Ren'Py version as a temporary download, separate from the SDKs installed in Runtimes, and copies its macOS runtime files into the game. The game then starts.

The inspector's **Ren'Py patch** group shows the game's Ren'Py version and patch status. Its **Patch** button does the same as step 3 without starting the game, and **Remove Ren'Py patch** takes the runtime files out again.

The patch needs the whole game folder, so it's unavailable when only the game's `game` folder was imported, and for games that are already Mac apps. Saves keep going where Ren'Py puts them, and the Ren'Py SDK runtime stays available for the same game if you switch back.

## RPG Maker MV: newer graphics libraries

[RPG Maker](https://www.rpgmakerweb.com/) MV games draw with the [PixiJS](https://pixijs.com/) graphics library they were built with. The **Libraries** row in the **Patches** section replaces it with the PixiJS 5 patch set from the [RPG Maker MV PixiJS 5 patches](https://github.com/kins-dev/rpgmaker-mv-pixi5), as packaged by [rpgmakermlinux-cicpoffs](https://github.com/bakustarver/rpgmakermlinux-cicpoffs). The set holds PixiJS 5.3.8 together with matching versions of RPG Maker MV's core scripts, which call into it.

1. Select an RPG Maker MV game and find **Libraries** under **Patches** in its inspector.
2. Press **Patch**. MacLauncher lists any warnings about the game's files and asks for confirmation.
3. Confirm. Each original file that the patch replaces is backed up next to itself with a `.maclauncher-old` suffix, and the new files are copied in.

To go back, press **Unpatch**. It restores every `.maclauncher-old` backup and removes the files that the patch added. The refresh button next to the status reads the game's files again, for example after you've edited the folder yourself.

## RPG Maker MV and MZ: the Tools overlay on NW.js

MV and MZ games get an in-game Tools overlay, with cheats, inventory, teleport, variable and switch pages, opened with Ctrl-Shift-T or Cmd-Shift-T. When a game runs on NW.js, the overlay is added to the game's own scripts by a patch, and the **Tools patch** row takes care of it.

1. Choose an NW.js runtime for the game, then find **Tools patch** under **Patches** in its inspector.
2. Press **Patch** and confirm. MacLauncher adds a small bootstrap plugin, `js/plugins/MacLauncher_Tools.js`, puts the overlay's files under `js/plugins/maclauncher/`, and adds the bootstrap to the game's `js/main.js`.
3. Start the game and press Ctrl-Shift-T or Cmd-Shift-T.

A `patch.json` file in `js/plugins/maclauncher/` records what the patch did, so patching twice changes nothing, and **Unpatch** puts `js/main.js` back and removes the added files. [Saves and cheats](/maclauncher/tools/saves-and-cheats/) describes what the overlay can do.

## RPG Maker MV and MZ: plugins

The inspector's **Plugins** group adds two community plugins to an MV or MZ game: **Install text hooker** adds Clipboard_llule, a text extractor that copies game text to the clipboard, and **Install 500 save slots** adds CustomizeMaxSaveFile.

1. Select the game and find **Plugins** in its inspector.
2. Press **Install text hooker** or **Install 500 save slots**. MacLauncher copies the plugin into `js/plugins/`, adds it to the game's plugin list in `js/plugins.js`, and notes in `js/plugins/maclauncher/` that it installed the file.
3. Start the game.

Unlike the patches above, these plugins go straight into the original game files. If the game already has a plugin file of the same name, MacLauncher keeps that file and only adds the list entry. **Uninstall text hooker** and **Uninstall 500 save slots** ask first, then take the entry out of `js/plugins.js` and delete only plugin files that MacLauncher installed.

## Ren'Py: the console and community add-ons

For Ren'Py games, the **Cheats** window, opened with **Cheats** in the inspector, holds three add-ons instead of cheat fields. Each row has a **Patch** button and a remove button, which turns on once the add-on's files are in the game.

- **Ren'Py console (Shift+O)** turns on Ren'Py's developer console by adding one script, `zz_maclauncher_console.rpy`, and leaves the game's own scripts untouched. Restart the game after patching, then press Shift+O in it.
- **Universal Ren'Py Walkthrough System** copies the add-on's five scripts, which come with MacLauncher, into the game's `game/__urw/` folder. It removes the scripts of the older version first, so its hooks don't run twice, and replaces the add-on's own updater with a notice.
- **Universal Ren'Py Mod (own file)** installs from a `0x52_URM.rpa` file that you've downloaded yourself. The first **Patch** opens a file dialog. MacLauncher checks the file and keeps a copy, so patching another game later needs no new selection and works offline. **Choose another Universal Ren'Py Mod file…** in the inspector replaces that copy.

Removing the console deletes MacLauncher's files, but third-party files in the way are left in place and reported. [Saves and cheats](/maclauncher/tools/saves-and-cheats/#renpy) describes what the console can do.

## Changes that leave the game's files alone

Several other features change how a game runs without editing its folder:

- **NW.js (Patched).** This runtime, which RPG Maker MV and MZ prefer once NW.js is installed, applies MacLauncher's compatibility fixes while the game loads: assets whose names differ only in case, your own `*.maclauncher.js` scripts from the game folder, and Greenworks for games that contain it. MV and MZ can also turn on the Kawariki remap, fixes and variables inspector, and loaders for decrypted assets, all off by default.
- **32-bit Mac apps.** **Game compatibility patches** in Runtime Settings lets mac32 apply its fixes for particular game builds in memory. It's off by default, and the app's files on disk stay as they are.
- **Upscaling adapters.** DLSS to MetalFX, the FSR and XeSS adapters and similar features replace DLLs only in a separate launch folder, as [How the adapters treat your game files](/maclauncher/windows/effects-and-upscaling/#how-the-adapters-treat-your-game-files) explains.
- **Graphics translators.** Outside MacLauncher, newer translators get into CrossOver by patching a copy of the app with tools such as CXPatcher. MacLauncher keeps translator versions outside CrossOver, Sikarugir and WineCX instead, and each game picks its own; [Translator versions](/maclauncher/windows/translator-versions/) compares the two approaches.
- **Live2D and save folders.** Live2D for a single Ren'Py game is installed in MacLauncher's storage rather than in the game, and a different MV or MZ save folder is set up from MacLauncher's own wrapper page when the game starts, without rewriting the game's scripts.

Guides: [Cheats](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/CHEATS.md#nwjs-patching), [Ren'Py cheat add-ons](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/CHEATS.md#renpy-cheat-add-ons), [NW.js (Patched)](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WEB_RUNTIMES.md#nwjs-patched), [Ren'Py](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RENPY.md#renpy-patch), [RPG Maker MV and MZ](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_MV_MZ.md)
