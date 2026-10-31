---
title: Choosing a runtime
description: Game types and runtimes, when to use a native engine, Sikarugir or CrossOver for Windows games, which Android runtime to pick, and how versions fit in.
sidebar:
  order: 2
---

Most of the time you don't need to choose anything. When you import a game, MacLauncher works out what it is, which engine version it uses and which runtime should play it, and selects that runtime for you.

Many games can run in more than one way, though, and sometimes the second choice works better. This page explains the trade-offs, so you know when switching is worth trying. If terms such as *compatibility layer* are new, [How games run on a Mac](/maclauncher/background/how-games-run/) covers the background.

## Game types and runtimes

MacLauncher sorts every game it imports into a **game type**: the engine or platform the game was made for, such as Ren'Py, RPG Maker MV, Unity, Android or PlayStation 5. The game type decides how MacLauncher reads the game's files, which settings apply and which tools appear in the inspector.

A **runtime** is one way to play a game type: an engine, a player or a compatibility layer. Every game type has a default runtime, and many have several. The PlayStation 5 game type, for example, can run on AnyPS5 or on Prosper. Ren'Py games can run in the Ren'Py SDK, through Ren'Py Patch, or as the game's own Mac app. Some runtimes serve many game types: Electron and NW.js play all the web-based game types, and Sikarugir and CrossOver can play the Windows executable of almost any game.

Tools belong to the game type, not the runtime. A Unity game keeps its Unity decompiler and asset tools when you switch it to CrossOver, because the tools read the game's own data.

