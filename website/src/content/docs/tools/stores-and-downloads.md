---
title: Stores and downloads
description: "Import installed Steam, Epic, GOG and itch.io games on macOS, download any platform or older version you own, including Windows, Linux and 32-bit Mac Steam builds and Android APKs, and use several accounts per store."
head:
  - tag: title
    content: "Steam, Epic, GOG and itch.io games on Mac: imports and downloads | MacLauncher"
sidebar:
  order: 1
---

The **External** window, next to Settings in the toolbar, connects MacLauncher to the game stores you already use. It finds the games you've already installed, and it downloads the games you own in exactly the version and platform you want. That second part follows MacLauncher's [version management](/maclauncher/tools/#version-management) principle: you get to choose what you download as far as the store allows, which is often more than its own launcher offers on a Mac.

## Games you already have

The External window's **Installed** tab gathers the games installed by [Steam](https://store.steampowered.com/), [Epic Games](https://store.epicgames.com/) (including through [Heroic](https://heroicgameslauncher.com/) and [Legendary](https://github.com/legendary-gl/legendary)), [GOG](https://www.gog.com/) and [itch.io](https://itch.io/), both in their usual macOS locations and inside [CrossOver](https://www.codeweavers.com/crossover/) bottles. It reads the stores' local records, so it works offline. Tick the games you want and press **Import**. The games stay where they are, and MacLauncher adds them to your library.

Versions that MacLauncher downloaded for you appear in the **Downloaded** tab instead, which works the same way.

## Downloading what you own

Each store has its own tab, and these tabs let you choose more than the official launchers do. The Steam client on a Mac, for instance, won't normally let you download the Windows version of a game. MacLauncher will, and if the game is built on an engine with a [native runtime](/maclauncher/games/), that Windows build can run natively without CrossOver.

What you can choose depends on the store:

| Store | What you can pick |
| --- | --- |
| Steam | Branches, builds, individual [depots](https://partner.steamgames.com/doc/store/application/depots), and historical manifests (look up older manifest IDs on [SteamDB](https://steamdb.info/), or fetch the history from inside MacLauncher) |
| Epic | Published platform builds, or an exact historical manifest |
| GOG | Offline installer versions and [Galaxy](https://www.gog.com/galaxy) builds, including previous ones |
| itch.io | Uploads for each platform, and earlier builds when you sign in |
| [Google Play](https://play.google.com/store/games) | The current version for a choice of Android device profiles, or exact version codes |
| [F-Droid](https://f-droid.org/) and [IzzyOnDroid](https://apt.izzysoft.de/fdroid/) | Every published APK version |

If the store terms are new to you: a Steam game is made of **depots**, separate bundles of files for each platform, language or add-on, and every update of a depot gets a new **manifest** ID. Knowing an older manifest ID is enough to download that build again, even after the game has moved on. [SteamDB](https://steamdb.info/) lists the manifests of each depot, and **Fetch previous versions** asks SteamDB for the selected game's history, so you can pick a date instead of copying IDs. That helps when an update breaks a mod you rely on, for example.

The platform is your choice too: Windows, Linux, Mac (including old 32-bit Mac builds) and, where a publisher offers one, Android. Downloads go into their own version folders, so you can keep several versions side by side, and they're imported into your library automatically unless you untick that option.

:::note
Downloads follow the store's rules. You can download what your account owns or what's free, and some restricted or removed content stays unavailable.
:::

## Accounts

You can sign in to as many accounts as you need, instead of one per store, which helps when your games are spread over several accounts.

Steam offers two kinds of sign-in. **Reuse Steam** uses the account signed in to the Steam app on your Mac; MacLauncher talks to the running client and doesn't copy your credentials. **Sign in manually** adds a separate Steam session inside the External window, with [Steam Guard](https://help.steampowered.com/en/faqs/view/06B0-26E6-2CF8-254C) codes, mobile or email approvals and QR sign-in. **Add account** opens another sign-in, and the account selector switches the library you're browsing between all of them, while a download that's already running keeps its account.

Google Play sign-in goes through your browser and is shared with the Android runtimes in **Settings → Android**, so you can choose among the Google accounts you've added there, and each download can use a different Android device profile. Searching and downloading from Google Play happens in the External window itself, without starting Android. Epic and GOG can reuse a sign-in from [Heroic](https://heroicgameslauncher.com/), [Legendary](https://github.com/legendary-gl/legendary) or the store's own tools without changing their settings, or you can sign in on the store's page in your browser. On itch.io, public games need no account at all: paste a game's link and its downloads appear, and an API key adds your purchases, claims and bundles.

Remembered sign-ins are stored encrypted and protected by the macOS Keychain, and passwords are never saved.

## Steam API without Steam

Downloading a Steam game is often only half the job. Many Steam games check with Steam when they start, through Steam's copy protection or the Steam API library that ships with them, and without a Steam client to answer they quit. On a Mac, the usual workaround for Windows games is to install the Windows version of Steam inside CrossOver and run it next to the game. MacLauncher handles this layer itself instead.

For Windows games in CrossOver or Sikarugir, the [Steam client bridge](/maclauncher/windows/steam-client-bridge/) connects the game's own Steam API to the Steam app for Mac, so the Steam you already use answers the game's account and ownership checks. The Mac Steam app has to be running for that, and MacLauncher can start it when you press Play. The bridge doesn't patch Steam, CrossOver, Sikarugir or the game, so most Steam updates leave it working, and it works the same in CrossOver and Sikarugir. [NotProton](https://github.com/NotProtonNot/NotProton), a community project, makes a similar connection by patching Steam.

Native runtimes that need the Steam API get [offline Steam API support](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/STEAM_API.md) instead, so those games can run locally, with the genuine [Steamworks](https://partner.steamgames.com/doc/sdk) libraries used where a game requires them.

Guides: [External game libraries](https://github.com/procrastinine/maclauncher/blob/master/docs/library/EXTERNAL.md), [Android app downloads](https://github.com/procrastinine/maclauncher/blob/master/docs/library/GOOGLE_PLAY.md)
