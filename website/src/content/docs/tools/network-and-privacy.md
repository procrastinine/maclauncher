---
title: Network and privacy
description: "When MacLauncher goes online and when it doesn't: network requests only after Refresh, Install, a store action or a Play you agreed to, nothing in the background, installed runtimes that work offline, network access switched off for each game by default, no telemetry, and logs that stay on your Mac."
head:
  - tag: title
    content: "MacLauncher network use, offline play and privacy on Mac | MacLauncher"
sidebar:
  order: 9
---

A game launcher sits between you, your games and the Internet, so it's fair to ask what it sends where. MacLauncher's answer is short: it goes online only when you ask it to, it records nothing about you, and everything it keeps stays in your own files. This page goes through what that means in practice.

## When MacLauncher goes online

Every network request MacLauncher makes follows something you did. Nothing happens in the background, and simply opening a window or a tab doesn't go online either, because lists you've loaded before come from a local cache. The actions that do reach the network are these:

- In **Runtimes**, **Load versions** or **Reload versions** fetches a version list, and **Install** downloads the version you selected. Shader collections and neural models under **Runtimes → Effects** work the same way.
- **Play** for a game whose runtime, translator or tool isn't installed yet first shows a dialog naming what it will download, and only downloads after you agree. Preparation and the launch then carry on by themselves.
- In the **External** window, connecting to a store, reloading a list, refreshing a game's versions and downloading a game use the network. So does **Fetch previous versions**, which asks [SteamDB](https://steamdb.info/) for a Steam game's older builds.
- **Check for Updates…**, in the MacLauncher menu and in **Settings → Launcher**, asks GitHub for a newer release.

There's one setting that goes online on its own once you turn it on: **Check for updates at launch** in **Settings → Launcher** looks for a new release each time MacLauncher starts. It's off by default.

Some actions start other software that has its own network use. When a Steam game asks for the Steam client, for example, MacLauncher can start the Steam app for Mac, which then signs in. That's why the **Steam client on Play** setting asks first by default, as [Versions and settings](/maclauncher/tools/versions-and-settings/#steam-client-on-play) explains.

## Working offline

An installed runtime, translator, model or tool needs no connection to use, and neither does anything else MacLauncher does with games already on your Mac: importing them, detecting their engines, preparing them, applying graphics effects and running the tools. Version lists stay cached after a refresh, so you can still pick from them offline, and installed versions remain usable even after their publisher stops offering them.

## Network access for each game

Games can go online too, and MacLauncher controls that separately for each game. The **Network access** checkbox in a game's inspector cuts the game off from the Internet and your local network while it's unchecked, and for newly imported games it starts unchecked. A few games need it, such as web games that load their content from a website or games with online features, and for those you tick the checkbox. **Settings → Launcher** has the same checkbox for the starting value of newly imported games, and a change applies from the game's next launch.

The block applies to the game and everything it starts, including native libraries and helper programs, and works the same way in every runtime. If MacLauncher can't put it in place, the game doesn't start. It covers only the game's own processes, though: it isn't a firewall for your whole Mac, and it doesn't affect the Steam client, a browser or downloads that MacLauncher makes before the game starts. The [network isolation reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md) describes what stays reachable, such as WINE's own local communication.

## No telemetry

MacLauncher has no telemetry, analytics or crash reporting. It doesn't send usage data anywhere, and there's no account to create for MacLauncher itself.

## Logs stay on your Mac

When something goes wrong, the details are in log files on your Mac, and nothing sends them anywhere. **Help → Show Log in Finder** opens the folder with MacLauncher's own log, `main.log`. Each game also keeps the logs of its runtime and tools in its own folder, `games/<game ID>/logs/`, inside MacLauncher's data folder `~/Library/Application Support/maclauncher/`. If you report a problem, you decide what to share from them.

## Your files and accounts

The games themselves stay where you put them. MacLauncher keeps its own data, such as installed runtimes, caches and private Windows environments, in its data folder, and **Forget** removes a game's share of it without touching the game's files. The few changes that do go into a game folder, such as a patch or a cheat add-on, are tracked and can be undone, as [Patch and tinker tools](/maclauncher/tools/#unchanged-source) explains.

Store sign-ins stay on your Mac as well. Remembered sign-ins are stored encrypted and protected by the macOS Keychain, passwords are never saved, and reusing the account of the Steam app on your Mac doesn't copy its credentials. [Stores and downloads](/maclauncher/tools/stores-and-downloads/#accounts) has the details.

## Checking it yourself

None of this has to be taken on trust. MacLauncher is open source, so its [source on GitHub](https://github.com/procrastinine/maclauncher) shows every request it can make. Its releases are also built by GitHub Actions in a way you can verify, so you can confirm that the app you downloaded came from that exact source, as [How can I trust MacLauncher binaries?](/maclauncher/help/faq/#how-can-i-trust-maclauncher-binaries) explains.

Further reading: [Network isolation](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md), [Downloads and offline use](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/README.md#downloads-and-offline-use) and [App updates](https://github.com/procrastinine/maclauncher/blob/master/docs/UPDATES.md) in the reference documentation.
