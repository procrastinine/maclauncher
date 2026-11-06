---
title: Runtime settings
description: "The WINE settings MacLauncher offers for each Windows game on macOS: translators, locale, Windows version, Retina and DPI, custom virtual desktop sizes, keyboard and mouse, engine options and diagnostic HUDs."
head:
  - tag: title
    content: "WINE settings for Windows games on Mac: CrossOver and Sikarugir | MacLauncher"
sidebar:
  order: 5
---

WINE has a lot of switches, spread across environment variables, registry keys and command-line options. MacLauncher gathers the useful ones into each game's **Runtime Settings**, in its inspector. **Settings** holds the defaults for every game, and a game's own Runtime Settings can override any of them. Changes apply the next time the game starts, and options your Mac can't use, such as ones that need Apple Silicon, aren't shown.

The settings come in a Basic group and four advanced groups: Display, Input, Compatibility and Diagnostics. Sikarugir and CrossOver share almost all of them.

## Basic

| Setting | What it does |
| --- | --- |
| Environment | Runs the game in its own private Windows environment, or in one of your [existing bottles or wrappers](/maclauncher/windows/existing-bottles/). |
| Default Direct3D engine, Direct3D 8 to 12, Vulkan driver, Video codecs | Choose the game's [graphics translators](/maclauncher/windows/graphics-translators/). |
| Game temporal integration | Lets the game's DLSS option drive [MetalFX and MacLauncher's temporal upscalers](/maclauncher/windows/effects-and-upscaling/#temporal-upscaling). |
| Synchronization | Automatic, MSync or Off, plus ESync for CrossOver versions older than 25. |
| Language locale | Sets a locale such as `ja_JP.UTF-8`, for Japanese games that otherwise show garbled text. |
| Windows version | Chooses which Windows version WINE reports: 10, 11, 7 or XP each get their own environment, and Sikarugir can also report older and server versions such as Vista or 98 inside the Windows 10 one. CrossOver calls this **Windows environment** and adds a per-launch Windows version. |
| Windows executable | Picks a different `.exe` inside the game folder, for when MacLauncher's automatic choice is the wrong one. |
| Game arguments | Passes extra command-line arguments to the game, one per line. |

## Display

**High Resolution (Retina)** renders at your screen's full resolution and sets 192 DPI unless you choose a DPI yourself, and **DPI** sets the scaling directly. **Fullscreen display capture** and **Vertical sync** can be forced on or off.

**Virtual desktop** runs the game inside a Windows desktop window of a size you choose, written as width by height, such as `1920x1080`. Type `off` to turn it off, or leave it empty to keep the runtime's default.

## Input

**Option as Alt** and **Command as Ctrl** map both the left and right Mac modifier keys to their Windows counterparts, which helps with games that expect an Alt or Ctrl key. **Mouse capture** keeps the cursor inside the game window and controls how DirectInput games move the mouse.

## Compatibility

**Advertise AVX under Rosetta** tells games running through Rosetta that the processor supports AVX instructions, which some newer games require. It's on by default in the environments MacLauncher creates.

The other compatibility options belong to a particular translator, so each one appears only when that translator is in use:

- DXVK: **DXVK async**, in DXVK builds that include it.
- DXMT: a frame-rate preset of 30, 60 or 120 FPS, and **MetalFX spatial** upscaling.
- D3DMetal: an FPS limit and **Metal 4**, in builds that include it.
- MoltenVK: fast math, argument buffers and an Unreal Engine 4 compatibility option.
- WineD3D: its own configuration string, such as `renderer=gl`.

If MacLauncher has to fall back to another translator for a launch, the options of the translator that didn't load are left out. **Runtime default** keeps the translator's own behavior. vkd3d-proton and KosmicKrisp have no options of their own here. The [graphics translators reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md#translator-options) lists the environment variable behind each option.

Sikarugir also has **DirectDraw compatibility**, an optional [cnc-ddraw](https://github.com/FunkyFr3sh/cnc-ddraw) wrapper for old 32-bit games that draw with DirectDraw.

**Enable BepInEx winhttp override** lets [BepInEx](https://github.com/BepInEx/BepInEx) mods that the game already contains load under WINE. MacLauncher doesn't download any mods or DLLs for it.

**Wine DLL overrides** and **Environment variables** are here too, for anything the other settings don't cover. MacLauncher sets the WINE and Windows environment paths itself, and an environment variable you set overrides the matching control above.

## Diagnostics

Apple's **Metal Performance HUD** and the **DXVK HUD** show frame rates and other figures on screen, the **Wine crash dialog** can be turned on or off, and **Wine debug channels** such as `+seh` write WINE's own logs for troubleshooting.

## In an existing bottle or wrapper

When a game runs in one of your own bottles or wrappers, every setting starts at **Bottle setting** or **Wrapper setting**, along with the value currently stored there, which MacLauncher reads without starting WINE. Choose **Custom setting** to change one. Settings stored in the Windows registry are then written into that bottle. MacLauncher writes nothing for settings you leave as they are.

If the bottle's WINE server is still running, the selector shows it, and changes to High Resolution or synchronization wait until it stops.

Further reading: the full settings tables in the [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md#runtime-settings) and [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md#runtime-settings) references.
