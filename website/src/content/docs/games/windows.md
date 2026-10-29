---
title: Windows games through WINE
description: Sikarugir and CrossOver run the Windows games that have no native engine runtime, with private bottles and per-game graphics settings.
sidebar:
  order: 3
---

Not every Windows game is built on an engine with a Mac runtime. Custom engines, [Unreal](https://www.unrealengine.com/) games, Unity [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) builds and countless older titles need Windows itself, or at least something that speaks its language. For those, MacLauncher uses **[WINE](https://www.winehq.org/)**, the compatibility layer that answers a game's Windows API calls with macOS equivalents. (New to the term? [How games run on a Mac](/maclauncher/background/how-games-run/#compatibility-layers-translate-the-conversation) explains it.)

There are two flavors, and MacLauncher handles the fiddly parts of both.

## Sikarugir: free, and managed for you

[Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free WINE distribution for macOS. Normally you'd install its Creator app, build a "wrapper" per game and wire it up yourself. MacLauncher skips all of that: it downloads Sikarugir's WINE engines directly, keeps as many versions as you like, and builds a private Windows environment (a ["prefix"](https://gitlab.winehq.org/wine/wine/-/wikis/FAQ) or "bottle") per game the first time you press Play.

Sikarugir is the default runtime for any Windows `.exe` that MacLauncher doesn't recognize as a known engine. Recognized engines offer it as an alternative.

## CrossOver: bring your own

If you own [CrossOver](https://www.codeweavers.com/crossover/), MacLauncher finds it in your Applications folder and offers it alongside Sikarugir. You can register more than one copy, such as a preview build or an older version you want to keep, and choose a different one for each game. CodeWeavers keeps CrossOver current with fixes for newer games, so if you own it, it's usually the better choice; you can make it the default for Windows games in **Settings**. CrossOver's own updates and licensing stay with CodeWeavers; MacLauncher just points games at the copy you pick.

## What MacLauncher does for you

**Your game folder stays pristine.** Windows games love writing settings and saves next to their own files. MacLauncher gives each game a private copy to write into, using copy-on-write cloning so it takes almost no extra disk space on [APFS](https://en.wikipedia.org/wiki/Apple_File_System). Your original files are never modified, and updates to the originals flow into the private copy without overwriting your saves or mods.

**Each game gets its own Windows.** Separate prefixes mean one game's tweaks, DLL overrides or registry changes can't break another.

**Settings you'd otherwise hunt for.** The inspector's Runtime Settings collect the useful knobs in one place:

- **Graphics backend:** Automatic, [DXMT](https://github.com/3Shain/dxmt), [DXVK](https://github.com/doitsujin/dxvk), D3DMetal (from Apple's [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/)) or WineD3D. These are the different ways of turning [DirectX](https://en.wikipedia.org/wiki/DirectX) into [Metal](https://developer.apple.com/metal/); when a game renders wrongly, switching backend is the first thing to try.
- **Language locale,** such as `ja_JP.UTF-8`, for Japanese games that show garbled text otherwise.
- **Windows version** to report (10, 11, 7 or XP).
- **DirectDraw compatibility** for old 2D games.
- **DLL overrides, environment variables, game arguments and WINE debug channels** for advanced tuning, plus a workaround that lets [BepInEx](https://github.com/BepInEx/BepInEx) mods load.

**Rosetta, handled.** WINE on the Mac runs Intel code, so on Apple Silicon it needs [Rosetta 2](https://support.apple.com/en-us/102527). If Rosetta isn't installed yet, MacLauncher asks and installs it through macOS's normal prompt.

**Graphics effects work here too.** The [graphics layer](/maclauncher/graphics/) runs on top of WINE games just like native ones. With compatible 64-bit games, Sikarugir can even pass [MetalFX](https://developer.apple.com/documentation/metalfx) temporal upscaling through the game's own [DLSS](https://www.nvidia.com/en-us/geforce/technologies/dlss/) setting.

## What to expect

WINE is very good, but it's a translation, so results vary from game to game. Games with DRM or anti-cheat that require real Windows won't run, and installers that need to install extra components aren't supported as playable games. MacLauncher plays the game itself: point it at the installed game folder or its main `.exe`.

If a game has a recognized engine, try its [native runtime](/maclauncher/games/desktop-engines/) first; it will usually run better. If a WINE game misbehaves, try another graphics backend, another WINE version, or CrossOver if you have it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#windows-games) has more on picking between them.

Guides: [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md), [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md)
