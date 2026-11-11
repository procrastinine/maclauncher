---
title: Mobile and consoles
description: "Android, iOS and iPadOS apps, PlayStation 5 and Nintendo Switch games, all running on a Mac without emulating the device."
head:
  - tag: title
    content: "Android, iPhone, PlayStation 5 and Switch games on Mac | MacLauncher"
sidebar:
  order: 4
---

Android apps, iPhone games, and PlayStation 5 and Nintendo Switch games can run on a Mac without emulating the device. Each of these runtimes works like [WINE](https://www.winehq.org/): the game's own code runs on your Mac's processor, and a layer translates what it asks of its home platform into macOS. [How games run on a Mac](/maclauncher/background/how-games-run/#not-just-windows-consoles-and-phones) explains why that's possible.

Android, iPhone and iPad, and Switch games are built for ARM processors, so they need an Apple Silicon Mac. PlayStation 5 games are Intel (x86-64) programs instead: they run directly on Intel Macs and through [Rosetta](https://support.apple.com/en-us/102527) on Apple Silicon. MacLauncher Android works on any macOS version that MacLauncher supports, while AIM, both PS5 runtimes and nxnative need macOS 26. Each Mac.apk and PlayCover release states its own minimum, which MacLauncher reads from the download. The Vulkan driver a game uses can need a newer macOS still; the [requirements reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md) lists each one.

## Android

Drag in an `.apk`, a folder of [split APKs](https://developer.android.com/guide/app-bundle), or an `.xapk`, `.apkm` or `.apks` bundle, and press Play. [Expansion (OBB) files](https://developer.android.com/google/play/expansion-files) next to the APK come along automatically.

The Android game type has three runtimes. The default, MacLauncher Android, is a game-focused runtime that runs the full [Android 16](https://developer.android.com/about/versions/16) framework, supports Google accounts and services, and handles ARM64 VR/XR titles such as [Beat Saber](https://www.beatsaber.com/). It's the most compatible with complex commercial games like [Roblox](https://www.roblox.com/) or [Hungry Shark Evolution](https://www.ubisoft.com/en-us/game/hungry-shark/evolution). The other two are [Mac.apk](https://github.com/kksimp/Mac.apk), an independent runtime with a choice of [Metal](https://developer.apple.com/metal/) or [Vulkan](https://www.vulkan.org/) graphics, and [AIM](https://github.com/hahnlee/aim), which runs apps offline on Android's original [ART runtime](https://source.android.com/docs/core/runtime) with Android services. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#android-games) compares them.

Whichever runtime you use, each app runs on a virtual device modeled on the Pixel Tablet, in its own window, with private storage that stays separate from your other games.

You can also download APKs inside MacLauncher from [Google Play](https://play.google.com/store/games) (with your own account), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/), including specific older versions. See [Stores and downloads](/maclauncher/tools/stores-and-downloads/).

In MacLauncher Android, the data-usage figures an app can ask Android for always read zero, so no app learns anything about the Mac's network traffic or that of other apps.

**Example games:** Roblox, Monument Valley, Stardew Valley.

Guide: [Android](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ANDROID.md)

## iOS and iPadOS

iPhone and iPad apps are already ARM64 programs for an Apple operating system, so an Apple Silicon Mac can run them almost directly. MacLauncher uses [PlayCover](https://github.com/PlayCover/PlayCover)'s [PlayTools](https://github.com/PlayCover/PlayTools) framework to fill the gaps, including keyboard and mouse mapping. You don't need to install the PlayCover app itself: MacLauncher downloads the runtime, prepares a private copy of the app, signs it locally and launches it.

You need a decrypted (unencrypted) `.ipa`. Apps run in a file sandbox with network access off by default; turn on **Network access** in the inspector for games that need to go online.

**Example games:** Genshin Impact.

Guide: [iOS / iPadOS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/IOS.md)

## PlayStation 5

PS5 games are x86-64 programs, the same instruction family as PC games, and the PlayStation 5 game type has two runtimes for them.

The default, [AnyPS5](https://github.com/boykopovar/AnyPS5), converts the game's executable and modules into macOS programs and supplies its own versions of the PS5 system libraries. Converted games run natively on Intel Macs and through [Rosetta](https://support.apple.com/en-us/102527) on Apple Silicon, with graphics on Vulkan over Metal using an Intel-compatible driver. MacLauncher uses its own macOS port of AnyPS5 and manages the conversion, runtime versions, the Vulkan driver and your controls. You need an unpacked, decrypted PS5 game folder (with `sce_sys/param.json` and the game executable) and macOS 26 or later.

AnyPS5’s converted program uses the game’s library title and artwork for its macOS application name and Dock icon. Its prepared application holds the converted game itself and reuses that conversion on later launches.

Controls map to keyboard and mouse by default (I/J/K/L for the face buttons, WASD for the left stick, and so on), and every binding can be edited per game; physical controllers work too. The first launch converts the game, and later launches reuse that work. While it converts, the game's row counts the program's modules as they're done, such as **Converting PS5 program… 3 / 10 modules**, and **Cancel** stops the conversion.

<span id="runtime-prosper"></span>The second runtime, [Prosper](https://github.com/mattias800/prosper), runs the original PS5 programs instead of converting them. It also runs as an Intel program, using Rosetta on Apple Silicon, and it needs Vulkan 1.4 with Intel support. Prosper comes as MacLauncher Builds packages, which **Runtimes** lists alongside any local builds you add. If the package is missing when you press **Play**, MacLauncher asks before downloading it and then carries on preparing the game. AnyPS5 stays the default.

The game type's inspection and decompilation tools work with either runtime.

**Example games:** titles the AnyPS5 project is bringing up include Ghost of Tsushima Director's Cut, Forspoken, Skyrim and Diablo II: Resurrected. Each has a [bring-up thread](https://github.com/boykopovar/AnyPS5/discussions/categories/game-bring-up) that reports how far the game gets.

Guide: [PlayStation 5](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/PS5.md)

## Nintendo Switch

The Switch runs on an ARM64 processor, like Apple Silicon, so its game code can run directly on your Mac once it's prepared. [nxnative](https://github.com/seedds/nxnative) supplies the system services and converts the graphics to Metal.

Import an `.nsp`, `.nsz`, `.xci` or `.xcz` file, or a folder of them. The first launch extracts the game, patches its code and compiles its shaders, showing progress as it goes. That can take a while, but later launches start straight away. Encrypted games need your own `prod.keys` file, which you can select in the game's Runtime Settings. If shader compilation needs Apple's Metal compiler, MacLauncher can download it, so Xcode isn't needed.

Decrypted dumps, Switch 2 games among them, and `.nup` files play without `prod.keys` or firmware. Import the dump's folder or the `.nup` file. Once preparation identifies a Switch 2 title, the library shows it as **Nintendo Switch 2**. When a dump contains several updates, **Game update** in Runtime Settings chooses which one runs: **Latest available**, the default, or a particular version such as **Base game (v0)**. Changing it prepares that version and keeps your saves, and the inspector shows the selected update. If the installed nxnative tools can't handle these inputs or the chosen update, Play asks before downloading newer tools and then carries on with the game.

nxnative has fixed keyboard controls (WASD for the left stick, J/K/U/I for A/B/X/Y, and so on), which Settings shows for reference, and supported controllers work natively. After the first preparation, the game's own options from nxnative appear in Runtime Settings.

**Example games:** Mario Kart 8 Deluxe, The Legend of Zelda: Breath of the Wild, Super Mario Odyssey, from [nxnative's list of tested games](https://github.com/seedds/nxnative).

Guide: [Nintendo Switch](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SWITCH.md)

## Bringing your own games

MacLauncher doesn't provide games, keys or firmware. For Android, the built-in store downloads cover apps you own or that are free. For iOS, PS5 and Switch, you need your own decrypted copies, and encrypted Switch containers also need your own keys.
