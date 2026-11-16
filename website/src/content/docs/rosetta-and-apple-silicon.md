---
title: Rosetta and Apple Silicon
description: "Apple keeps Rosetta as a general-purpose translator through macOS 27. Which parts of MacLauncher still run Intel code, how FEX differs from Rosetta, and how each part is moving to Apple Silicon."
head:
  - tag: title
    content: "Rosetta and Apple Silicon: Intel code in MacLauncher after macOS 27 | MacLauncher"
---

Almost everything in MacLauncher already runs natively on Apple Silicon: the launcher itself, the graphics layer, the Android, iPhone and Switch runtimes, and most game engines. A few parts still contain Intel code, though, and on an Apple Silicon Mac they run through [Rosetta](https://support.apple.com/en-us/102527), Apple's translator for Intel programs. Apple has said how long Rosetta stays around in its current form, so this page covers what that means for MacLauncher and how each of those parts is moving to Apple Silicon.

## Apple's timeline

Apple's developer documentation, in [About the Rosetta translation environment](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment), puts it this way:

> Rosetta was designed to make the transition to Apple silicon easier, and will be available through macOS 27 — as a general-purpose tool for Intel apps to help developers complete the migration of their apps. Beyond this timeframe, we will keep a subset of Rosetta functionality aimed at supporting older unmaintained gaming titles, that rely on Intel-based frameworks.

Through macOS 27, then, Rosetta keeps working the way it does today. From macOS 28 on, only that subset remains, and the statement doesn't say what the subset covers. MacLauncher doesn't count on it, so the aim is for every part to work on Apple Silicon without Rosetta.

## Rosetta and FEX

A program needs two things from a computer: a processor that understands its instructions, and an operating system that answers its requests, as [How games run on a Mac](/maclauncher/background/how-games-run/#what-a-game-actually-needs) explains. Rosetta takes care of both for Intel Mac programs. It translates their x86-64 instructions into ARM64, and when a translated program calls into macOS to open a window, draw with Metal or play a sound, Rosetta connects that call to the real, native macOS frameworks.

[FEX](https://github.com/FEX-Emu/FEX) is an open-source translator for x86 and x86-64 code, and it handles only the first half. It has no connection to the macOS frameworks, so everything the translated code calls has to be something that already runs natively. That happens to be exactly the situation inside WINE. A Windows game never calls macOS directly: it calls the Windows API, and WINE is what supplies that API. When WINE itself is built for Apple Silicon, FEX translates the game's x86-64 or x86 code, along with Windows libraries such as DXVK, while WINE answers every request natively. Windows libraries built as ARM64EC or ARM64X skip the translation altogether.

That leads to one simple rule:

- **FEX can stand in for Rosetta** wherever MacLauncher or a WINE supplies the operating system that the x86 code talks to. Windows games in an Apple Silicon WINE are the main case, and PS5 games are a candidate too, since AnyPS5 supplies the PS5's system libraries itself.
- **Intel Mac programs need Apple Silicon builds.** An Intel build of a Mac engine or library calls the macOS frameworks directly, and FEX has nothing to connect those calls to. The way forward for these is a native build, or a newer upstream version that already has one.

## Where each part stands

The table lists every part of MacLauncher with Intel code today, the route to running it without Rosetta, and where that route stands. **Available** means you can use it now, **In progress** means it's being built, and **Not planned** comes with its reason. [Processor compatibility](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/PROCESSOR_COMPATIBILITY.md) in the reference documentation lists the processor of every component, including the many that are already native.

| Intel code today | Route without Rosetta | State |
| --- | --- | --- |
| CrossOver's Intel WINE | CrossOver builds with ARM64 WINE, which MacLauncher runs natively, with FEX translating the game | Available |
| Sikarugir and WineCX, including the Mac libraries they come with, such as GStreamer | Apple Silicon WINEs with FEX, [MetalSharp](https://github.com/metalsharp/MetalSharp-Wine) and [Highball](https://github.com/gauthierpiarrette/highball), next to the existing WINEs | In progress |
| Windows games and the Windows side of their translators and adapters: DXVK, vkd3d-proton, DXVK-NVAPI, the DLSS and FidelityFX adapters and the Steam bridge | FEX runs them inside an Apple Silicon WINE. DXVK-NVAPI already includes an ARM64X build, and the Steam bridge an Apple Silicon Mac library | Available |
| MacLauncher's WINE graphics helpers: its DXMT build for DLSS forwarding, Streamline camera forwarding, the XeSS GPU host and the Vulkan scene connection | Apple Silicon builds, loaded by Apple Silicon WINEs | In progress |
| DXMT from its upstream releases and Sikarugir Templates | MacLauncher's Apple Silicon build of DXMT's Mac library, inside an Apple Silicon WINE | In progress |
| D3DMetal | None for D3DMetal itself; Apple Silicon WINEs translate Direct3D with DXVK and vkd3d-proton | Not planned (D3DMetal is Apple's closed Intel framework, so only Apple can build it for Apple Silicon) |
| AnyPS5 and Prosper (PS5 games) | Keep the PS5 game code as x86 and run it under FEX in an Apple Silicon program, with the PS5 system libraries built for Apple Silicon. AnyPS5 comes first, starting with a feasibility check, and Prosper then reuses the same FEX setup | In progress |
| HashLink (Haxe games) | An Apple Silicon JIT compiler in upstream HashLink | Not planned (HashLink's JIT compiler writes Intel code as the game runs, and every HashLink native module calls macOS directly, so FEX doesn't fit) |
| mac32 (32-bit Mac apps) | None | Not planned (32-bit Mac apps call Cocoa, Carbon and OpenGL directly, which FEX can't provide) |
| RLVM (RealLive visual novels) | An Apple Silicon build of RLVM | In progress |
| LÖVE 0.10.2 | An Apple Silicon build of LÖVE 0.10.2. LÖVE 11.5 is already Universal, for games that run on it | In progress |
| Java 8 | Java 21 for Apple Silicon, which MacLauncher already recommends for Java 8 games | Available |
| The Steamworks 1.9 bridge for Java games | An Apple Silicon build of the 1.9 bridge | In progress |
| Older Ren'Py SDKs, such as 7.3.5 and 8.0.3 | Newer Universal Ren'Py SDKs, for games that run on them | Available |
| SteamCMD, for downloading Lossless Scaling models | **Download from Steam…** through the Mac Steam app, **Find in Steam / CrossOver** or **Import Lossless Scaling DLL…** | Available |

A game that runs only on an older Intel Ren'Py SDK, or on an Intel Java because it ships Intel-only native libraries of its own, still uses Rosetta.

Each Apple Silicon route is added next to the existing Intel one as another choice in the same menus, rather than replacing it. **Runtimes** already lists the WINE runtimes under **Wine · Apple Silicon** and **Wine · Intel (Rosetta)**, sorted by the processor of their actual files rather than their names.

Further reading: [Macs and macOS versions](/maclauncher/macs-and-macos/) for which features need which Mac, [CrossOver, Sikarugir and WineCX](/maclauncher/windows/crossover-and-sikarugir/) for the WINE runtimes, the [Rosetta](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/ROSETTA.md) reference page for how MacLauncher installs Rosetta, and the [FEX project](https://github.com/FEX-Emu/FEX) for more about FEX.