MacLauncher also picks the right processor build of each runtime for you. Some engines need a newer macOS than MacLauncher itself, or run on only one kind of processor; the [requirements table](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) lists them, and [Processor builds](/maclauncher/tools/versions-and-settings/#processor-builds) explains how Intel and Apple Silicon builds work together.

## Where the choice lives

Select a game in your library to open its **inspector**. Its runtime selector lists every runtime that can play this game, with the installed versions of each, and a change there is saved for that game alone and can be undone at any time. **Runtimes** in the toolbar is where you install, update and remove runtime versions, and **Settings** sets the default runtime for each game type.

## Windows games

A game made with an engine MacLauncher recognizes keeps that engine's game type, even when you import its Windows `.exe`. If the game includes a compatible Windows executable, its runtime list has two kinds of choices: the engine's native runtime, which is the default, and the two WINE runtimes, Sikarugir and CrossOver. That works for every game type, however you imported the game; [Games made with other engines](/maclauncher/games/windows/#games-made-with-other-engines) covers the details, including the one exception, a game that lives inside a Mac `.app`. A Windows executable whose engine isn't recognized becomes a *Windows Game*, a game type whose only runtimes are Sikarugir and CrossOver.

### Native runtimes

If MacLauncher recognizes the engine ([Ren'Py](https://www.renpy.org/), [RPG Maker](https://www.rpgmakerweb.com/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/) Mono, [LÖVE](https://love2d.org/), [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA)/[FNA](https://fna-xna.github.io/), KiriKiri, Siglus and [many more](/maclauncher/games/)), it defaults to a native macOS runtime for that engine. This is the option to prefer. It's usually faster and easier on the battery, and it behaves like a real Mac app: mouse input feels right, fullscreen works the macOS way, and the graphics layer has the most information to work with.

How well it works depends on the engine. Engines whose games are mostly data, such as Ren'Py, all generations of RPG Maker, HTML5 games, most visual-novel engines and LÖVE, run nearly perfectly. Godot and GameMaker usually work well with the right version, which matters a lot for them; MacLauncher reads the version from the game files for you. Unity depends on the game. Unity games built with [Mono](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) can run on the macOS Unity player, but not when they rely on a lot of Windows-specific code or ship only Direct3D shaders. Unity games built with IL2CPP are compiled to Windows machine code, so they need a compatibility layer.

### Sikarugir

[Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free distribution of [WINE](https://www.winehq.org/). MacLauncher downloads its engines on request, keeps several versions side by side, and sets up a private Windows environment for each game automatically. Sikarugir is the default runtime for Windows Game entries, and it's offered as an alternative for recognized engines too. Its requirements are on the [Windows games](/maclauncher/games/windows/#sikarugir) page.

Try it when:

- the game uses an engine with no native runtime (a custom engine, [Unreal](https://www.unrealengine.com/), Unity IL2CPP, and so on);
- the native runtime has a problem with this particular game;
- you want the game to behave as it does on Windows, including Windows-only mods or plugins.

### CrossOver

[CrossOver](https://www.codeweavers.com/crossover/) is CodeWeavers' commercial WINE. If it's installed, MacLauncher finds it and offers it as another runtime. You can register several copies of CrossOver, such as a preview build, and pick a different one for each game. CodeWeavers keeps CrossOver current with fixes for newer games, so if you own it, it's usually the better WINE to use. Sikarugir stays the default because it's free and always available. To use CrossOver, pick it in a game's inspector, or make it the default runtime for Windows Game in **Settings**.

A few game types have tools but no Mac player: BGI / Ethornell, CatSystem2 and Haxe native builds. These games play their Windows executable through a registered CrossOver application when there is one, and through Sikarugir otherwise.

:::tip[Rule of thumb]
Use the native runtime first. If the game won't start or misbehaves, switch to WINE: CrossOver if you have it, otherwise Sikarugir. Each runtime has its own settings in the inspector, so check those too, for example the graphics backend or locale for WINE.
:::

## Android games

The Android game type has three runtimes, and they make different trade-offs. All three run on Apple Silicon without an Android emulator or virtual machine; [How games run on a Mac](/maclauncher/background/how-games-run/#not-just-windows-consoles-and-phones) explains why they work like WINE.

### MacLauncher Android

MacLauncher Android is the default runtime, and it's MacLauncher's own, built for games. It runs the complete [Android 16](https://developer.android.com/about/versions/16) framework, executes the app's native ARM64 libraries directly on your Mac's CPU, and supports Google accounts and installed Google services. That makes it the most compatible choice for complex commercial games. Because it's built on [Klepton](https://github.com/shinyquagsire23/Klepton), it also runs ARM64 VR/XR titles.

The **Execution** setting chooses between two modes:

- **JVM**, the default, converts the app's Android bytecode to run on [Java 21](https://openjdk.org/projects/jdk/21/).
- **ART** runs Android's original [runtime](https://source.android.com/docs/core/runtime) instead, using a genuine Android system image, which MacLauncher downloads separately.

Both modes come in one MacLauncher Android download and share its installed files. ART installations from earlier MacLauncher versions, which were a separate download, stay available with their saved version choices and can be removed in **Runtimes**.

If a game crashes or misbehaves in one mode, try the other.

### Mac.apk

[Mac.apk](https://github.com/kksimp/Mac.apk) is an independent project that runs Android apps on macOS. MacLauncher downloads its releases and lets you choose its graphics backend for each game: [Metal](https://developer.apple.com/metal/), or [Vulkan](https://www.vulkan.org/) through [MoltenVK](https://github.com/KhronosGroup/MoltenVK). Each release states the macOS version it needs, which MacLauncher reads from the download. Network access is off by default and can be turned on per game, and Google sign-in is available through its own account panel. It's a good alternative when a lighter game doesn't get along with the default runtime.

### AIM

[AIM](https://github.com/hahnlee/aim) runs apps with Android's original ART runtime and Android services, still without a Linux kernel or a VM. MacLauncher manages an adapted build and the matching Android system image. AIM requires macOS 26 or later and runs apps offline, without Google account integration. Try it when you want the behavior closest to stock Android and the game doesn't need online services.

| | MacLauncher Android | Mac.apk | AIM |
| --- | --- | --- | --- |
| Best for | Complex commercial games, Google sign-in, VR/XR | Lighter games, choice of Metal or Vulkan | Stock Android behavior, offline games |
| How it runs apps | Android framework on Java (JVM) or original ART | Its own Java-based Android host | Original ART with Android services |
| Google accounts | Yes | Yes, turned on per game | No |
| Requirements | Apple Silicon, macOS 13+ | Apple Silicon, macOS set by each release | Apple Silicon, macOS 26+ |

The [Android guide](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ANDROID.md) has the full details. You can get APKs from [Google Play](https://play.google.com/store/games), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/) inside MacLauncher; see [Stores and downloads](/maclauncher/tools/stores-and-downloads/).

## Other game types with a choice

| Game type | Runtimes | How they differ |
| --- | --- | --- |
| [Flash](https://en.wikipedia.org/wiki/Adobe_Flash) | Adobe Flash Player (default), [Ruffle](https://ruffle.rs/) | Adobe's Flash Player projector is the most faithful. Ruffle is an open-source reimplementation that keeps improving. |
| Web games: RPG Maker MV and MZ, Construct, Tyrano, GameMaker HTML5 and Web | [Electron](https://www.electronjs.org/) (default, included with MacLauncher), [NW.js](https://nwjs.io/), NW.js (Patched) | Electron works for most games. NW.js is closer to what many of these games were built for, and NW.js (Patched) adds optional compatibility settings. RPG Maker MV and MZ switch to NW.js (Patched) automatically once an NW.js version is installed. |
| GameMaker | [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) (default), the official GameMaker runners, [OpenGMK](https://github.com/OpenGMK/OpenGMK) | Butterscotch and the official runners play GameMaker Studio games. OpenGMK plays classic GameMaker 8 games. |
| NScripter | [ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri) (default), [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN), ONScripter-Yuri Web | ONScripter-Yuri and ONScripter-EN differ in the script features and save locations they support. ONScripter-Yuri Web runs the game in a browser window. |
| Siglus / RealLive | [siglus_rs](https://github.com/xmoezzz/siglus_rs) (default), [RLVM](https://github.com/eglaysher/rlvm) | siglus_rs plays Siglus, RealLive and AVG32 games. RLVM is an alternative for RealLive games. |
| PlayStation 5 | [AnyPS5](https://github.com/boykopovar/AnyPS5) (default), [Prosper](https://github.com/mattias800/prosper) | AnyPS5 converts the game into macOS programs. Prosper runs the original PS5 programs; Runtimes offers MacLauncher Builds packages and accepts local builds. |
| Ren'Py | Ren'Py SDK (default), Ren'Py Patch | The SDK runs the game from a private copy of its scripts. Ren'Py Patch copies the macOS runtime files from the matching SDK into the game. |

Many game types can also run a working Mac build that ships with the game. That runtime is called **Game's macOS app**. Graphics effects still apply.

## Versions

Every runtime in MacLauncher is versioned, and you can keep as many versions installed as you like. When a game starts, MacLauncher picks the version in this order:

1. Your choice for this game, if you picked one in its inspector.
2. The version the game asks for, when MacLauncher can read it from the game files. Godot, Unity, GameMaker and Ren'Py games care about this a lot.
3. Your default for that runtime, set in **Runtimes**.

A version you pick is used exactly: if it isn't installed, MacLauncher offers to download it instead of falling back to another version. Without any of these, MacLauncher uses the newest version the project has published, and a saved default that the project has since withdrawn is replaced by the newest one unless you have it installed.
