---
title: Mac apps, retro and more
description: Native macOS apps and scripts, 32-bit Mac apps, DOS games, classic adventure games, Infinity Engine, MUGEN, HashLink, and video playback.
sidebar:
  order: 5
---

A grab bag of everything else MacLauncher can run, from Mac apps you already have to DOS games and videos.

## Mac apps and scripts

<span id="runtime-native"></span>Why run a Mac app through MacLauncher at all? A few good reasons:

- **The graphics layer.** Any Mac app or game can get shaders, upscaling and frame generation. Yes, *any* app; it doesn't have to be a game.
- **Fixing "damaged" apps.** Indie Mac builds downloaded from the web are often blocked by [Gatekeeper](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)'s quarantine. **Remove quarantine** in the inspector clears it.
- **Scripts and loose binaries.** `.sh`, `.command`, Python and other scripts, and bare Mac executables, can be launched from the library. **Make executable** fixes a missing permission bit.
- **One library.** Your Mac games sit alongside everything else, with the same notes, tools and launchers.

### 32-bit Mac apps

macOS [dropped support for 32-bit apps](https://support.apple.com/en-us/103076) back in Catalina, which stranded a lot of older Mac games. MacLauncher can run them again through [mac32](https://github.com/Shagulka/mac32), which loads a 32-bit Intel app inside a 64-bit process and bridges its system calls to current macOS. It's picked automatically for 32-bit-only apps, and it's how games like [Portal 2](https://store.steampowered.com/app/620/Portal_2/)'s old Mac build come back to life. It needs macOS 26 or later and [Rosetta](https://support.apple.com/en-us/102527).

Guides: [Native apps](https://github.com/procrastinine/maclauncher/blob/master/docs/README.md#add-and-play), [mac32](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/MAC32.md)

## DOS games

DOS games run on [DOSBox Staging](https://www.dosbox-staging.org/). This one really is an emulator, and that's fine: these games are tiny, and the PCs they expect no longer exist. Import the game's folder (or its `.exe`, `.com` or `.bat` when there are several) and play.

**Example games:** DOOM, Prince of Persia.

Guide: [DOS](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/DOSBOX.md)

## Classic adventure games

[ScummVM](https://www.scummvm.org/) runs hundreds of point-and-click adventures from their original data files: LucasArts [SCUMM](https://en.wikipedia.org/wiki/SCUMM) games, Sierra's SCI and AGI games, Adventure Game Studio games and many more. MacLauncher recognizes common layouts on import and downloads ScummVM when you first press Play.

**Example games:** The Secret of Monkey Island, Day of the Tentacle.

Guide: [ScummVM](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SCUMMVM.md)

## Infinity Engine, MUGEN and HashLink

- **[Infinity Engine](https://en.wikipedia.org/wiki/Infinity_Engine)** games and mods (the Baldur's Gate family) run on [GemRB](https://gemrb.org/).
- **[MUGEN](https://en.wikipedia.org/wiki/Mugen_(game_engine))** fighting-game content runs on [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO).
- **[Haxe](https://haxe.org/)** games compiled for the [HashLink](https://hashlink.haxe.org/) virtual machine run on HashLink.

**Example games:** Baldur's Gate, Planescape: Torment and Icewind Dale (Infinity Engine); Dead Cells and Northgard (HashLink).

Guide: [Other engines](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/OTHER_ENGINES.md)

## Videos

It sounds a little funny, but MacLauncher plays videos too, through [mpv](https://mpv.io/). The reason is the graphics layer: the same upscalers, anime-oriented shaders, neural restoration and effect chains you use for games work on video.

Drop in a video file, or a folder of videos to get a playlist. MacLauncher remembers where you stopped, supports subtitles, and comes with the [uosc](https://github.com/tomasklaen/uosc) interface and [thumbfast](https://github.com/po5/thumbfast) thumbnails; you can add other mpv plugins too. You can also preview and export a video with your effects applied.

Guide: [Video](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/VIDEO.md)
