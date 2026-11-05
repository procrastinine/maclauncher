---
title: Getting started
description: "Download MacLauncher for an Apple Silicon or Intel Mac, get it past Gatekeeper, import your first game and press Play."
head:
  - tag: title
    content: "Install MacLauncher on a Mac and play your first game | MacLauncher"
---

MacLauncher needs a Mac running macOS 13 or later, with either Apple Silicon or an Intel processor. Some runtimes need more: Android and iOS games need Apple Silicon, and a few runtimes need a newer macOS (the PlayStation 5 runtime and some Android runtimes need macOS 26, for example). MacLauncher tells you when that's the case, and [Macs and macOS versions](/maclauncher/macs-and-macos/) lists what works where.

:::tip[Look around first]
The [interactive demo](/maclauncher/demo/) runs the real MacLauncher interface in your browser, with a library of example games. Every button explains what it would do and links to the article about it.
:::

## 1. Download

MacLauncher comes in two builds, one for each kind of Mac processor: [Apple Silicon](https://github.com/procrastinine/maclauncher/releases/latest/download/MacLauncher.app.zip) and [Intel](https://github.com/procrastinine/maclauncher/releases/latest/download/MacLauncher-Intel.app.zip). To see which one your Mac has, open **Apple menu → About This Mac**: a Chip line means Apple Silicon, and a Processor line means Intel. Both links always download the latest release. Unzip the download and drag MacLauncher.app into your **Applications** folder. Earlier versions and release notes are on the [Releases page](https://github.com/procrastinine/maclauncher/releases).

Both versions of the app share one library, one set of settings and the same installed runtimes, and each downloads runtimes built for its own processor. The Intel app keeps choosing Intel builds even when it runs on an Apple Silicon Mac through Rosetta. If you need a runtime built for the other processor, [Runtimes](/maclauncher/tools/versions-and-settings/#processor-builds) has it.

There's no separate download for each macOS version. On an older macOS, or on a GPU that lacks a feature, MacLauncher switches off only the graphics effects that need it, and the rest keep working.

The app is small because game engines aren't bundled with it; MacLauncher downloads the ones you need when you need them.

## 2. Allow it through Gatekeeper

[Gatekeeper](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web) is the part of macOS that checks apps before they open. MacLauncher is ad-hoc signed rather than signed with a paid Apple Developer ID, so the first time you open it, macOS refuses and says it can't verify the developer. To allow it:

1. Double-click MacLauncher.app once and dismiss the warning.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the message about MacLauncher and click **Open Anyway**.
4. Confirm with your password or Touch ID.

After that it opens like any other app. Apple's guide [Open a Mac app from an unknown developer](https://support.apple.com/en-us/102445) shows the same steps with screenshots.

:::note
MacLauncher also runs from source and behaves the same way. The [development guide](https://github.com/procrastinine/maclauncher/blob/master/docs/development/DEVELOPMENT.md) explains how to build it.
:::

## 3. Add a game

There are three ways to bring a game into your library:

- Drag a game folder or file onto the library window.
- Use **File → Open…** (`⌘O`) or **Add game…** in the toolbar.
- In Finder, right-click a game and choose **Open With → MacLauncher**.

Usually you add the whole game folder or the game's main executable. MacLauncher also accepts packages directly: `.exe`, `.app`, `.apk`, `.ipa`, `.jar`, `.swf`, `.love`, Switch `.nsp`/`.xci` files, PS5 game folders, DOS programs, videos and more. Installers and self-extracting archives often work too, because MacLauncher can unpack the common ones.

On import, MacLauncher reads the files to work out the game's [game type](/maclauncher/background/choosing-a-runtime/#game-types-and-runtimes) (the engine or platform it was made for), the engine version, and which runtime can play it on macOS. Your original files stay where they are.

## 4. Look around the inspector

Click a game to open its **inspector** on the right, where everything about that game lives:

- **Runtime and version** show what will run the game and which installed version it uses. The default is usually the right one; [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) explains when to change it.
- **Runtime Settings** holds options for that runtime, such as window size, language, controls or launch flags. These override the global defaults from **Settings** for this game only.
- **Graphics** adds shaders, upscaling, frame generation and more. See [Graphics and effects](/maclauncher/graphics/).
- **Tools** has saves, cheats, decompilers and extractors, depending on the game type. See [Tinker tools](/maclauncher/tools/).
- **Network access** is a per-game switch that can cut the game off from the Internet and your local network.

## 5. Press Play

Click **Play**. If the game's runtime isn't installed yet, MacLauncher asks before downloading it, installs it, and then prepares and launches the game without further clicks. Some games take longer the first time while MacLauncher prepares them, for example by converting files, compiling shaders or setting up a private Windows environment. Later launches reuse that work.

**Stop** ends the game from the launcher if you need to.

## Good to know

- **Runtimes**, **Settings**, **External** and **Credits** each open in their own window, so you can keep them next to the library or the game.
- **Create shortcut…** in the inspector saves a small launcher file. Double-click it to start that game with its current settings, without opening the library.
- **Forget** removes a game from the library and deletes MacLauncher's private data for it: generated files, caches and the saves it keeps in its own storage. The game's original files are never touched.
- MacLauncher's own data, including installed runtimes, lives in `~/Library/Application Support/maclauncher/`.

To learn more, read [how games run on a Mac](/maclauncher/background/how-games-run/), browse the [supported games and runtimes](/maclauncher/games/), or go straight to [graphics and effects](/maclauncher/graphics/).
