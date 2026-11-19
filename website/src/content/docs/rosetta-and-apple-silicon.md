---
title: Preparing for the end of Rosetta
description: "What changes in macOS 28, what FEX does, and which MacLauncher runtimes already have an Apple Silicon route."
head:
  - tag: title
    content: "Preparing for the end of Rosetta | MacLauncher"
---

The Apple Silicon MacLauncher app, its graphics layer and many of its game engines already run natively. Some runtimes still use Intel Mac programs or libraries, and those need Rosetta on Apple Silicon. Other runtimes work differently. They can run an Intel game inside a native host, using FEX to translate just the game's code.

## Apple's timeline

macOS 27 is the last release with Rosetta for general Intel Mac apps. With macOS 28, Apple keeps a limited version for some older games that are no longer maintained and depend on Intel frameworks. An Intel Mac runtime that needs general-purpose Rosetta therefore needs a different route. [Apple Support](https://support.apple.com/en-us/102527), [Apple Developer](https://developer.apple.com/news/?id=w5ngl9k2)

## Rosetta and FEX

A program needs a processor that understands its instructions and an operating system that answers its requests. Rosetta lets an Intel Mac program run on Apple Silicon while it keeps using macOS. [How games run on a Mac](/maclauncher/background/how-games-run/#what-a-game-actually-needs)

FEX translates x86 and x86-64 instructions. It can do that inside an Apple Silicon host that already supplies the game's system interfaces. For a Windows game, Wine supplies the Windows API. For a PS5 game, AnyPS5 supplies the PS5 libraries. A Mac engine or library that calls macOS directly needs its own Apple Silicon build. [FEX](https://github.com/FEX-Emu/FEX)

Explore [Windows games on Apple Silicon](/maclauncher/rosetta/windows-on-apple-silicon/), [PS5 games through FEX](/maclauncher/rosetta/ps5-through-fex/) and [MacLauncher's Apple Silicon builds](/maclauncher/rosetta/apple-silicon-builds/).

## Where each part stands

The table shows which choices already have a route off Rosetta and which still use it on Apple Silicon. The processor reference also covers the components that are already native. [Processor compatibility](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/PROCESSOR_COMPATIBILITY.md)

| Intel code today | Route without Rosetta | State |
| --- | --- | --- |
| CrossOver's Intel Wine | CrossOver builds with ARM64 Wine and FEX | Available in CodeWeavers' ARM64 preview |
| Sikarugir and WineCX, including their Mac libraries | MetalSharp Wine and Highball Wine offer native Wine with FEX | Alternatives available |
| Windows games and x86 Windows libraries | FEX translates the Windows code inside Apple Silicon Wine. Compatible ARM64X libraries can run their ARM code directly | Available with Apple Silicon Wine |
| The Steam bridge's Intel Wine library | The Steam client bridge includes an Apple Silicon `lsteamclient.so` | Available |
| MacLauncher's WineVulkan scene connection | The arm64 WineVulkan Scene build for MetalSharp Wine 11.20 | Available |
| Intel Wine helpers for DXMT DLSS forwarding, Streamline camera forwarding and the XeSS GPU host | These particular helper routes use Intel Wine | Rosetta required |
| Intel DXMT in upstream releases and Sikarugir Templates | **MacLauncher DXMT** has ARM64X Windows libraries and a native Metal renderer for MetalSharp Wine | Available |
| D3DMetal | DXVK and vkd3d-proton are alternative translators in Apple Silicon Wine | D3DMetal uses Intel Wine |
| AnyPS5 converted games | AnyPS5 FEX runs the game inside an Apple Silicon host with native PS5 system libraries | MCLv13 is published and requires macOS 27.0 |
| Prosper (PS5 games) | The published Prosper runtime runs as an Intel Mac program | Rosetta required |
| HashLink (Haxe games) | The shipped HashLink versions have a JIT compiler that emits Intel code | Rosetta required |
| mac32 (32-bit Mac apps) | Its Intel host runs Mac code that calls macOS frameworks | Rosetta required |
| RLVM (RealLive visual novels) | MacLauncher Builds publishes Universal RLVM 0.14 | Available |
| Intel LÖVE 0.10.2 | MacLauncher Builds publishes the same LÖVE version as a Universal package | Available |
| Java 8 | Java 21 for Apple Silicon, which MacLauncher already recommends for Java 8 games | Available |
| The Intel Steamworks 1.9 bridge for Java games | The Universal Steamworks 1.9 bridge works with a compatible Apple Silicon Java | Available |
| Older Ren'Py SDKs, such as 7.3.5 and 8.0.3 | Newer Universal Ren'Py SDKs, for games that run on them | Available |
| SteamCMD, for downloading Lossless Scaling models | MacLauncher can use the installed Steam app or import a copy of the DLL | Alternatives available |

A game that runs only on an older Intel Ren'Py SDK, or on an Intel Java because it ships Intel-only native libraries of its own, still uses Rosetta.

In **Runtimes**, **Wine · Apple Silicon** and **Wine · Intel** show the builds by the CPU of the actual Wine program. The Apple Silicon version of a Mac app wrapper alone says little about which Wine it contains.

Further reading: [Macs and macOS versions](/maclauncher/macs-and-macos/) for which features need which Mac, [CrossOver, Sikarugir and WineCX](/maclauncher/windows/crossover-and-sikarugir/) for the WINE runtimes, the [Rosetta](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/ROSETTA.md) reference page for how MacLauncher installs Rosetta, and the [FEX project](https://github.com/FEX-Emu/FEX) for more about FEX.
