---
title: Effects and upscaling
description: "MacLauncher's graphics effects on Windows games running in WINE on macOS, and how a game's own DLSS, XeSS or FidelityFX support can feed MetalFX and other temporal upscalers through DXMT, D3DMetal, CrossOver, Sikarugir and WineCX."
head:
  - tag: title
    content: "Effects, MetalFX and FSR upscaling for WINE games on Mac | MacLauncher"
sidebar:
  order: 4
---

MacLauncher's [graphics layer](/maclauncher/graphics/) works on Windows games in WINE just as it does on native games, with shaders, CRT effects, spatial and neural upscaling, frame generation and the rest. Most of it needs nothing from the game except its finished picture. Temporal upscalers are different, because they need data from inside the game's renderer, so MacLauncher adds a few pieces on the WINE side to get at that data.

## Effects

You set up effects for a WINE game the same way as for any other game, and you can change them while it runs. For CrossOver games, MacLauncher attaches its graphics layer through private copies of CrossOver's small WINE loaders (the programs that start WINE), which it prepares and signs itself, so the CrossOver application stays untouched. If those copies can't be prepared, the game still runs, just without effects for that launch.

Effects are set up for the [graphics translator](/maclauncher/windows/graphics-translators/) that the game actually uses, the layer that turns its Direct3D calls into Metal. If your chosen translator [couldn't load](/maclauncher/windows/graphics-translators/#when-a-translator-cant-load) and another one stood in, the graphics layer works with the one that ran. A translator change you make while the game runs applies from the next launch.

## Temporal upscaling

A [temporal upscaler](/maclauncher/graphics/upscaling/#temporal-upscalers) rebuilds a sharp picture from several low-resolution frames, using the game's depth buffer and motion vectors. Those come from inside the game's renderer, and a finished picture can't supply them. Many modern Windows games, however, already pass exactly this data to an upscaler of their own, such as NVIDIA's DLSS, AMD's FSR or Intel's XeSS. MacLauncher's adapters, small libraries that stand in for the upscaler the game calls, take that data and give it to a Mac upscaler instead.

The DLSS, FSR and XeSS support described below needs an Apple Silicon Mac and a 64-bit Windows game.

### DLSS games and the selected upscaler

When a game has a [DLSS](https://www.nvidia.com/en-us/geforce/technologies/dlss/) setting, the frame data it would give DLSS can go to MacLauncher's selected temporal upscaler instead. The game still provides its own color, depth, motion vectors and scaling values on each frame, and MacLauncher hands them to MetalFX, FSR or another selected method whose inputs are available. If no replacement method is selected, MetalFX gets them.

How the data reaches MacLauncher's graphics pipeline depends on the game's translator:

| Game's translator | How the frame data reaches MacLauncher |
| --- | --- |
| DXMT, for Direct3D 11 | The adapter passes the frame through DXMT's own MetalFX support. |
| vkd3d-proton, for Direct3D 12 | The adapter describes each frame's images through Vulkan to MacLauncher KosmicKrisp or to a MoltenVK build that accepts such frames. |
| DXVK, for Direct3D 11 | DXVK's Vulkan interop provides the matching images and GPU queue, and the frame then takes the same path as with vkd3d-proton. |
| D3DMetal | D3DMetal's own MetalFX call supplies the frame's textures, and a small WINE component can also pass on the camera data from Streamline, the NVIDIA library that many games call DLSS through. |

With the DXMT and D3DMetal that come with CrossOver or Sikarugir, the **Game temporal integration** setting in Runtime Settings makes the game show its DLSS option, and choosing a Temporal upscaling row also requests this integration at launch. A DXMT or D3DMetal version you pick from Runtimes for Direct3D 11 or 12 turns the integration on by itself, and if your Mac, macOS or the game can't run it, the game simply starts without it.

Games normally offer DLSS only on an NVIDIA GPU. So when D3DMetal performs the DLSS in a WINE that reads D3DMetal's adapter settings, such as WineCX, the game sees an NVIDIA GeForce RTX 4090. The `D3DM_VENDOR_ID`, `D3DM_DEVICE_ID` and `D3DM_DEVICE_DESCRIPTION` [environment variables](/maclauncher/windows/settings/#environment-variables) change the GPU vendor, model and name that the game sees in that case. With the other translators, the game sees your Mac's own GPU.

DXVK and vkd3d-proton need no setting either. Forwarding, the passing of their DLSS frames to MacLauncher, turns on by itself whenever a 64-bit game renders through one of them with DXVK's own DXGI on a Vulkan driver that can pass the frames on: MacLauncher KosmicKrisp or the **MoltenVK scene support** build. If you pick DXVK or vkd3d-proton from Runtimes and leave the **Vulkan driver** on Automatic, MacLauncher uses KosmicKrisp by itself. MoltenVK scene support serves only an older DXVK built for MoltenVK, because current DXVK and vkd3d-proton releases can't start on MoltenVK. CrossOver's own MoltenVK, an unmodified MoltenVK and LWJGL's KosmicKrisp can't pass the frames on, so if you pick one of them, the game starts without forwarding and the inspector says so.

Whichever translator a game uses, DLSS must be turned on in the game's own settings, and the translator and adapter libraries have to match. For DXVK and vkd3d-proton, the adapter libraries are two small packages from MacLauncher Builds, where MacLauncher publishes the packages it builds itself: **DXVK-NVAPI** and **Vulkan DLSS forwarding**, which Play offers to install. Play also writes the WINE registry value that tells the game's DLSS library where to find the forwarding library.

The selected upscaler takes over only when the game's frame includes everything it needs. When something is missing, such as the camera data that FSR 2 and 3 need, DXMT and D3DMetal keep the game's own MetalFX scaler. If the selected upscaler fails on a single frame, MetalFX Temporal fills in for that frame and the inspector's graphics status says so; the next frame tries your choice again. The [frame-source reference](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#scene-producers) describes each of these paths and the exact data it passes on.

### When an upscaler needs camera data

FSR 2 and FSR 3 need the game's camera parameters as well as depth and motion. Games that call DLSS through NVIDIA's Streamline library supply those parameters to Streamline. MacLauncher never swaps out the game's Streamline library, because games can check its NVIDIA signature and switch Streamline off if it changed. A DLSS call without Streamline constants supplies no camera, so it cannot provide the inputs for a method that needs one.

Whether camera data is available depends on the translator that actually runs. With DXVK and vkd3d-proton, the forwarding library picks up the camera inside the game's own Streamline library whenever forwarding is on, with no setting, and adds it to the frame of that DLSS call. On DXMT and D3DMetal, Streamline games get MetalFX Temporal without a camera, so FSR 2 and FSR 3 are not offered for them. The [temporal upscaler reference](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/PROVIDERS.md#scene-temporal-upscaling) lists the full input requirements.

All of this supplies the inputs of DLSS Super Resolution, the upscaling part of DLSS. NVIDIA's DLSS Frame Generation and Ray Reconstruction aren't made available to games. MacLauncher's own [frame generation](/maclauncher/graphics/frame-generation/) is a separate choice with its own input and presentation requirements.

### XeSS games

Games that use Intel's XeSS through its Direct3D 11 library can have their XeSS requests run through MetalFX. MacLauncher's XeSS adapter does this automatically when DXMT renders the game with MacLauncher's matching DXMT libraries.

### FidelityFX games

Games that ship AMD's FidelityFX API library, for Vulkan or Direct3D 12, can have their FidelityFX upscaling run by MacLauncher's selected upscaler instead, with CrossOver, Sikarugir or WineCX. This needs the FidelityFX API adapter from MacLauncher Builds, which Play offers to install, and a Vulkan driver that passes the game's frames on, which means MacLauncher KosmicKrisp or MoltenVK scene support. Direct3D 12 games also need MacLauncher's vkd3d-proton, which MacLauncher prepares only when the game's graphics settings use its frame data. When a frame can't be passed on, the game's own FidelityFX runs.

With the adapter in place, the graphics menus count the game's depth, motion and camera data as supplied, so temporal upscalers are no longer listed under **Needs scene inputs**. Effects placed before the upscaler work on the game's smaller rendered image. When the game shows the upscaled picture, it goes through the rest of the effects, and each effect runs once per frame.

Turning **Graphics** off while the game runs gives the upscaling back to the game's own FidelityFX, so the game looks just as it would without MacLauncher. Turning it back on brings MacLauncher's upscaler back from the next frame. Either way the switch takes effect within about a tenth of a second, without a restart.

## How the adapters treat your game files

Most of these adapters have to replace a DLL that sits next to the game's executable. MacLauncher never changes the original. Instead, it makes a small, separate launch folder with copies of the executable and the replaced DLLs, while the rest of the game is used from its original folder. For an Unreal Engine game whose top-level `.exe` only starts the real game program, that program is copied into the launch folder too. The game's working directory is still its own folder, as under CrossOver, so logs, saves and settings it writes relative to that folder land there. Only files it writes next to the adapted executable's own path stay in the launch folder. A game that doesn't need an adapter runs straight from its original files, and if an adapter can't be prepared, the game runs without it.

Further reading: [Upscaling](/maclauncher/graphics/upscaling/), and the [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md#temporal-upscaling), [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md#game-temporal-integration) and [Wine runtimes](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINE.md#what-each-source-supplies) references for every requirement.
