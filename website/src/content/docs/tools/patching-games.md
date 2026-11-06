---
title: Patching games
description: "How to patch games on macOS with MacLauncher, step by step: Ren'Py Patch for the Mac runtime, the PixiJS 5 library patch for RPG Maker MV, and the in-game Tools overlay for RPG Maker MV and MZ on NW.js. What each patch changes, and how to undo it."
head:
  - tag: title
    content: "Patch Ren'Py and RPG Maker games on Mac, and undo it | MacLauncher"
sidebar:
  order: 2.5
---

MacLauncher plays most games without touching their files: it runs them from where they are, and private copies, caches and settings live in its own storage. A few fixes and extras only work from inside the game folder, though, and for those MacLauncher has **patches**. Each one asks before it changes anything and can be undone.

All of them live in the game's inspector. Ren'Py's patch has its own group, and RPG Maker's patches sit in the **Patches** section, where each row shows its state:

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

## Related features

A few other features change how a game runs while editing its folder less, or not at all:

- **Graphics translators.** Outside MacLauncher, newer translators get into CrossOver by patching a copy of the app with tools such as CXPatcher. MacLauncher keeps translator versions outside CrossOver and Sikarugir instead, and each game picks its own; [Translator versions](/maclauncher/windows/translator-versions/) compares the two approaches.
- **Ren'Py extras.** The Ren'Py developer console adds a single script file, `zz_maclauncher_console.rpy`, to the game and leaves the existing scripts untouched, and removing it deletes MacLauncher's files again. Live2D for a single game is installed in MacLauncher's storage rather than in the game.
- **RPG Maker MV and MZ save folders.** A different save folder is set up from MacLauncher's own wrapper page when the game starts, without rewriting the game's scripts.

Guides: [Cheats](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/CHEATS.md#nwjs-patching), [Ren'Py](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RENPY.md#renpy-patch), [RPG Maker MV and MZ](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_MV_MZ.md)
