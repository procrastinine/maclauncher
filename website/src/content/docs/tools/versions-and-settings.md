---
title: Versions and settings
description: "Install and switch runtime versions on macOS, set defaults and per-game overrides, add launch arguments and environment variables, control each game's network access, save .command launchers and run games from the command line."
head:
  - tag: title
    content: "Runtime versions and game settings on Mac | MacLauncher"
sidebar:
  order: 4
---

MacLauncher lets you choose the version of everything it runs, and it passes through nearly every option a runtime has. Each game can pick its own runtime and version, change any runtime setting, add launch arguments and environment variables, and decide whether it may go online. This page covers where those choices live: the Runtimes window for versions, the game's inspector for per-game choices, and the Settings window for defaults.

## The Runtimes window

The **Runtimes** window is MacLauncher's download manager. Everything MacLauncher can download has a page there, sorted into the groups Game engines, Consoles and mobile, Compatibility, Graphics and Tools. That includes the small packages other runtimes load, such as DXVK-NVAPI and Vulkan DLSS forwarding beside DXVK, CrossOver graphics integration, or MoltenVK scene support among the Vulkan drivers. Runtimes is only about downloads: settings that change how a runtime behaves, such as environment variables and plugin switches, are in [Settings](#settings). Each page works the same way:

- <span id="refresh"></span>The refresh button above a version list, **Reload versions**, looks up the available versions; the first time, it reads **Load versions**. The list comes straight from each project's own releases, so a new release appears the next time you refresh, without waiting for a MacLauncher update. Apart from a download you've agreed to, this is the only time MacLauncher checks for new versions. The results are cached, so the list is still there offline.
- <span id="install"></span>**Install** downloads the version you've selected. You can keep as many versions installed as you like, side by side.
- <span id="remove"></span>**Remove** deletes an installed version you no longer need. Each installed version shows how much disk space it takes, which helps when deciding what to remove.
- <span id="the-default"></span>The default is the version used by games that don't ask for a specific one. A version picked for a particular game, or one the game's own files call for, takes precedence. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/#versions) explains the order.

Many runtimes have two sources: the upstream project's own releases, and [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), which provides ready-to-run macOS builds of engines that need adapting. Each source has its own version list, and everything you've installed from either one shows up together when you choose a version for a game. A few components ship inside MacLauncher itself and are marked **Included**.

### Processor builds

MacLauncher comes as two apps, and each one downloads runtimes built for its own processor: the Apple Silicon app prefers Apple Silicon builds and the Intel app prefers Intel builds, even when it runs on an Apple Silicon Mac through Rosetta. A universal build, which contains both, serves either app.

When a runtime is published for both processors, a **Build** menu above its version list switches to the other processor's versions. Builds for both can be installed side by side. Builds for the app's own processor and universal builds have no tag, while one built for the other processor carries an **Intel** or **Apple Silicon** tag. **Set default** on such a build makes it that runtime's default.

