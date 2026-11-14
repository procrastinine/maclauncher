---
title: Windows games through WINE
description: "Which Windows games MacLauncher plays through WINE on macOS: Windows Game entries, the Windows builds of games made with other engines, and engines with no Mac player, run with Sikarugir, CrossOver or WineCX."
head:
  - tag: title
    content: "Windows games on Mac with WINE: Sikarugir, CrossOver and WineCX | MacLauncher"
sidebar:
  order: 3
---

Not every Windows game is built on an engine with a Mac runtime. Custom engines, [Unreal](https://www.unrealengine.com/) games, Unity [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) builds and countless older titles need Windows itself, or at least something that can stand in for it. For those, MacLauncher uses [WINE](https://www.winehq.org/), the compatibility layer that answers a game's Windows API calls with macOS equivalents. MacLauncher has three WINE runtimes to choose from: Sikarugir and WineCX, two free builds of WINE that MacLauncher downloads for you, and CrossOver, a paid app from CodeWeavers that packages WINE for the Mac.

Playing Windows games through WINE has its own section on this site, [Windows games and WINE](/maclauncher/windows/). It explains how the three runtimes work, how graphics translators turn Direct3D (the Windows graphics API most games draw with) into Metal (the one macOS uses), and what MacLauncher adds on top of WINE. This page covers the step before that: which games get the WINE runtimes in the first place, which depends on how MacLauncher identifies them on import.

## Windows Game

A Windows executable whose engine MacLauncher doesn't recognize is imported as a **Windows Game**, and its runtimes are the three WINE ones: Sikarugir (the default), CrossOver and WineCX. You can import the `.exe` itself or the folder it's in. In a folder, MacLauncher looks for the game's executable at the top level and ignores uninstallers, setup programs, updaters, redistributables and crash reporters. If several executables remain, import asks you to pick one.

Both x86 and x64 Windows games can be played this way. DOS programs can't, since they go to the DOS emulator [DOSBox Staging](/maclauncher/games/more/) instead, and neither can DLLs, Windows ARM64 executables or installers that need a further installation step.

## Games made with other engines

Plenty of games made with a recognized engine, such as Ren'Py, RPG Maker, Unity, Godot, GameMaker or Construct, also ship a Windows build. Whatever its engine, any game with a working x86 or x64 Windows executable offers the WINE runtimes next to its native runtime, while keeping its engine's game type, default runtime and tools. It doesn't matter whether you imported the folder, the Windows `.exe` or another launcher file, such as a Ren'Py `.sh` script.

Here too, MacLauncher picks out the main executable on import and ignores uninstallers, setup programs, redistributables and crash reporters. A game that lives inside a Mac `.app` runs as that app and doesn't get the WINE runtimes. An app that merely sits beside a Windows build changes nothing, though, so a Ren'Py release with a Windows `.exe`, a Linux `.sh` script and a Mac `.app` side by side still offers both.

MacLauncher saves the chosen executable with the game, and the list of runtimes reads that saved choice instead of the game's files, so a game on an unplugged drive keeps its WINE choices. If an update renames the executable, MacLauncher records the new name the next time it refreshes the game's details, at startup or when the drive comes back.

## Engines with no Mac player

A few game types have tools in MacLauncher but no runtime that can play them on a Mac: BGI / Ethornell and CatSystem2 visual novels, and Haxe native builds. These games play their original Windows executable through WINE instead. They use CrossOver when you've added a copy of it to MacLauncher and Sikarugir otherwise, and WineCX is there as another choice in the game's inspector.

## More about WINE games

- [Windows games and WINE](/maclauncher/windows/): how a Windows game runs on a Mac, and what MacLauncher adds.
- [CrossOver, Sikarugir and WineCX](/maclauncher/windows/crossover-and-sikarugir/): the three runtimes, and where each game's Windows files live.
- [Graphics translators](/maclauncher/windows/graphics-translators/): DXMT, D3DMetal, DXVK, MoltenVK, KosmicKrisp and the other programs that turn a game's drawing commands into Metal, and how to choose one.
- [Choosing a translator](/maclauncher/windows/choosing-a-translator/): which translator and Vulkan driver suit each kind of game.
- [KosmicKrisp](/maclauncher/windows/kosmickrisp/): the newer of the two programs that let Vulkan games draw with Metal (it is built on Metal 4), MacLauncher's own build of it, and how it compares with MoltenVK, the older one.
- [Translator versions](/maclauncher/windows/translator-versions/): any translator version for any game, and how that compares with patching CrossOver.
- [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/): the graphics layer and temporal upscaling in WINE games.
- [Runtime settings](/maclauncher/windows/settings/) and [existing bottles and wrappers](/maclauncher/windows/existing-bottles/).

The [Windows Game reference](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOWS.md) has every detail of detection and import.
