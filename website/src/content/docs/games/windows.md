---
title: Windows games through WINE
description: "Which Windows games MacLauncher plays through WINE on macOS: Windows Game entries, the Windows builds of games made with other engines, and engines with no Mac player, run with Sikarugir or CrossOver."
head:
  - tag: title
    content: "Windows games on Mac with WINE: Sikarugir and CrossOver | MacLauncher"
sidebar:
  order: 3
---

Not every Windows game is built on an engine with a Mac runtime. Custom engines, [Unreal](https://www.unrealengine.com/) games, Unity [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) builds and countless older titles need Windows itself, or at least something that speaks its language. For those, MacLauncher uses **[WINE](https://www.winehq.org/)**, the compatibility layer that answers a game's Windows API calls with macOS equivalents, through one of its two WINE runtimes, Sikarugir and CrossOver.

Playing Windows games through WINE has its own section on this site, [Windows games and WINE](/maclauncher/windows/), which explains how the two runtimes work, how graphics translators turn Direct3D into Metal, and what MacLauncher adds on top of WINE. Which games get the WINE runtimes in the first place depends on how MacLauncher identifies them on import.

## Windows Game

A Windows executable whose engine MacLauncher doesn't recognize is imported as a **Windows Game**, and its only runtimes are Sikarugir, the default, and CrossOver. You can import the `.exe` itself or the folder it's in. In a folder, MacLauncher looks for the game's executable at the top level and ignores uninstallers, setup programs, updaters, redistributables and crash reporters. If several executables remain, import asks you to pick one.

x86 and x64 Windows games can be played. DOS programs (which [DOSBox Staging](/maclauncher/games/more/) handles), DLLs, Windows ARM64 executables and installers that need a further installation step can't be.

## Games made with other engines

Plenty of games made with a recognized engine, such as Ren'Py, RPG Maker, Unity, Godot, GameMaker or Construct, also ship a Windows build. Any game with a working x86 or x64 Windows executable offers Sikarugir and CrossOver next to its native runtime, whatever its engine, and keeps its engine's game type, default runtime and tools. It doesn't matter whether you imported the folder, the Windows `.exe` or another launcher file, such as a Ren'Py `.sh` script.

When it imports a game, MacLauncher picks out the main executable and ignores uninstallers, setup programs, redistributables and crash reporters. A game that lives inside a Mac `.app` runs as that app and doesn't get the WINE runtimes. An app that merely sits beside a Windows build changes nothing, so a Ren'Py release with a Windows `.exe`, a Linux `.sh` script and a Mac `.app` side by side still offers both.

The chosen executable is saved with the game, and the runtime list reads that record instead of the game's files. A game on an unplugged drive therefore keeps its WINE choices. If an update renames the executable, MacLauncher records the new one the next time it refreshes the game's details, at startup or when the drive comes back.

## Engines with no Mac player

A few game types have tools in MacLauncher but no runtime that can play them on a Mac: BGI / Ethornell and CatSystem2 visual novels, and Haxe native builds. These games play their original Windows executable through WINE, with a registered CrossOver application when you have one and with Sikarugir otherwise.

## More about WINE games

- [Windows games and WINE](/maclauncher/windows/): how a Windows game runs on a Mac, and what MacLauncher adds.
- [CrossOver and Sikarugir](/maclauncher/windows/crossover-and-sikarugir/): the two runtimes, and where each game's Windows files live.
- [Graphics translators](/maclauncher/windows/graphics-translators/): DXMT, D3DMetal, DXVK, MoltenVK, KosmicKrisp and the rest, and how to choose one.
- [Choosing a translator](/maclauncher/windows/choosing-a-translator/): which translator and Vulkan driver suit each kind of game.
- [KosmicKrisp](/maclauncher/windows/kosmickrisp/): the Vulkan driver on Metal 4, MacLauncher's own build of it, and how it compares with MoltenVK.
- [Translator versions](/maclauncher/windows/translator-versions/): any translator version for any game, and how that compares with patching CrossOver.
- [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/): the graphics layer and temporal upscaling in WINE games.
- [Runtime settings](/maclauncher/windows/settings/) and [existing bottles and wrappers](/maclauncher/windows/existing-bottles/).

The [Windows Game reference](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOWS.md) has every detail of detection and import.
