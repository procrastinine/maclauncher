---
title: Choosing a translator
description: "Which graphics translator and Vulkan driver to pick for each kind of game on a Mac: DXMT, D3DMetal, DXVK, vkd3d-proton and WineD3D for Direct3D 8 to 12, KosmicKrisp or MoltenVK for Vulkan, and ANGLE's backends for Android, with the steps to change them in MacLauncher."
head:
  - tag: title
    content: "DXMT, D3DMetal, DXVK, vkd3d-proton, KosmicKrisp or MoltenVK: which to choose on Mac | MacLauncher"
sidebar:
  order: 2.1
---

Most games never need a choice. Every translator setting starts at its runtime's automatic choice, MacLauncher checks the result before each launch, and the inspector shows what actually ran. When a game renders wrongly, runs slowly or won't start, though, the right translator depends mostly on two things: the graphics API the game uses, and your Mac. This page goes through the common cases. [Graphics translators](/maclauncher/windows/graphics-translators/) explains what each translator is.

## Start with your Mac

A few translators only exist on some Macs, so your Mac narrows the list before the game does:

- **Apple Silicon with macOS 26 or later.** Everything is available, including KosmicKrisp and MacLauncher KosmicKrisp.
- **Apple Silicon with an older macOS.** KosmicKrisp needs Metal 4 and therefore macOS 26, so Vulkan runs on MoltenVK. DXMT works from macOS 14, and D3DMetal's minimum depends on its version.
- **Intel Macs.** Vulkan runs on MoltenVK, and D3DMetal, which needs Apple Silicon, isn't an option. DXMT, on GPUs that support it, and WineD3D remain.
- **Virtual machines.** KosmicKrisp needs a physical Apple Silicon Mac, so Vulkan runs on MoltenVK here too.

If you're not sure which graphics API a game uses, its system requirements usually name the DirectX version.

## By kind of game

| Game draws with | Start with | Alternatives |
| --- | --- | --- |
| Direct3D 8 or 9 | DXVK on KosmicKrisp where the Mac can run it, WineD3D elsewhere | DXVK-macOS on MoltenVK |
| Direct3D 10 or 11 | DXMT | D3DMetal, DXVK on MacLauncher KosmicKrisp, WineD3D |
| Direct3D 12 | D3DMetal | vkd3d-proton on MacLauncher KosmicKrisp, WINE's vkd3d |
| Vulkan | KosmicKrisp where the Mac can run it | MoltenVK |
| OpenGL ES, on Android | ANGLE on Metal | ANGLE on Vulkan |

The sections below explain each row.

### Direct3D 8 and 9

Neither DXMT nor D3DMetal handles Direct3D 9 or earlier, so these games choose between DXVK and WineD3D. On an Apple Silicon Mac with macOS 26, Sikarugir's automatic choice already runs them through D9VK on KosmicKrisp. Elsewhere it falls back to WineD3D, which works on any Mac.

Which DXVK fits depends on the Vulkan driver. The releases from the DXVK project, versions 2 and 3, need features that MoltenVK and LWJGL's KosmicKrisp lack: MoltenVK has no geometry shaders, and LWJGL's KosmicKrisp has no wireframe drawing. MacLauncher KosmicKrisp provides them, and Sikarugir pairs its own KosmicKrisp with the DXVK builds in its Template. With MoltenVK, pick one of Gcenx's DXVK-macOS builds, which are made for it.

### Direct3D 10 and 11

DXMT is the usual first choice. It goes straight from Direct3D to Metal, it's Sikarugir's automatic choice, and several MacLauncher features need it: DLSS to MetalFX on macOS 14 or later, the FSR camera adapters and XeSS. D3DMetal is the alternative on Apple Silicon for 64-bit games, and it also turns DLSS into MetalFX, from macOS 26.

DXVK on MacLauncher KosmicKrisp is worth a try when both Metal translators struggle with a game. Through it, a Direct3D 11 game sees at most feature level 12_0. WineD3D is the fallback that every Mac has, and it draws through OpenGL instead of Metal.

### Direct3D 12

D3DMetal is the one Direct3D 12 route that doesn't pass through Vulkan, and it's the only route for DLSS to MetalFX in Direct3D 12 games. It needs Apple Silicon and a 64-bit game.

vkd3d-proton is the open-source alternative. It refuses to start on a driver without transform feedback, robust null descriptors and single-texel buffer alignment, which rules out MoltenVK and LWJGL's KosmicKrisp, while MacLauncher KosmicKrisp provides all three. MacLauncher recommends KosmicKrisp for vkd3d-proton and warns when a game pairs it with another driver. On MacLauncher KosmicKrisp, vkd3d-proton reports at most feature level 12_0, so a game that insists on 12_1 or 12_2 won't run this way. WINE's own vkd3d is the third choice, and it comes with WINE itself.

### Vulkan games

Games that use Vulkan directly only need a driver. On an Apple Silicon Mac with macOS 26 or later, KosmicKrisp is a conformant Vulkan 1.4 implementation, and MacLauncher KosmicKrisp adds features that games sometimes use, such as transform feedback, sparse resources and mesh shaders. MoltenVK covers every other Mac. On CrossOver, one exception applies: the [FidelityFX scene route](/maclauncher/windows/effects-and-upscaling/#fidelityfx-in-vulkan-games-on-crossover) needs the **Vulkan driver** left at CrossOver's automatic choice.

### Android games

Android games draw with OpenGL ES, which ANGLE provides on Metal by default. ANGLE's Metal renderer offers OpenGL ES 3.0, so for an app that needs a newer version, MacLauncher switches that game to ANGLE's Vulkan renderer by itself, unless you've chosen a backend for it. OpenGL ES 3.2 adds geometry and tessellation shaders, and ANGLE only offers them on a Vulkan driver with transform feedback, which MacLauncher KosmicKrisp has and MoltenVK and LWJGL's KosmicKrisp don't. One exception: apps that run with native Android execution need MoltenVK for their shared graphics buffers.

Android apps that render with Vulkan themselves use the same **Vulkan implementation** setting directly.

### PlayStation 5 games

AnyPS5 and Prosper run as Intel programs and need an Intel driver build. Their automatic choice prefers KosmicKrisp, and on a Mac that can run it, Play offers the Intel build of MacLauncher KosmicKrisp the first time one is needed.

## Changing a translator

1. Select the game and open **Runtime Settings** in its inspector. For Android games, the settings are **OpenGL ES backend** and **Vulkan implementation**.
2. Pick the translator for the game's Direct3D version, **Direct3D 12**, or the **Vulkan driver**. Each list starts with the automatic choice, followed by the versions that come with the game's runtime and the ones installed in Runtimes.
3. Press **Play**. The change applies from the next launch, and anything still missing downloads after you agree.
4. Check the inspector. It shows each translator as **selected → used**, with the reason whenever MacLauncher had to fall back.

To make a choice the default for every game, set it in **Settings** instead, and games without their own choice follow it. New versions come from **Runtimes → Graphics**, as [Translator versions](/maclauncher/windows/translator-versions/) describes, and installing one never changes a game that already uses another.

Further reading: [KosmicKrisp](/maclauncher/windows/kosmickrisp/) for the Vulkan drivers in depth, and the [graphics translator reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md).
