---
title: KosmicKrisp
description: "Why KosmicKrisp, the conformant Vulkan 1.4 driver on Metal 4, matters for WINE and Android games on Apple Silicon Macs, how it compares with MoltenVK, what MacLauncher's own build adds for DXVK, vkd3d-proton and ANGLE, and which build each game loads."
head:
  - tag: title
    content: "KosmicKrisp vs MoltenVK on Mac: Vulkan on Metal 4 for WINE and Android games | MacLauncher"
sidebar:
  order: 2.2
---

Not every game reaches Metal directly. Some draw with [Vulkan](https://www.vulkan.org/), Windows games whose Direct3D calls go through DXVK or vkd3d-proton end up in Vulkan too, and Android games can reach Vulkan through ANGLE. A Mac has no Vulkan of its own, so all of these end in a **Vulkan driver** that turns Vulkan work into Metal work. KosmicKrisp is one of the two drivers that do this on a Mac, and on an Apple Silicon Mac with macOS 26 or later it's the one Khronos recommends.

## What KosmicKrisp is

[KosmicKrisp](https://docs.mesa3d.org/drivers/kosmickrisp.html) is a Vulkan driver from the [Mesa](https://mesa3d.org/) project, the open-source graphics stack that also supplies Linux's GPU drivers. LunarG develops it for Apple Silicon Macs, and it's written for Metal 4, the version of Metal that arrived with macOS 26. KosmicKrisp records Vulkan's work into Metal 4 command buffers, lets a single Metal 4 compute encoder handle compute work and copies alike, and binds resources through Metal 4's argument tables. Because of Metal 4, it needs an Apple Silicon Mac with macOS 26 or later, and it doesn't run on iOS.

Khronos lists KosmicKrisp as a conformant Vulkan 1.4 product for the M1 to M5 chip families and the A18 Pro, tested on macOS 27. LunarG's Vulkan SDK for macOS includes it as a Vulkan 1.4 driver, and keeps MoltenVK for Intel Macs and older versions of macOS.

## Why it matters

The older driver, [MoltenVK](https://github.com/KhronosGroup/MoltenVK), has carried Vulkan on the Mac for years, and it still runs on every Mac from macOS 12, Intel ones included. Where Vulkan and Metal differ too much, though, MoltenVK leaves parts of Vulkan out and lists what's missing through an extension called the portability subset. Its own README says it isn't fully compliant with the Vulkan specification.

KosmicKrisp takes a different line. It [passed the Khronos Group's conformance tests for Vulkan 1.4](https://www.khronos.org/news/permalink/kosmickrisp-achieves-vulkan-1.4-conformance-on-apple-silicon), so it implements the full API without a portability subset. Khronos now recommends it, too: the [MoltenVK README](https://github.com/KhronosGroup/MoltenVK) now says that Khronos has deprecated MoltenVK, that the community maintains it on a best-effort basis, and that Khronos recommends KosmicKrisp for Vulkan on Apple Silicon Macs. MoltenVK stays the recommendation for Intel Macs and iOS.

MacLauncher keeps both drivers. MoltenVK covers Intel Macs, macOS versions before 26 and virtual machines, it's the driver that comes with CrossOver, and natively executed Android apps need it for their shared graphics buffers. KosmicKrisp covers Apple Silicon Macs from macOS 26, where it lets more of the Vulkan routes run.

## MacLauncher KosmicKrisp

Conformance means KosmicKrisp does everything Vulkan 1.4 requires, but the translators ask for more than the required core. DXVK insists on wireframe drawing, vkd3d-proton insists on transform feedback and a particular texel buffer alignment, and ANGLE wants transform feedback before it offers the geometry and tessellation shaders of OpenGL ES 3.2. Upstream KosmicKrisp has none of those, so DXVK and vkd3d-proton won't start on it at all.

MacLauncher therefore publishes **MacLauncher KosmicKrisp**, its own build of KosmicKrisp from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds). It takes the same Mesa source and adds the missing Vulkan features, each one implemented on Metal. Besides what the translators require, it brings sparse resources, which Direct3D's tiled resources need, along with conservative rasterization, mesh and task shaders, 64-bit floating point computed in software, pipeline statistics, and a much larger push constant space. The build comes for Apple Silicon and Intel processes alike, and both need an Apple Silicon Mac with macOS 26.

The Khronos conformance belongs to the upstream driver that was submitted for testing. MacLauncher's build is based on that driver but adds to it, so it has no conformance submission of its own. Some Direct3D levels also stay out of reach. Feature level 12_1, the highest that DXVK offers for Direct3D 11 and the next step up for Direct3D 12, needs rasterizer-ordered views, which DXVK and vkd3d-proton build on a Vulkan feature called pixel interlock. The build offers only the per-sample variant, sample interlock, so through DXVK or vkd3d-proton a game sees at most feature level 12_0. Feature level 12_2 would also need ray tracing and variable rate shading, which no KosmicKrisp build has.

## At a glance

| | LWJGL's KosmicKrisp | MacLauncher KosmicKrisp | MoltenVK |
| --- | --- | --- | --- |
| Vulkan | Conformant Vulkan 1.4 | Vulkan 1.4 plus the features translators use | A subset of Vulkan 1.4 |
| Macs | Apple Silicon, macOS 26 or later | Apple Silicon, macOS 26 or later | Intel and Apple Silicon, macOS 12 or later |
| Builds | Apple Silicon only | Apple Silicon and Intel | Apple Silicon, Intel or universal |
| DXVK 2.x and 3.x | Doesn't start | Runs | Doesn't start; DXVK-macOS builds are made for it |
| vkd3d-proton | Doesn't start | Runs | Doesn't start |
| ANGLE's Vulkan renderer | No geometry or tessellation shaders, which OpenGL ES 3.2 needs | Geometry and tessellation shaders available | No geometry or tessellation shaders |

The full feature comparison lives in the [KosmicKrisp reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md#compatibility-with-moltenvk).

## Which build a game loads

A Vulkan driver runs inside the program that uses it, so it has to be built for that program's processor, which isn't always the game's. Windows games run inside WINE, and Sikarugir and the usual CrossOver releases run WINE as an Intel program under Rosetta. They need an Intel build of KosmicKrisp, even on an Apple Silicon Mac. The same goes for AnyPS5 and Prosper, which play PlayStation 5 games as Intel programs. Android games, on the other hand, run in an Apple Silicon host and load Apple Silicon builds, and so does a CrossOver whose WINE is itself an ARM64 program.

| Who uses the driver | Build |
| --- | --- |
| Sikarugir and CrossOver with Intel WINE | Intel |
| CrossOver with ARM64 WINE | Apple Silicon |
| AnyPS5 and Prosper | Intel |
| Android games | Apple Silicon |

LWJGL's KosmicKrisp builds contain only Apple Silicon code, which is why Intel WINE and the PlayStation 5 runtimes use MacLauncher KosmicKrisp or Sikarugir's own copy instead. MacLauncher sorts this out by itself: it reads which processor each program runs on and offers only builds that fit.

## Getting it

KosmicKrisp and MacLauncher KosmicKrisp live in **Runtimes → Graphics → Vulkan drivers**, next to MoltenVK. You rarely need to visit, though. When a game that runs as an Intel program needs Vulkan on a Mac that can run KosmicKrisp, and no fitting driver is installed yet, Play offers the Intel build of MacLauncher KosmicKrisp, and **Use MoltenVK** carries on with MoltenVK instead. Once installed, a version works offline and every game shares it.

To pick a driver yourself, use the **Vulkan driver** control in a WINE game's Runtime Settings, or **Vulkan implementation** for Android games. [Choosing a translator](/maclauncher/windows/choosing-a-translator/) walks through which driver suits which kind of game.

Further reading: the [KosmicKrisp reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md), with exact versions, every added feature and the Direct3D feature level rules, and [Graphics translators](/maclauncher/windows/graphics-translators/).
