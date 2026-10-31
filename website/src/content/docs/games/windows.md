---
title: Windows games through WINE
description: "Windows games on macOS through WINE: Sikarugir and CrossOver run the games that have no native engine runtime, with a private Windows environment and graphics settings for each game."
head:
  - tag: title
    content: "Windows games on Mac with WINE: Sikarugir and CrossOver | MacLauncher"
sidebar:
  order: 3
---

Not every Windows game is built on an engine with a Mac runtime. Custom engines, [Unreal](https://www.unrealengine.com/) games, Unity [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) builds and countless older titles need Windows itself, or at least something that speaks its language. For those, MacLauncher uses **[WINE](https://www.winehq.org/)**, the compatibility layer that answers a game's Windows API calls with macOS equivalents. [How games run on a Mac](/maclauncher/background/how-games-run/#compatibility-layers-translate-the-conversation) explains how it works.

MacLauncher has two WINE runtimes, Sikarugir and CrossOver. A Windows executable whose engine MacLauncher doesn't recognize is imported as the Windows Game type, and these two are its runtimes. They also serve other game types: any game with a compatible Windows executable offers them next to its native runtime, as [Games made with other engines](#games-made-with-other-engines) explains, and BGI, CatSystem2 and Haxe native builds, which have no Mac player, play through them.

## Sikarugir

[Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free WINE distribution for macOS. Used on its own, it means installing its Creator app, building a "wrapper" for each game and setting it up yourself. MacLauncher skips all of that. It downloads Sikarugir's WINE engines directly, keeps as many versions as you like, and builds a private Windows environment (a ["prefix"](https://gitlab.winehq.org/wine/wine/-/wikis/FAQ) or "bottle") for each game the first time you press Play.

Sikarugir is the default runtime for Windows Game entries, and games of other types offer it as an alternative.

MacLauncher reads each engine's macOS requirement and identifies the renderers in its matching Template package during installation. Graphics libraries have separate requirements: DXMT starts at macOS 14 on a compatible GPU, while D3DMetal needs Apple Silicon and a macOS version supported by the installed framework and its dependencies. If an installation is ever incomplete, **Install** in Runtimes replaces it, or Play offers to download it again before the game starts, and either way each game's private Windows environment and saves are kept. [Sikarugir's runtime reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md) describes the renderers and their graphics requirements.

## CrossOver

If you own [CrossOver](https://www.codeweavers.com/crossover/), MacLauncher finds it in your Applications folder and offers it alongside Sikarugir. You can register more than one copy, such as a preview build or an older version you want to keep, and choose a different one for each game. CodeWeavers keeps CrossOver current with fixes for newer games, so if you own it, it's usually the better choice, and you can make it the default runtime for Windows Game in **Settings**. CrossOver's updates and licensing stay with CodeWeavers; MacLauncher only points games at the copy you pick. Its **Graphics** selector shows only the renderers that your Mac and that CrossOver version can run.

## Games made with other engines

Plenty of games made with a recognized engine, such as Ren'Py, RPG Maker, Unity, Godot, GameMaker or Construct, also ship a Windows build. Any game with a working x86 or x64 Windows executable offers Sikarugir and CrossOver next to its native runtime, whatever its engine, and keeps its engine's game type, default runtime and tools. It doesn't matter whether you imported the folder, the Windows `.exe` or another launcher file, such as a Ren'Py `.sh` script.

When it imports a game, MacLauncher picks out the main executable and ignores uninstallers, setup programs, redistributables and crash reporters. A game that lives inside a Mac `.app` runs as that app and doesn't get the WINE runtimes. An app that merely sits beside a Windows build changes nothing, so a Ren'Py release with a Windows `.exe`, a Linux `.sh` script and a Mac `.app` side by side still offers both.

The chosen executable is saved with the game, and the runtime list reads that record instead of the game's files. A game on an unplugged drive therefore keeps its WINE choices. If an update renames the executable, MacLauncher records the new one the next time it refreshes the game's details, at startup or when the drive comes back.

## What MacLauncher handles

### Private files for each game

Windows games often write settings and saves next to their own files. MacLauncher gives each game a private copy of its folder to write into, using copy-on-write cloning, so the copy takes almost no extra disk space on [APFS](https://en.wikipedia.org/wiki/Apple_File_System). Updates to the original files flow into the private copy without overwriting your saves or mods.

Each game also gets its own Windows environment, so one game's tweaks, DLL overrides or registry changes can't break another.

### Runtime settings

**Runtime Settings** in each game's inspector gather the useful options in one place. The most important ones are:

| Setting | What it does |
| --- | --- |
| Graphics | Chooses how [DirectX](https://en.wikipedia.org/wiki/DirectX) becomes [Metal](https://developer.apple.com/metal/): Automatic, [DXMT](https://github.com/3Shain/dxmt), [DXVK](https://github.com/doitsujin/dxvk), D3DMetal (from Apple's [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/)) or WineD3D. When a game renders wrongly, try another backend first. |
| Language locale | Sets a locale such as `ja_JP.UTF-8`, for Japanese games that otherwise show garbled text. |
| Windows version | Chooses which Windows version to report: 10, 11, 7 or XP. |
| DirectDraw compatibility | Adds a compatibility wrapper for old 32-bit games that draw with DirectDraw (Sikarugir only). |
| DLL overrides, environment variables, game arguments and WINE debug channels | Advanced tuning, plus an option that lets [BepInEx](https://github.com/BepInEx/BepInEx) mods load. |

### Rosetta

WINE on the Mac runs Intel code, so on Apple Silicon it needs [Rosetta 2](https://support.apple.com/en-us/102527). If Rosetta isn't installed yet, MacLauncher asks and installs it through the normal macOS prompt.

### Graphics effects

MacLauncher's [graphics layer](/maclauncher/graphics/) works on WINE games just as it does on native ones. On Apple Silicon, WINE games can also feed MacLauncher's [temporal upscalers](/maclauncher/graphics/upscaling/#temporal-upscalers), which need information from the game's renderer. Compatible 64-bit games pass [MetalFX](https://developer.apple.com/documentation/metalfx) temporal upscaling through their own [DLSS](https://www.nvidia.com/en-us/geforce/technologies/dlss/) setting, and games that use AMD's FSR 2 or 3 hand over their camera data through DXMT.

For FSR, Play downloads only the DXMT libraries it needs, not another WINE engine. **Runtimes → Graphics → DXMT support** keeps one set of these library versions, with one default, for both Sikarugir and CrossOver, and each game's **DXMT support** setting can choose a different version.

## What to expect

WINE is very good, but it's a translation, so results vary from game to game. Games whose DRM or anti-cheat requires real Windows won't run. Installers that need to install further components can't be played as games; MacLauncher plays the game itself, so point it at the installed game folder or its main `.exe`.

If a game's engine has a [native runtime](/maclauncher/games/desktop-engines/), try that first; it will usually run better. If a WINE game misbehaves, try another graphics backend, another WINE version, or CrossOver if you have it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#windows-games) has more on choosing between them.

Guides: [Windows Game](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOWS.md), [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md), [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md)
