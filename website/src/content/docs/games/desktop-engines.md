---
title: Desktop engines
description: RPG Maker, Ren'Py, Godot, GameMaker, Unity, LÖVE, XNA/FNA, Java, Flash and HTML5 games, running on native macOS runtimes.
sidebar:
  order: 1
---

The engines on this page are behind a large share of indie games. Each has a native macOS runtime, so a game's Windows release can usually run without [WINE](https://www.winehq.org/): MacLauncher pairs the game's data with the right engine build, and the game behaves like a Mac app.

Each section below covers one game type, or a few closely related ones, and says what to expect. The linked guides describe every format and setting.

## Web games

Many games are web apps in a box. [RPG Maker](https://www.rpgmakerweb.com/) MV and MZ, [Construct](https://www.construct.net/) 2 and 3, [TyranoBuilder](https://tyranobuilder.com/) and TyranoScript, and [GameMaker](https://gamemaker.io/)'s HTML5 export all produce HTML and JavaScript, and a Windows release wraps that in a Windows copy of a browser engine. MacLauncher recognizes each of these as its own game type: RPG Maker MV, RPG Maker MZ, Construct, Tyrano and GameMaker HTML5. The Web game type covers any other HTML game.

All of them run in the same hosts: <span id="runtime-electron"></span>**[Electron](https://www.electronjs.org/)**, which is included with the app, so there's nothing to download, or <span id="runtime-nwjs"></span>**[NW.js](https://nwjs.io/)**, whose versions are downloaded on demand. There's also <span id="runtime-nwjs-patched"></span>**NW.js (Patched)**, which uses the same NW.js versions and adds a patch layer with optional compatibility settings; GameMaker HTML5 doesn't offer it. RPG Maker MV and MZ games use NW.js (Patched) when an NW.js version is installed, and Electron otherwise. Most of these games work well in either host. RPG Maker MV and MZ games also get a structured save editor and cheats; see [Saves and cheats](/maclauncher/tools/saves-and-cheats/).

**Example games:** OMORI (RPG Maker MV).

Guides: [RPG Maker MV and MZ](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_MV_MZ.md), [Construct](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/CONSTRUCT.md), [Tyrano](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/TYRANO.md), [GameMaker HTML5](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/GAMEMAKER_HTML5.md), [Web](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WEB.md), [Web runtimes](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WEB_RUNTIMES.md)

## RPG Maker XP, VX and VX Ace

The Ruby-based RPG Makers run on [MKXP-Z](https://github.com/mkxp-z/mkxp-z), an open-source reimplementation of the RPG Maker player. MacLauncher offers its own MKXP-Z builds, which add fixes for Unicode file names, as well as upstream builds. It also handles the [RPG Maker RTP](https://www.rpgmakerweb.com/run-time-package), the shared asset packs that many games expect, and downloads the official pack when a game needs it. Encrypted archives can be extracted, and the Ruby scripts can be exported and repacked.

**Example games:** To the Moon and OneShot (XP), The Witch's House (VX).

Guide: [RPG Maker XP/VX/VX Ace](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_XP_VX.md)

## RPG Maker 2000/2003

The older RPG Makers run on [EasyRPG Player](https://easyrpg.org/), a mature open-source reimplementation of the RPG Maker 2000/2003 engine. MacLauncher can also export a game's database, maps and dialogue as JSON or text, for example for translation.

**Example games:** Yume Nikki and Ib.

Guide: [RPG Maker 2000/2003](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_2000_2003.md)

## WOLF RPG Editor

[WOLF RPG Editor](https://www.silversecond.com/WolfRPGEditor/) games run on [Browser Woditor](https://frostyhowl.com/browser-woditor/), a browser port of the engine. MacLauncher converts archives that use the standard WOLF encryption into a form Browser Woditor can read, without changing the original files. Games that use Windows-specific system functions, native DLLs, WOLF RPG Pro features or MP4 video can run in [Sikarugir or CrossOver](/maclauncher/games/windows/) instead.

**Example games:** Mad Father.

Guide: [WOLF RPG Editor](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WOLFRPG.md)

## Ren'Py

[Ren'Py](https://www.renpy.org/) visual novels run on the <span id="runtime-sdk"></span>matching Ren'Py SDK for macOS. MacLauncher reads which Python generation and Ren'Py version a game was built with and picks a compatible SDK. The other runtime, <span id="runtime-patched"></span>**Ren'Py Patch**, copies the macOS runtime files from the matching SDK into the game instead. Ren'Py has its own toolbox too: RPA archive extraction, script decompilation, a developer console and cheat add-ons.

**Example games:** Slay the Princess, Doki Doki Literature Club!, Katawa Shoujo.

Guide: [Ren'Py](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RENPY.md)

## Godot

[Godot](https://godotengine.org/) games run on the official macOS engine of the *same version*. That matters, because a project made with one Godot version often won't load in another (4.5 and 4.6, for example). MacLauncher detects the version from the game, and it also chooses between Godot's two builds of each version. A game written in C# needs the .NET build and gets it automatically; other games use the Standard build, or the .NET build when only that one is installed. The inspector's **Variant** menu shows which build a game will use and can change it.

**Example games:** Brotato, Dome Keeper, Cassette Beasts, Buckshot Roulette.

Guide: [Godot](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/GODOT.md)

## GameMaker

GameMaker has a few generations, and each uses a different runtime. GameMaker Studio games, such as [UNDERTALE](https://undertale.com/), run on <span id="runtime-butterscotch"></span>[Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), an open-source runner and the default, or on <span id="runtime-official-studio"></span>the official GameMaker runners at the exact version the game needs. Classic GameMaker 8.0 and 8.1 games run on <span id="runtime-opengmk"></span>MacLauncher's macOS port of [OpenGMK](https://github.com/OpenGMK/OpenGMK), the only way to play them natively on a Mac. HTML5 exports are a separate game type, GameMaker HTML5, and run like the other [web games](#web-games).

**Example games:** UNDERTALE, Hyper Light Drifter and Hotline Miami (GameMaker Studio); the original freeware Spelunky (classic GameMaker).

Guide: [GameMaker](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/GAMEMAKER.md)

## Unity

[Unity](https://unity.com/) games use one of two [scripting backends](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends), and the backend decides how a game can run on a Mac. Mono games ship their code as [.NET](https://github.com/dotnet/runtime) assemblies, and MacLauncher can run them on the macOS Unity player of the exact version they were built with. Many work well, but games that rely on Windows-specific libraries, or that ship only Direct3D shaders, won't. IL2CPP games are compiled to Windows machine code, so they need [Sikarugir or CrossOver](/maclauncher/games/windows/).

**Example games:** Hollow Knight, Cuphead.

Guide: [Unity](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/UNITY.md)

## XNA and FNA

Games built on Microsoft's [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA) framework, a big part of the 2010s indie scene, belong to the FNA / XNA 4 game type. They run on [FNA](https://fna-xna.github.io/), a reimplementation of XNA, together with [FNA3D](https://github.com/FNA-XNA/FNA3D), [FAudio](https://github.com/FNA-XNA/FAudio) and .NET.

**Example games:** Terraria, Celeste, Fez.

Guide: [FNA / XNA 4](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/FNA.md)

## LÖVE

[LÖVE](https://love2d.org/) games, including `.love` archives, Windows "fused" executables and Linux AppImages, run on the matching LÖVE release. If a game ships compiled [Lua](https://www.lua.org/) or [LuaJIT](https://luajit.org/) bytecode, MacLauncher's tools can turn it back into readable source.

**Example games:** [Balatro](https://www.playbalatro.com/), Mari0.

Guide: [LÖVE](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/LOVE.md)

## Java

Java games run on [Eclipse Temurin](https://adoptium.net/), with the Java version chosen to match what the game was compiled for. Java games that use Steam get [steamworks4j](https://github.com/code-disaster/steamworks4j) support, and [Vineflower](https://vineflower.org/) can decompile their code.

In **Runtimes**, each long-term support (LTS) release of Java, from 8 to 25, has its own section, and Adoptium's other releases are listed under **Other**. A game's inspector offers the same releases, and an exact version chosen for a game stays selected even before its version list has been loaded.

**Example games:** Slay the Spire.

Guide: [Java](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/JAVA.md)

## Flash

[Flash](https://en.wikipedia.org/wiki/Adobe_Flash) games (`.swf`) can run on <span id="runtime-projector"></span>Adobe's own Flash Player projector, the default, or on <span id="runtime-ruffle"></span>[Ruffle](https://ruffle.rs/), the open-source Flash reimplementation. The projector gives the most faithful playback, and Ruffle is the alternative.

**Example games:** the original Meat Boy.

Guide: [Flash](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/FLASH.md)

## When a game ships its own Mac build

When a game includes a working macOS build, most game types on this page can run it directly. That runtime is called **Game's macOS app**. You still get the [graphics layer](/maclauncher/graphics/), version management and tools.
