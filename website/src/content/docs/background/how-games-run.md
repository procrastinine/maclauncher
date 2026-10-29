---
title: How games run on a Mac
description: Virtual machines, emulators, compatibility layers like WINE, and native runtimes — what each one does, and why MacLauncher prefers the last two.
sidebar:
  order: 1
---

If you have ever tried to play a Windows game on a Mac, you have probably run into a pile of words: *[virtual machine](https://en.wikipedia.org/wiki/Virtual_machine)*, *[emulator](https://en.wikipedia.org/wiki/Emulator)*, *[WINE](https://www.winehq.org/)*, *[CrossOver](https://www.codeweavers.com/crossover/)*, *[Rosetta](https://support.apple.com/en-us/102527)*, *port*. They all get a game running somewhere it wasn't built for, but they do it in very different ways, and those differences decide how fast the game runs, how well it behaves, and what can go wrong.

This page walks through the four main approaches, from the heaviest to the lightest, plus a fifth that rebuilds the game itself. Once they click, most of MacLauncher's design makes sense: it reaches for the lightest approach that works for each game.

## What a game actually needs

A game is a program, and a program expects three things from the machine it runs on:

1. **A CPU that speaks its language.** Compiled code is a list of instructions for one processor family: [x86-64](https://en.wikipedia.org/wiki/X86-64) for most Windows PCs and the PlayStation 5, [ARM64](https://en.wikipedia.org/wiki/AArch64) for [Apple Silicon](https://en.wikipedia.org/wiki/Apple_silicon), phones and the Nintendo Switch.
2. **An operating system to talk to.** Games ask the OS to open windows, read files, play sounds and read the controller. Windows, macOS, Linux, Android and the consoles all expose these services through different interfaces ([APIs](https://en.wikipedia.org/wiki/API)).
3. **A graphics API.** Drawing goes through [DirectX](https://en.wikipedia.org/wiki/DirectX) on Windows, [Metal](https://developer.apple.com/metal/) on macOS, [Vulkan](https://www.vulkan.org/) or [OpenGL](https://www.khronos.org/opengl/) elsewhere.

Every approach below is a different answer to "what do we do when one of these doesn't match?"

## Virtual machines: bring the whole computer

A **virtual machine** (VM), such as [Parallels Desktop](https://www.parallels.com/products/desktop/), VMware Fusion or [UTM](https://getutm.app/), runs a complete second operating system inside a window. If you install Windows in a VM, the game sees a real Windows, with real Windows drivers, and has no idea it's on a Mac.

That makes VMs extremely compatible, but you pay for it: a whole second OS uses memory and disk, graphics have to cross the boundary between the VM and the Mac (usually the slowest part), and on Apple Silicon a VM can only run an ARM operating system. Windows on ARM then has to translate x86 games yet again. For games, VMs tend to be the "it works, but…" option.

MacLauncher doesn't use virtual machines.

## Emulators: pretend to be the hardware

An **emulator** recreates a different machine's hardware in software: its CPU, its graphics chip, its sound chip, its memory map. The original program runs unchanged, believing it is on the original hardware.

This is the classic way to play old consoles and old computers, and it is wonderfully faithful when done well. It is also expensive, because every instruction of the original machine has to be imitated, often many times per real instruction. For a 1990s DOS game that cost doesn't matter: a modern Mac has power to spare. For a modern 3D game, full hardware emulation is usually far too slow.

MacLauncher does use one emulator on purpose: [DOSBox Staging](https://www.dosbox-staging.org/) for DOS games, because those games are tiny and the machine they expect no longer exists anywhere.

## Compatibility layers: translate the conversation

A **[compatibility layer](https://en.wikipedia.org/wiki/Compatibility_layer)** takes a different approach. Instead of pretending to be a whole computer, it lets the game's code run on the real CPU and *translates its requests to the operating system*. When a Windows game asks Windows to open a file or create a window, the compatibility layer answers by doing the equivalent thing on macOS.

The famous one is WINE, whose name literally stands for "Wine Is Not an Emulator". WINE reimplements the Windows APIs on top of macOS and Linux. CrossOver is a commercial, polished distribution of WINE, and [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free one that MacLauncher can download and manage for you. Graphics get the same treatment: DirectX calls are translated into Metal, either directly, as Apple's D3DMetal (part of its [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/)) and [DXMT](https://github.com/3Shain/dxmt) do, or through Vulkan with [DXVK](https://github.com/doitsujin/dxvk) on top of [MoltenVK](https://github.com/KhronosGroup/MoltenVK).

There is one more wrinkle on Apple Silicon. Windows games are x86-64 code, and an M-series chip speaks ARM64. Apple's Rosetta 2 handles that by translating x86-64 instructions into ARM64 ahead of time and on the fly. So "a Windows game on CrossOver" on a modern Mac is really two translations stacked together: Rosetta for the CPU, WINE for the operating system.

Compatibility layers are much lighter than VMs and much faster than emulators, which is why they are the usual way to play Windows games on a Mac. But a translation is never perfect: some Windows behavior has no exact macOS equivalent, and you can feel it in window handling, mouse input, audio, or fullscreen switching.

### Not just Windows: consoles and phones

The same idea works for other platforms, and several of MacLauncher's more surprising runtimes are compatibility layers in exactly this sense.

- **PlayStation 5 → [AnyPS5](https://github.com/boykopovar/AnyPS5).** PS5 games are x86-64 programs, just like PC games. AnyPS5 converts the game's executable and modules into macOS programs and supplies its own implementations of the PS5's system libraries, much as WINE supplies Windows DLLs. Rosetta handles the x86-64 code and Vulkan (running on Metal) handles graphics. Nothing pretends to be a PlayStation.
- **Nintendo Switch → [nxnative](https://github.com/seedds/nxnative).** The Switch has an ARM64 CPU, the same instruction family as Apple Silicon, so the game's code can run directly on your Mac's processor once it has been prepared. nxnative provides the system services the game expects and turns its graphics into Metal, compiling the shaders ahead of time. That's the first-launch "preparation" step you see in MacLauncher.
- **Android → MacLauncher Android, [AIM](https://github.com/hahnlee/aim) and [Mac.apk](https://github.com/kksimp/Mac.apk).** An Android app is mostly Java or Kotlin bytecode plus, often, native ARM64 libraries. Instead of booting an Android phone in a VM, these runtimes run the Android *platform* on macOS. MacLauncher Android, for example, runs the real [Android 16](https://developer.android.com/about/versions/16) framework on Java, executes native ARM64 libraries directly on Apple Silicon, and maps windows, input, audio and graphics to their macOS equivalents. AIM goes further toward the original by running Android's own [ART runtime](https://source.android.com/docs/core/runtime) with Android services, still without a Linux kernel or virtual machine.
- **iOS → [PlayCover](https://github.com/PlayCover/PlayCover).** iPhone and iPad apps are already ARM64 programs for an Apple operating system, so Apple Silicon Macs can run them nearly as-is. [PlayTools](https://github.com/PlayCover/PlayTools) adds the missing pieces, such as keyboard and mouse mapping.

So when this site says these runtimes are "like WINE", that's the meaning: the game's own code runs on your real CPU (directly, or through Rosetta), and a layer translates what it asks of its home platform into macOS.

## Native runtimes: use the engine that already runs on macOS

The lightest approach of all skips translation entirely.

Most games aren't written from scratch. They are built on an **[engine](https://en.wikipedia.org/wiki/Game_engine)**: [Ren'Py](https://www.renpy.org/), [RPG Maker](https://www.rpgmakerweb.com/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/), [LÖVE](https://love2d.org/), KiriKiri and many more. The engine is the program; the game is largely *data* that the engine reads: scripts, maps, images, sounds. A Windows release of a game usually bundles the Windows build of its engine next to that data.

But many engines also exist for macOS, either from their authors or as open-source reimplementations. If you point the macOS engine at the game's data, the game runs natively, with no WINE, no Rosetta and no emulation. A few examples:

- A **Ren'Py** visual novel runs on the Ren'Py SDK for macOS.
- An **RPG Maker MV/MZ** game is a web app, so it runs on [Electron](https://www.electronjs.org/) or [NW.js](https://nwjs.io/).
- An **RPG Maker XP/VX/VX Ace** game runs on [MKXP-Z](https://github.com/mkxp-z/mkxp-z), an open-source reimplementation of the RPG Maker player.
- A **GameMaker** game such as [UNDERTALE](https://undertale.com/) can run on the official GameMaker macOS runner or on [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch).
- A **KiriKiri** visual novel runs on [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2), and a **Siglus** one runs on [siglus_rs](https://github.com/xmoezzz/siglus_rs).

This is what MacLauncher means by a **native runtime**, and it's the heart of the project. Native runtimes usually run faster, use less power, and behave like proper Mac apps: windows, fullscreen, mouse and audio all work the way macOS expects. The catch is matching. The engine has to be the right one, often the *exact* version (Godot 4.5 data usually won't load in Godot 4.6), configured the right way. Doing that by hand is tedious, and doing it automatically is most of what MacLauncher does when you import a game.

## Decompilation and recompilation: rebuild the game itself

One more approach has taken off in the last few months. Instead of translating a game while it runs, fans rebuild it as a native program. It's almost always done for older games, mostly console games from the N64 to the Xbox 360 era, not modern releases.

- A **decompilation** project reverse-engineers a game's machine code back into readable source code, function by function, until that source compiles into a byte-for-byte copy of the original. [Super Mario 64](https://github.com/n64decomp/sm64) and [The Legend of Zelda: Ocarina of Time](https://github.com/zeldaret/oot) are the landmark examples. Once the source exists, the game can be ported like any other program: [Ship of Harkinian](https://github.com/HarbourMasters/Shipwright) is a PC port of Ocarina of Time built on its decompilation.
- A **static recompilation** gets there faster. A tool translates the console's machine code into C or C++ ahead of time, automatically, and the result is compiled for the new platform. [N64Recomp](https://github.com/N64Recomp/N64Recomp) produced [Zelda 64: Recompiled](https://github.com/Zelda64Recomp/Zelda64Recomp) for Majora's Mask, and [XenonRecomp](https://github.com/hedge-dev/XenonRecomp) did the same for the Xbox 360 version of Sonic Unleashed with [Unleashed Recompiled](https://github.com/hedge-dev/UnleashedRecomp).

Either way, the result is a true native program, as fast and as well-behaved as anything built for the Mac, and these projects often add widescreen, high frame rates and mods along the way. None of them ship the game itself: you supply the data from your own copy. Early projects took dedicated people years. Now AI models do much of the decompiling and porting, so a new game no longer takes months or years, which is why so many have appeared recently.

It's the native-runtime idea taken to its limit. A native runtime is an engine shared by many games; a decomp-recomp project is a runtime for exactly one. MacLauncher focuses on shared runtimes, so it doesn't package individual decomp-recomp games: there are simply too many of them. The [awesome-decomp-games](https://github.com/SubmitGame/awesome-decomp-games) list tracks them, and some publish their own macOS builds, Ship of Harkinian and Zelda 64: Recompiled among them.

## Putting it together

| Approach | What runs the game's code | What it costs | In MacLauncher |
| --- | --- | --- | --- |
| Virtual machine | A whole second operating system | Memory, disk, slow graphics; ARM-only guests on Apple Silicon | Not used |
| Emulator | Software imitating the original hardware | A lot of CPU time | DOSBox Staging for DOS games |
| Compatibility layer | Your real CPU (directly or through Rosetta), with OS calls translated | Translation gaps, some odd behavior | Sikarugir and CrossOver for Windows; AnyPS5, nxnative, the Android runtimes and PlayCover for consoles and phones |
| Native runtime | The engine's own macOS build | Needs the right engine and version | Ren'Py, RPG Maker, Godot, GameMaker, Unity, LÖVE, visual-novel engines and many more |
| Decompilation / recompilation | The game itself, rebuilt as a native program | A separate project for each game, almost always an older one | Not packaged: one project per game |

MacLauncher tries native runtimes first, falls back to compatibility layers when there is no native option, and keeps both available so you can switch. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) covers how to pick between them, and [Games and runtimes](/maclauncher/games/) lists what's supported.

## Further reading

- [Wine](https://en.wikipedia.org/wiki/Wine_(software)) on Wikipedia: where WINE came from and how it reimplements Windows.
- [Rosetta](https://en.wikipedia.org/wiki/Rosetta_(software)) on Wikipedia: Apple's translators for the PowerPC-to-Intel and Intel-to-Apple-Silicon transitions.
- [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/): Apple's tools for bringing Windows games to the Mac, including D3DMetal.
- [Game engine](https://en.wikipedia.org/wiki/Game_engine) and [runtime system](https://en.wikipedia.org/wiki/Runtime_system) on Wikipedia: the general ideas behind "engine" and "runtime".
- [Android runtime (ART) and Dalvik](https://source.android.com/docs/core/runtime): how Android runs app bytecode.

:::tip[Want the full details?]
The [runtime guides](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/README.md) in the repository document every runtime, format and setting exactly.
:::
