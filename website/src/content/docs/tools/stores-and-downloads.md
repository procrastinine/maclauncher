---
title: Stores and downloads
description: Import installed Steam, Epic, GOG and itch.io games, and download any platform or version you own, including Steam depots and Android APKs.
sidebar:
  order: 1
---

The **External** window, next to Settings in the toolbar, connects MacLauncher to the stores you already use. It does two things: it finds games you've already installed, and it downloads games you own, in exactly the version and platform you want.

## Games you already have

The **Installed** tab gathers the games installed by [Steam](https://store.steampowered.com/), [Epic Games](https://store.epicgames.com/) (including through [Heroic](https://heroicgameslauncher.com/) and [Legendary](https://github.com/legendary-gl/legendary)), [GOG](https://www.gog.com/) and [itch.io](https://itch.io/), both in their usual macOS locations and inside [CrossOver](https://www.codeweavers.com/crossover/) bottles. It reads the stores' local records, so it works offline. Tick the games you want and press **Import**; they stay where they are, and MacLauncher just adds them to your library.

## Downloading what you own

Each store has its own tab, and this is where MacLauncher goes further than the official launchers. The Steam client on a Mac, for instance, won't normally let you download the Windows version of a game. MacLauncher will, and that Windows build may well run natively through one of its [engine runtimes](/maclauncher/games/), no CrossOver required.

What you can choose depends on the store:

| Store | What you can pick |
| --- | --- |
| **Steam** | Branches, builds, individual [depots](https://partner.steamgames.com/doc/store/application/depots), and historical manifests (look up older manifest IDs on [SteamDB](https://steamdb.info/), or fetch the history from inside MacLauncher) |
| **Epic** | Published platform builds, or an exact historical manifest |
| **GOG** | Offline installer versions and [Galaxy](https://www.gog.com/galaxy) builds, including previous ones |
| **itch.io** | Uploads for each platform, and earlier builds when you sign in |
| **[Google Play](https://play.google.com/store/games)** | Current versions for a choice of Android device profiles, or exact version codes |
| **[F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/)** | Every published APK version |

Platforms are your call too: Windows, Linux, Mac (including old 32-bit Mac builds) and, where a publisher offers one, Android. Downloads go into their own version folders, so you can keep several versions side by side, and they're imported into your library automatically unless you untick that.

:::note
Downloads follow the store's rules. You can download what your account owns or what's free, and some restricted or removed content stays unavailable.
:::

## Accounts

You can use more than one account per store.

- **Steam:** either reuse the account signed in to the Steam app on your Mac (MacLauncher talks to the running client, without copying your credentials), or sign in to any number of additional accounts inside the External window, with [Steam Guard](https://help.steampowered.com/en/faqs/view/06B0-26E6-2CF8-254C) and QR sign-in supported. Remembered sign-ins are protected by the macOS Keychain, and passwords are never stored.
- **Epic, GOG and itch.io** have their own sign-ins in their tabs.
- **Google Play** accounts are shared with the Android runtimes, with a choice of device profiles.

## Steam API without Steam

Some games refuse to start unless Steam is running. MacLauncher includes [offline Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md) for the runtimes that need it, so those games can run locally, with the genuine [Steamworks](https://partner.steamgames.com/doc/sdk) libraries used where a game requires them.

Guides: [External game libraries](https://github.com/procrastinine/maclauncher/blob/master/docs/EXTERNAL.md), [Android app downloads](https://github.com/procrastinine/maclauncher/blob/master/docs/GOOGLE_PLAY.md)
