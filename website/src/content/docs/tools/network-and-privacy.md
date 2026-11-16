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

Every network request MacLauncher makes follows something you did. Nothing happens in the background, and simply opening a window or a tab doesn't go online either, because lists you've loaded before come from a local cache. These are the actions that do reach the network:

- In **Runtimes**, **Load versions** or **Reload versions** fetches a version list, and **Install** downloads the version you selected. Shader collections, neural models and the FSR 4.1.2 and Apex Neural Rendering model data under **Runtimes → Effects** work the same way.
- When a game's runtime, translator or tool isn't installed yet, **Play** first shows a dialog naming what it will download, and only downloads after you agree. Preparation and the launch then carry on by themselves. An inspector tool or a patch that needs a download asks the same way, and a missing video plugin is offered with a **Skip** button.
- In the **External** window, connecting to a store, reloading a list, refreshing a game's versions and downloading a game use the network. So does **Fetch previous versions**, which asks [SteamDB](https://steamdb.info/) for a Steam game's older builds.
- **Check for Updates…**, in the MacLauncher menu and in **Settings → Launcher**, asks GitHub for a newer release.

One setting goes online on its own once you turn it on. **Check for updates at launch** in **Settings → Launcher** looks for a new release each time MacLauncher starts, and it's off by default.

Some actions start other software that uses the network itself. When a Steam game asks for the Steam client, for example, MacLauncher can start the Steam app for Mac, which then signs in. For that reason the **Steam client on Play** setting asks first by default, as [Versions and settings](/maclauncher/tools/versions-and-settings/#steam-client-on-play) explains.

## Working offline

An installed runtime, translator, model or tool needs no connection to use. Neither does anything else MacLauncher does with games already on your Mac: importing them, detecting their engines, preparing them, applying graphics effects and running the tools. Version lists stay cached after a refresh, so you can still pick from them offline, and installed versions remain usable even after their publisher stops offering them.

## Network access for each game

Games can go online too, and MacLauncher controls that separately for each game. While the **Network access** checkbox in a game's inspector is unchecked, the game is cut off from the Internet and your local network, and newly imported games start with it unchecked. A few games need access, such as web games that load their content from a website or games with online features, and for those you tick the checkbox. **Settings → Launcher** has the same checkbox for the starting value of newly imported games. A change applies from the game's next launch.

The block applies to the game and everything it starts, including native libraries and helper programs, and works the same way in every runtime. If MacLauncher can't put it in place, the game doesn't start. It covers only the game's own processes, though. It isn't a firewall for your whole Mac, and it doesn't affect the Steam client, a browser or downloads that MacLauncher makes before the game starts. The [network isolation reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md) describes what stays reachable, such as the local communication inside [WINE](https://www.winehq.org/), the layer that runs Windows games.

Since macOS 15, the system has a Local Network permission of its own and asks for it the first time an app looks for devices nearby. Games in Sikarugir and WineCX, the two free WINE distributions MacLauncher downloads, run from an app bundle that MacLauncher prepares for each of those runtimes, so macOS asks about them once per runtime, as [Game Mode and local network access](/maclauncher/windows/crossover-and-sikarugir/#game-mode-and-local-network-access) explains. That answer and the **Network access** checkbox both apply: with the checkbox off, the game stays off your local network whatever you answered.

## No telemetry

MacLauncher has no telemetry, analytics or crash reporting. It doesn't send usage data anywhere, and MacLauncher itself has no account to create.

## Logs stay on your Mac

When something goes wrong, the details are written to log files on your Mac, and nothing sends them anywhere. **Help → Show Log in Finder** opens the folder with MacLauncher's own log, `main.log`. Each game also keeps the logs of its runtime and tools in its own folder, `games/<game ID>/logs/`, inside MacLauncher's data folder `~/Library/Application Support/maclauncher/`. If you report a problem, you decide what to share from them.

## Your files and accounts

The games themselves stay where you put them. MacLauncher keeps its own data, such as installed runtimes, caches and private Windows environments, in its data folder, and **Forget** removes a game's share of it without touching the game's files. The few changes that do go into a game folder, such as a patch or a cheat add-on, are tracked and can be undone, as [Patch and tinker tools](/maclauncher/tools/#unchanged-source) explains.

Store sign-ins stay on your Mac as well. Remembered sign-ins are stored encrypted and protected by the macOS Keychain, passwords are never saved, and reusing the account of the Steam app on your Mac doesn't copy its credentials. [Stores and downloads](/maclauncher/tools/stores-and-downloads/#accounts) has the details.

## Checking it yourself

None of this has to be taken on trust. MacLauncher is open source, so its [source on GitHub](https://github.com/procrastinine/maclauncher) shows every request it can make. Its releases are also built by GitHub Actions, GitHub's build service, in a way you can verify, which lets you confirm that the app you downloaded came from that exact source, as [How can I trust MacLauncher binaries?](/maclauncher/help/faq/#how-can-i-trust-maclauncher-binaries) explains.

Further reading: [Network isolation](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NETWORK_ISOLATION.md), [Downloads and offline use](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/README.md#downloads-and-offline-use) and [App updates](https://github.com/procrastinine/maclauncher/blob/master/docs/UPDATES.md) in the reference documentation.
