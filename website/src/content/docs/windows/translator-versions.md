---
title: Translator versions
description: "How MacLauncher handles graphics translator versions for WINE games on a Mac: releases from the translators' own projects, your own files and the copies in CrossOver, Sikarugir and WineCX, a separate choice for each game, one shared installation and automatic fallback, and how this compares with patching CrossOver."
head:
  - tag: title
    content: "DXVK, DXMT and MoltenVK versions for each WINE game on Mac | MacLauncher"
sidebar:
  order: 3
---

CrossOver, Sikarugir and WineCX, the WINE distributions that run Windows games on a Mac, each include the [graphics translators](/maclauncher/windows/graphics-translators/) that were current when that release came out, and every game in the distribution uses those versions. The projects behind the translators keep publishing new releases, though, and a game may need a different version from the one its WINE distribution includes. This page explains how MacLauncher makes any version available to any game, and how that compares with patching CrossOver.

## Patching CrossOver

Outside MacLauncher, one way to get newer translators into CrossOver is to patch the app, which is how [CXPatcher](https://github.com/italomandara/CXPatcher), an unofficial community tool, works. It makes a patched copy of the CrossOver app with newer builds of the DXVK, D3DMetal and MoltenVK translators, including compatibility patches such as DXVK changes for Unreal Engine 4 games, and it can also update DXMT to a build you download. The original app stays as it was, and by default the patched copy keeps its bottles in a separate folder. Its developer has announced [Procyon](https://github.com/italomandara/Procyon) as its successor.

With this approach, the translator versions are part of the patched copy of the app, and every bottle that runs in it uses the same versions. A new CrossOver release starts out unpatched, so it has to be patched again with a CXPatcher version that supports that release. CXPatcher's README also notes that CodeWeavers doesn't support patched copies.

## Translators kept outside the WINE runtimes

MacLauncher leaves CrossOver, Sikarugir and WineCX as they are and keeps translators in its own storage instead. Each translator has a section under **Runtimes → Graphics**, in **DirectX → Vulkan**, **DirectX → Metal**, **Vulkan drivers** or **Video codecs**, and each version there is installed once, from one of these sources:

- releases from the translators' own projects, downloaded when you press **Refresh** and **Install**: DXMT, DXVK, Gcenx's macOS and async builds of DXVK, vkd3d-proton and MoltenVK;
- the DXMT, DXVK, D9VK and D3DMetal libraries from Sikarugir's Template releases (the translator packages that accompany each Sikarugir engine), which install on their own, without another WINE engine;
- files you already have, added with **Register custom…**: a folder, an archive, a disk image, or a translator inside an installed application, such as your own copy of Apple's Game Porting Toolkit for D3DMetal.

The copies that come with your CrossOver application, Sikarugir Template or WineCX release are choices as well, and they need no installation at all. Each installed WINE version lists them in **Runtimes** on an **Includes** line, read from its own files, such as "Includes DXMT 0.80 · DXVK 1.10.3 for 32-bit games · MoltenVK 1.4.2 · GStreamer 1.26.3" for WineCX. When a translator brings its own DXGI library for only one kind of game, as that DXVK does for 32-bit games, it's offered only to games of that kind. A few small companion packages from MacLauncher Builds, where MacLauncher publishes the packages it builds itself, sit beside the translators that load them: **DXVK-NVAPI** and **Vulkan DLSS forwarding** in **DirectX → Vulkan**, which pass a game's DLSS calls through DXVK or vkd3d-proton, and **MoltenVK scene support** in **Vulkan drivers**. Play installs them, after asking, when a game needs them, and each has its own versions, sizes and **Remove** button like any other download. **Register custom…** in DXVK-NVAPI's section accepts your own `nvapi64.dll`, or a release folder holding it, once it's checked to be the 64-bit library with the NVAPI entry point.

Which version a game uses is chosen per game. **Settings** holds a default for each translator control, and a game's **Runtime Settings** can override it, so one game can use a different version from all the others. When the game starts, MacLauncher links the chosen version into that launch. The translators that come with CrossOver, Sikarugir or WineCX are selected through their usual settings, and other versions are linked into MacLauncher's private graphics folders for that WINE version or into the game's Windows environment. If a translator has to replace a DLL inside a bottle, the original is set aside and put back when you choose something else.

## What this means in practice

- One game can try a newer DXVK while your other games keep the version they have. A saved choice names one installed version, so installing another version changes nothing until you pick it.
- A CrossOver update doesn't undo any of this. The installed versions live outside the app, and an app that's updated in place keeps its games and their choices. CrossOver's own files are never modified, so the app stays as CodeWeavers ships it.
- The same installed versions serve CrossOver, Sikarugir and WineCX games alike, and each one is stored once however many games use it. Translators that you register from inside a CrossOver application are the exception: they're used with CrossOver only.
- The translator for each Direct3D version and the Vulkan driver are chosen separately, so a particular DXVK version can run with a different MoltenVK version, for example.
- A choice that can't load doesn't stop the game. MacLauncher checks the files before every launch and falls back to the same translator from CrossOver, Sikarugir or WineCX, while your choice stays saved for later; [When a translator can't load](/maclauncher/windows/graphics-translators/#when-a-translator-cant-load) has the details. A saved version that has since been removed falls back to the automatic choice in the same way.
- Your own bottles and wrappers stay as they were. As long as a translator control is left at **Bottle setting** or **Wrapper setting**, MacLauncher places no translator files there, as [Existing bottles and wrappers](/maclauncher/windows/existing-bottles/) explains.

The [graphics translator reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md) describes the sources, links and checks in full.
