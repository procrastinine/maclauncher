---
title: Steam client bridge
description: "How MacLauncher connects Windows Steam games in CrossOver and Sikarugir to the Steam client for Mac: when Play offers the Steam client bridge, what Play Without It does, how to check that a game used it, and how to remove it in Runtimes."
head:
  - tag: title
    content: "Run Windows Steam games with the Steam client for Mac in WINE | MacLauncher"
sidebar:
  order: 5.5
---

Windows games that use Steam's features carry Valve's Steam API, a `steam_api.dll` or `steam_api64.dll` file next to the game, which expects a Windows Steam client to answer it. Under WINE there's no Windows Steam client, so a game that checks your account or its ownership can refuse to start. The **Steam client bridge** connects the game's own Steam API to the Steam client for Mac, so Steam itself answers those requests. It works the same way in CrossOver and Sikarugir.

The game's files, its Steam API and its copy protection stay as they are, and the bridge doesn't change CrossOver, Sikarugir or the Steam client for Mac.

## When Play offers it

Play offers the bridge for a Windows game in CrossOver or Sikarugir when all of these hold:

- the game includes `steam_api.dll` or `steam_api64.dll`;
- MacLauncher knows the game's Steam app ID, either because the game is in a Steam library on your Mac or because you downloaded it with MacLauncher's Steam tab;
- the Steam client for Mac is installed.

Every other game starts without it.

## Playing with the bridge

1. Press **Play** on the game.
2. If the bridge isn't installed yet, MacLauncher asks before downloading it. When the bridge is the only download, the dialog is **Download Steam client bridge**, with the version, the download size and a note that Windows Steam client files from Valve come with it. Choose **Download and Play**. When the same Play also needs another download, such as a graphics component, the bridge appears as one more line in that dialog instead.
3. If Steam isn't running, MacLauncher asks **Start Steam for this game?**, because the Steam client goes online and signs in. Choose **Start Steam**. Your **Steam client on Play** setting in **Settings → Launcher**, or the game's own choice, can answer this question for you, as [Versions and settings](/maclauncher/tools/versions-and-settings/#steam-client-on-play) explains.
4. The game starts. There's nothing else to press; after the download, MacLauncher goes straight on to the game.

The Windows Steam client files come from Valve's current Steam client download, and MacLauncher checks them against the content address Valve publishes before keeping them, so later Plays don't download them again. The bridge doesn't need a particular version of the Steam client for Mac.

To check that a game used the bridge, look at its inspector after playing. A **Steam** row names the bridge version, such as **Steam client bridge 1.0.0**. A game whose last Play didn't use the bridge has no such row.

## Playing without it

**Play Without It** in the download dialog starts the game the ordinary way, without the bridge. So does **Launch without Steam** in the Steam question, and so does the **Don't start** setting, because the bridge can't work without a running Steam client.

MacLauncher remembers a declined or failed download for that game and doesn't ask again on later Plays. To be offered the bridge again, either:

- press the refresh button in the **CrossOver**, **Sikarugir** or **Steam client bridge** section of **Runtimes**, or
- install the bridge yourself in **Runtimes → Steam client bridge**, which makes every Windows Steam game eligible again.

## The bridge in Runtimes

**Runtimes → Steam client bridge**, under **Compatibility**, is where the bridge lives. Its **Components** card lists the **Windows Steam client files**, with the start of their content address once they're installed. Below it, **Versions** lists the bridge versions from MacLauncher Builds with an **Install** button, and **Installed** lists the ones you have. Play always uses the newest installed version, so the section has no default to set, and it has no **Register custom…** button, because Play uses only the bridge packages installed here.

To remove the bridge, press the trash button next to its version under **Installed**. Removing the last version also removes the Windows Steam client files, and the next Play of an eligible game offers both again.

## What the bridge doesn't decide

The bridge gives a game a working connection to Steam. Whether the game then runs still depends on Steam and on the game's own checks, and a working Steam connection says nothing about the game's graphics, other Windows features or anti-cheat software.

Further reading: [Windows Steam games](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINDOWS_STEAM.md) and [Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md) in the reference documentation.
