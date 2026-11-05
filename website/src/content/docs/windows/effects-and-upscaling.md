---
title: Effects and upscaling
description: "MacLauncher's graphics effects on Windows games running in WINE on macOS, and how a game's own DLSS, XeSS or FidelityFX support can feed MetalFX and other temporal upscalers through DXMT, D3DMetal, CrossOver and Sikarugir."
head:
  - tag: title
    content: "Effects, MetalFX and FSR upscaling for WINE games on Mac | MacLauncher"
sidebar:
  order: 4
---

MacLauncher's [graphics layer](/maclauncher/graphics/) works on Windows games in WINE just as it does on native games: shaders, CRT effects, spatial and neural upscaling, frame generation and the rest. Most of it needs nothing from the game except its finished picture. Temporal upscalers are different, because they need data from inside the game's renderer, and that's where MacLauncher's WINE-side additions come in.

## Effects

You set up effects for a WINE game the same way as for any other game, and you can change them while it runs. For CrossOver games, MacLauncher attaches its graphics layer through private copies of CrossOver's small WINE loaders, which it prepares and signs itself, so the CrossOver application stays untouched. If those copies can't be prepared, the game still runs, just without effects for that launch.

Effects are set up for the translator that the game actually uses. If your chosen translator [couldn't load](/maclauncher/windows/graphics-translators/#when-a-translator-cant-load) and another one stood in, the graphics layer works with the one that ran. A translator change you make while the game runs applies from the next launch.

## Temporal upscaling

A [temporal upscaler](/maclauncher/graphics/upscaling/#temporal-upscalers) rebuilds a sharp picture from several low-resolution frames, using the game's depth buffer and motion vectors. Those come from inside the game's renderer, and a finished picture can't supply them. Many modern Windows games already pass exactly this data to an upscaler of their own, such as NVIDIA's DLSS, AMD's FSR or Intel's XeSS. MacLauncher's adapters catch that hand-off and give the data to a Mac upscaler instead.

The DLSS, FSR and XeSS routes below need an Apple Silicon Mac and a 64-bit Windows game.

### DLSS to MetalFX

**Game temporal integration**, in a game's Runtime Settings, makes a game's [DLSS](https://www.nvidia.com/en-us/geforce/technologies/dlss/) option run Apple's [MetalFX](https://developer.apple.com/documentation/metalfx) Temporal upscaler. It works when the game renders with DXMT on macOS 14 or later, or with D3DMetal on macOS 26 or later. Turn DLSS on in the game's own settings to use it. If you select a temporal upscaler in MacLauncher's graphics settings, the integration turns on by itself at launch, and the game's DLSS data then feeds the upscaler you chose. DLSS frame generation and ray reconstruction aren't part of this.

### FSR 2 and FSR 3 from DLSS games

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data as well as depth and motion. Games that call DLSS through NVIDIA's Streamline library already hand that data over, and MacLauncher's Streamline and DXMT camera adapters pass it on. For this, DXMT has to be the game's Direct3D engine; in CrossOver it has to be chosen explicitly, not left to CrossOver's automatic choice. The camera adapters come with MacLauncher. Play downloads only the DXMT libraries they need, not another WINE engine, and Sikarugir and CrossOver share one set of these library versions under **Runtimes → Graphics → DirectX → Metal → DXMT**. If the DXMT version that a game uses doesn't match the camera adapter, the inspector says camera support is unavailable, and the game keeps rendering with that DXMT.

### XeSS games

Games that use Intel's XeSS through its Direct3D 11 library can have their XeSS requests run through MetalFX. MacLauncher's XeSS adapter does this automatically, under the same DXMT conditions as the camera adapters.

### FidelityFX in Vulkan games on CrossOver

CrossOver games that render with Vulkan and use AMD's FidelityFX API can also hand their scene to MacLauncher. This route needs three packages from MacLauncher Builds, which Play offers to install: a WineVulkan scene adapter, a FidelityFX API adapter and a MoltenVK build with scene support. MacLauncher prepares it only when your graphics settings use scene data and the game includes the matching FidelityFX library. The WineVulkan adapter is built for CrossOver 26.3, and it's used only with a CrossOver whose WINE Vulkan files match it. Keep the game's **Vulkan driver** on CrossOver's automatic choice for this route.

## How the adapters treat your game files

Most of these adapters have to replace a DLL that sits next to the game's executable. MacLauncher never changes the original: it makes a small, separate launch folder with copies of the executable and the replaced DLLs, while the rest of the game is used from its original folder. Files the game writes next to the adapted executable stay in that launch folder, and a game that doesn't need an adapter runs straight from its original files. If an adapter can't be prepared, the game runs without it.

Further reading: [Upscaling](/maclauncher/graphics/upscaling/), and the [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md#temporal-upscaling) and [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md#game-temporal-integration) references for every requirement.
