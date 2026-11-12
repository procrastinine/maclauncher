---
title: KosmicKrisp
description: "Why KosmicKrisp, the conformant Vulkan 1.4 driver on Metal 4, matters for WINE and Android games on Apple Silicon Macs, how it compares with MoltenVK, what MacLauncher's own build adds for DXVK, vkd3d-proton and ANGLE, how Direct3D 12 games run through vkd3d-proton at feature level 12_1 or 12_2, how Apple GPU families, the Performance and Conformance modes and KK_EMULATION work, and which build each game loads."
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

MacLauncher keeps both drivers. MoltenVK covers Intel Macs, macOS versions before 26 and virtual machines, it's the driver that comes with CrossOver and WineCX, and natively executed Android apps need it for their shared graphics buffers. KosmicKrisp covers Apple Silicon Macs from macOS 26, where it lets more of the Vulkan routes run. On those Macs it's the Vulkan driver that AnyPS5 and Prosper use by default, Sikarugir's automatic choice for Windows games is the KosmicKrisp in its own Template, and Android games can pick it too.

## MacLauncher KosmicKrisp

Conformance means KosmicKrisp does everything Vulkan 1.4 requires. The translators, however, ask for more than the required core. DXVK insists on wireframe drawing, vkd3d-proton insists on transform feedback and a particular texel buffer alignment, and ANGLE wants transform feedback before it offers the geometry and tessellation shaders of OpenGL ES 3.2. Upstream KosmicKrisp has none of those, so DXVK and vkd3d-proton won't even start on it.

To close the gap, MacLauncher publishes **MacLauncher KosmicKrisp**, its own build of KosmicKrisp from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds). It starts from the same Mesa source and adds optional Vulkan features that upstream lacks, each one implemented on Metal so that what the driver reports actually works. Most of them are what DXVK and vkd3d-proton need to run Direct3D games properly:

- transform feedback with geometry streams, mesh and task shaders, and geometry and tessellation shaders together with multiview;
- pixel and sample interlock, which the translators use for Direct3D's rasterizer-ordered views;
- conservative rasterization, depth bias control, wireframe and point fill, and wide or stippled lines;
- sparse resources where Metal supports them, which Direct3D's tiled resources rest on, plus descriptor heaps and device-generated commands;
- 64-bit floating point in shaders, computed in software;
- pipeline statistics, a much larger push constant space and caches of the Metal shaders it generates.

The build comes for Apple Silicon and Intel processes alike, and both need an Apple Silicon Mac with macOS 26. The Khronos conformance belongs to the upstream driver that was submitted for testing. MacLauncher's build is based on that driver but adds to it, so it has no conformance submission of its own. The [feature list](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md#features-of-maclauncher-kosmickrisp) in the KosmicKrisp reference names every added feature.

## Direct3D 12 games through vkd3d-proton

Those extra features give Direct3D 12 games a new route on the Mac. [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) is the Direct3D 12 translator from Valve's Proton, the same one that runs Direct3D 12 games on Linux and the Steam Deck, and it turns a game's Direct3D 12 calls into Vulkan. Upstream KosmicKrisp lacks the transform feedback and texel buffer alignment that vkd3d-proton requires, and MoltenVK lacks transform feedback and robust null descriptors, so on either driver vkd3d-proton refuses to create a device and the game stops before it draws anything. MacLauncher KosmicKrisp has everything vkd3d-proton requires, so a Direct3D 12 game in CrossOver, Sikarugir or WineCX can run through vkd3d-proton on it.

Creating the device is only the first hurdle. Direct3D 12 also sorts graphics hardware into **feature levels**, and a game can refuse to start below the level it was made for. On MacLauncher KosmicKrisp, vkd3d-proton reports feature level 12_1, the second highest, in the default performance mode, and 12_2, the highest, in conformance mode. Feature level 12_0 rests on tiled resources, which vkd3d-proton builds from the sparse resources this build offers wherever Metal supports them, and 12_1 adds rasterizer-ordered views and conservative rasterization. vkd3d-proton makes rasterizer-ordered views out of a Vulkan feature called pixel interlock, and MacLauncher KosmicKrisp provides both pixel interlock and conservative rasterization.

