---
title: Windows games and WINE
description: "How MacLauncher plays Windows games on macOS through WINE, with Sikarugir or CrossOver, a private Windows environment for each game, a choice of graphics translators, and graphics effects and upscaling."
head:
  - tag: title
    content: "Windows games on Mac with WINE, CrossOver and Sikarugir | MacLauncher"
sidebar:
  order: 0
  label: Overview
---

Many Windows games don't need WINE on a Mac, because their engine has a native macOS runtime. Plenty of others do. Games on custom engines, [Unreal](https://www.unrealengine.com/) games, Unity [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) builds and countless older titles need Windows itself, or something that can stand in for it. MacLauncher plays them through **[WINE](https://www.winehq.org/)**, with one of two WINE distributions: [Sikarugir](https://github.com/Sikarugir-App/Sikarugir), which is free and which MacLauncher downloads for you, or CodeWeavers' [CrossOver](https://www.codeweavers.com/crossover/), if you own it.

This is one of MacLauncher's major features. Besides starting the game in CrossOver or Sikarugir, MacLauncher gives every game its own Windows environment, lets each game pick its own graphics translator and version, keeps your existing CrossOver bottles and Sikarugir wrappers safe, and brings its graphics effects and upscalers to WINE games. The pages in this section explain each part, starting with what WINE does.

## How a Windows game runs on a Mac

A Windows game expects three things a Mac doesn't have: Windows itself, an x86 processor, and Microsoft's Direct3D for graphics. A different layer stands in for each one.

WINE replaces Windows. It's a compatibility layer, not an emulator: the game's own code runs on your Mac's processor, and WINE answers its requests to Windows, such as opening a window or reading a file, with the macOS equivalent. [How games run on a Mac](/maclauncher/background/how-games-run/#compatibility-layers-translate-the-conversation) explains the idea in more detail.

On Apple Silicon, Apple's [Rosetta 2](https://support.apple.com/en-us/102527) takes care of the processor. WINE on the Mac usually runs as an Intel program, and Rosetta translates its x86 code, and the game's, into ARM code. A CrossOver build whose WINE is an ARM64 program leaves the game's Intel code to the FEX emulator instead. If Rosetta isn't installed yet, MacLauncher asks and installs it through the normal macOS prompt.

Graphics need one more piece, because macOS draws with [Metal](https://developer.apple.com/metal/) and has no Direct3D. A **graphics translator** turns the game's Direct3D calls into Metal, either directly or through [Vulkan](https://www.vulkan.org/) and a Vulkan driver that runs on Metal. A game can behave differently with different translators, so MacLauncher lets you choose one for each game; [Graphics translators](/maclauncher/windows/graphics-translators/) explains the options.

Some Windows games also have a native Mac version, either an official build or a community port. Those don't need any of this: when a game lives inside a working Mac `.app`, MacLauncher runs the app itself and doesn't offer WINE for it.

## When MacLauncher uses WINE

MacLauncher prefers a native runtime whenever there is one. A game made with an engine it recognizes, such as Ren'Py, RPG Maker, Godot or Unity's Mono builds, starts on that engine's native runtime by default. If the game also includes a compatible Windows executable, Sikarugir and CrossOver appear next to the native runtime as alternatives, which you can pick in the game's inspector.

A Windows executable whose engine MacLauncher doesn't recognize becomes a **Windows Game**, and its only runtimes are Sikarugir and CrossOver. Sikarugir is the default, and you can make CrossOver the default in **Settings**. A few game types, BGI / Ethornell, CatSystem2 and Haxe native builds, have tools but no Mac player at all, so they play through CrossOver when you have it and through Sikarugir otherwise. [Windows games through WINE](/maclauncher/games/windows/) covers which games get the WINE runtimes and how MacLauncher picks the right executable.

## CrossOver or Sikarugir

Both are distributions of WINE for the Mac, with graphics translators included. Sikarugir is free, and MacLauncher downloads and sets it up for you. CrossOver is a commercial product that you install and license yourself; MacLauncher finds it and uses it, but never downloads or updates it. If you own CrossOver, it's usually the better choice, because CodeWeavers keeps it current with fixes for newer games. Otherwise Sikarugir is always there. [CrossOver and Sikarugir](/maclauncher/windows/crossover-and-sikarugir/) compares them in more detail.

## What MacLauncher adds

CrossOver and Sikarugir supply WINE itself. Everything below is MacLauncher's own work on top of them, and none of it modifies the CrossOver application, a Sikarugir engine or its support libraries.

### A Windows environment for every game

WINE keeps a game's Windows registry, installed DLLs and Windows user folders in a Windows environment, which CrossOver calls a bottle and WINE calls a prefix. Using Sikarugir on its own means installing its Creator app and building a "wrapper" app for each game. In MacLauncher, the first time you press **Play**, a private bottle or prefix is created for that game alone, and the game runs from its original folder without being copied. That environment survives CrossOver updates and changes of WINE version, so the game's Windows-side saves and settings stay put. Games don't share an environment, so one game's DLL overrides and registry changes can't affect another.

### Your own bottles and wrappers stay yours

If you already have a CrossOver bottle or a Sikarugir wrapper that a game is set up in, MacLauncher can run the game there instead. It uses the bottle where it is and never deletes, recreates, moves or replaces it, and **Stop** ends only that game unless you confirm closing everything else in the bottle. [Existing bottles and wrappers](/maclauncher/windows/existing-bottles/) has the details.

### A graphics translator for each game

On its own, CrossOver chooses among the graphics engines that ship with that CrossOver release, and community tools such as CXPatcher update those engines by patching a copy of the app. MacLauncher keeps translators outside CrossOver and Sikarugir instead. Each game can use CrossOver's or Sikarugir's own engines, newer or older upstream releases such as [DXMT](https://github.com/3Shain/dxmt) and [DXVK](https://github.com/doitsujin/dxvk), files you downloaded yourself, or D3DMetal from your own copy of Apple's [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/). The Vulkan driver, the Direct3D 12 translator and the video codecs can be chosen separately, too. One game can therefore try a newer DXVK while your other games keep theirs, and a CrossOver update leaves every choice in place. [Graphics translators](/maclauncher/windows/graphics-translators/) explains what each translator does, and [Translator versions](/maclauncher/windows/translator-versions/) how the versions work.

Direct3D 12 games get more than one route this way. Besides Apple's D3DMetal and WINE's own vkd3d, they can run through [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton), the Direct3D 12 translator from Valve's Proton, on MacLauncher's own build of the KosmicKrisp Vulkan driver. vkd3d-proton reports Direct3D feature level 12_1 there, and [KosmicKrisp](/maclauncher/windows/kosmickrisp/#direct3d-12-games-through-vkd3d-proton) explains what that means for a game. Paired with DXVK for Direct3D 8 to 11, that's the graphics path Valve's Proton uses on Linux, open to any game in CrossOver or Sikarugir that you set up this way, as [Proton's graphics path on a Mac](/maclauncher/windows/graphics-translators/#protons-graphics-path-on-a-mac) describes.

### One copy of each version

Each translator version is downloaded and installed once. Every game that selects it links to that one installation, so adding a second game with the same choice takes no extra space for the translator.

### Choices that check themselves

Before a game starts, MacLauncher reads the translator's actual files to see whether it can load with this WINE and this macOS. Version numbers and lists of tested versions aren't involved. If the chosen translator can't load, the game starts with the same engine from its WINE distribution instead, or with the distribution's automatic choice, and the inspector shows what you chose, what ran and why.

### Effects and upscaling for WINE games

MacLauncher's [graphics layer](/maclauncher/graphics/) works on WINE games, and it's set up for the translator the game actually uses. Games with DLSS or XeSS support can also feed MacLauncher's [temporal upscalers](/maclauncher/graphics/upscaling/#temporal-upscalers) on Apple Silicon. [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/) explains how.

### Settings in one place

Each game's Runtime Settings gather WINE's display, input, compatibility and diagnostic options, from Retina mode and custom virtual desktop sizes to keyboard mapping and performance HUDs. A game in an existing bottle can keep the bottle's current values. [Runtime settings](/maclauncher/windows/settings/) lists them.

### Steam for Windows games

Windows games from Steam can talk to the Steam client for Mac through the optional [Steam client bridge](/maclauncher/windows/steam-client-bridge/), which Play offers for games that include Valve's Steam API once the Steam client for Mac is installed.

## What to expect

WINE is very good, but it's a translation, so results vary from game to game. Games whose DRM or anti-cheat requires real Windows won't run. Installers that need to install further components can't be played as games either; point MacLauncher at the installed game folder or its main `.exe` instead.

If a game's engine has a [native runtime](/maclauncher/games/desktop-engines/), try that first, since it will usually run better. If a WINE game misbehaves, try another Direct3D engine, another WINE version, or CrossOver if you have it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#windows-games) has more on choosing between them.

:::tip[Full reference]
The repository's reference pages document every detail: [Windows Game](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOWS.md), [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md), [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md) and [Graphics translators](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md).
:::
