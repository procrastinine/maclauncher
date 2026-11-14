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

Playing a game is only part of what MacLauncher does. It's also a patch/tinker tool, which means it lets you choose the version of everything it runs, download exactly the edition of a game you want from your stores, and open games up with save editors, cheats and decompilers. Windows games get extra attention. They run on the Mac through [WINE](https://www.winehq.org/), the compatibility layer that lets Windows programs run on macOS, packaged as one of three distributions: [CrossOver](https://www.codeweavers.com/crossover/), CodeWeavers' paid app; [Sikarugir](https://github.com/Sikarugir-App/Sikarugir), a free distribution; or [WineCX](https://github.com/dappermint/winecx-gptk), a free distribution built from CrossOver's WINE changes. MacLauncher can swap a different graphics translator, the piece that turns a Windows game's Direct3D drawing calls into Metal or Vulkan, into any of the three. All of these features follow three principles, which this page explains with examples before listing the tools.

## Three principles

### Version management

Whatever has versions, you can choose the version of. That covers every runtime (the engine, player or emulator that runs a game), every graphics translator and Vulkan driver (the library that runs Vulkan graphics on Metal), and even the version and platform of the games you download from a store. Each choice comes from a catalog or from files you already have, and MacLauncher picks a sensible default that you can always override.

Version matching matters more than you might think. A [Godot](https://godotengine.org/) game made with Godot 4.5 often won't run on 4.6, for example, so MacLauncher reads the version a game was made with, installs that one, and keeps it next to the other Godot versions your other games use. In the same way, a Windows game in CrossOver can try a newer [DXVK](https://github.com/doitsujin/dxvk), a widely used DirectX translator, while the rest of your games keep theirs. A Steam game can be downloaded as its Windows build, its Linux build or an older release instead of whatever the Steam client offers on a Mac.

- [Versions and settings](/maclauncher/tools/versions-and-settings/): installing, keeping and choosing runtime versions, and using your own copies.
- [Runtime patching](/maclauncher/tools/runtime-patching/), [Graphics translators](/maclauncher/windows/graphics-translators/), [Translator versions](/maclauncher/windows/translator-versions/) and [KosmicKrisp](/maclauncher/windows/kosmickrisp/): a translator and Vulkan driver for each Windows game.
- [Stores and downloads](/maclauncher/tools/stores-and-downloads/): any platform or older version of the games you own.

### Unchanged source

As far as possible, MacLauncher doesn't change what it runs. Your games are played from where they are, and anything MacLauncher generates for them, such as converted files, caches and private Windows environments, goes into its own storage. While a game runs, its engine keeps its usual save and settings locations, so you can play a game in MacLauncher, play it some other way, and pick up where you left off.

A few game types do need files in the game folder for a patch, a cheat or a mod, such as the in-game Tools overlay for RPG Maker or Ren'Py's cheat add-ons. MacLauncher keeps track of every file such a patch adds, shows whether the patch is in place and removes it again with one click, as [Patching games](/maclauncher/tools/patching-games/) shows.

The same principle applies to the apps MacLauncher builds on. Tools like [CXPatcher](https://github.com/italomandara/CXPatcher) give games newer graphics translators by patching a copy of CrossOver, and [NotProton](https://github.com/NotProtonNot/NotProton) connects Windows games to the Steam app for Mac by patching Steam. MacLauncher does both jobs without modifying CrossOver, Sikarugir, WineCX or Steam, so you don't need patched copies of any of them, and their updates usually don't break anything. [Runtime patching](/maclauncher/tools/runtime-patching/) and the [Steam client bridge](/maclauncher/windows/steam-client-bridge/) explain how.

### As much power to the user as possible

Wherever it can, MacLauncher includes every tool and option available and leaves the decisions to you:

- Every decompiler, extractor, save tool and cheat tool available for each game type, from Ren'Py and RPG Maker to Unity, GameMaker, Java and Android, described in [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/) and [Saves and cheats](/maclauncher/tools/saves-and-cheats/).
- Every setting a runtime offers, plus your own launch flags, in each game's runtime settings, as [Versions and settings](/maclauncher/tools/versions-and-settings/#per-game-choices) describes.
- Environment variables for every translator and runtime that reads them, with defaults in **Settings → Environment variables** and separate values for each game, from DXVK's HUD to `KK_EMULATION` in KosmicKrisp, one of the two Vulkan drivers for the Mac.
- Control over your own files and connections: no network request without an action of yours, and no telemetry, as [Network and privacy](/maclauncher/tools/network-and-privacy/) explains.

## The tools

- [Runtime patching](/maclauncher/tools/runtime-patching/) explains why a newer graphics translator or Vulkan driver can help a Windows game, and walks through choosing one for a game along with its options and environment variables.
- [Graphics translators](/maclauncher/windows/graphics-translators/), [Translator versions](/maclauncher/windows/translator-versions/) and [KosmicKrisp](/maclauncher/windows/kosmickrisp/) go into DXMT, D3DMetal, DXVK, vkd3d-proton, MoltenVK and KosmicKrisp in depth.
- [Stores and downloads](/maclauncher/tools/stores-and-downloads/) imports the games you've installed from [Steam](https://store.steampowered.com/), [Epic](https://store.epicgames.com/), [GOG](https://www.gog.com/) and [itch.io](https://itch.io/), and downloads the games you own for any platform and in any version you can get, including Android apps from [Google Play](https://play.google.com/store/games), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/).
- The [Steam client bridge](/maclauncher/windows/steam-client-bridge/) lets Windows games in CrossOver, Sikarugir or WineCX use the Steam app for Mac.
- [Versions and settings](/maclauncher/tools/versions-and-settings/) covers the Runtimes and Settings windows, per-game choices, launch arguments, environment variables, network access, shortcuts and the command line.
- [Patching games](/maclauncher/tools/patching-games/) covers Ren'Py Patch, RPG Maker's library patch and plugins, and the in-game Tools overlay, with how to undo each one.
- [Saves and cheats](/maclauncher/tools/saves-and-cheats/) finds a game's saves, takes snapshots, edits [RPG Maker](https://www.rpgmakerweb.com/) MV and MZ saves, and opens the cheats built in for RPG Maker and [Ren'Py](https://www.renpy.org/).
- [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/) unpacks archives, decrypts assets and decompiles scripts and code for most game types.
- [Network and privacy](/maclauncher/tools/network-and-privacy/) explains when MacLauncher goes online, how each game's network access works, and where logs go.

A game's decompilers and extractors belong to its [game type](/maclauncher/background/choosing-a-runtime/#game-types-and-runtimes), so they stay available whichever runtime plays it, the WINE runtimes included. Their output goes into MacLauncher's storage, apart from the game's files, along with exports, private copies and caches, and **Forget** cleans all of it up.
