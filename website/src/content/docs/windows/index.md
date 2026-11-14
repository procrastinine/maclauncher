---
title: Windows games and WINE
description: "How MacLauncher plays Windows games on macOS through WINE, with Sikarugir, CrossOver or WineCX, a private Windows environment for each game, a choice of graphics translators, and graphics effects and upscaling."
head:
  - tag: title
    content: "Windows games on Mac with WINE, CrossOver, Sikarugir and WineCX | MacLauncher"
sidebar:
  order: 0
  label: Overview
---

Many Windows games don't need WINE on a Mac, because their engine has a native macOS runtime. Plenty of others do. Games on custom engines, [Unreal](https://www.unrealengine.com/) games, Unity games built with [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) (which compiles the game's code into Windows machine code) and countless older titles need Windows itself, or something that can stand in for it. That stand-in is [WINE](https://www.winehq.org/), a compatibility layer that lets Windows programs run on other operating systems. MacLauncher plays these games through one of three WINE distributions for the Mac: [Sikarugir](https://github.com/Sikarugir-App/Sikarugir), a free distribution that MacLauncher downloads for you; [WineCX](https://github.com/dappermint/winecx-gptk), a free WINE that dappermint builds from CrossOver's own WINE changes, which MacLauncher also downloads; or [CrossOver](https://www.codeweavers.com/crossover/), CodeWeavers' paid app, if you own it.

Windows games are one of MacLauncher's major features. Besides starting the game in WINE, MacLauncher gives every game its own Windows environment and lets each game pick its own graphics translator and version. It also keeps your existing CrossOver bottles and Sikarugir wrappers safe, and it brings its graphics effects and upscalers to WINE games. The pages in this section explain each part, starting with what WINE does.

## How a Windows game runs on a Mac

A Windows game expects Windows itself, an x86 processor and Microsoft's Direct3D for graphics. No Mac has Windows or Direct3D, and an Apple Silicon Mac doesn't have an x86 processor either, so a different layer stands in for each one.

WINE stands in for Windows as a compatibility layer. The game's own code runs on your Mac's processor, and when the game asks Windows for something, such as opening a window or reading a file, WINE answers with the macOS equivalent. Nothing about the PC is emulated. [How games run on a Mac](/maclauncher/background/how-games-run/#compatibility-layers-translate-the-conversation) explains the idea in more detail.

On Apple Silicon, Apple's [Rosetta 2](https://support.apple.com/en-us/102527) takes care of the processor. WINE on the Mac usually runs as an Intel program, and Rosetta translates its x86 code, and the game's, into ARM code. A CrossOver build whose WINE is an ARM64 program instead leaves the game's Intel code to FEX, an emulator that runs x86 code on ARM processors. If Rosetta isn't installed yet, MacLauncher asks and installs it through the normal macOS prompt.

Graphics need one more piece, because macOS draws with [Metal](https://developer.apple.com/metal/) and has no Direct3D. A *graphics translator* turns the game's Direct3D calls into Metal. Some translators do that directly. Others turn Direct3D into [Vulkan](https://www.vulkan.org/), a cross-platform graphics API, and rely on a *Vulkan driver* to carry out the Vulkan work with Metal. The Mac has two Vulkan drivers: MoltenVK, the long-established one, which runs on Intel and Apple Silicon Macs, and KosmicKrisp, a newer driver that implements all of Vulkan 1.4 on Apple Silicon Macs with macOS 26 or later. MacLauncher also has its own build of KosmicKrisp, which adds features that some translators need, and [KosmicKrisp](/maclauncher/windows/kosmickrisp/) explains the difference. A game can behave differently with different translators, so MacLauncher lets you choose one for each game, and [Graphics translators](/maclauncher/windows/graphics-translators/) explains the options.

Some Windows games also have a native Mac version, either an official build or a community port, and those don't need any of this. When a game lives inside a working Mac `.app`, MacLauncher runs the app itself and doesn't offer WINE for it.

## When MacLauncher uses WINE

MacLauncher prefers a native runtime whenever there is one. A game made with an engine it recognizes, such as Ren'Py, RPG Maker, Godot or Unity's Mono builds, starts on that engine's native runtime by default. If the game also includes a compatible Windows executable, the WINE runtimes appear next to the native runtime as alternatives, which you can pick in the game's inspector.

A Windows executable whose engine MacLauncher doesn't recognize becomes a **Windows Game**, and its runtimes are Sikarugir, CrossOver and WineCX. Sikarugir is the default, and you can make another one the default in **Settings**. A few game types (BGI / Ethornell, CatSystem2 and Haxe native builds) have tools but no Mac player at all, so they play through CrossOver when you have it and through Sikarugir otherwise. [Windows games through WINE](/maclauncher/games/windows/) covers which games get the WINE runtimes and how MacLauncher picks the right executable.

## Sikarugir, CrossOver or WineCX

All three package WINE for the Mac together with graphics translators, but they come from different places. Sikarugir is free, and MacLauncher downloads and sets it up for you. CrossOver is a commercial product from CodeWeavers that you install and license yourself; MacLauncher finds it and uses it, but never downloads or updates it. WineCX sits in between. It's free and downloaded for you like Sikarugir, but its WINE is built from CodeWeavers' CrossOver changes on a current WINE release, so Apple's D3DMetal translator can load into it as it does in CrossOver. Current WineCX releases need macOS 26.

If you own CrossOver, it's usually the better choice, because CodeWeavers keeps it current with fixes for newer games. Otherwise Sikarugir is always there, and WineCX is a newer WINE to try when a game needs one. MacLauncher runs all three on one shared WINE layer, so the rest of this section works the same whichever one a game uses. [CrossOver, Sikarugir and WineCX](/maclauncher/windows/crossover-and-sikarugir/) compares them in more detail.

## What MacLauncher adds

CrossOver, Sikarugir and WineCX supply WINE itself. Everything below is MacLauncher's own work on top of them, and none of it modifies the CrossOver application, a Sikarugir engine, a WineCX release or their support libraries.

### A Windows environment for every game

WINE keeps a game's Windows registry, installed DLLs and Windows user folders in a Windows environment, which CrossOver calls a bottle and WINE calls a prefix. Using Sikarugir on its own means installing its Creator app and building a "wrapper" app for each game. In MacLauncher, a private bottle or prefix is created for the game the first time you press **Play**, and the game runs from its original folder without being copied. That environment survives CrossOver updates and changes of WINE version, so the game's Windows-side saves and settings stay put. Because games don't share an environment, one game's DLL overrides and registry changes can't affect another.

### Your own bottles and wrappers stay yours

If you already have a CrossOver bottle or a Sikarugir wrapper that a game is set up in, MacLauncher can run the game there instead. It uses the bottle where it is and never deletes, recreates, moves or replaces it, and **Stop** ends only that game unless you confirm closing everything else in the bottle. [Existing bottles and wrappers](/maclauncher/windows/existing-bottles/) has the details.

### A graphics translator for each game

On its own, CrossOver chooses among the graphics engines that ship with that CrossOver release, and community tools such as CXPatcher update those engines by patching a copy of the app. MacLauncher keeps translators outside the WINE distributions instead. Each game can use the translators its WINE distribution includes, newer or older releases from the translators' own projects, such as [DXMT](https://github.com/3Shain/dxmt) (Direct3D 10 and 11 to Metal) and [DXVK](https://github.com/doitsujin/dxvk) (Direct3D 8 to 11 to Vulkan), files you downloaded yourself, or D3DMetal from your own copy of Apple's [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/). The Vulkan driver, the Direct3D 12 translator and the video codecs can be chosen separately, too. As a result, one game can try a newer DXVK while your other games keep theirs, and a CrossOver update leaves every choice in place. [Runtime patching](/maclauncher/tools/runtime-patching/) explains why this helps and walks through it step by step. [Graphics translators](/maclauncher/windows/graphics-translators/) explains what each translator does, and [Translator versions](/maclauncher/windows/translator-versions/) explains how the versions work.

Direct3D 12 games get more options this way. Besides Apple's D3DMetal and WINE's own vkd3d, they can run through [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton), the Direct3D 12 translator from Proton, the compatibility layer Valve uses to run Windows games on Linux. vkd3d-proton needs a capable Vulkan driver, and MacLauncher provides one in its own build of the KosmicKrisp Vulkan driver. On it, vkd3d-proton reports Direct3D feature level 12_1 in the default performance mode and 12_2 in conformance mode; a feature level is the set of Direct3D capabilities a game can count on, and [KosmicKrisp](/maclauncher/windows/kosmickrisp/#direct3d-12-games-through-vkd3d-proton) explains what each one means for a game. Paired with DXVK for Direct3D 8 to 11, vkd3d-proton gives you the graphics path Proton uses on Linux. Any game in CrossOver, Sikarugir or WineCX can be set up this way, as [Proton's graphics path on a Mac](/maclauncher/windows/graphics-translators/#protons-graphics-path-on-a-mac) describes.

### One copy of each version

Each translator version is downloaded and installed once. Every game that selects it links to that one installation, so adding a second game with the same choice takes no extra space for the translator.

### Choices that check themselves

Before a game starts, MacLauncher reads the translator's actual files to see whether it can load with this WINE and this macOS. Version numbers and lists of tested versions aren't involved. If the chosen translator can't load, the game starts with the same translator from its WINE distribution instead, or with the distribution's automatic choice, and the inspector shows what you chose, what ran and why.

### Effects and upscaling for WINE games

MacLauncher's [graphics layer](/maclauncher/graphics/) works on WINE games, and it adapts to the translator the game actually uses. On Apple Silicon, games with DLSS or XeSS support (NVIDIA's and Intel's upscalers) can also pass their frame data to MacLauncher's [temporal upscalers](/maclauncher/graphics/upscaling/#temporal-upscalers). [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/) explains how.

### Settings in one place

Each game's Runtime Settings gather WINE's display, input, compatibility and diagnostic options, from Retina mode, the language locale and custom virtual desktop sizes to keyboard mapping and performance HUDs. They also hold environment variables for WINE and each translator, and **Settings → Environment variables** sets those for every game. A game in an existing bottle can keep the bottle's current values. [Runtime settings](/maclauncher/windows/settings/) lists them.

### Steam for Windows games

Windows games from Steam can talk to the Steam client for Mac through the optional [Steam client bridge](/maclauncher/windows/steam-client-bridge/). Play offers it for games that include Valve's Steam API once the Steam client for Mac is installed. You don't need to install the Windows version of Steam in the bottle, and Steam itself isn't patched.

## What to expect

WINE is very good, but it's a translation, so results vary from game to game. Games whose DRM or anti-cheat requires real Windows won't run. Installers that need to install further components can't be played as games either; point MacLauncher at the installed game folder or its main `.exe` instead.

If a game's engine has a [native runtime](/maclauncher/games/desktop-engines/), try that first, since it will usually run better. If a WINE game misbehaves, try another Direct3D translator, another WINE version, or another WINE runtime, such as CrossOver if you have it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#windows-games) has more on choosing between them.

:::tip[Full reference]
The repository's reference pages document every detail: [Windows Game](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOWS.md), [Wine runtimes](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINE.md), [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md), [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md), [WineCX](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINECX.md) and [Graphics translators](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md).
:::
