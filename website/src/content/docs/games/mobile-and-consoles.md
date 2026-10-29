---
title: Mobile and consoles
description: Android, iOS and iPadOS apps, PlayStation 5 and Nintendo Switch games, all running natively on Apple Silicon without emulation.
sidebar:
  order: 4
---

This is the part of MacLauncher that tends to surprise people. Android apps, iPhone games, and even PlayStation 5 and Nintendo Switch games can run on an Apple Silicon Mac **without emulating the device**. Each of these runtimes works like [WINE](https://www.winehq.org/): the game's own code runs on your Mac's processor, and a layer translates what it asks of its home platform into macOS. [How games run on a Mac](/maclauncher/background/how-games-run/#not-just-windows-consoles-and-phones) explains why that's possible.

All of these need an Apple Silicon Mac.

## Android

Drag in an `.apk`, a folder of [split APKs](https://developer.android.com/guide/app-bundle), or an `.xapk`, `.apkm` or `.apks` bundle, and press Play. [Expansion (OBB) files](https://developer.android.com/google/play/expansion-files) that sit next to the APK come along automatically. MacLauncher has three Android runtimes:

- **MacLauncher Android**, the default, is a game-focused runtime that runs the full [Android 16](https://developer.android.com/about/versions/16) framework, supports Google accounts and services, and handles ARM64 VR/XR titles such as [Beat Saber](https://www.beatsaber.com/). It's the most compatible with complex commercial games like [Roblox](https://www.roblox.com/) or [Hungry Shark Evolution](https://www.ubisoft.com/en-us/game/hungry-shark/evolution).
- **[Mac.apk](https://github.com/kksimp/Mac.apk)**, an independent runtime with a choice of [Metal](https://developer.apple.com/metal/) or [Vulkan](https://www.vulkan.org/) graphics.
- **[AIM](https://github.com/hahnlee/aim)**, which runs apps on Android's original [ART runtime](https://source.android.com/docs/core/runtime) with Android services, offline.

[Choosing a runtime](/maclauncher/background/choosing-a-runtime/#android-games) compares them. Each app runs on a virtual Pixel Tablet-like device in its own window, with private storage that stays separate from your other games.

You can also download APKs right inside MacLauncher, from **[Google Play](https://play.google.com/store/games)** (with your own account), **[F-Droid](https://f-droid.org/)** and **[IzzyOnDroid](https://apt.izzysoft.de/fdroid/)**, including specific older versions. See [Stores and downloads](/maclauncher/tools/stores-and-downloads/).

**Example games:** Roblox, Monument Valley, Stardew Valley.

Guide: [Android applications](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/ANDROID.md)

## iOS and iPadOS

iPhone and iPad apps are already ARM64 programs for an Apple operating system, so an Apple Silicon Mac can run them almost directly. MacLauncher uses [PlayCover](https://github.com/PlayCover/PlayCover)'s [PlayTools](https://github.com/PlayCover/PlayTools) framework to fill the gaps, including keyboard and mouse mapping. You don't need to install the PlayCover app itself: MacLauncher downloads the runtime, prepares a private copy of the app, signs it locally and launches it.

You'll need a decrypted (unencrypted) `.ipa`. Apps run in a file sandbox with network access off by default; switch on **Network access** in the inspector for games that need to go online.

**Example games:** Genshin Impact.

Guide: [iOS and iPadOS](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/IOS.md)

## PlayStation 5

PS5 games are x86-64 programs, the same instruction family as PC games. [AnyPS5](https://github.com/boykopovar/AnyPS5) converts the game's executable and modules into macOS programs and supplies its own versions of the PS5 system libraries. On Apple Silicon, the converted game runs through [Rosetta](https://support.apple.com/en-us/102527), with graphics on Vulkan over Metal. MacLauncher uses its own macOS port of AnyPS5, and manages conversion, runtime versions, the Vulkan driver and your controls.

What you need:

- an **unpacked, decrypted** PS5 game folder (with `sce_sys/param.json` and the game executable);
- **macOS 26** or later.

Controls map to keyboard and mouse out of the box (I/J/K/L for the face buttons, WASD for the left stick, and so on), and every binding is editable per game. Physical controllers work too. The first launch converts the game, and later launches reuse that work.

<span id="runtime-prosper"></span>There's also an optional [Prosper](https://github.com/mattias800/prosper) backend if you supply your own macOS build of it.

**Example games:** titles the AnyPS5 project is bringing up include Ghost of Tsushima Director's Cut, Forspoken, Skyrim and Diablo II: Resurrected. Each has a [bring-up thread](https://github.com/boykopovar/AnyPS5/discussions/categories/game-bring-up) that reports how far the game gets.

Guides: [PlayStation 5](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/ANYPS5.md), [Prosper](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/PROSPER.md)

## Nintendo Switch

The Switch runs on an ARM64 processor, just like Apple Silicon, so its game code can run directly on your Mac once it's prepared. [nxnative](https://github.com/seedds/nxnative) supplies the system services and converts the graphics to Metal.

Import an `.nsp`, `.nsz`, `.xci` or `.xcz` file (or a folder of them). The first launch extracts the game, patches its code and compiles its shaders, showing progress as it goes. That can take a while, and later launches start straight away. Encrypted games need your own `prod.keys` file, which you can point to in the game's Runtime Settings. If shader compilation needs Apple's Metal compiler, MacLauncher can download it for you with your consent, without Xcode.

Keyboard controls come preset (WASD for the left stick, J/K/U/I for A/B/X/Y, and so on), and supported controllers work natively. After the first preparation, the game's own options from nxnative appear in Runtime Settings.

**Example games:** Mario Kart 8 Deluxe, The Legend of Zelda: Breath of the Wild, Super Mario Odyssey, from [nxnative's list of tested games](https://github.com/seedds/nxnative).

Guide: [Nintendo Switch](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NXNATIVE.md)

## Bringing your own games

MacLauncher doesn't provide games, keys or firmware. For Android, the built-in store downloads cover apps you own or that are free. For iOS, PS5 and Switch you need your own decrypted copies and keys.
