---
title: Patch and tinker tools
description: "MacLauncher as a patch/tinker tool for Mac games, and the three principles behind it: a version choice for every runtime, translator, Vulkan driver and store download; games and apps left unchanged except through patches you can undo; and as much control as possible, from decompilers and cheats to launch flags, environment variables and network access."
head:
  - tag: title
    content: "Patch and tinker tools for Mac games: versions, translators, stores, saves and decompilers | MacLauncher"
sidebar:
  order: 0
  label: Overview
---

Playing a game is only part of what MacLauncher does. It's also a patch/tinker tool: it lets you choose the version of everything it runs, swap graphics translators into CrossOver, Sikarugir and WineCX, download exactly the edition of a game you want from your stores, and open games up with save editors, cheats and decompilers. Its features in this area follow three principles, which this page explains with examples before listing the tools.

## Three principles

### Version management

Whatever has versions, you can choose the version of. That covers every runtime, every graphics translator and Vulkan driver, and even the version and platform of the games you download from a store. Each choice comes from a catalog or from files you already have, and MacLauncher picks a sensible default that you can always override.

Version matching matters more than you might think. A [Godot](https://godotengine.org/) game made with Godot 4.5 often won't run on 4.6, for example, so MacLauncher reads the version a game was made with, installs that one, and keeps it next to the other Godot versions your other games use. In the same way, a Windows game in CrossOver can try a newer [DXVK](https://github.com/doitsujin/dxvk) while the rest of your games keep theirs, and a Steam game can be downloaded as its Windows build, its Linux build or an older release instead of whatever the Steam client offers on a Mac.

- [Versions and settings](/maclauncher/tools/versions-and-settings/): installing, keeping and choosing runtime versions, and using your own copies.
- [Runtime patching](/maclauncher/tools/runtime-patching/), [Graphics translators](/maclauncher/windows/graphics-translators/), [Translator versions](/maclauncher/windows/translator-versions/) and [KosmicKrisp](/maclauncher/windows/kosmickrisp/): a translator and Vulkan driver for each Windows game.
- [Stores and downloads](/maclauncher/tools/stores-and-downloads/): any platform or older version of the games you own.

### Unchanged source

As far as possible, MacLauncher doesn't change what it runs. Your games are played from where they are, and what MacLauncher generates for them, such as converted files, caches and private Windows environments, goes into its own storage. While a game runs, its engine keeps its usual save and settings locations, so you can play a game in MacLauncher, then play it some other way, and pick up where you left off.

A few game types do need files in the game folder for a patch, a cheat or a mod, such as the in-game Tools overlay for RPG Maker or Ren'Py's cheat add-ons. Those are managed patches: MacLauncher tracks every file it adds, shows whether a patch is in place and removes it again with one click, as [Patching games](/maclauncher/tools/patching-games/) shows.

The same principle applies to the apps MacLauncher builds on. It gives each game its own graphics translators without modifying CrossOver, Sikarugir or WineCX, which tools like [CXPatcher](https://github.com/italomandara/CXPatcher) do by patching a copy of CrossOver, and it connects Windows games to the Steam app for Mac without patching Steam, which [NotProton](https://github.com/NotProtonNot/NotProton) does to make the same connection. You don't need patched copies of either app, and their updates usually don't break anything. [Runtime patching](/maclauncher/tools/runtime-patching/) and the [Steam client bridge](/maclauncher/windows/steam-client-bridge/) explain how.

### As much power to the user as possible

Wherever it's possible, MacLauncher includes everything it can and leaves the decisions to you:

- Every decompiler, extractor, save tool and cheat tool available for each game type, from Ren'Py and RPG Maker to Unity, GameMaker, Java and Android, described in [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/) and [Saves and cheats](/maclauncher/tools/saves-and-cheats/).
- Every setting a runtime offers, plus your own launch flags, in each game's runtime settings, as [Versions and settings](/maclauncher/tools/versions-and-settings/#per-game-choices) describes.
- Environment variables for every translator and runtime that reads them, with defaults in **Settings → Environment variables** and values of its own for each game, from DXVK's HUD to KosmicKrisp's `KK_EMULATION`.
- Your own files, no network request without an action of yours and no telemetry, as [Network and privacy](/maclauncher/tools/network-and-privacy/) explains.

## The tools

- [Runtime patching](/maclauncher/tools/runtime-patching/) explains why a newer graphics translator or Vulkan driver can help a Windows game and walks through choosing one for a game, with its options and environment variables.
- [Graphics translators](/maclauncher/windows/graphics-translators/), [Translator versions](/maclauncher/windows/translator-versions/) and [KosmicKrisp](/maclauncher/windows/kosmickrisp/) go into DXMT, D3DMetal, DXVK, vkd3d-proton, MoltenVK and KosmicKrisp in depth.
- [Stores and downloads](/maclauncher/tools/stores-and-downloads/) imports the games you've installed from [Steam](https://store.steampowered.com/), [Epic](https://store.epicgames.com/), [GOG](https://www.gog.com/) and [itch.io](https://itch.io/), and downloads the games you own for any platform and in any version you can get, including Android apps from [Google Play](https://play.google.com/store/games), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/).
- The [Steam client bridge](/maclauncher/windows/steam-client-bridge/) lets Windows games in CrossOver, Sikarugir or WineCX use the Steam app for Mac.
- [Versions and settings](/maclauncher/tools/versions-and-settings/) covers the Runtimes and Settings windows, per-game choices, launch arguments, environment variables, network access, shortcuts and the command line.
- [Patching games](/maclauncher/tools/patching-games/) covers Ren'Py Patch, RPG Maker's library patch and plugins, and the in-game Tools overlay, with how to undo each one.
- [Saves and cheats](/maclauncher/tools/saves-and-cheats/) finds a game's saves, takes snapshots, edits [RPG Maker](https://www.rpgmakerweb.com/) MV and MZ saves, and opens the cheats built in for RPG Maker and [Ren'Py](https://www.renpy.org/).
- [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/) unpacks archives, decrypts assets and decompiles scripts and code for most game types.
- [Network and privacy](/maclauncher/tools/network-and-privacy/) explains when MacLauncher goes online, how each game's network access works, and where logs go.

A game's decompilers and extractors belong to its [game type](/maclauncher/background/choosing-a-runtime/#game-types-and-runtimes), so they stay available whichever runtime plays it, the WINE runtimes included. Their output, along with exports, private copies and caches, goes into MacLauncher's storage, apart from the game's files, and **Forget** cleans it up.
