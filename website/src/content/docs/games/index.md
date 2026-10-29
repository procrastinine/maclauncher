---
title: Games and runtimes
description: A tour of the kinds of games MacLauncher plays, and the runtimes behind each one.
sidebar:
  order: 0
  label: Overview
---

A surprising number of games built for Windows don't really *need* Windows. Their engine also exists for macOS, or there is an open-source reimplementation that reads the same data. MacLauncher collects those runtimes, picks the right one when you import a game, and manages the versions so you don't have to.

This section is a guided tour. Each page explains a family of games, what runs them, and what to expect. The [runtime guides](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/README.md) in the repository have the exact formats, versions and settings for every one.

## The families

| Family | Examples of what's inside | Page |
| --- | --- | --- |
| Desktop game engines | [RPG Maker](https://www.rpgmakerweb.com/), [Ren'Py](https://www.renpy.org/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/), [LÖVE](https://love2d.org/), [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA)/[FNA](https://fna-xna.github.io/), Java, Flash, HTML5 games | [Desktop engines](/maclauncher/games/desktop-engines/) |
| Visual novels | KiriKiri, Siglus/RealLive, NScripter, AliceSoft, MAGES., Nitroplus, Minori, FAVORITE, AI5WIN, VNDS | [Visual novels](/maclauncher/games/visual-novels/) |
| Any other Windows game | [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) ([WINE](https://www.winehq.org/)) and [CrossOver](https://www.codeweavers.com/crossover/) | [Windows games through WINE](/maclauncher/games/windows/) |
| Phones, tablets and consoles | Android, iOS/iPadOS, PlayStation 5, Nintendo Switch | [Mobile and consoles](/maclauncher/games/mobile-and-consoles/) |
| Everything else | macOS apps (including 32-bit ones), DOS, adventure games, Infinity Engine, MUGEN, [HashLink](https://hashlink.haxe.org/), video | [Mac apps, retro and more](/maclauncher/games/more/) |

## How a game finds its runtime

You never have to tell MacLauncher what a game is. On import it looks at the files: a `Game.ini` with RPG Maker scripts, a Ren'Py `game/` folder, a Godot `.pck`, a GameMaker `data.win`, an `.apk` manifest, a PS5 `param.json`. From those it works out the engine and, where it matters, the engine *version*, which can make or break a game. Godot 4.5 and 4.6 projects, for instance, usually aren't interchangeable, and Unity games want the exact player version they were built with.

The inspector then shows the runtime it picked and the alternatives. When you press **Play**, anything missing is downloaded after you agree, and the game starts.

## Native first

Wherever there's a native option, MacLauncher prefers it, and the reasons go beyond speed:

- **Performance and battery.** No translation layer sits between the game and your Mac.
- **It feels like a Mac app.** Window management, fullscreen, mouse and audio behave the way macOS expects. WINE can be surprisingly erratic in exactly these places.
- **Broken Mac builds become playable.** Some games ship a Mac `.app` that was never tested and fails on signing or packaging. Pointing a working runtime at the game's data side-steps the problem.

When there isn't a native option, Sikarugir and CrossOver are always there as a fallback, and you can switch any time. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) talks through the trade-offs.

## Runtimes come from catalogs

MacLauncher itself stays small. Engines and tools are downloaded on demand from two kinds of catalog: the upstream projects' own releases, and [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), a companion project with ready-to-run macOS builds for engines that need adapting or have no official Mac release. Either way, you pick versions in **Runtimes**, installed versions work offline, and nothing is fetched until you ask.

## Some unique pieces

Most runtimes are existing open-source projects that MacLauncher manages. A few exist only here, and they open up games that otherwise wouldn't run natively on a Mac at all:

- [MacLauncher Android](https://github.com/procrastinine/maclauncher-android), a game-focused Android runtime that also handles ARM64 VR/XR titles.
- A macOS port of [OpenGMK](https://github.com/OpenGMK/OpenGMK), the only native way to play classic GameMaker 8 games on a Mac.
- macOS ports of [AnyPS5](https://github.com/boykopovar/AnyPS5), [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN), [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2), [KAG3](https://github.com/krkrsdl2/kag3) and [ReMinori](https://github.com/luoyily/ReMinori).
- [Offline Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md), for games that expect Steam to be running before they'll start.
