---
title: Mobile and consoles
description: "Android, iOS and iPadOS apps, PlayStation 5 and Nintendo Switch games, all running on a Mac without emulating the device."
head:
  - tag: title
    content: "Android, iPhone, PlayStation 5 and Switch games on Mac | MacLauncher"
sidebar:
  order: 4
---

Android apps, iPhone games, and PlayStation 5 and Nintendo Switch games can run on a Mac without emulating the device. Each of these runtimes works the way [WINE](https://www.winehq.org/) does for Windows programs: the game's own code runs on your Mac's processor, and a layer translates what it asks of its home platform into macOS. [How games run on a Mac](/maclauncher/background/how-games-run/#not-just-windows-consoles-and-phones) explains why that's possible.

Android, iPhone and iPad, and Switch games are built for ARM processors, so they need an Apple Silicon Mac. PlayStation 5 games use x86-64 instructions. On Apple Silicon, AnyPS5 can translate them through FEX in a native host, or run a converted game through Rosetta. The runtimes described below also differ in the macOS version they need. MacLauncher Android works on any macOS version that MacLauncher supports, while AIM, the converted PS5 route, Prosper and nxnative need macOS 26 or later. The published AnyPS5 MCLv13 FEX host requires macOS 27.0. Each Mac.apk and PlayCover release states its own minimum, which MacLauncher reads from the download. A game's Vulkan driver can need a newer macOS still. [PS5 games through FEX](/maclauncher/rosetta/ps5-through-fex/), [System requirements](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md)

## Android

Drag in an `.apk`, a folder of [split APKs](https://developer.android.com/guide/app-bundle), or an `.xapk`, `.apkm` or `.apks` bundle, and press Play. [Expansion (OBB) files](https://developer.android.com/google/play/expansion-files) next to the APK come along automatically.

The Android game type has three runtimes. The default, MacLauncher Android, is MacLauncher's own game-focused runtime that runs the full [Android 16](https://developer.android.com/about/versions/16) framework, supports Google accounts and services, and handles ARM64 VR/XR titles such as [Beat Saber](https://www.beatsaber.com/). It's the most compatible with complex commercial games like [Roblox](https://www.roblox.com/) or [Hungry Shark Evolution](https://www.ubisoft.com/en-us/game/hungry-shark/evolution). The other two are [Mac.apk](https://github.com/kksimp/Mac.apk), an independent runtime with a choice of [Metal](https://developer.apple.com/metal/) or [Vulkan](https://www.vulkan.org/) graphics, and [AIM](https://github.com/hahnlee/aim), which runs apps offline on Android's original [ART runtime](https://source.android.com/docs/core/runtime) with Android services. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#android-games) compares them.

Whichever runtime you use, each app runs on a virtual device modeled on the Pixel Tablet, in its own window, with private storage that stays separate from your other games.

You can also download APKs inside MacLauncher from [Google Play](https://play.google.com/store/games) (with your own account), [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/), including specific older versions. See [Stores and downloads](/maclauncher/tools/stores-and-downloads/).

In MacLauncher Android, the data-usage figures an app can ask Android for always read zero, so no app learns anything about the Mac's network traffic or that of other apps.

Example games: Roblox, Monument Valley, Stardew Valley.

Guide: [Android](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ANDROID.md)

## iOS and iPadOS

iPhone and iPad apps are already ARM64 programs for an Apple operating system, so an Apple Silicon Mac can run them almost directly. MacLauncher fills the remaining gaps, including keyboard and mouse mapping, with the [PlayTools](https://github.com/PlayCover/PlayTools) framework from [PlayCover](https://github.com/PlayCover/PlayCover), an open-source app for running iPhone and iPad apps on a Mac. You don't need to install the PlayCover app itself: MacLauncher downloads the runtime, prepares a private copy of the app, signs it locally and launches it.

You need a decrypted (unencrypted) `.ipa`. Apps run in a file sandbox with network access off by default; turn on **Network access** in the inspector for games that need to go online.

Example games: Genshin Impact.

Guide: [iOS / iPadOS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/IOS.md)

## PlayStation 5

PS5 games are x86-64 programs, the same instruction family as PC games, and the PlayStation 5 game type has two runtimes for them.

The default, [AnyPS5](https://github.com/boykopovar/AnyPS5), supplies its own versions of the PS5 system libraries. The version you pick in **Runtimes** decides how the game's x86-64 code runs. On Apple Silicon, the FEX version translates it inside a native host and sends its graphics through an Apple Silicon Vulkan driver. **Automatic** prefers a ready FEX version on Apple Silicon. The converted-game versions run natively on Intel Macs and through [Rosetta](https://support.apple.com/en-us/102527) on Apple Silicon, with an Intel Vulkan driver. MacLauncher handles preparation, the runtime and your controls. Bring an unpacked, decrypted PS5 game folder with `sce_sys/param.json` and the game executable. [PS5 games through FEX](/maclauncher/rosetta/ps5-through-fex/)

Either way, the game runs from a macOS application of its own, with its library title for the app, menu and window name. Custom library artwork supplies its Dock icon, or the original game icon when no custom artwork is selected. Both versions use the same controls, saves and launch lifecycle. The FEX application contains only a copy of the native host entry; its libraries stay linked to the selected runtime.

Controls map to keyboard and mouse by default (I/J/K/L for the face buttons and WASD for the left stick), and every binding can be edited per game. Physical controllers work too. With a converted-game version, the first launch converts the game and later launches reuse that work. The game's row shows conversion progress and offers **Cancel**.

<span id="runtime-prosper"></span>The second runtime, [Prosper](https://github.com/mattias800/prosper), runs the original PS5 programs instead of converting them. It also runs as an Intel program, using Rosetta on Apple Silicon, and it needs Vulkan 1.4 with Intel support. Prosper is downloaded from [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), the companion project that hosts MacLauncher's own runtime builds, and **Runtimes** lists its versions alongside any local builds you add. If Prosper isn't installed when you press **Play**, MacLauncher asks before downloading it and then carries on preparing the game. AnyPS5 stays the default.

The game type's inspection and decompilation tools work with either runtime.

Example games: the AnyPS5 project is working on titles such as Ghost of Tsushima Director's Cut, Forspoken, Skyrim and Diablo II: Resurrected. Each has a [progress thread](https://github.com/boykopovar/AnyPS5/discussions/categories/game-bring-up) that reports how far the game gets.

Guide: [PlayStation 5](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/PS5.md)

## Nintendo Switch

The Switch runs on an ARM64 processor, like Apple Silicon, so its game code can run directly on your Mac once it's prepared. [nxnative](https://github.com/seedds/nxnative), the Switch runtime, supplies the system services the game expects and converts its graphics to Metal.

Import an `.nsp`, `.nsz`, `.xci` or `.xcz` file, or a folder of them. The first launch extracts the game, patches its code and compiles its shaders, showing progress as it goes. That can take a while, but later launches start straight away. Encrypted games need your own `prod.keys` file, which you can select in the game's Runtime Settings. If shader compilation needs Apple's Metal compiler, MacLauncher can download it, so you don't need Xcode, Apple's developer app.

Decrypted dumps, Switch 2 games among them, and `.nup` files play without `prod.keys` or firmware. Import the dump's folder or the `.nup` file. Once preparation identifies a Switch 2 title, the library shows it as **Nintendo Switch 2**. When a dump contains several updates, **Game update** in Runtime Settings chooses which one runs: **Latest available**, the default, or a particular version such as **Base game (v0)**. Changing it prepares that version and keeps your saves, and the inspector shows the selected update. If the installed nxnative tools can't handle these files or the chosen update, **Play** asks before downloading newer tools and then carries on with the game.

nxnative has fixed keyboard controls (WASD for the left stick, J/K/U/I for A/B/X/Y, and so on), which Settings shows for reference, and supported controllers work natively. After the first preparation, the game's own options from nxnative appear in Runtime Settings.

Example games: Mario Kart 8 Deluxe, The Legend of Zelda: Breath of the Wild, Super Mario Odyssey, from [nxnative's list of tested games](https://github.com/seedds/nxnative).

Guide: [Nintendo Switch](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SWITCH.md)

## Bringing your own games

MacLauncher doesn't provide games, keys or firmware. For Android, the built-in store downloads cover apps you own or that are free. For iOS, PS5 and Switch, you need your own decrypted copies, and encrypted Switch containers also need your own keys.
