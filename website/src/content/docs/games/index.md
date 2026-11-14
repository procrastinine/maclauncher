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

Many games built for Windows can run on a Mac without Windows at all, and without [WINE](https://www.winehq.org/), the compatibility layer that runs Windows programs on other systems. That works because the game's engine also exists for macOS, or because an open-source reimplementation of the engine can read the same game data. These macOS engines are called runtimes. MacLauncher collects them, picks the right one when you import a game, and keeps track of their versions for you.

Every game in MacLauncher has a game type, such as Ren'Py, Unity or PlayStation 5, and each game type has one or more runtimes that can play it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#game-types-and-runtimes) explains both terms in more detail. The pages in this section group related game types and describe what runs them. For the exact formats, versions, settings, tools and runtimes of each game type, the repository has a [game type reference](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/README.md) with a page for every one.

<video src="/maclauncher/videos/runtime-compatibility.mp4" poster="/maclauncher/videos/runtime-compatibility.jpg" controls preload="metadata" playsinline></video>

*The Penjikent Creature, a [Godot](https://github.com/godotengine/godot) game packaged for Windows, dragged in as its `.exe`. MacLauncher detects Godot 3.5.2, downloads the matching runtime after asking and plays the game natively, without WINE. The installed Godot versions then appear in **Runtimes**.*

## The game types

| Page | Game types |
| --- | --- |
| [Desktop engines](/maclauncher/games/desktop-engines/) | [RPG Maker](https://www.rpgmakerweb.com/) (MV and MZ, XP/VX/VX Ace, 2000/2003), WOLF RPG Editor, [Ren'Py](https://www.renpy.org/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/), [LÖVE](https://love2d.org/), [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA)/[FNA](https://fna-xna.github.io/), Java, Flash, and the web game types: Construct, Tyrano, GameMaker HTML5 and Web |
| [Visual novels](/maclauncher/games/visual-novels/) | KiriKiri, Siglus / RealLive, NScripter, AliceSoft, MAGES., Nitroplus, Minori, FAVORITE / FVP, AI5WIN, VNDS, BGI / Ethornell, CatSystem2 |
| [Windows games through WINE](/maclauncher/games/windows/) | Windows Game, plus the Windows executables of other game types, played through WINE with [Sikarugir](https://github.com/Sikarugir-App/Sikarugir), [CrossOver](https://www.codeweavers.com/crossover/) or [WineCX](https://github.com/dappermint/winecx-gptk) |
| [Mobile and consoles](/maclauncher/games/mobile-and-consoles/) | Android, iOS / iPadOS, PlayStation 5, Nintendo Switch |
| [Mac apps, retro and more](/maclauncher/games/more/) | macOS Game (including 32-bit apps), DOS, Doom engine (UZDoom), Build engine (Raze), LucasArts (DREAMM), ScummVM, Infinity Engine, Half-Life (Xash3D FWGS), MUGEN / Ikemen GO, [HashLink](https://hashlink.haxe.org/), Haxe native build, Video |

## How a game finds its runtime

When you import a game, MacLauncher reads its files to recognize it: a `Game.ini` with RPG Maker scripts, a Ren'Py `game/` folder, a Godot `.pck`, a GameMaker `data.win`, an `.apk` manifest or a PS5 `param.json`. From those it works out the game type and, where it matters, the engine *version*, which often decides whether a game runs at all. Godot 4.5 and 4.6 projects, for instance, usually aren't interchangeable, and Unity games want the exact player version they were built with.

The runtime MacLauncher picked then shows in the game's [inspector](/maclauncher/launcher/), the panel beside the game list, along with the alternatives. Pressing **Play** downloads anything missing and starts the game.

## Native first

Wherever there's a native runtime, MacLauncher prefers it. Speed and battery life are part of the reason, since no translation layer sits between the game and your Mac. A native runtime also behaves like a Mac app, so window management, fullscreen, mouse and audio work the way macOS expects; those are exactly the areas where WINE can be erratic. They help, too, when a game's own Mac `.app` fails to open because of signing or packaging problems, since a native runtime can play the same game data anyway.

For games without a native runtime, MacLauncher falls back on three versions of WINE: Sikarugir and WineCX, two free builds that MacLauncher downloads for you, and CrossOver, a paid app from CodeWeavers that packages WINE for the Mac. You can switch between them at any time, and [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) talks through the trade-offs.

## Runtimes come from catalogs

MacLauncher itself stays small, because it downloads engines and tools only when a game needs them. They come from two kinds of catalog: the original projects' own releases, and [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), a companion project with ready-to-run macOS builds of engines that need adapting or have no official Mac release. Either way, you pick versions in the **Runtimes** window.

## Runtimes built for MacLauncher

Most runtimes are existing open-source projects that MacLauncher downloads and sets up. A few exist only in MacLauncher:

- [MacLauncher Android](https://github.com/procrastinine/maclauncher-android), a game-focused Android runtime that also handles ARM64 VR/XR titles.
- A macOS port of [OpenGMK](https://github.com/OpenGMK/OpenGMK), the only native way to play classic GameMaker 8 games on a Mac.
- macOS ports of [AnyPS5](https://github.com/boykopovar/AnyPS5), [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN), [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2), [KAG3](https://github.com/krkrsdl2/kag3) and [ReMinori](https://github.com/luoyily/ReMinori).
- [Offline Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md), for games that expect Steam to be running before they'll start.
