---
title: Saves and cheats
description: Find saves, snapshot and restore them, edit RPG Maker saves, and use the built-in cheats for RPG Maker and Ren'Py games.
sidebar:
  order: 2
---

## Save tools

Games hide their saves in all sorts of places: next to the executable, in `~/Library`, inside a [WINE](https://www.winehq.org/) bottle, in a browser profile. **Saves** (**Edit saves** for game types that support save editing) in the game's inspector shows you where this game's saves actually live, and gives you a few ways to look after them.

### Snapshots

Before you try something risky (a save edit, a mod, a cheat, a new runtime version), take a **snapshot**. It's an exact copy of the save files, kept in MacLauncher's storage. Restoring shows you a preview first, then puts back exactly the files that were recorded and leaves any newer saves alone.

You won't need to remember, either: MacLauncher automatically takes a snapshot before any import, edit or restore it performs on your saves. If a save editor ever goes wrong, you can roll back.

### Moving saves around

**Files** lets you import and export save files, and edit them as JSON for engines where MacLauncher understands the format. You can also point a game at a different save folder, for instance to share saves with another copy of the game.

### Editing RPG Maker MV/MZ saves

[RPG Maker](https://www.rpgmakerweb.com/) MV and MZ saves get a proper editor. **Edit values** shows switches, variables, gold, inventory, and each party member's HP, MP, TP and level, with names taken from the game's own database where it has them. Nothing from the game runs while you edit, and the original encoding is preserved.

For other engines, the right tool depends on the format. RPG Maker XP/VX/VX Ace saves can be inspected as a data graph, and [Ren'Py](https://www.renpy.org/) saves through their metadata (to change Ren'Py game state, the console below is the way). WINE games keep their saves in a private copy of the game folder or their Windows profile, and Save tools shows you both.

Guides: [Save snapshots](https://github.com/procrastinine/maclauncher/blob/master/docs/SAVE_SNAPSHOTS.md), [MV/MZ save editor](https://github.com/procrastinine/maclauncher/blob/master/docs/MVMZ_SAVE_EDITOR.md)

## Cheats

Some engines make a universal cheat possible, because every game built with them shares the same internals. MacLauncher takes advantage of that.

### RPG Maker

For RPG Maker MV and MZ games, the **Cheats** panel has a long list of switches you can flip while you play:

- **Movement and speed:** game speed, move speed, always dash, no clip, no random encounters, fast events.
- **Battle:** god mode, one-hit kills, always hit, always crit, immunity to status effects, always escape, damage and EXP multipliers.
- **Items and shops:** infinite items, no skill costs, every item in shops, free shopping.
- **Story:** instant text, message skipping on a held key, no game over.

RPG Maker XP, VX and VX Ace games share the same launcher panel, and add an in-game cheat menu on **F8** with extras like item grants, teleport slots, party and enemy tools, and stat, level and gold edits. Changes made in either place stay in sync.

### Ren'Py

Ren'Py games can get an opt-in **developer console** (open it with Shift+O in game). With it you can read and change the game's variables, for example to set your money, then save to a new slot. MacLauncher installs it as a separate script file and leaves the game's own scripts untouched; removing it puts everything back. There are also integrations for two community add-ons: the [Universal Ren'Py Mod](https://0x52.dev/mods/Universal-Ren-Py-Mod-1000) and the [Universal Ren'Py Walkthrough System](https://github.com/BCassO/universal-renpy-walkthrough).

Guides: [Cheats](https://github.com/procrastinine/maclauncher/blob/master/docs/cheats.md), [Ren'Py tools](https://github.com/procrastinine/maclauncher/blob/master/docs/RENPY_TOOLS.md)
