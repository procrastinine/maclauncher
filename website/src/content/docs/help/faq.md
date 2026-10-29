---
title: FAQ and troubleshooting
description: Common questions about MacLauncher, and what to try when a game doesn't start or doesn't behave.
---

## General

### Is MacLauncher free?

Yes. It's open source under the [MIT license](https://github.com/procrastinine/maclauncher/blob/master/LICENSE). The runtimes it downloads are open-source projects or official free releases, each under its own license; the [attributions](https://github.com/procrastinine/maclauncher/blob/master/docs/ATTRIBUTIONS.md) list them all. A few optional extras use software you bring yourself, like [CrossOver](https://www.codeweavers.com/crossover/) or a purchased copy of [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/).

### What Mac do I need?

An Apple Silicon Mac with macOS 13 or later. Some runtimes need a newer macOS: [AnyPS5](https://github.com/boykopovar/AnyPS5) and the 32-bit Mac runtime need macOS 26, and Android's [Mac.apk](https://github.com/kksimp/Mac.apk) needs macOS 26.4, for example. The inspector tells you when a runtime has extra requirements.

### Does it change my game files?

No. MacLauncher reads your games where they are. Anything it generates (converted files, caches, private copies for [WINE](https://www.winehq.org/) games, managed saves, exports) goes into its own storage under `~/Library/Application Support/maclauncher/`. **Forget** removes that data for a game; your originals stay put.

### Does it connect to the Internet?

Only when you do something that needs it: refreshing a version list, installing a runtime or tool after you've agreed, or using a store. There are no background checks, analytics or update pings. Installed runtimes work offline. Each game also has a **Network access** switch that can block its own Internet and local-network access.

### Do I still need CrossOver or WINE?

Only for games that have no native runtime. When a Windows game does need WINE, MacLauncher can download and manage [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) for free, and if you own CrossOver, it can use that instead, which is usually the better choice. See [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#windows-games).

### Is it an emulator?

Mostly not. Most runtimes run the game's own engine natively on macOS, or run the game's code on your real CPU while translating its system calls, the way WINE does. DOS games are the exception, through [DOSBox Staging](https://www.dosbox-staging.org/). [How games run on a Mac](/maclauncher/background/how-games-run/) explains the difference.

### Why is it built on Electron?

On purpose, believe it or not. Browser-based games are a big share of all games and run on the included [Electron](https://www.electronjs.org/) without any download, the codebase can travel to other platforms later, and the launcher's own weight hardly matters once a game is running. If you'd rather skip the library window entirely, save a `.command` launcher for the game and double-click that.

## Troubleshooting

### macOS says MacLauncher can't be opened

That's [Gatekeeper](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web), because the app is ad-hoc signed rather than signed with a paid Developer ID. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. [Getting started](/maclauncher/getting-started/#2-allow-it-through-gatekeeper) has the steps.

### A Mac game says it's "damaged"

Downloaded Mac games often carry Gatekeeper's quarantine flag, especially indie builds. Import the app and use **Remove quarantine** in its inspector.

### My game wasn't recognized, or was recognized as the wrong thing

Try importing the whole game folder rather than a single file, or the other way round. If a folder holds several executables, drag in the main `.exe` itself so MacLauncher knows which one is the game. A Windows game whose engine isn't recognized still imports, and runs through Sikarugir (WINE).

### The game won't start, or crashes

Work through these, roughly in order:

1. **Try another version** of the same runtime in the inspector. Engines like [Godot](https://github.com/godotengine/godot), [Unity](https://unity.com/) and [GameMaker](https://gamemaker.io/) are picky about versions.
2. **Try another runtime.** A game with a native runtime usually also offers Sikarugir and CrossOver, and Android games have three runtimes to choose from.
3. **Check Runtime Settings.** For WINE games, switching the graphics backend fixes a lot of rendering problems, and Japanese games may need the `ja_JP.UTF-8` locale.
4. **Turn off graphics effects** to rule them out, then add them back one at a time.
5. **Look at the log:** **Help → Show Log in Finder** reveals MacLauncher's log file.

### The first launch takes a long time

Some games need preparing the first time: Switch games extract and compile shaders, PS5 games are converted, Android apps are prepared, WINE games get a private Windows environment. Progress is shown while it happens, and later launches reuse the result.

### Effects don't seem to change anything

Check that **Graphics** is switched on for the game, and that the effect isn't bypassed in the chain. Temporal upscalers and some depth effects need extra information from the game renderer, so they only work where a runtime supplies it. The [graphics section](/maclauncher/graphics/) explains which effects need what.

### How do I uninstall MacLauncher?

Quit it, delete MacLauncher.app, and delete `~/Library/Application Support/maclauncher/` if you also want to remove installed runtimes, settings and MacLauncher's per-game data. Your game folders are untouched either way.

## Still stuck?

Search or open an issue on [GitHub](https://github.com/procrastinine/maclauncher/issues). Mention the game, its engine (shown in the inspector), the runtime and version you used, and attach the relevant part of the log.
