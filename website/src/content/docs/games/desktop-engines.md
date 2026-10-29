---
title: Desktop engines
description: RPG Maker, Ren'Py, Godot, GameMaker, Unity, LÖVE, XNA/FNA, Java, Flash and HTML5 games, running on native macOS runtimes.
sidebar:
  order: 1
---

These are the engines behind a huge share of indie games. Each one has a native macOS runtime, so a Windows release of the game can usually run without [WINE](https://www.winehq.org/): MacLauncher pairs the game's data with the right engine build, and it plays like a Mac app.

Below, each engine gets a short "what to expect". The linked guides go into every format and setting.

## Web games: RPG Maker MV/MZ, Construct, TyranoBuilder and friends

A lot of games are really web apps in a box. [RPG Maker](https://www.rpgmakerweb.com/) MV and MZ, [Construct](https://www.construct.net/) 2/3, [TyranoBuilder](https://tyranobuilder.com/) and [GameMaker](https://gamemaker.io/)'s HTML5 export all produce HTML and JavaScript, and the Windows release just wraps them in a Windows copy of a browser engine.

MacLauncher runs them in <span id="runtime-electron"></span>**[Electron](https://www.electronjs.org/)** (included with the app, so there's nothing to download) or <span id="runtime-nwjs"></span>**[NW.js](https://nwjs.io/)** (versions downloaded on demand). There's also <span id="runtime-nwjs-patched"></span>**NW.js (Patched)**, which uses the same NW.js versions and adds a patch layer with optional compatibility settings. RPG Maker MV and MZ games use NW.js (Patched) when an NW.js version is installed, and Electron otherwise. These games generally just work. RPG Maker MV/MZ games also get a structured save editor and cheats; see [Saves and cheats](/maclauncher/tools/saves-and-cheats/).

**Example games:** OMORI (RPG Maker MV).

Guide: [HTML hosts](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIMES.md)

## RPG Maker XP, VX and VX Ace

The Ruby-based RPG Makers run on [MKXP-Z](https://github.com/mkxp-z/mkxp-z), an open-source reimplementation of the RPG Maker player. MacLauncher offers a MacLauncher build that adds Unicode filename fixes, plus upstream builds. It also handles the [RPG Maker RTP](https://www.rpgmakerweb.com/run-time-package) (the shared asset packs many games expect), downloading the official pack after asking when a game needs it. Encrypted archives can be extracted, and the Ruby scripts can be exported and repacked.

**Example games:** To the Moon and OneShot (XP), The Witch's House (VX).

Guide: [MKXP-Z](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/MKXPZ.md)

## RPG Maker 2000/2003 and WOLF RPG Editor

The older RPG Makers run on [EasyRPG Player](https://easyrpg.org/), a mature open-source player. [WOLF RPG Editor](https://www.silversecond.com/WolfRPGEditor/) games run on [Browser Woditor](https://frostyhowl.com/browser-woditor/).

**Example games:** Yume Nikki and Ib (RPG Maker 2000/2003), Mad Father (WOLF RPG Editor).

Guides: [EasyRPG](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/EASYRPG.md), [WOLF RPG](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WOLFRPG.md)

## Ren'Py

[Ren'Py](https://www.renpy.org/) visual novels run on the <span id="runtime-sdk"></span>matching Ren'Py SDK for macOS. MacLauncher reads which Python generation and Ren'Py version a game was built with and picks a compatible SDK. Compatibility is excellent. There's a toolbox for Ren'Py too: RPA archive extraction, script decompilation, a developer console and cheat add-ons.

**Example games:** Slay the Princess, Doki Doki Literature Club!, Katawa Shoujo.

Guides: [Ren'Py](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIMES.md#renpy), [Ren'Py tools](https://github.com/procrastinine/maclauncher/blob/master/docs/RENPY_TOOLS.md)

## Godot

[Godot](https://godotengine.org/) games run on the official macOS engine of the *same version*. That detail matters: projects made with one Godot version often won't load in another (4.5 and 4.6, for example). MacLauncher detects the version from the game and offers Standard and .NET builds where Godot has both.

**Example games:** Brotato, Dome Keeper, Cassette Beasts, Buckshot Roulette.

Guide: [Godot](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIMES.md#godot)

## GameMaker

GameMaker has a few generations, and each gets a different runtime:

- **GameMaker Studio** games (such as [UNDERTALE](https://undertale.com/)) can use <span id="runtime-butterscotch"></span>[Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), an open-source runner, or <span id="runtime-official-studio"></span>the official GameMaker runners at the exact version the game needs.
- **Classic GameMaker 8.0/8.1** games run on <span id="runtime-opengmk"></span>MacLauncher's macOS port of [OpenGMK](https://github.com/OpenGMK/OpenGMK), the only way to play them natively on a Mac.
- **HTML5 exports** run like the other [web games](#web-games-rpg-maker-mvmz-construct-tyranobuilder-and-friends).

**Example games:** UNDERTALE, Hyper Light Drifter and Hotline Miami (GameMaker Studio); the original freeware Spelunky (classic GameMaker).

Guide: [GameMaker](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/GAMEMAKER.md)

## Unity

[Unity](https://unity.com/) games come in two flavors, called [scripting backends](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends), and the flavor decides everything:

- **Mono** games ship their code as [.NET](https://github.com/dotnet/runtime) assemblies. MacLauncher can run them on the macOS Unity player of the exact version they were built with. Many work well; games that lean on Windows-specific libraries won't.
- **IL2CPP** games are compiled to Windows machine code, so they need [Sikarugir or CrossOver](/maclauncher/games/windows/).

**Example games:** Hollow Knight, Cuphead.

Guide: [Unity](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/UNITY.md)

## XNA and FNA

Games built on Microsoft's [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA) framework (a big part of the 2010s indie scene) run on [FNA](https://fna-xna.github.io/), a reimplementation of XNA, together with [FNA3D](https://github.com/FNA-XNA/FNA3D), [FAudio](https://github.com/FNA-XNA/FAudio) and .NET.

**Example games:** Terraria, Celeste, Fez.

Guide: [FNA](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/FNA.md)

## LÖVE

[LÖVE](https://love2d.org/) games, including `.love` archives, Windows "fused" executables and Linux AppImages, run on the matching LÖVE release. If a game ships compiled [Lua](https://www.lua.org/) or [LuaJIT](https://luajit.org/) bytecode, MacLauncher's tools can turn it back into readable source.

**Example games:** [Balatro](https://www.playbalatro.com/), Mari0.

Guide: [LÖVE](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/LOVE.md)

## Java

Java games run on [Eclipse Temurin](https://adoptium.net/), with the Java version chosen to match what the game was compiled for. Steam-integrated Java games get [steamworks4j](https://github.com/code-disaster/steamworks4j) support, and [Vineflower](https://vineflower.org/) can decompile the code.

**Example games:** Slay the Spire.

Guides: [Java](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIMES.md#temurin--vineflower), [Java and Steam](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/JAVA_STEAM.md)

## Flash

[Flash](https://en.wikipedia.org/wiki/Adobe_Flash) games (`.swf`) can run on <span id="runtime-projector"></span>Adobe's own Flash Player projector or on <span id="runtime-ruffle"></span>[Ruffle](https://ruffle.rs/), the open-source Flash reimplementation. Both are downloaded on demand. Try the projector for the most faithful playback and Ruffle as the alternative.

**Example games:** the original Meat Boy.

Guide: [Flash](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIMES.md#ruffle--flash-player)

## When a game ships its own Mac build

GameMaker, Godot, Unity, XNA/FNA, LÖVE and Ren'Py also offer **Native app** when the game includes a working macOS build. MacLauncher runs that build directly, and you still get the [graphics layer](/maclauncher/graphics/), version management and tools.
