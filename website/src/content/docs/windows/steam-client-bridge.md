---
title: Steam client bridge
description: "How MacLauncher connects Windows Steam games in CrossOver, Sikarugir and WineCX to the Steam client for Mac, without Windows Steam in the bottle and without patching Steam: when Play offers the Steam client bridge, what Play Without Steam does, how to check that a game used it, and how to remove it in Runtimes."
head:
  - tag: title
    content: "Run Windows Steam games with the Steam client for Mac in WINE | MacLauncher"
sidebar:
  order: 5.5
---

Windows games that use Steam's features include Valve's Steam API, a `steam_api.dll` or `steam_api64.dll` file next to the game, which expects a Windows Steam client to answer it. Under WINE, the compatibility layer that runs Windows games on a Mac, there's no Windows Steam client, so a game that checks your account or its ownership can refuse to start. The **Steam client bridge** connects the game's own Steam API to the Steam client for Mac, so Steam itself answers those requests. It works the same way in [CrossOver, Sikarugir and WineCX](/maclauncher/windows/crossover-and-sikarugir/), the three WINE distributions MacLauncher runs Windows games with.

The game keeps running in its usual Windows environment (a CrossOver bottle, or a Sikarugir or WineCX prefix), with the same saves and settings. The bridge's own files load from MacLauncher's runtime storage outside the bottle. Inside the bottle, MacLauncher writes only the few Steam registry entries that the bridge needs, and it makes no copy of the bottle. The game's files, its Steam API and its copy protection stay as they are, and the bridge doesn't change the CrossOver or Sikarugir app or the Steam client for Mac. Games wrapped in Steam's own copy protection (SteamStub), which checks the Windows Steam client's files and your ownership of the game before the game itself starts, pass that check too: the bridge points it at the original client files, and the Steam app on your Mac answers the ownership request.

## Why a bridge

Without the bridge, the usual way to play a Windows Steam game on a Mac is to install the Windows version of Steam inside CrossOver and keep it running next to the game. That means a second Steam client with its own sign-in, its own updates and its own space in the bottle, running under WINE. With the bridge, the Steam app you already use on your Mac answers the game instead, so you never run Windows Steam in CrossOver or Sikarugir. The one requirement is that the Mac Steam app is running while you play, and MacLauncher can start it for you when you press Play.

The community project [NotProton](https://github.com/NotProtonNot/NotProton) makes a similar connection by patching Steam. MacLauncher's bridge starts from the same code, the `lsteamclient` library from [Proton](https://github.com/ValveSoftware/Proton), Valve's compatibility layer for Windows games on Linux, with NotProton's macOS changes. Unlike NotProton, it leaves Steam untouched, following MacLauncher's [unchanged source](/maclauncher/tools/#unchanged-source) principle. Most Steam updates therefore don't affect it, and it works for CrossOver, Sikarugir and WineCX alike.

## When Play offers it

Play offers the bridge for a Windows game in CrossOver, Sikarugir or WineCX when all of these hold:

- the game includes `steam_api.dll` or `steam_api64.dll`;
- MacLauncher knows the game's Steam app ID from a local Steam library, a completed Steam download or the portable game's `steam_appid.txt`;
- the Steam client for Mac is installed.

Every other game starts without it.

## Playing with the bridge

1. Press **Play** on the game.
2. If the bridge or the Windows Steam client files aren't installed yet, MacLauncher asks one question, **Play with Steam?** The dialog names what **Play with Steam** downloads (the Steam client bridge, the Windows Steam client files from Valve, or both, whichever you don't have yet) and says that Steam starts if it isn't running, because the Steam client goes online and signs in. Choose **Play with Steam**. When the same Play also needs another download, such as a WINE engine, that download's dialog lists the bridge instead and adds an **Also connect to Steam** checkbox, selected by default.
3. MacLauncher downloads what's missing and starts Steam if it isn't running, without asking again, unless the game's **Steam client on Play** setting is **Don't start**.
4. The game starts. There's nothing else to press. For an Unreal Engine game whose top-level `.exe` only starts the real game program, the bridge starts that program directly, so Steam is connected before the game's own code runs.

Once both are installed, or registered from copies you already have, later Plays use them without a dialog while Steam is running. When Steam isn't running, your **Steam client on Play** setting in **Settings → Launcher**, or the game's own choice, decides what happens; with **Ask**, the default, MacLauncher shows the same **Play with Steam?** question, as [Versions and settings](/maclauncher/tools/versions-and-settings/#steam-client-on-play) explains.

The Windows Steam client files come from Valve's current Steam client download. MacLauncher checks them against the content address Valve publishes (a fingerprint computed from the files' contents) and then keeps them, so later Plays don't download them again. The bridge doesn't need a particular version of the Steam client for Mac.

To check that a game used the bridge, look at its inspector after playing. A **Steam** row names the bridge version that ran. A game whose last Play didn't use the bridge has no such row.

## Playing without it

**Play Without Steam** in the **Play with Steam?** dialog starts the game the ordinary way, without the bridge, and so does clearing **Also connect to Steam** in another download's dialog. The **Don't start** setting does the same, because the bridge can't work without a running Steam client.

When you choose **Play Without Steam** in the download question, clear the checkbox, or the bridge download fails, MacLauncher remembers that for the game and doesn't ask again on later Plays. A refresh in **Runtimes** keeps that choice. To be offered the bridge again, install it yourself in **Runtimes → Steam client bridge**, which makes every Windows Steam game eligible again.

## The bridge in Runtimes

The bridge has its own tab in Runtimes, **Runtimes → Steam client bridge**, under **Compatibility**, with two sections: **Steam client bridge** and **Windows Steam client files**. The bridge section lists the bridge versions from MacLauncher Builds. The client files section lists the version of Valve's current Steam client after **Refresh Valve versions**, which reads only the file directories of Valve's archives, and keeps every version you install there, so an older client stays available after Valve moves on. Both sections have **Install**, a **Default** menu and **Register custom…**. Play uses the version you picked for the game, then the default, then the newest one you have.

**Register custom…** adds a copy you already have without changing it. For the bridge, that's a bridge package folder, such as an installed version's folder, as long as it matches this MacLauncher and contains every part its manifest names. For the client files, it's a folder holding `steamclient.dll` and `steamclient64.dll`, each checked to be the 32-bit or 64-bit Windows file it should be.

To remove a version, press the trash button next to it under **Installed**. Removing the last bridge version also removes the client files that came with the bridge, including copies from earlier MacLauncher versions, while client files you installed yourself or made the default stay. When a Play installs the client files for you, that copy is tidied away later, once a newer one is installed and nothing uses it, so copies don't pile up.

## What the bridge doesn't decide

The bridge gives a game a working connection to Steam. Whether the game then runs still depends on Steam and on the game's own checks, and a working Steam connection says nothing about the game's graphics, other Windows features or anti-cheat software.

Further reading: [Windows Steam games](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINDOWS_STEAM.md) and [Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md) in the reference documentation.
