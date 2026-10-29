---
title: Choosing a runtime
description: When to use a native engine, Sikarugir or CrossOver for Windows games, which Android runtime to pick, and how versions fit in.
sidebar:
  order: 2
---

Most of the time you don't need to choose anything. When you import a game, MacLauncher works out what engine it uses, which version, and which runtime should run it, then picks that runtime for you. Press **Play** and it goes.

But many games have more than one way to run, and sometimes the second choice works better. This page explains the trade-offs so you know when switching is worth trying. If the terms are new, [How games run on a Mac](/maclauncher/background/how-games-run/) covers the background.

## Where the choice lives

Select a game in your library to open its **inspector**. The runtime selector there shows every runtime that can play this game, along with the installed versions of each. Changing it affects just that game. **Runtimes** (in the toolbar) is where you install, update and remove runtime versions and set the defaults for everything else.

Nothing is lost when you switch: your choice is saved per game, the original files stay untouched, and you can switch back at any time.

## Windows games

A Windows game in MacLauncher usually has up to three kinds of options.

### 1. The game's own engine, natively

If MacLauncher recognizes the engine ([Ren'Py](https://www.renpy.org/), [RPG Maker](https://www.rpgmakerweb.com/), [Godot](https://github.com/godotengine/godot), [GameMaker](https://gamemaker.io/), [Unity](https://unity.com/) Mono, [LÖVE](https://love2d.org/), [XNA](https://en.wikipedia.org/wiki/Microsoft_XNA)/[FNA](https://fna-xna.github.io/), KiriKiri, Siglus and [many more](/maclauncher/games/)), it defaults to a native macOS runtime for that engine. This is the option to prefer: it's usually faster, gentler on the battery, and behaves like a real Mac app. Mouse input feels right, fullscreen works the macOS way, and the graphics layer has the most information to work with.

How well it works depends on the engine:

- **Near-perfect:** engines whose games are mostly data, such as Ren'Py, RPG Maker (all generations), HTML5 games, most visual-novel engines and LÖVE.
- **Usually good with the right version:** Godot and GameMaker. Version matching matters a lot here, and MacLauncher reads the version from the game files for you.
- **Depends on the game:** Unity. Unity games built with [Mono](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) can run on the macOS Unity player, but games with a lot of Windows-specific code won't. Unity games built with IL2CPP are compiled to Windows machine code, so they need a compatibility layer.

### 2. Sikarugir (WINE), managed for you

[Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free distribution of [WINE](https://www.winehq.org/). MacLauncher downloads its engines on request, keeps several versions side by side, and sets up a private Windows environment for each game automatically. It's the default for Windows games that MacLauncher doesn't recognize, and it's offered as an alternative for recognized engines too.

Reach for it when:

- the game uses an engine with no native runtime (a custom engine, [Unreal](https://www.unrealengine.com/), Unity IL2CPP, and so on);
- the native runtime has a problem with this particular game;
- you want the game to behave exactly as it does on Windows, including Windows-only mods or plugins.

### 3. CrossOver, if you have it

[CrossOver](https://www.codeweavers.com/crossover/) is CodeWeavers' commercial WINE. If it's installed, MacLauncher finds it and offers it as another choice; you can even register several CrossOver copies (a preview build, say) and pick a different one per game. CodeWeavers keeps it current with fixes for newer games, so if you own it, it's usually the better WINE to use. Sikarugir stays the default because it's free and always available; pick CrossOver in a game's inspector, or make it the default for Windows games in **Settings**.

Both WINE options copy the game into private launcher storage (using copy-on-write cloning where the disk supports it), so a game that writes saves or settings next to its files never modifies your original folder.

:::tip[A quick rule of thumb]
Native runtime first. If the game won't start or misbehaves, switch to WINE: CrossOver if you have it, otherwise Sikarugir. Each runtime has its own settings in the inspector, so check those too, for example the graphics backend or locale for WINE.
:::

## Android games

Android has three runtimes, and they make different trade-offs. All three run on Apple Silicon without an Android emulator or virtual machine (see [why they're like WINE](/maclauncher/background/how-games-run/#not-just-windows-consoles-and-phones)).

### MacLauncher Android (the default)

MacLauncher's own Android runtime, built for games. It runs the complete [Android 16](https://developer.android.com/about/versions/16) framework, executes the app's native ARM64 libraries directly on your Mac's CPU, and supports Google accounts and installed Google services. That makes it the most compatible choice for complex commercial games, and since it's built on [Klepton](https://github.com/shinyquagsire23/Klepton) it also runs ARM64 VR/XR titles.

It has two execution modes, selected with the **Execution** setting:

- **JVM** (default) converts the app's Android bytecode to run on [Java 21](https://openjdk.org/projects/jdk/21/).
- **ART** runs Android's original [runtime](https://source.android.com/docs/core/runtime) instead, using a genuine Android system image that MacLauncher downloads with your consent.

If a game crashes or misbehaves under one mode, trying the other is a good first step.

### Mac.apk

[Mac.apk](https://github.com/kksimp/Mac.apk) is an independent project that runs Android apps on macOS. MacLauncher downloads its releases and lets you choose its graphics backend ([Metal](https://developer.apple.com/metal/) or [Vulkan](https://www.vulkan.org/) through [MoltenVK](https://github.com/KhronosGroup/MoltenVK)) per game. It needs macOS 26.4 or later. Network access is off by default and can be turned on per game, and Google sign-in is available through its own account panel. It's a good alternative when a lighter game doesn't get along with the default runtime.

### AIM

[AIM](https://github.com/hahnlee/aim) runs apps with Android's original ART runtime and Android services, still without a Linux kernel or a VM. MacLauncher manages an adapted build and downloads the matching Android system image with your consent. It requires macOS 26 or later and runs apps offline, without Google account integration. Try it when you want behavior closest to stock Android and the game doesn't need online services.

| | MacLauncher Android | Mac.apk | AIM |
| --- | --- | --- | --- |
| Best for | Complex commercial games, Google sign-in, VR/XR | Lighter games, choice of Metal or Vulkan | Stock Android behavior, offline games |
| How it runs apps | Android framework on Java (JVM) or original ART | Its own Java-based Android host | Original ART with Android services |
| Google accounts | Yes | Yes, turned on per game | No |
| Requirements | Apple Silicon | Apple Silicon, macOS 26.4+ | Apple Silicon, macOS 26+ |

The [Android guide](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/ANDROID.md) has the full details. You can get APKs from [Google Play](https://play.google.com/store/games), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/) directly in MacLauncher; see [Stores and downloads](/maclauncher/tools/stores-and-downloads/).

## Other places with a choice

A few other game types come with more than one runtime:

- **[Flash](https://en.wikipedia.org/wiki/Adobe_Flash):** Adobe's Flash Player projector is the most faithful; [Ruffle](https://ruffle.rs/) is an open-source reimplementation that keeps improving.
- **HTML5 and RPG Maker MV/MZ:** [Electron](https://www.electronjs.org/) (included with MacLauncher), [NW.js](https://nwjs.io/), and a patched NW.js with extra compatibility options. Electron works for most games; NW.js is closer to what many of these games were built for.
- **GameMaker:** [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) or the official GameMaker runners for Studio games, and [OpenGMK](https://github.com/OpenGMK/OpenGMK) for classic GameMaker 8 games.
- **NScripter:** [ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri) or [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN), which differ in the script features and save locations they support.
- **Siglus and RealLive:** [siglus_rs](https://github.com/xmoezzz/siglus_rs) for both, or [RLVM](https://github.com/eglaysher/rlvm) for RealLive games.
- **Games that ship a working Mac version:** many engines also offer **Native app**, which runs the Mac build the developer supplied. Graphics effects still apply.

## Versions

Every runtime in MacLauncher is versioned, and you can keep as many versions installed as you like. When a game starts, its version is decided in a simple order:

1. **Your choice for this game**, if you picked one in its inspector.
2. **What the game asks for**, when MacLauncher can read it from the game files. Godot, Unity, GameMaker and Ren'Py games care about this a lot.
3. **Your default** for that runtime, set in **Runtimes**.

An explicit choice is never quietly replaced: if the version you picked isn't installed, MacLauncher asks before downloading it instead of falling back to something else.

New runtime versions are only looked up when you ask (the refresh button in Runtimes), and installed versions keep working offline.
