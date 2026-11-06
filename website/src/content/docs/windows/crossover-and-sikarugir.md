---
title: CrossOver and Sikarugir
description: "The two WINE runtimes in MacLauncher for macOS: free Sikarugir, downloaded and set up for you, and CrossOver, used from your own installation. How they differ, how to choose, and where each game's Windows files live."
head:
  - tag: title
    content: "CrossOver vs Sikarugir on Mac: MacLauncher's WINE runtimes | MacLauncher"
sidebar:
  order: 1
---

MacLauncher has two WINE runtimes, and both are distributions of WINE for macOS: a WINE build packaged with graphics translators and the libraries the Mac needs. [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is free, and MacLauncher downloads it for you. [CrossOver](https://www.codeweavers.com/crossover/) is CodeWeavers' commercial version, which you buy and install yourself. Every game that can use WINE offers Sikarugir, and it offers CrossOver too whenever MacLauncher finds or has registered a CrossOver application.

## Sikarugir

Sikarugir's publisher releases WINE engines together with matching Template packages, which hold the support libraries and graphics translators for each engine. Used on its own, Sikarugir means installing its Creator app, building a "wrapper" for each game and setting it up yourself. MacLauncher skips all of that. It downloads the engines directly, keeps as many versions as you like, and sets up a private Windows environment (a ["prefix"](https://gitlab.winehq.org/wine/wine/-/wikis/FAQ), or "bottle") for each game the first time you press **Play**.

Sikarugir is the default runtime for Windows Game entries, and games of other types offer it as an alternative. You can install versions in advance from **Runtimes → Sikarugir**, or let Play download one when a game first needs it. Each installed version stays selectable, and a game's **Version** selector can choose a particular one for that game.

Current Sikarugir engines need macOS 14 or later, and MacLauncher reads each engine's requirement from its files during installation. The graphics translators in each Template have requirements of their own: DXMT starts at macOS 14 on a compatible GPU, while D3DMetal needs Apple Silicon and the macOS version that its installed framework requires. If an installation is ever incomplete, **Install** in Runtimes replaces it, or Play offers to download it again before the game starts. Either way, each game's private Windows environment and saves are kept.

## CrossOver

If you own CrossOver, MacLauncher finds it in your Applications folder and offers it alongside Sikarugir. You can register more copies with **Add CrossOver…** in Runtimes, such as a preview build or an older version you want to keep, and choose a different one for each game. CrossOver's updates and licensing stay with CodeWeavers. MacLauncher only points games at the copy you pick, and it never changes the CrossOver application itself.

When you update CrossOver in place, games keep using it with their existing bottles. If a game's selected copy goes missing, though, MacLauncher won't swap in another one on its own; put it back, or add its new location in **Runtimes**.

## Which one to use

CodeWeavers keeps CrossOver current with fixes for newer games, so if you own it, it's usually the better choice. You can make it the default runtime for Windows Game in **Settings**, or pick it for a single game in its inspector. Sikarugir stays the default because it's free and always available.

The two share more than you might expect. They offer the same [graphics translators](/maclauncher/windows/graphics-translators/) from MacLauncher, the same [runtime settings](/maclauncher/windows/settings/) and the same [effects and upscaling](/maclauncher/windows/effects-and-upscaling/). The differences are in what each distribution includes: its own WINE build, its own set of included translators and, for CrossOver, CodeWeavers' fixes. Some settings belong to one of them only. Sikarugir has an optional DirectDraw compatibility wrapper for old 32-bit games, for example, and CrossOver can report a different Windows version for a single launch.

## Original game files and separate Windows environments

When you press **Play**, the game runs in its original folder and reads its files there directly, without a private copy of the whole game folder. Each game does get its own Windows environment, though, which holds its registry, Windows profile and DLL overrides.

That environment belongs to the game, not to the WINE version. Updating CrossOver, switching to another Sikarugir version or changing the graphics translator keeps it, along with any saves the game wrote to its Windows profile. The Windows version setting is the exception: in CrossOver, each Windows environment type (Windows 10, 11, 7 or XP) is its own bottle, and in Sikarugir those four versions each get their own prefix. CrossOver normally links a bottle's Windows Documents and Desktop folders to your Mac's own, but MacLauncher replaces those links with private folders, so games don't write into your Mac folders. **Open Windows files** in the inspector shows the environment once the game has been played.

MacLauncher normally starts the original Windows executable. The exception is a camera, XeSS or FidelityFX adapter that has to replace a DLL next to the executable; [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/) explains what these adapters are for. Such an adapter needs a small, separate launch folder with the executable and DLLs, although the game still runs in its original folder. Files that a game writes next to the adapted executable stay in that launch folder. The [runtime reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md) describes how the adapters handle files.

Removing a game from your library removes the Windows environments MacLauncher created for it and leaves the game files alone. Bottles and wrappers you made yourself are never removed; [Existing bottles and wrappers](/maclauncher/windows/existing-bottles/) explains how to run a game in one.

## Rosetta

Sikarugir and the usual CrossOver releases run WINE as an Intel program, so on Apple Silicon they need [Rosetta 2](https://support.apple.com/en-us/102527). A CrossOver build whose WINE is an ARM64 program runs it natively and leaves the game's Intel code to the FEX emulator. If Rosetta isn't installed yet, MacLauncher asks and installs it through the normal macOS prompt.

Further reading: the [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md) and [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md) reference pages, and CodeWeavers' [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index).
