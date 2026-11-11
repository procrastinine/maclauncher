---
title: CrossOver, Sikarugir and WineCX
description: "The three WINE runtimes in MacLauncher for macOS: free Sikarugir and WineCX, downloaded and set up for you, and CrossOver, used from your own installation. How they differ, how to choose, and where each game's Windows files live."
head:
  - tag: title
    content: "CrossOver vs Sikarugir vs WineCX on Mac: MacLauncher's WINE runtimes | MacLauncher"
sidebar:
  order: 1
---

MacLauncher has three WINE runtimes, and all of them are distributions of WINE for macOS: a WINE build packaged with graphics translators and the libraries the Mac needs. [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is free, and MacLauncher downloads it for you. [CrossOver](https://www.codeweavers.com/crossover/) is CodeWeavers' commercial version, which you buy and install yourself. [WineCX](https://github.com/dappermint/winecx-gptk) is free as well and downloaded for you, and its WINE comes from CrossOver's own changes. Every game that can use WINE offers Sikarugir and WineCX, and it offers CrossOver too whenever MacLauncher finds or has registered a CrossOver application.

MacLauncher runs all three on one shared WINE layer. Settings, translator choices, private Windows environments, graphics effects, DLSS routing and the Steam client bridge work the same way for each, so what differs is mostly where the WINE comes from and what it includes.

## Sikarugir

Sikarugir's publisher releases WINE engines together with matching Template packages, which hold the support libraries and graphics translators for each engine. Used on its own, Sikarugir means installing its Creator app, building a "wrapper" for each game and setting it up yourself. MacLauncher skips all of that. It downloads the engines directly, keeps as many versions as you like, and sets up a private Windows environment (a ["prefix"](https://gitlab.winehq.org/wine/wine/-/wikis/FAQ), or "bottle") for each game the first time you press **Play**.

Sikarugir is the default runtime for Windows Game entries, and games of other types offer it as an alternative. You can install versions in advance from **Runtimes → Sikarugir**, or let Play download one when a game first needs it. Each installed version stays selectable, and a game's **Version** selector can choose a particular one for that game.

Current Sikarugir engines need macOS 14 or later, and MacLauncher reads each engine's requirement from its files during installation. The graphics translators in each Template have requirements of their own: DXMT starts at macOS 14 on a compatible GPU, while D3DMetal needs Apple Silicon and the macOS version that its installed framework requires. If an installation is ever incomplete, **Install** in Runtimes replaces it, or Play offers to download it again before the game starts. Either way, each game's private Windows environment and saves are kept.

## CrossOver

If you own CrossOver, MacLauncher finds it in your Applications folder and offers it alongside Sikarugir. You can register more copies with **Add CrossOver…** in Runtimes, such as a preview build or an older version you want to keep, and choose a different one for each game. CrossOver's updates and licensing stay with CodeWeavers. MacLauncher only points games at the copy you pick, and it never changes the CrossOver application itself.

When you update CrossOver in place, games keep using it with their existing bottles. If a game's selected copy goes missing, though, MacLauncher won't swap in another one on its own; put it back, or add its new location in **Runtimes**.

## WineCX

WineCX is a free WINE runtime published by dappermint. It takes CodeWeavers' CrossOver changes to WINE and rebases them onto a current WINE release. Because its WINE follows CrossOver's internals, Apple's D3DMetal can load into it the same way it loads into CrossOver.

MacLauncher downloads WineCX releases from GitHub after asking, just like Sikarugir, and checks each download against both GitHub's checksum and the publisher's own checksum file. **Runtimes → WineCX** lists the releases, and an installed version is labeled with its WINE version, such as **WineCX 4.8.1 · Wine 11.19**, along with the translators it includes.

Each release comes with DXMT, DXVK, MoltenVK and GStreamer video codecs. The DXVK in the current release has no 64-bit DXGI library, so MacLauncher offers it to 32-bit games only. D3DMetal isn't included: install a D3DMetal version in **Runtimes → Graphics → DirectX → Metal**, for example from Sikarugir's Template releases or your own copy of Apple's Game Porting Toolkit, and pick it for Direct3D 11 or 12. Every other translator in Runtimes works with WineCX as it does with Sikarugir, including the DXVK and vkd3d-proton releases that pair with MacLauncher KosmicKrisp. Left on its automatic choice, WineCX uses its DXMT for Direct3D 10 and 11, WineD3D for Direct3D 8 and 9, WINE's own vkd3d for Direct3D 12 and its MoltenVK for Vulkan.

Current WineCX releases need macOS 26 or later. MacLauncher reads that requirement from the first few megabytes of a release before downloading the rest, so a version your Mac can't run is listed with **Requires macOS 26 or later** and never downloaded. WineCX has no wrapper or bottle format of its own, so each game always gets a private Windows environment. Every WineCX launch is checked against the list of files MacLauncher recorded when it installed that version, so WineCX versions come only from these downloads, and **Runtimes → WineCX** has no **Register custom…** button.

## Which one to use

CodeWeavers keeps CrossOver current with fixes for newer games, so if you own it, it's usually the better choice. You can make it the default runtime for Windows Game in **Settings**, or pick it for a single game in its inspector. Sikarugir stays the default because it's free and always available. On macOS 26, WineCX is the free way to a CrossOver-style WINE on a current WINE release, with D3DMetal from Runtimes.

The three share more than you might expect. They offer the same [graphics translators](/maclauncher/windows/graphics-translators/) from MacLauncher, the same [runtime settings](/maclauncher/windows/settings/) and the same [effects and upscaling](/maclauncher/windows/effects-and-upscaling/). The differences are in what each distribution includes: its own WINE build, its own set of included translators and, for CrossOver and WineCX, CodeWeavers' changes. Some settings belong to one of them only. Sikarugir has an optional DirectDraw compatibility wrapper for old 32-bit games, for example, and CrossOver can report a different Windows version for a single launch.

## Original game files and separate Windows environments

When you press **Play**, the game runs in its original folder and reads its files there directly, without a private copy of the whole game folder. Each game does get its own Windows environment, though, which holds its registry, Windows profile and DLL overrides.

That environment belongs to the game, not to the WINE version. Updating CrossOver, switching to another Sikarugir or WineCX version or changing the graphics translator keeps it, along with any saves the game wrote to its Windows profile. The Windows version setting is the exception: in CrossOver, each Windows environment type (Windows 10, 11, 7 or XP) is its own bottle, and in Sikarugir and WineCX those four versions each get their own prefix. CrossOver normally links a bottle's Windows Documents and Desktop folders to your Mac's own, but MacLauncher replaces those links with private folders, so games don't write into your Mac folders. **Open Windows files** in the inspector shows the environment once the game has been played.

MacLauncher normally starts the original Windows executable. The exception is a camera or XeSS adapter that has to replace a DLL next to the executable; [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/) explains what these adapters are for. Such an adapter needs a small, separate launch folder with the executable and DLLs, although the game still runs in its original folder. Files that a game writes next to the adapted executable stay in that launch folder. The [runtime reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md) describes how the adapters handle files.

Removing a game from your library removes the Windows environments MacLauncher created for it and leaves the game files alone. Bottles and wrappers you made yourself are never removed; [Existing bottles and wrappers](/maclauncher/windows/existing-bottles/) explains how to run a game in one.

## Game Mode and local network access

macOS has a Game Mode for games played full screen: it gives the game top priority on the CPU and GPU and lowers Bluetooth latency for wireless controllers and AirPods. macOS switches it on only for apps it knows are games, and a WINE program doesn't count as one by itself. For Sikarugir and WineCX games, MacLauncher therefore starts the game from a small app bundle of its own, filed in the games category. Once the game is full screen and in front, macOS turns Game Mode on. CrossOver games run from CrossOver's own WINE program, which doesn't declare itself a game.

Because macOS treats that bundle as an app, macOS 15 and later also ask you whether it may use the local network, the same question any Mac app gets before it can find devices nearby. Each WINE runtime has its own bundle, so the question comes at most once for Sikarugir and once for WineCX, the first time one of their games uses the local network, and its explanation names the runtime. Your answer covers every game and every version of that runtime, and **System Settings → Privacy & Security → Local Network** can change it later. Play never waits for it, because WINE's background programs start outside the bundle; only the game's own local network use waits until you answer. Most games use the local network only for LAN multiplayer or nearby devices, and Internet access doesn't depend on it.

The game's **Network access** checkbox still applies on top of this answer. With it off, the game stays cut off from your local network whatever you answered, as [Network and privacy](/maclauncher/tools/network-and-privacy/#network-access-for-each-game) explains.

## Rosetta

Sikarugir, WineCX and the usual CrossOver releases run WINE as an Intel program, so on Apple Silicon they need [Rosetta 2](https://support.apple.com/en-us/102527). A CrossOver build whose WINE is an ARM64 program runs it natively and leaves the game's Intel code to the FEX emulator. If Rosetta isn't installed yet, MacLauncher asks and installs it through the normal macOS prompt.

Further reading: the [Wine runtimes](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINE.md), [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md), [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md) and [WineCX](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINECX.md) reference pages, and CodeWeavers' [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index).
