---
title: Saves and cheats
description: "Find game saves on macOS, snapshot and restore them, edit RPG Maker saves, and use the built-in cheats for RPG Maker and Ren'Py games."
head:
  - tag: title
    content: "Game saves, save editing and cheats on Mac | MacLauncher"
sidebar:
  order: 2
---

MacLauncher finds the saves of games on your Mac, keeps snapshots of them and moves them between locations, edits RPG Maker MV and MZ saves, and has built-in cheats for RPG Maker and Ren'Py games.

## Save tools

Games keep their saves in all sorts of places: next to the executable, in `~/Library`, inside a [WINE](https://www.winehq.org/) bottle or in a browser profile. Every game type that knows where its games save has save tools. **Saves** in the game's inspector (**Edit saves** for game types that support save editing) shows where this game's saves actually live and gives you a few ways to look after them.

### Snapshots

Before you try something risky, such as a save edit, a mod, a cheat or a new runtime version, take a snapshot with **Create snapshot**. A snapshot is an exact copy of the save files, kept in MacLauncher's storage. Restoring shows you a preview first, then puts back exactly the files that were recorded and leaves any newer saves alone.

MacLauncher also takes a snapshot automatically before any import, edit or restore it performs on your saves, so a save edit that goes wrong can be rolled back.

### Moving saves around

In the same view, the **Save files** tab lets you import and export save files, and edit them as JSON for game types whose save format MacLauncher can read. You can also point a game at a different save folder, for instance to share saves with another copy of the game.

### Editing RPG Maker MV/MZ saves

[RPG Maker](https://www.rpgmakerweb.com/) MV and MZ saves get a full editor. **Edit values** shows switches, variables, gold, inventory, and each party member's HP, MP, TP and level, with names taken from the game's own database where it has them. Nothing from the game runs while you edit, and the original encoding is preserved.

For other game types, the right tool depends on the format. RPG Maker XP, VX and VX Ace saves can be inspected as a data graph, and [Ren'Py](https://www.renpy.org/) saves through their metadata; to change a Ren'Py game's state, use the [console](#renpy) instead. Sikarugir keeps the original working directory. Saves can live in the original game folder or the game's Windows profile, and the save tools show both. An app-adjacent DLL adapter can also leave executable-relative files in its retained [adapter view](/maclauncher/games/windows/#original-game-files-and-separate-windows-environments).

Guides: [Save snapshots](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/SAVE_SNAPSHOTS.md), [RPG Maker MV and MZ save editor](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_MV_MZ.md#structured-save-editing)

## Cheats

RPG Maker MV, MZ and XP/VX/VX Ace games and Ren'Py games have built-in cheats. Every game built with one of these engines shares the same internals, so one set of cheats works for all of them. **Cheats** in the inspector opens them.

### RPG Maker

For RPG Maker MV and MZ games, the **Cheats** window has a long list of switches you can flip while you play:

| Category | Cheats |
| --- | --- |
| Movement and speed | Game speed, move speed, always dash, no clip, no random encounters, fast events |
| Battle | God mode, one-hit kills, always hit, always crit, immunity to status effects, always escape, damage and EXP multipliers |
| Items and shops | Infinite items, no skill costs, every item in shops, free shopping |
| Story | Instant text, message skipping on a held key, no game over |

MV and MZ games also get an in-game Tools overlay, opened with Ctrl-Shift-T or Cmd-Shift-T, with the same cheats plus searchable inventory, teleport, variable and switch pages. With NW.js, the overlay is added by a patch from the inspector's **Patches** section.

RPG Maker XP, VX and VX Ace games use the same Cheats window, and add an in-game cheat menu on **F8** with extras such as item grants, teleport slots, party and enemy tools, and stat, level and gold edits. Changes made in either place stay in sync.

### Ren'Py

Ren'Py games can get an opt-in developer console, which you open with Shift+O in the game. With it you can read and change the game's variables, for example to set your money, and then save to a new slot. MacLauncher installs the console as a separate script file and leaves the game's own scripts untouched, and removing it puts everything back. The Cheats window can also install two community add-ons: the [Universal Ren'Py Mod](https://0x52.dev/mods/Universal-Ren-Py-Mod-1000) and the [Universal Ren'Py Walkthrough System](https://github.com/BCassO/universal-renpy-walkthrough).

Guides: [Cheats](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/CHEATS.md), [Ren'Py console](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RENPY.md#renpy-console)
