---
title: Mac apps, retro and more
description: "Native macOS apps and scripts, 32-bit Mac apps, DOS games on DOSBox Staging, ScummVM adventure games, Infinity Engine games on GemRB, Half-Life on Xash3D FWGS, MUGEN, HashLink and video playback."
head:
  - tag: title
    content: "32-bit Mac apps, DOS, ScummVM and Infinity Engine games on Mac | MacLauncher"
sidebar:
  order: 5
---

This page covers the remaining game types that MacLauncher plays on a Mac, from Mac apps you already have to DOS games, classic adventure games and videos.

## Mac apps and scripts

<span id="runtime-native"></span>Mac apps, scripts and executables that no engine-specific game type claims are imported as the macOS Game type, and they run as they are. MacLauncher still adds a few things:

- The graphics layer gives any Mac app or game shaders, upscaling and frame generation. The app doesn't have to be a game.
- Indie Mac builds downloaded from the web are often blocked by [Gatekeeper](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)'s quarantine and reported as "damaged". **Remove quarantine** in the inspector clears it.
- Scripts (`.sh`, `.command`, Python and others) and bare Mac executables can be launched from the library. **Make executable** fixes a missing permission bit.
- Your Mac games sit in the same library as everything else, with the same notes, tools and launchers.

### 32-bit Mac apps

macOS [dropped support for 32-bit apps](https://support.apple.com/en-us/103076) in Catalina, which stranded a lot of older Mac games. MacLauncher can run them again with the 32-bit Mac runtime, [mac32](https://github.com/Shagulka/mac32), which loads a 32-bit Intel app inside a 64-bit process and bridges its system calls to current macOS. MacLauncher picks it automatically for apps that are only 32-bit, such as the old Mac build of [Portal 2](https://store.steampowered.com/app/620/Portal_2/). Each mac32 release states the macOS version it needs, which MacLauncher reads from the download, and on Apple Silicon it also needs [Rosetta](https://support.apple.com/en-us/102527).

Guides: [macOS Game](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MACOS.md), [32-bit Mac](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MACOS.md#32-bit-mac)

## DOS games

DOS games run on [DOSBox Staging](https://www.dosbox-staging.org/). This one really is an emulator, which is fine: these games are tiny, and the PCs they expect no longer exist. Import the game's folder, or its `.exe`, `.com` or `.bat` file when the folder has several programs, and play.

**Example games:** DOOM, Prince of Persia.

Guide: [DOS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/DOS.md)

## Classic adventure games

[ScummVM](https://www.scummvm.org/) runs hundreds of point-and-click adventures from their original data files: LucasArts [SCUMM](https://en.wikipedia.org/wiki/SCUMM) games, Sierra's SCI and AGI games, Adventure Game Studio games and many more. Common layouts are recognized on import as the ScummVM game type, and ScummVM itself is downloaded when you first press Play.

**Example games:** The Secret of Monkey Island, Day of the Tentacle.

Guide: [ScummVM](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SCUMMVM.md)

## Infinity Engine

[Infinity Engine](https://en.wikipedia.org/wiki/Infinity_Engine) games and mods, the Baldur's Gate family, run on [GemRB](https://gemrb.org/), which plays the original game data as a native macOS program. [Near Infinity](https://github.com/Argent77/NearInfinity) is available in the inspector for browsing and editing their resources.

**Example games:** Baldur's Gate, Planescape: Torment and Icewind Dale.

Guide: [Infinity Engine](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/INFINITY_ENGINE.md)

## Half-Life

[Half-Life](https://store.steampowered.com/app/70/HalfLife/) runs on [Xash3D FWGS](https://github.com/FWGS/xash3d-fwgs), an open-source engine compatible with GoldSrc, the engine Valve built for the original game. Xash3D FWGS plays the data from your own copy as a native Mac program, on Apple Silicon or Intel, without WINE. Import your Half-Life folder, such as the Steam installation, and press **Play**: the engine and Half-Life's game code are downloaded the first time.

Mods that run on Half-Life's own game code, such as map packs, work the same way when you import the mod's folder from inside the Half-Life folder. Mods that bring their own Windows game code, Opposing Force and Blue Shift among them, can't load into a Mac engine, so they run through [Sikarugir or CrossOver](/maclauncher/games/windows/) from the Half-Life entry instead.

Saves and settings stay in MacLauncher's data, and the game folder itself is never changed.

Guide: [Half-Life (Xash3D FWGS)](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/HALF_LIFE.md)

## MUGEN and Ikemen GO

[MUGEN](https://en.wikipedia.org/wiki/Mugen_(game_engine)) fighting-game content runs on [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO), an engine compatible with MUGEN characters, stages and screenpacks. Ikemen GO 1.0 runs on Apple Silicon with macOS 14 or later, and version 0.99 is an Intel build that runs directly on Intel Macs and through Rosetta on Apple Silicon.

Guide: [MUGEN / Ikemen GO](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MUGEN.md)

## HashLink and Haxe

[Haxe](https://haxe.org/) games compiled for the [HashLink](https://hashlink.haxe.org/) virtual machine run on HashLink, using its Intel VM through Rosetta on Apple Silicon.

Haxe games compiled to native Windows code instead are a separate game type, Haxe native build. They have no Mac runtime, so MacLauncher identifies and inspects them and plays them through Sikarugir or CrossOver.

**Example games:** Dead Cells and Northgard (HashLink).

Guides: [HashLink](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/HASHLINK.md), [Haxe native build](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/HAXE.md)

## Videos

MacLauncher also plays videos, through [mpv](https://mpv.io/), so that the same upscalers, anime-oriented shaders, neural restoration and effect chains you use for games work on video too. mpv comes in Apple Silicon and Intel builds, and the Intel build of mpv 0.41 needs macOS 15. The effects have their own [hardware requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md#graphics).

Drop in a video file, or a folder of videos to get a playlist. Playback resumes where you stopped, and subtitles are supported. The [uosc](https://github.com/tomasklaen/uosc) interface and [thumbfast](https://github.com/po5/thumbfast) timeline previews are on by default, and Play offers to download them the first time. Plugins are installed, updated and removed in **Runtimes → mpv player → Plugins**, where **Add plugin** brings in other mpv plugins from GitHub or a local file; the switches that turn each one on or off are in **Settings → Video**. To use scripts of your own without MacLauncher managing them, **Additional scripts** in a video's settings loads them from where they are. You can also preview a video with your effects applied and export the result.

Guide: [Video](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/VIDEO.md)
