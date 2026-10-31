---
title: Versions and settings
description: Install and switch runtime versions, set defaults and per-game overrides, add launch arguments, save .command launchers and run games from the command line.
sidebar:
  order: 4
---

## Runtimes: one place for every version

The **Runtimes** window is MacLauncher's version manager. Every engine, player and tool has a page there, sorted into the groups Game engines, Consoles and mobile, Compatibility, Graphics and Tools. Each page works the same way:

- <span id="refresh"></span>The refresh button above a version list, **Reload versions**, looks up the available versions; the first time, it reads **Load versions**. The list comes straight from each project's own releases, so a new release appears the next time you refresh, without waiting for a MacLauncher update. Apart from a download you've agreed to, this is the only time MacLauncher checks for new versions. The results are cached, so the list is still there offline.
- <span id="install"></span>**Install** downloads the version you've selected. You can keep as many versions installed as you like, side by side.
- <span id="remove"></span>**Remove** deletes an installed version you no longer need.
- <span id="the-default"></span>The default is the version used by games that don't ask for a specific one. A version picked for a particular game, or one the game's own files call for, takes precedence. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#versions) explains the order.

Many runtimes have two sources: the upstream project's own releases, and [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), which provides ready-to-run macOS builds of engines that need adapting. Each source has its own version list, and everything you've installed from either one shows up together when you choose a version for a game. A few components ship inside MacLauncher itself and are marked **Included**.

### Processor builds

MacLauncher comes as two apps, and each one downloads runtimes built for its own processor: the Apple Silicon app prefers Apple Silicon builds and the Intel app prefers Intel builds, even when it runs on an Apple Silicon Mac through Rosetta. A universal build, which contains both, serves either app.

When a runtime is published for both processors, a **Build** menu above its version list switches to the other processor's versions. Builds for both can be installed side by side. One built for the other processor carries an **Intel** or **Apple Silicon** tag, while builds for the app's own processor and universal builds have none, and **Set default** on such a build makes it that runtime's default.

An Apple Silicon build runs only on an Apple Silicon Mac, while Intel builds also run on Apple Silicon through [Rosetta](https://support.apple.com/en-us/102527). If Rosetta isn't installed yet, Play offers to install it, and macOS shows Apple's license prompt. A build your Mac can't run stays in the list, along with what it needs. [Macs and macOS versions](/maclauncher/macs-and-macos/) explains which runtimes and features depend on the processor or the macOS version.

### Your own copies

Some runtimes can use a copy you already have. **Register custom…** adds your own executable, app or runtime folder to a runtime's choices, and CrossOver has **Add CrossOver…** and **Find installed applications**. Those copies stay where they are, because MacLauncher only points to them, and removing one only forgets it.

### Downloads

You don't have to refresh before playing. If a game needs a runtime and no version list has been loaded yet, the download prompt that **Play** shows covers looking up the versions too, and MacLauncher installs the runtime's default version, which is the newest one that runs on your Mac unless you've chosen another. Development builds published through GitHub Actions, such as LÖVE nightlies and MKXP-Z's upstream builds, download without a GitHub account or any developer tools. A MacLauncher Builds package of a project that publishes no releases of its own is listed by the date of the upstream code it was built from, such as **Development build (Oct 28)**.

Downloads run in the background while you keep using the launcher. A download button in the Runtimes window lists everything in progress, with a progress bar and a cancel button for each.

**Runtimes → Graphics** manages the graphics components the same way: shader collections, imported shaders, presets, neural models and the upscaling and frame-generation components. See [Graphics and effects](/maclauncher/graphics/).

## Per-game choices

A game's inspector lets you override almost everything for that game alone.

### Runtime and version

You can pick a different runtime or pin an exact version. The first entry in the version menu is the game's **Recommended** version when its files call for one, and otherwise the **Default**. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) explains which runtime suits which game.

### Runtime settings

A gear next to the runtime opens that runtime's settings for this game, such as window size, language, controls or launch flags. The defaults for each game type live in **Settings**; anything you change here applies to this game only, and **Reset** returns to the defaults. Less common options sit in a collapsed **Advanced** group.

### Launch arguments

Launch arguments are extra command-line arguments passed to the game, for example `--windowed --name "Example name"`. Quotes keep spaces inside one argument. The arguments stay with the game even if you change its runtime, and shortcuts use them too.

### Network access

Every game runs cut off from the Internet and your local network unless you allow it. The **Network access** checkbox turns access on for this game, and the default for newly added games is in **Settings → Launcher**. The block covers the game and everything it starts, native code included, and if MacLauncher can't put it in place, the game doesn't start. Changes apply the next time the game starts. A few games need access, for example web games that load their content from a website.

### Steam client on Play

Games that use [Steam](https://store.steampowered.com/) can start the Mac Steam client when you press Play. With **Ask**, the default, MacLauncher offers **Start Steam** or **Launch without Steam** when Steam isn't running, because the Steam client goes online. **Start automatically** and **Don't start** skip the question. The setting is in **Settings → Launcher**, and each game can override it.

### Save location

You can point the game at a different save folder, or reset it to the default. See [Saves and cheats](/maclauncher/tools/saves-and-cheats/#moving-saves-around).

## Settings

The **Settings** window (Cmd+,) holds preferences, and the only thing in it that goes online is the **Check for Updates…** button. Its sidebar starts with a search field, followed by these sections:

- **Launcher**: appearance (System, Light or Dark), whether the library shows game icons and runtime tags, the default **Network access** for new games, **Steam client on Play**, **Check for Updates…** with the result of the last check, and **Check for updates at launch**, which is off by default.
- One section per game type, with its **Default runtime** and a tab for each runtime's settings. A tab shows **Modified** when its settings differ from the defaults.

Changes save as you make them and show up in every open window straight away. Graphics presets and the shader library live in **Runtimes → Graphics**.

## Shortcuts

**Create shortcut…** next to Play (or **Shortcut** on a library row) saves a small `.command` file wherever you like, under any name. Double-click it and the game starts with its current runtime, version, settings and save location, without opening the library window. You can put it in the Dock, a games folder or another launcher.

## Launching without the library

If you run MacLauncher from source, the same backend works from the terminal:

```sh
pnpm launch --game /path/to/game --wait      # play
pnpm launch --game /path/to/game --inspect   # show what was detected
pnpm launch --game /path/to/game --action <action-id>
```

Guides: [Runtime system](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/README.md), [Settings reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SETTINGS_REFERENCE.md), [Release catalogs](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIME_CATALOGS.md), [Network isolation](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md), [Backend and command line](https://github.com/procrastinine/maclauncher/blob/master/docs/development/BACKEND.md)
