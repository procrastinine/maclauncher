---
title: Effects and upscaling
description: "MacLauncher's graphics effects on Windows games running in WINE on macOS, and how a game's own DLSS, XeSS or FidelityFX support can feed MetalFX and other temporal upscalers through DXMT, D3DMetal, CrossOver, Sikarugir and WineCX."
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

### DLSS games and the selected upscaler

A game's [DLSS](https://www.nvidia.com/en-us/geforce/technologies/dlss/) setting can supply the scene data for MacLauncher's selected temporal upscaler. The game still provides its own color, depth, motion vectors and scaling values on each frame, but MacLauncher hands them to MetalFX, FSR or another selected method whose inputs are available. Without a selected replacement method, the integration uses MetalFX.

There are several ways for that data to reach the shared graphics pipeline:

| Game's translator | How the scene reaches MacLauncher |
| --- | --- |
| DXMT, for Direct3D 11 | The adapted DLSS call passes its scene through DXMT's native MetalFX integration. |
| vkd3d-proton, for Direct3D 12 | The adapted DLSS call passes a temporal frame description through Vulkan to MacLauncher KosmicKrisp or a MoltenVK build with temporal-frame support. |
| DXVK, for Direct3D 11 | DXVK's Vulkan interop provides the matching images and queue for the same temporal-frame route. |
| D3DMetal | The native MetalFX call supplies the scene textures; a small Wine component can also pass on a Streamline camera. |

With the DXMT and D3DMetal that come with CrossOver or Sikarugir, **Game temporal integration** in Runtime Settings exposes the game's DLSS option, and choosing a Temporal upscaling row also requests the integration at launch. A DXMT or D3DMetal version you pick from Runtimes for Direct3D 11 or 12 turns the integration on by itself, and if your Mac, macOS or the game can't run it, the game simply starts without it. Games normally offer DLSS only on an NVIDIA GPU, so when D3DMetal performs the DLSS in a WINE that reads D3DMetal's adapter settings, such as WineCX, the game sees an NVIDIA GeForce RTX 4090. The `D3DM_VENDOR_ID`, `D3DM_DEVICE_ID` and `D3DM_DEVICE_DESCRIPTION` [environment variables](/maclauncher/windows/settings/#environment-variables) replace that identity, and the other routes keep your Mac's own GPU. The DXVK and vkd3d-proton route needs no setting either. It turns on by itself whenever a 64-bit game renders through one of them with DXVK's own DXGI on a Vulkan driver that can carry the frames, which means MacLauncher KosmicKrisp or the **MoltenVK scene support** build. Pick DXVK or vkd3d-proton from Runtimes and leave the **Vulkan driver** on Automatic, and MacLauncher uses KosmicKrisp by itself; MoltenVK scene support serves only an older DXVK built for MoltenVK, because current DXVK and vkd3d-proton releases can't start on MoltenVK. CrossOver's own MoltenVK, a stock MoltenVK and LWJGL's KosmicKrisp can't carry the frames, so if you pick one of them, the game starts without forwarding and the inspector says so. On every route, DLSS must be enabled in the game's own settings, and the routes need matching translator and adapter libraries. For DXVK and vkd3d-proton, those are two small packages from MacLauncher Builds, **DXVK-NVAPI** and **Vulkan DLSS forwarding**, which Play offers to install. Play also writes the WINE registry value that tells the game's DLSS library where to find the forwarding library.

The selected upscaler takes over only when the game's frame carries everything it needs. When something is missing, such as the camera data that FSR 2 and 3 need, DXMT and D3DMetal keep the game's own MetalFX scaler. If the selected upscaler fails on a single frame, MetalFX Temporal fills in for that frame and the inspector's graphics status says so; the next frame tries your choice again. The [frame-source reference](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/INPUTS_AND_ADAPTERS.md#scene-producers) describes each route and the exact data it carries.

### When an upscaler needs camera data

FSR 2 and FSR 3 need the game's camera parameters as well as depth and motion. Games that call DLSS through NVIDIA's Streamline library can supply those parameters, and MacLauncher's adapters pass them on through DXMT, the Vulkan temporal-frame routes or D3DMetal. A DLSS call without Streamline constants supplies no camera, so it cannot provide the inputs for a method that needs one.

Camera support follows the translator that actually runs. DXMT needs an adapter matched to its native library and Windows component; if they do not match, the game keeps its chosen DXMT renderer and the inspector reports camera support as unavailable. On the DXVK and vkd3d-proton route, the Streamline adapter goes in whenever the route forwards, with no setting, and hands each DLSS call's camera to the forwarding library, which adds it to that call's frame. For D3DMetal, a camera is handed to the next native scaler once and is cleared at presentation, so it cannot carry over to a later frame. Full input requirements are listed in the [temporal upscaler reference](https://github.com/procrastinine/maclauncher/blob/master/docs/graphics/PROVIDERS.md#scene-temporal-upscaling).

These integrations supply Super Resolution inputs. They do not expose NVIDIA DLSS Frame Generation or Ray Reconstruction. MacLauncher's own [frame generation](/maclauncher/graphics/frame-generation/) is a separate choice with its own input and presentation requirements.

### XeSS games

Games that use Intel's XeSS through its Direct3D 11 library can have their XeSS requests run through MetalFX. MacLauncher's XeSS adapter does this automatically, under the same DXMT conditions as the camera adapters.

### FidelityFX games

Games that ship AMD's FidelityFX API library, for Vulkan or Direct3D 12, can have their FidelityFX upscaling run by MacLauncher's selected upscaler instead, with CrossOver, Sikarugir or WineCX. This needs the FidelityFX API adapter from MacLauncher Builds, which Play offers to install, and a Vulkan driver that passes the game's frames on: MacLauncher KosmicKrisp or MoltenVK scene support. Direct3D 12 games also need MacLauncher's vkd3d-proton. MacLauncher prepares it only when the game's graphics settings use scene data. When a frame can't be passed on, the game's own FidelityFX runs.

With the adapter in place, the graphics menus count the game's depth, motion and camera data as supplied, so temporal upscalers no longer sit under **Needs scene inputs**. Effects placed before the upscaler work on the game's smaller rendered image. The upscaled picture then goes through the rest of the chain when the game shows it, and each effect runs once per frame.

Turning **Graphics** off while the game runs gives the upscaling back to the game's own FidelityFX, so the game looks just as it would without MacLauncher. Turning it back on brings MacLauncher's upscaler back from the next frame. Either way the switch takes effect within about a tenth of a second, without a restart.

## How the adapters treat your game files

Most of these adapters have to replace a DLL that sits next to the game's executable. MacLauncher never changes the original: it makes a small, separate launch folder with copies of the executable and the replaced DLLs, while the rest of the game is used from its original folder. For an Unreal Engine game whose top-level `.exe` only starts the real game program, that program is copied into the launch folder too. The game's working directory is still its own folder, as under CrossOver, so logs, saves and settings it writes relative to that folder land there. Only files it writes next to the adapted executable's own path stay in the launch folder. A game that doesn't need an adapter runs straight from its original files. If an adapter can't be prepared, the game runs without it.

Further reading: [Upscaling](/maclauncher/graphics/upscaling/), and the [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md#temporal-upscaling), [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md#game-temporal-integration) and [Wine runtimes](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/WINE.md#what-each-source-supplies) references for every requirement.
