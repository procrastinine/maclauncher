---
title: Versions and settings
description: Install and switch runtime versions, set defaults and per-game overrides, add launch arguments, save .command launchers and run games from the command line.
sidebar:
  order: 4
---

## Runtimes: one place for every version

The **Runtimes** window is MacLauncher's version manager. Every engine, player and tool has a page there, grouped into game engines, consoles and mobile, compatibility layers, graphics and tools, and each page works the same way:

- <span id="refresh"></span>**Refresh** (or **Load versions** the first time) looks up the versions that are available. This is the only time MacLauncher checks for new versions, so nothing happens behind your back. Results are cached, so the list is still there offline.
- <span id="install"></span>**Install** downloads the version you've selected. You can keep as many versions installed as you like, side by side.
- <span id="remove"></span>**Remove** deletes an installed version you no longer need.
- <span id="the-default"></span>**The default** is the version used by games that don't ask for a specific one. A version picked for a particular game, or one the game's own files call for, comes first. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#versions) explains the order.

Many runtimes have two sources: the upstream project's own releases, and [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), which provides ready-to-run macOS builds for engines that need adapting. Each source has its own version list, and everything you've installed shows up together when you choose a version for a game. A few components ship inside MacLauncher itself and are marked **Included**.

### Your own copies

Some runtimes can use a copy you already have. **Register custom…** adds your own executable, app or runtime folder to a runtime's choices, and applications such as [CrossOver](https://www.codeweavers.com/crossover/) have **Add application** and **Find installed applications**. Those copies stay where they are; MacLauncher simply points to them, and removing one only forgets it.

### Downloads

Downloads run in the background while you keep using the launcher. The download button in the Runtimes window lists everything in progress, with a progress bar and a cancel button for each.

**Runtimes → Graphics** manages the graphics side the same way: shader collections, imported shaders, presets, neural models and the upscaling and frame-generation components. See [Graphics and effects](/maclauncher/graphics/).

## Per-game choices

A game's inspector lets you override almost everything for that game alone.

### Runtime and version

Pick a different runtime or pin an exact version. The version menu's first entry is the game's **Recommended** version when its files call for one, otherwise the **Default**. A version you choose explicitly is never silently swapped for another one; if it's missing, Play asks before downloading it. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) explains which runtime suits which game.

### Runtime settings

The gear beside the runtime opens that runtime's settings for this game, such as window size, language, controls or launch flags. Global defaults live in **Settings**; anything you change here applies to this game only, and **Reset** goes back to the defaults. Less common options sit in a collapsed **Advanced** group.

### Launch arguments

Extra command-line arguments passed to the game, for example `--windowed --name "Example name"`. Quotes keep spaces inside one argument. Arguments stay with the game even if you change its runtime, and shortcuts use them too.

### Network access

Every game runs cut off from the Internet and your local network unless you allow it. The **Network access** checkbox turns access on for this game; the default for newly added games is in **Settings → Launcher**. The block covers the game and everything it starts, native code included, and if MacLauncher can't put it in place, the game doesn't start. Changes apply the next time the game starts. A few games need access, for example web games that load their content from a website.

### Steam client on Play

Games that use [Steam](https://store.steampowered.com/) can start the Mac Steam client when you press Play. **Ask** (the default) offers **Start Steam** or **Launch without Steam** when Steam isn't running, because the Steam client goes online; **Start automatically** and **Don't start** skip the question. The setting is in **Settings → Launcher**, and each game can override it.

### Save location

Point the game at a different save folder, or reset it to the default. See [Saves and cheats](/maclauncher/tools/saves-and-cheats/#moving-saves-around).

## Settings

The **Settings** window (Cmd+,) holds preferences only; it never downloads anything. Its sidebar has search, then:

- **Launcher**: appearance (System, Light or Dark), whether the library shows game icons and runtime tags, the default **Network access** for new games, and **Steam client on Play**.
- **One section per game type**, with its **Default runtime** and a tab for each runtime's settings. A tab reads **Modified** when its settings differ from the defaults.

Changes save as you make them and show up in every open window straight away. Graphics presets and the shader library live in **Runtimes → Graphics**.

## Shortcuts

**Create shortcut…** next to Play (or **Shortcut** on a library row) saves a small `.command` file wherever you like, under any name. Double-click it and the game starts with its current runtime, version, settings and save location, without opening the library window. It's handy for the Dock, a games folder, or another launcher.

## Launching without the library

If you run MacLauncher from source, the same backend works from the terminal:

```sh
pnpm launch --game /path/to/game --wait      # play
pnpm launch --game /path/to/game --inspect   # show what was detected
pnpm launch --game /path/to/game --action <action-id>
```

Guides: [Runtime system](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIMES.md), [Release catalogs](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIME_CATALOGS.md), [Network isolation](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md), [Backend and CLI](https://github.com/procrastinine/maclauncher/blob/master/docs/BACKEND.md)
