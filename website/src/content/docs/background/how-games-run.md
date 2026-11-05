---
title: How games run on a Mac
description: "Virtual machines, emulators, compatibility layers like WINE, and native runtimes on a Mac: what each one does, and why MacLauncher prefers the last two."
head:
  - tag: title
    content: "How games run on a Mac: emulators, WINE, Rosetta and native runtimes | MacLauncher"
sidebar:
  order: 1
---

If you have tried to play a Windows game on a Mac, you have probably met a pile of terms: *[virtual machine](https://en.wikipedia.org/wiki/Virtual_machine)*, *[emulator](https://en.wikipedia.org/wiki/Emulator)*, *[WINE](https://www.winehq.org/)*, *[CrossOver](https://www.codeweavers.com/crossover/)*, *[Rosetta](https://support.apple.com/en-us/102527)*, *port*. They all get a game running somewhere it wasn't built for, but they work in very different ways, and those differences decide how fast the game runs, how well it behaves and what can go wrong.

There are four main approaches, from the heaviest to the lightest, plus a fifth that rebuilds the game itself. MacLauncher uses the lightest approach that works for each game, which explains most of its design.

## What a game actually needs

A game is a program, and a program expects three things from the machine it runs on.

The first is a CPU that understands its instructions. Compiled code is a list of instructions for one processor family: [x86-64](https://en.wikipedia.org/wiki/X86-64) for most Windows PCs and the PlayStation 5, and [ARM64](https://en.wikipedia.org/wiki/AArch64) for [Apple Silicon](https://en.wikipedia.org/wiki/Apple_silicon), phones and the Nintendo Switch.

Macs come with either kind: older ones with Intel x86-64 processors, newer ones with Apple Silicon. Both can run native engines, and Apple's Rosetta translator lets Apple Silicon run many Intel programs as well. Running the ARM64 code of Android, iOS or Switch games directly, however, needs Apple Silicon. A Universal Mac download contains code for both processors, though some graphics features still work on only one of them. The [requirements reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) gives these details for each component.

The second is an operating system. Games ask the OS to open windows, read files, play sounds and read the controller. Windows, macOS, Linux, Android and the consoles all offer these services, each through different interfaces ([APIs](https://en.wikipedia.org/wiki/API)).

The third is a graphics API. Drawing goes through [DirectX](https://en.wikipedia.org/wiki/DirectX) on Windows, [Metal](https://developer.apple.com/metal/) on macOS, and [Vulkan](https://www.vulkan.org/) or [OpenGL](https://www.khronos.org/opengl/) elsewhere.

Each approach below deals differently with a mismatch in one or more of these.

## Virtual machines: bring the whole computer

A **virtual machine** (VM), such as [Parallels Desktop](https://www.parallels.com/products/desktop/), VMware Fusion or [UTM](https://getutm.app/), runs a complete second operating system inside a window. If you install Windows in a VM, the game sees real Windows, with real Windows drivers, and doesn't know it's on a Mac.

That makes VMs very compatible, but the cost is high. A whole second OS uses memory and disk, and graphics have to cross the boundary between the VM and the Mac, which is usually the slowest part. On Apple Silicon a VM can only run an ARM operating system, so Windows on ARM then has to translate x86 games a second time. For games, a VM usually works, but not well.

MacLauncher doesn't use virtual machines.

## Emulators: pretend to be the hardware

An **emulator** recreates a different machine's hardware in software: its CPU, its graphics chip, its sound chip and its memory map. The original program runs unchanged, as if it were on the original hardware.

This is the classic way to play old consoles and old computers, and a good emulator is very faithful. It is also expensive, because every instruction of the original machine has to be imitated, often with many real instructions for each one. For a 1990s DOS game that cost doesn't matter, because a modern Mac has power to spare. For a modern 3D game, full hardware emulation is usually far too slow.

MacLauncher uses one emulator on purpose: [DOSBox Staging](https://www.dosbox-staging.org/) for DOS games, because those games are tiny and the machine they expect no longer exists.

## Compatibility layers: translate the conversation

A **[compatibility layer](https://en.wikipedia.org/wiki/Compatibility_layer)** doesn't imitate a whole computer. It lets the game's code run on the real CPU and *translates the game's requests to the operating system*. When a Windows game asks Windows to open a file or create a window, the compatibility layer does the equivalent thing on macOS.

The best-known compatibility layer is WINE, whose name stands for "Wine Is Not an Emulator". WINE reimplements the Windows APIs on top of macOS and Linux. CrossOver is a commercial, polished distribution of WINE, and [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free one that MacLauncher can download and manage for you. Graphics are translated too: DirectX calls become Metal calls, either directly, as Apple's D3DMetal (part of its [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/)) and [DXMT](https://github.com/3Shain/dxmt) do, or through Vulkan with [DXVK](https://github.com/doitsujin/dxvk) on top of [MoltenVK](https://github.com/KhronosGroup/MoltenVK).

Apple Silicon adds one more step. Windows games are x86-64 code, and an M-series chip runs ARM64. Apple's Rosetta 2 translates x86-64 instructions into ARM64, both ahead of time and while the program runs. On a modern Mac, a Windows game in CrossOver therefore goes through two translations: Rosetta for the CPU and WINE for the operating system.

Compatibility layers are much lighter than VMs and much faster than emulators, which is why they are the usual way to play Windows games on a Mac. The translation is never perfect, though. Some Windows behavior has no exact macOS equivalent, and you can notice it in window handling, mouse input, audio or fullscreen switching.

### Not just Windows: consoles and phones

The same idea works for other platforms, and several of MacLauncher's runtimes for consoles and phones are compatibility layers in exactly this sense.

PlayStation 5 games are x86-64 programs, like PC games. [AnyPS5](https://github.com/boykopovar/AnyPS5) converts the game's executable and modules into macOS programs and supplies its own versions of the PS5's system libraries, much as WINE supplies Windows DLLs. An Intel Mac runs the x86-64 code directly and Apple Silicon runs it through Rosetta, while Vulkan, running on Metal, handles graphics. No part of this imitates PlayStation hardware.

The Nintendo Switch has an ARM64 CPU, the same instruction family as Apple Silicon, so once a Switch game has been prepared, its code runs directly on your Mac's processor. [nxnative](https://github.com/seedds/nxnative) provides the system services the game expects and turns its graphics into Metal, compiling the shaders ahead of time. That compilation is the preparation step you see the first time you launch a Switch game.

An Android app is mostly Java or Kotlin bytecode, often with native ARM64 libraries. MacLauncher's Android runtimes, MacLauncher Android, [AIM](https://github.com/hahnlee/aim) and [Mac.apk](https://github.com/kksimp/Mac.apk), don't boot an Android phone in a VM. They run the Android *platform* on macOS. MacLauncher Android, for example, runs the real [Android 16](https://developer.android.com/about/versions/16) framework on Java, executes native ARM64 libraries directly on Apple Silicon, and maps windows, input, audio and graphics to their macOS equivalents. AIM stays closer to a real device by running Android's own [ART runtime](https://source.android.com/docs/core/runtime) with Android services, still without a Linux kernel or a virtual machine.

iPhone and iPad apps are already ARM64 programs for an Apple operating system, so Apple Silicon Macs can run them almost as they are. [PlayCover](https://github.com/PlayCover/PlayCover)'s [PlayTools](https://github.com/PlayCover/PlayTools) framework adds the missing pieces, such as keyboard and mouse mapping.

When this site calls these runtimes "like WINE", it means that the game's own code runs on your real CPU (directly, or through Rosetta), and a layer translates what the game asks of its home platform into macOS.

## Native runtimes: use the engine that already runs on macOS

The lightest approach skips translation entirely. Most games aren't written from scratch. They are built on an **[engine](https://en.wikipedia.org/wiki/Game_engine)** such as [Ren'Py](https://www.renpy.org/), [RPG Maker](https://www.rpgmakerweb.com/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/), [LÖVE](https://love2d.org/) or KiriKiri. The engine is the program, and the game is largely *data* that the engine reads: scripts, maps, images and sounds. A Windows release of a game usually bundles the Windows build of its engine next to that data.

Many engines also exist for macOS, either from their authors or as open-source reimplementations. If you point the macOS engine at the game's data, the game runs natively, with no WINE, no Rosetta and no emulation. Some examples:

- A Ren'Py visual novel runs on the Ren'Py SDK for macOS.
- An RPG Maker MV or MZ game is a web app, so it runs on [Electron](https://www.electronjs.org/) or [NW.js](https://nwjs.io/).
- An RPG Maker XP, VX or VX Ace game runs on [MKXP-Z](https://github.com/mkxp-z/mkxp-z), an open-source reimplementation of the RPG Maker player.
- A GameMaker game such as [UNDERTALE](https://undertale.com/) can run on [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) or on the official GameMaker macOS runner.
- A KiriKiri visual novel runs on [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2), and a Siglus one runs on [siglus_rs](https://github.com/xmoezzz/siglus_rs).

MacLauncher calls this a **native runtime**, and most of the project is built around it. Native runtimes usually run faster, use less power and behave like proper Mac apps: windows, fullscreen, mouse and audio work the way macOS expects. The difficulty is matching. The engine has to be the right one, often in the *exact* version the game was made with (Godot 4.5 data usually won't load in Godot 4.6), and it has to be configured correctly. That's tedious by hand, and doing it automatically is most of what MacLauncher does when you import a game.

## Decompilation and recompilation: rebuild the game itself

Another approach is for fans to rebuild a game as a native program, instead of translating it while it runs. This is almost always done for older games, mostly console games from the N64 to the Xbox 360 era, rather than modern releases. There are two ways to get there.

A **decompilation** project reverse-engineers a game's machine code back into readable source code, function by function, until that source compiles into a byte-for-byte copy of the original. [Super Mario 64](https://github.com/n64decomp/sm64) and [The Legend of Zelda: Ocarina of Time](https://github.com/zeldaret/oot) are the landmark examples. Once the source exists, the game can be ported like any other program: [Ship of Harkinian](https://github.com/HarbourMasters/Shipwright) is a PC port of Ocarina of Time built on its decompilation.

A **static recompilation** is faster. A tool translates the console's machine code into C or C++ automatically, ahead of time, and the result is compiled for the new platform. [N64Recomp](https://github.com/N64Recomp/N64Recomp) produced [Zelda 64: Recompiled](https://github.com/Zelda64Recomp/Zelda64Recomp) for Majora's Mask, and [XenonRecomp](https://github.com/hedge-dev/XenonRecomp) did the same for the Xbox 360 version of Sonic Unleashed with [Unleashed Recompiled](https://github.com/hedge-dev/UnleashedRecomp).

Either way, the result is a true native program, as fast and well-behaved as anything built for the Mac, and these projects often add widescreen, high frame rates and mods along the way. None of them ship the game itself; you supply the data from your own copy. Early projects took dedicated people years. AI models now do much of the decompiling and porting, so a new game no longer takes months or years, which is why there are so many of them.

A decomp or recomp project is a native runtime for exactly one game, where a native runtime is usually an engine shared by many. MacLauncher focuses on shared runtimes and doesn't package individual decomp and recomp games, because there are too many of them. The [awesome-decomp-games](https://github.com/SubmitGame/awesome-decomp-games) list tracks them, and some publish their own macOS builds, Ship of Harkinian and Zelda 64: Recompiled among them.

## Putting it together

| Approach | What runs the game's code | What it costs | In MacLauncher |
| --- | --- | --- | --- |
| Virtual machine | A whole second operating system | Memory, disk, slow graphics; ARM-only guests on Apple Silicon | Not used |
| Emulator | Software imitating the original hardware | A lot of CPU time | DOSBox Staging for DOS games |
| Compatibility layer | Your real CPU (directly or through Rosetta), with OS calls translated | Translation gaps, some odd behavior | Sikarugir and CrossOver for Windows; AnyPS5, nxnative, the Android runtimes and PlayCover for consoles and phones |
| Native runtime | The engine's own macOS build | Needs the right engine and version | Ren'Py, RPG Maker, Godot, GameMaker, Unity, LÖVE, visual-novel engines and many more |
| Decompilation / recompilation | The game itself, rebuilt as a native program | A separate project for each game, almost always an older one | Not packaged: one project per game |

MacLauncher tries native runtimes first, falls back to compatibility layers when there is no native option, and keeps both available so you can switch. In MacLauncher's terms, every game belongs to a *game type*, and each runtime is one way to play a game type. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) explains those terms and how to pick between runtimes, and [Games and runtimes](/maclauncher/games/) lists what's supported.

## Further reading

- [Wine](https://en.wikipedia.org/wiki/Wine_(software)) on Wikipedia: where WINE came from and how it reimplements Windows.
- [Rosetta](https://en.wikipedia.org/wiki/Rosetta_(software)) on Wikipedia: Apple's translators for the PowerPC-to-Intel and Intel-to-Apple-Silicon transitions.
- [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/): Apple's tools for bringing Windows games to the Mac, including D3DMetal.
- [Game engine](https://en.wikipedia.org/wiki/Game_engine) and [runtime system](https://en.wikipedia.org/wiki/Runtime_system) on Wikipedia: the general ideas behind "engine" and "runtime".
- [Android runtime (ART) and Dalvik](https://source.android.com/docs/core/runtime): how Android runs app bytecode.

:::tip[Full reference]
The [game type pages](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/README.md) in the repository document the formats, settings, tools and runtimes of every game type.
:::
