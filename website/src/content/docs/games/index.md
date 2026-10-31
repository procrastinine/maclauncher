---
title: Games and runtimes
description: "The game types MacLauncher plays on macOS, from RPG Maker, Ren'Py and Godot games to visual novels, Android apps and Windows games, and the runtimes behind each one."
head:
  - tag: title
    content: "Game types and runtimes on Mac | MacLauncher"
sidebar:
  order: 0
  label: Overview
---

Many games built for Windows can run without it, because their engine also exists for macOS or an open-source reimplementation can read the same data. MacLauncher collects those runtimes, picks the right one when you import a game, and manages their versions for you.

Every game in MacLauncher has a game type, such as Ren'Py, Unity or PlayStation 5, and each game type has one or more runtimes that can play it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#game-types-and-runtimes) explains the two terms. The pages in this section group related game types and describe what runs them. In the repository, the [game type reference](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/README.md) has a page for every game type with its exact formats, versions, settings, tools and runtimes.

## The game types

| Page | Game types |
| --- | --- |
| [Desktop engines](/maclauncher/games/desktop-engines/) | [RPG Maker](https://www.rpgmakerweb.com/) (MV and MZ, XP/VX/VX Ace, 2000/2003), WOLF RPG Editor, [Ren'Py](https://www.renpy.org/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/), [LÖVE](https://love2d.org/), [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA)/[FNA](https://fna-xna.github.io/), Java, Flash, and the web game types: Construct, Tyrano, GameMaker HTML5 and Web |
| [Visual novels](/maclauncher/games/visual-novels/) | KiriKiri, Siglus / RealLive, NScripter, AliceSoft, MAGES., Nitroplus, Minori, FAVORITE / FVP, AI5WIN, VNDS, BGI / Ethornell, CatSystem2 |
| [Windows games through WINE](/maclauncher/games/windows/) | Windows Game, plus the Windows executables of other game types, played with [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) ([WINE](https://www.winehq.org/)) or [CrossOver](https://www.codeweavers.com/crossover/) |
| [Mobile and consoles](/maclauncher/games/mobile-and-consoles/) | Android, iOS / iPadOS, PlayStation 5, Nintendo Switch |
| [Mac apps, retro and more](/maclauncher/games/more/) | macOS Game (including 32-bit apps), DOS, ScummVM, Infinity Engine, Half-Life (Xash3D FWGS), MUGEN / Ikemen GO, [HashLink](https://hashlink.haxe.org/), Haxe native build, Video |

## How a game finds its runtime

MacLauncher identifies a game by reading its files on import: a `Game.ini` with RPG Maker scripts, a Ren'Py `game/` folder, a Godot `.pck`, a GameMaker `data.win`, an `.apk` manifest or a PS5 `param.json`. From those it works out the game type and, where it matters, the engine *version*, which often decides whether a game runs at all. Godot 4.5 and 4.6 projects, for instance, usually aren't interchangeable, and Unity games want the exact player version they were built with.

The game's inspector then shows the runtime MacLauncher picked, along with the alternatives, and pressing **Play** downloads anything missing and starts the game.

## Native first

Wherever there's a native runtime, MacLauncher prefers it. Speed and battery life are part of the reason, since no translation layer sits between the game and your Mac. A native runtime also behaves like a Mac app: window management, fullscreen, mouse and audio work the way macOS expects, and those are the areas where WINE can be erratic. A game whose own Mac `.app` fails to open because of signing or packaging problems can still run on a native runtime, which plays the same game data.

When there is no native runtime, Sikarugir and CrossOver are always available as a fallback, and you can switch at any time. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) talks through the trade-offs.

## Runtimes come from catalogs

MacLauncher itself stays small, because engines and tools are downloaded on demand from two kinds of catalog: the upstream projects' own releases, and [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), a companion project with ready-to-run macOS builds of engines that need adapting or have no official Mac release. Either way, you pick versions in the **Runtimes** window.

## Runtimes built for MacLauncher

Most runtimes are existing open-source projects that MacLauncher manages. A few exist only in MacLauncher:

- [MacLauncher Android](https://github.com/procrastinine/maclauncher-android), a game-focused Android runtime that also handles ARM64 VR/XR titles.
- A macOS port of [OpenGMK](https://github.com/OpenGMK/OpenGMK), the only native way to play classic GameMaker 8 games on a Mac.
- macOS ports of [AnyPS5](https://github.com/boykopovar/AnyPS5), [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN), [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2), [KAG3](https://github.com/krkrsdl2/kag3) and [ReMinori](https://github.com/luoyily/ReMinori).
- [Offline Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md), for games that expect Steam to be running before they'll start.
