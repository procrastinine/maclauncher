---
title: Tinker tools
description: "How MacLauncher's tools work on macOS, and an overview of its store downloads, save tools, cheats, decompilers and version management."
head:
  - tag: title
    content: "Game tools on Mac: store downloads, saves, cheats and decompilers | MacLauncher"
sidebar:
  order: 0
  label: Overview
---

Besides importing and playing games, MacLauncher has tools for working with the games on your Mac: store downloads, save tools, cheats, decompilers and version management.

## How the tools work

- Generated files, caches, private copies and exports live in MacLauncher's own storage, apart from the game's files, and **Forget** cleans them up.
- Runtimes expose their settings, you can pass any launch flags you like, and every game can override the defaults and turn its own network access on or off.
- Runtimes, tools, store downloads and accounts can all be managed by version, and a default applies when you don't choose one.

A game's decompilers and extractors belong to its [game type](/maclauncher/background/choosing-a-runtime/#game-types-and-runtimes), so they stay available whichever runtime plays it, including Sikarugir or CrossOver.

## The tools

### [Stores and downloads](/maclauncher/tools/stores-and-downloads/)

Find the games already installed from [Steam](https://store.steampowered.com/), [Epic](https://store.epicgames.com/), [GOG](https://www.gog.com/) and [itch.io](https://itch.io/), and download the games you own straight from those stores, for any platform and in any version you can get. That includes the Windows build of a Steam game on a Mac, or an older build by its manifest ID. Android apps come from [Google Play](https://play.google.com/store/games), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/).

### [Saves and cheats](/maclauncher/tools/saves-and-cheats/)

Find where a game keeps its saves, take snapshots before you experiment, restore them, and edit [RPG Maker](https://www.rpgmakerweb.com/) MV and MZ saves field by field. Cheats are built in for RPG Maker and [Ren'Py](https://www.renpy.org/) games.

### [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/)

Unpack archives, decrypt assets, and decompile scripts and code for most game types, from Ren'Py and RPG Maker to [Unity](https://unity.com/), [GameMaker](https://gamemaker.io/), Java, Flash and Android. The tools download on demand.

### [Versions and settings](/maclauncher/tools/versions-and-settings/)

Install and switch between runtime versions, set defaults and per-game overrides, add launch arguments, save `.command` launchers, and run games from the command line.
