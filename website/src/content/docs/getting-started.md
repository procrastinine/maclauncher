---
title: Getting started
description: Download MacLauncher, get it past Gatekeeper, import your first game and press Play.
---

Getting from zero to playing takes a couple of minutes. You'll need an Apple Silicon Mac running macOS 13 or later. A few runtimes ask for a newer macOS (the PlayStation 5 and some Android runtimes need macOS 26, for example), and MacLauncher tells you when that's the case.

:::tip[Look around first]
The [interactive demo](/maclauncher/demo/) runs the real MacLauncher interface in your browser, on a library of example games. Every button explains what it would do, with a link to the article about it.
:::

## 1. Download

Grab the latest **MacLauncher.app** zip from the [Releases page](https://github.com/procrastinine/maclauncher/releases). Unzip it and drag MacLauncher.app into your **Applications** folder.

The app is small on purpose. Game engines aren't bundled; MacLauncher downloads the ones you actually need, when you need them, and only after asking.

## 2. Allow it through Gatekeeper

[Gatekeeper](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web) is the part of macOS that checks apps before they open. MacLauncher is ad-hoc signed rather than signed with a paid Apple Developer ID, so the first time you open it macOS will refuse and say it can't verify the developer. That's expected. To allow it:

1. Double-click MacLauncher.app once and dismiss the warning.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the message about MacLauncher and click **Open Anyway**.
4. Confirm with your password or Touch ID.

From then on it opens like any other app. Apple's guide has screenshots: [Open a Mac app from an unknown developer](https://support.apple.com/en-us/102445).

:::note
Prefer to build it yourself? MacLauncher runs from source too, and behaves the same. See the [development guide](https://github.com/procrastinine/maclauncher/blob/master/docs/DEVELOPMENT.md).
:::

## 3. Add a game

There are three ways to bring a game into your library:

- **Drag and drop** a game folder or file onto the library window.
- Use **File → Open…** (`⌘O`) or the add button in the toolbar.
- In Finder, right-click a game and choose **Open With → MacLauncher**.

What should you drag in? Usually the whole game folder, or the game's main executable. MacLauncher also accepts packages directly: `.exe`, `.app`, `.apk`, `.ipa`, `.jar`, `.swf`, `.love`, Switch `.nsp`/`.xci` files, PS5 game folders, DOS programs, videos and more. Installers and self-extracting archives are often fine too; MacLauncher can unpack common ones.

When you import, MacLauncher looks at the files to work out what you've got: which engine made the game, which version of that engine, and which runtime can run it on macOS. Your original files stay exactly where they are.

## 4. Look around the inspector

Click a game to open its **inspector** on the right. This is where everything about that game lives:

- **Runtime and version.** What will run the game, and which installed version. The default is usually the right one; [Choosing a runtime](/maclauncher/background/choosing-a-runtime/) explains when to change it.
- **Runtime Settings.** Options for that runtime, such as window size, language, controls or launch flags. These override the global defaults in **Settings** for this game only.
- **Graphics.** Shaders, upscaling, frame generation and more. See [Graphics and effects](/maclauncher/graphics/).
- **Tools.** Saves, cheats, decompilers and extractors, depending on the game. See [Tinker tools](/maclauncher/tools/).
- **Network access.** A per-game switch that can cut the game off from the Internet and your local network.

## 5. Press Play

Click **Play**. If the runtime this game needs isn't installed yet, MacLauncher asks before downloading it, installs it, and then carries on preparing and launching the game without any further clicks. The first launch of some games takes a little longer while MacLauncher prepares them (converting files, compiling shaders, or setting up a private Windows environment); later launches reuse that work.

Once something is installed, it stays available offline.

**Stop** ends the game from the launcher if you need to.

## Handy things to know

- **Runtimes**, **Settings**, **External** and **Credits** each open in their own window, so you can keep them next to the library or the game.
- **Create shortcut…** in the inspector creates a small launcher file. Double-click it to start that game with its current settings, without opening the library at all.
- **Forget** removes a game from the library and deletes MacLauncher's private data for it (generated files, caches, managed saves). The game's original files are never touched.
- MacLauncher's own data, including installed runtimes, lives in `~/Library/Application Support/maclauncher/`.
- MacLauncher makes no network requests in the background. It only goes online when you do something that needs it, like refreshing a version list, downloading a runtime after you've agreed, or browsing a store.

Ready for more? Learn [how games run on a Mac](/maclauncher/background/how-games-run/), browse the [supported games and runtimes](/maclauncher/games/), or jump into [graphics and effects](/maclauncher/graphics/).