An Apple Silicon build runs only on an Apple Silicon Mac, while Intel builds also run on Apple Silicon through [Rosetta](https://support.apple.com/en-us/102527). If Rosetta isn't installed yet, Play offers to install it, and macOS shows Apple's license prompt. A build your Mac can't run stays in the list, along with what it needs. [Macs and macOS versions](/maclauncher/macs-and-macos/) explains which runtimes and features depend on the processor or the macOS version.

### Your own copies

Some runtimes can use a copy you already have. **Register custom…** adds your own executable, app or runtime folder to a runtime's choices, and CrossOver has **Add CrossOver…** and **Find installed applications**. Those copies stay where they are, because MacLauncher only points to them, and removing one only forgets it.

### Downloads

You don't have to refresh before playing. If a game needs a runtime and no version list has been loaded yet, the download prompt that **Play** shows covers looking up the versions too, and MacLauncher installs the runtime's default version, which is the newest one that runs on your Mac unless you've chosen another. Development builds published through GitHub Actions, such as LÖVE nightlies and MKXP-Z's upstream builds, download without a GitHub account or any developer tools. A MacLauncher Builds package of a project that publishes no releases of its own is listed by the date of the upstream code it was built from, such as **Development build (Oct 28)**. A package with neither an upstream version nor a date is listed by its own version instead, such as **MCLv8**.

When a version you already have can play the game, Play uses it instead of downloading another one. A version that Play installed only because it was the default is tidied away later, once a newer default is installed and no game uses the old one; a version you installed yourself with **Install**, or made the default with **Set default**, stays until you remove it. Downloaded archives are deleted once they're unpacked, so only the installed files take up space.

Downloads run in the background while you keep using the launcher. A download button in the Runtimes window lists everything in progress, with a progress bar and a cancel button for each.

The graphics components are managed the same way, under **Runtimes → Effects**: shader collections, neural models, the upscaling and frame-generation components, and the adapters that pass a game's scene data to them. See [Graphics and effects](/maclauncher/graphics/).

### Downloaded files

A few downloads belong to no runtime of their own: the font that NScripter games fall back on, the soundfont and RPG Maker run-time packages that MKXP-Z uses, the GOG and Epic download helpers, Android's system image and microG, the shared libraries that runtime packages declare, and caches that MacLauncher fills, such as Steam's version lists. **Runtimes → Tools → Downloaded files** lists the ones on your Mac, largest first, with each file's size, where it came from and which runtimes or games use it.

**Delete** removes a file after asking, and **Delete unused** clears out everything that nothing uses any more. **Add from file…** takes a file you downloaded yourself and adds it once MacLauncher has checked that it matches a known download, without going online. On the rows for the GOG and Epic helpers and for microG, a refresh button looks up the newest release, which the next download that needs it brings in; the refresh button at the top only reads the list on your Mac again. You never have to visit this tab before playing, though: each of these files downloads on its own, after you agree, when something needs it.

## Per-game choices

A game's inspector lets you override almost everything for that game alone.

### Runtime and version

You can pick a different runtime or choose an exact version. The first entry in the version menu is the game's **Recommended** version when its files call for one, and otherwise the **Default**. [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) explains which runtime suits which game.

### Runtime settings

A gear next to the runtime opens that runtime's settings for this game, such as window size, language, controls or launch flags. The defaults for each game type live in **Settings**; anything you change here applies to this game only, and **Reset** returns to the defaults. Less common options sit in a collapsed **Advanced** group.

### Launch arguments

Launch arguments are extra command-line arguments passed to the game, for example `--windowed --name "Example name"`. Quotes keep spaces inside one argument. The arguments stay with the game even if you change its runtime, and shortcuts use them too.

### Translator environment variables

Many runtimes and translators read environment variables, and plenty of their switches exist nowhere else. A game's runtime settings have an **Environment variables** section for the ones it uses: WINE and the graphics translators it loads, the Android engines together with ANGLE and the Vulkan driver, and the PlayStation 5 runtimes. The section follows your other choices, so picking a different translator shows that translator's variables instead.

Values set in **Settings → Environment variables** show up here marked **From Settings**. You can change one for this game, remove it for this game only, or add a variable of your own; names are suggested as you type, each with a short description. **Restore** brings back an inherited value, and **Reset** returns the whole game to the values from Settings. Values are passed exactly as written, without shell expansion, and apply from the next launch. For example, `DXVK_HUD=fps` shows DXVK's frame counter in one game, and `KK_EMULATION=conformance` turns on every emulated feature of [KosmicKrisp](/maclauncher/windows/kosmickrisp/#kk_emulation) for a game that needs it. A row marked **Set by MacLauncher** means MacLauncher sets that variable itself, and its hint explains whether your value replaces MacLauncher's or isn't used. [Runtime patching](/maclauncher/tools/runtime-patching/#4-add-environment-variables) shows this step in context.

### Network access

Every game runs cut off from the Internet and your local network unless you allow it. A few games need access, for example web games that load their content from a website, and for those the **Network access** checkbox turns it on for this game; the default for newly added games is in **Settings → Launcher**, and it starts off. Changes apply the next time the game starts. The block covers the game and everything it starts, native code included, and if MacLauncher can't put it in place, the game doesn't start. [Network and privacy](/maclauncher/tools/network-and-privacy/#network-access-for-each-game) explains what it does and doesn't cover.

### Steam client on Play

Games that use [Steam](https://store.steampowered.com/) can start the Mac Steam client when you press Play. With **Ask**, the default, MacLauncher asks **Play with Steam?** with **Play with Steam** or **Play Without Steam** when Steam isn't running, because the Steam client goes online. **Start automatically** and **Don't start** skip the question. The setting is in **Settings → Launcher**, and each game can override it.

### Save location

You can point the game at a different save folder, or reset it to the default. See [Saves and cheats](/maclauncher/tools/saves-and-cheats/#moving-saves-around).

## Settings

The **Settings** window (Cmd+,) holds preferences, and the only thing in it that goes online is the **Check for Updates…** button. Its sidebar starts with a search field, followed by these sections:

- **Launcher**: appearance (System, Light or Dark), whether the library shows game icons and runtime tags, the default **Network access** for new games, **Steam client on Play**, the [graphics shortcuts and screenshot folder](/maclauncher/graphics/composing-effects/#shortcuts-and-screenshots), **Check for Updates…** with the result of the last check, and **Check for updates at launch**, which is off by default.
- <span id="environment-variables"></span>**Environment variables**: extra environment variables for the translators and runtimes that games run through, such as CrossOver, Sikarugir, DXVK, KosmicKrisp, the Android engines or the PlayStation 5 runtimes, with one collapsed block for each. Values set here apply to every game that uses that translator, and a game's **Runtime Settings** can change, add or remove variables for that game alone. Common variables are suggested as you type, each with a short description, and a row marked **Set by MacLauncher** shows when a value replaces one that MacLauncher sets itself.
- **Graphics**: the [shader library](/maclauncher/graphics/shaders/#the-shader-library) and your saved [graphics presets](/maclauncher/graphics/composing-effects/#presets), on the **Shaders** and **Presets** tabs.
- One section per game type, with its **Default runtime** and a tab for each runtime's settings. A tab shows **Modified** when its settings differ from the defaults.

Changes save as you make them and show up in every open window straight away.

## Shortcuts

**Create shortcut…** next to Play (or **Shortcut** on a library row) saves a small `.command` file wherever you like, under any name. Double-click it and the game starts with its current runtime, version, settings and save location, without opening the library window. You can put it in the Dock, a games folder or another launcher.

## Launching without the library

If you run MacLauncher from source, its backend, the part that detects, prepares and launches games, also works from the terminal:

```sh
pnpm launch --game /path/to/game --wait      # play
pnpm launch --game /path/to/game --inspect   # show what was detected
pnpm launch --game /path/to/game --action <action-id>
```

Guides: [Runtime system](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/README.md), [Settings reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SETTINGS_REFERENCE.md), [Release catalogs](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/RUNTIME_CATALOGS.md), [Network isolation](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md), [Backend and command line](https://github.com/procrastinine/maclauncher/blob/master/docs/development/BACKEND.md)