Feature level 12_2 adds ray tracing, mesh shaders and variable rate shading, and MacLauncher KosmicKrisp provides all three. The performance mode described below keeps mesh shaders on but leaves ray tracing, which runs on software traversal, and variable rate shading off, so a game reaches 12_2 in conformance mode. The shader model follows the same split: 6.8 in performance mode and 6.9 in conformance mode. A game that insists on 12_2 or shader model 6.9 needs conformance mode, which `KK_EMULATION=conformance` in its Runtime Settings selects. Ray tracing in that mode is slow on every Mac, for the reasons under [Performance and conformance](#performance-and-conformance).

To use this route, pick vkd3d-proton for **Direct3D 12** in the game's Runtime Settings and leave the **Vulkan driver** on its automatic choice. That choice pairs vkd3d-proton with MacLauncher KosmicKrisp, and Play offers the driver if it isn't installed yet. If you pick another driver yourself, MacLauncher warns that KosmicKrisp is recommended for vkd3d-proton. Sikarugir, WineCX and the usual CrossOver releases run WINE as an Intel program, so they load the Intel build of MacLauncher KosmicKrisp under Rosetta, which still needs an Apple Silicon Mac with macOS 26 or later. Together with DXVK for older Direct3D versions, this is the graphics path that Proton takes on Linux, which [Proton's graphics path on a Mac](/maclauncher/windows/graphics-translators/#protons-graphics-path-on-a-mac) explains. A game that calls DLSS can also hand its scene data to MacLauncher's upscalers along this route, as [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/#dlss-games-and-the-selected-upscaler) explains. The [Direct3D feature level rules](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md#direct3d-feature-levels) in the KosmicKrisp reference list the exact conditions for each level.

## Direct3D 8 to 11 through DXVK

[DXVK](https://github.com/doitsujin/dxvk), Proton's translator for Direct3D 8 to 11, works the same way. Its current releases need Vulkan features that MoltenVK and upstream KosmicKrisp lack, so they don't start on either driver, and MoltenVK runs only the DXVK-macOS builds made for it. When you pick a DXVK version installed from Runtimes for a game, MacLauncher DXVK included, and leave the **Vulkan driver** on Automatic, MacLauncher pairs it with MacLauncher KosmicKrisp. The game then goes through Proton's graphics path, with KosmicKrisp turning the Vulkan work into Metal at the end, instead of D3DMetal or DXMT. It's your choice, per game, and the WINE underneath is still CrossOver's, Sikarugir's or WineCX's. [Runtime patching](/maclauncher/tools/runtime-patching/#step-by-step) walks through making that choice.

## At a glance

| | LWJGL's KosmicKrisp | MacLauncher KosmicKrisp | MoltenVK |
| --- | --- | --- | --- |
| Vulkan | Conformant Vulkan 1.4 | Vulkan 1.4 plus the features translators use | A subset of Vulkan 1.4 |
| Macs | Apple Silicon, macOS 26 or later | Apple Silicon, macOS 26 or later | Intel and Apple Silicon, macOS 12 or later |
| Builds | Apple Silicon only | Apple Silicon and Intel | Apple Silicon, Intel or universal |
| DXVK 2.x and 3.x | Doesn't start | Runs | Doesn't start; DXVK-macOS builds are made for it |
| vkd3d-proton | Doesn't start | Runs, at Direct3D feature level 12_1, or 12_2 in conformance mode | Doesn't start |
| ANGLE's Vulkan renderer | No geometry or tessellation shaders, which OpenGL ES 3.2 needs | Geometry and tessellation shaders available | No geometry or tessellation shaders |

The full feature comparison lives in the [KosmicKrisp reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md#compatibility-with-moltenvk).

## Apple GPU families

KosmicKrisp is built on Metal 4, so it needs macOS 26 and an Apple GPU from the Apple7 family or later, which covers every M-series Mac. Apple sorts its GPUs into families, and a newer family can do some things in hardware that an older one has to emulate:

| GPU family | Mac chips |
| --- | --- |
| Apple7 | M1 |
| Apple8 | M2 |
| Apple9 | M3 and M4 |
| Apple10 | M5 |
| Apple11 | M6 |

MacLauncher KosmicKrisp reads your Mac's family when a game creates its Vulkan device and takes Metal's native path wherever that family has one. On M5 and later, for example, sampler LOD bias and minimum and maximum sampler filtering go straight to Metal, while older chips do them in the shader, and textures can be 32,768 pixels wide instead of 16,384. On M2 and later, 64-bit image atomics are available as well. You don't have to set anything for this: each Mac gets the fast path its GPU supports, and the [Apple GPU family notes](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md#apple-gpu-families) list the details.

## Performance and conformance

Some Vulkan features have no Metal equivalent at all, and MacLauncher KosmicKrisp reproduces them in shaders or extra GPU passes. Those emulations cost time, so each one is a named switch, and two modes decide which switches start out on:

- **Performance**, the default, applies to every game that leaves `KK_EMULATION` unset. The driver detects the Mac's GPU family on its own and turns on the emulations that are fast on that family, which is most of them on every Mac. Denormal handling, for example, stays on, because without it vkd3d-proton drops from shader model 6.2 and up to 6.1. Ray tracing, which runs on software traversal, stays off, and so does variable rate shading, which would put every pixel shader of a vkd3d-proton game on a slower path. Software 64-bit floating point and a few rarely used features are off too, and on an M1 to M4 so are depth bounds tests, which M5 and later run natively. With this set, vkd3d-proton reports feature level 12_1 and shader model 6.8 on every Mac.
- **Conformance** turns every emulated feature on, so applications can use everything the build offers, at the cost of the extra shader work, memory or rendering passes. On top of the performance set, that adds ray tracing with opacity micromaps and hit objects, variable rate shading, software 64-bit floating point, multisampled storage images, two more depth bias representations and, on an M1 to M4, depth bounds tests, which together give feature level 12_2 and shader model 6.9. Conformance mode also gives every timestamp a game writes between compute work its own reading, which waits for the compute work before it; in performance mode those timestamps share one reading per compute pass and cost nothing. Ray tracing is slow on every Mac: acceleration structures are built in compute passes, rays walk them in shader code instead of on the ray tracing hardware of M3 and later chips, and ray tracing pipelines aren't kept in Metal's shader archive, so they compile again at every launch. Conformance mode doesn't give MacLauncher's adapted build a Khronos certification of its own.

A feature that your Mac's GPU family runs natively stays on in both modes, because it costs nothing extra. Ray tracing is reported only when you ask for it, with `+ray_tracing` or `conformance`.

### KK_EMULATION

The `KK_EMULATION` environment variable chooses the mode and individual switches. Like any environment variable, it can be set for every game in **Settings → Environment variables** or for one game in its runtime settings. Its value is a list of words separated by commas, read from left to right:

| Value | Effect |
| --- | --- |
| `conformance` | Turns every emulated feature on. |
| `performance,-denorm_preserve` | Keeps the performance defaults but turns denormal preservation off. |
| `performance,+float64` | Keeps the performance defaults and adds software 64-bit floating point. |
| `apple10` or `mode=10` | Adds the switches that M5 runs natively, emulating them on an M1 to M4. It does not apply M5's performance set. |
| `+ray_tracing` | Adds ray tracing to the performance defaults. |
| `conformance,-ray_tracing` | Everything except ray tracing. |

A chip preset like `apple10` is handy for checking how a game behaves with the feature set of a newer Mac, while a single `-name` helps narrow down which emulation a game trips over. The [performance and conformance reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md#performance-and-conformance) lists every switch with its default, its cost and what becomes unavailable when it's off.

## Shader compilation

A Vulkan game hands its driver shaders that have to become Metal code before the GPU can run them, and compiling them takes time, which a game often spends at a loading screen or, worse, in the middle of play. MacLauncher KosmicKrisp keeps the work it has already done. It caches the Metal Shading Language it generates from each shader and the Metal libraries compiled from it, so a shader seen before isn't processed again. For WINE games, that cache sits in the game's own MacLauncher folder, apart from the bottle, with room for 4 GB unless you set `MESA_SHADER_CACHE_MAX_SIZE` yourself.

Compute shaders that aren't cached yet also leave pipeline creation quickly. The driver generates their Metal code straight away and compiles the rest in the background at low priority, so a game that creates many compute pipelines at once doesn't stall on them. The first time the game actually uses one, it waits for that compile if it hasn't finished, and the compile gets full priority for the wait. A pipeline the game throws away before using it leaves the queue if its compile hasn't started yet.

Graphics pipelines can also be built in parts. MacLauncher KosmicKrisp offers graphics pipeline libraries, which let a translator compile a game's vertex and fragment shaders as separate pieces before drawing and assemble complete pipelines from them later. For ordinary single-sampled shaders, the assembly reuses the compiled pieces. Metal still finishes each new combination of pieces with a compile of its own.

## Which build a game loads

A Vulkan driver runs inside the program that uses it, so it has to be built for that program's processor, which isn't always the game's. Windows games run inside WINE, and Sikarugir, WineCX and the usual CrossOver releases run WINE as an Intel program under Rosetta. They need an Intel build of KosmicKrisp, even on an Apple Silicon Mac. The same goes for AnyPS5 and Prosper, which play PlayStation 5 games as Intel programs. Android games, on the other hand, run in an Apple Silicon host and load Apple Silicon builds, and so does a CrossOver whose WINE is itself an ARM64 program.

| Who uses the driver | Build |
| --- | --- |
| Sikarugir, WineCX and CrossOver with Intel WINE | Intel |
| CrossOver with ARM64 WINE | Apple Silicon |
| AnyPS5 and Prosper | Intel |
| Android games | Apple Silicon |

LWJGL's KosmicKrisp builds contain only Apple Silicon code, which is why Intel WINE and the PlayStation 5 runtimes use MacLauncher KosmicKrisp or Sikarugir's own copy instead. MacLauncher sorts this out by itself: it reads which processor each program runs on and offers only builds that fit.

## Getting it

KosmicKrisp and MacLauncher KosmicKrisp live in **Runtimes → Graphics → Vulkan drivers**, next to MoltenVK. You rarely need to visit, though. When AnyPS5 or Prosper, which run as Intel programs, needs Vulkan on a Mac that can run KosmicKrisp, and no fitting driver is installed yet, Play offers the Intel build of MacLauncher KosmicKrisp, and **Use MoltenVK** carries on with MoltenVK instead. When no Intel build can be downloaded, Play says so in one line under its progress and carries on with MoltenVK. WINE games get the same kind of offer when you pick DXVK or vkd3d-proton from Runtimes and leave the **Vulkan driver** on Automatic. With DXVK alone, **Use MoltenVK** runs the game on MacLauncher's MoltenVK build instead, while vkd3d-proton can't do without KosmicKrisp, so its offer has no such button. On a Mac that can't run KosmicKrisp, MacLauncher's MoltenVK build takes its place, and the game's inspector says why. Once installed, a version works offline and every game shares it.

To pick a driver yourself, use the **Vulkan driver** control in a WINE game's Runtime Settings, or **Vulkan implementation** for Android games. [Choosing a translator](/maclauncher/windows/choosing-a-translator/) walks through which driver suits which kind of game.

Further reading: the [KosmicKrisp reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/KOSMICKRISP.md), with exact versions, every added feature and the Direct3D feature level rules, the [MacLauncher KosmicKrisp source](https://github.com/procrastinine/maclauncher-kosmickrisp), where the adaptations and their build guide live, and [Graphics translators](/maclauncher/windows/graphics-translators/).
