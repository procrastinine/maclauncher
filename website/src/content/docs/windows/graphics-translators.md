---
title: Graphics translators
description: "What each graphics translator for WINE games does on a Mac: DXMT, D3DMetal, DXVK with its D9VK and async builds, vkd3d-proton and WineD3D, and the Vulkan drivers MoltenVK and KosmicKrisp. How they stack, what each one needs, and how MacLauncher chooses among them."
head:
  - tag: title
    content: "DXMT, D3DMetal, DXVK, MoltenVK and KosmicKrisp on Mac: graphics translators for WINE | MacLauncher"
sidebar:
  order: 2
---

Windows games draw their graphics through Microsoft's [Direct3D](https://en.wikipedia.org/wiki/Direct3D), the graphics part of DirectX, and a few draw through [Vulkan](https://www.vulkan.org/). A Mac has neither, because its graphics API is [Metal](https://developer.apple.com/metal/). A **graphics translator** sits between the two: it takes each drawing call the game makes and turns it into work for Metal. WINE stands in for the rest of Windows, so the translator alone decides how everything the game draws reaches your screen.

Several translators exist, and they differ in the Direct3D versions they handle, the Macs they run on and the way they get to Metal. This page goes through them one at a time and then explains how MacLauncher chooses among them and how you can choose yourself. Where each version comes from, and how every game can use its own, is covered in [Translator versions](/maclauncher/windows/translator-versions/).

## How the layers stack

A translator reaches Metal by one of two routes. Some go straight from Direct3D to Metal. The others translate Direct3D into Vulkan, the cross-platform graphics API, and leave the last step to a **Vulkan driver**, a library that implements Vulkan on top of Metal. Games that use Vulkan themselves need only that last step, which WINE's own Vulkan layer hands to the same driver.

```text
Direct3D 10 and 11   → DXMT          → Metal
Direct3D 11 and 12   → D3DMetal      → Metal
Direct3D 8 to 11     → DXVK          → Vulkan → MoltenVK or KosmicKrisp → Metal
Direct3D 12          → vkd3d-proton  → Vulkan → MoltenVK or KosmicKrisp → Metal
Direct3D 12          → WINE's vkd3d  → Vulkan → MoltenVK or KosmicKrisp → Metal
Vulkan               → WINE          → Vulkan → MoltenVK or KosmicKrisp → Metal
Direct3D up to 11    → WineD3D       → OpenGL
```

In MacLauncher, each layer is a separate setting. The **Default Direct3D engine** picks the translator for Direct3D 11 and earlier, and each of those versions can also have a translator of its own. **Direct3D 12** picks the one for Direct3D 12, and the **Vulkan driver** picks what sits underneath both. One layer can therefore change while the others stay put: a game can try another DXVK version on the same driver, or keep its DXVK and switch drivers.

## The Direct3D translators

### DXMT

[DXMT](https://github.com/3Shain/dxmt) is an open-source translator that turns Direct3D 10 and 11 directly into Metal, written for WINE on macOS. It needs macOS 14 or later and a Metal GPU that supports it. For Direct3D 10 and 11 games, DXMT is also what several MacLauncher features build on: games that call DLSS can get MetalFX upscaling through it, and the [camera and XeSS adapters](/maclauncher/windows/effects-and-upscaling/#temporal-upscaling) only work while DXMT is the game's Direct3D engine.

CrossOver, Sikarugir's Template and WineCX all include DXMT, and MacLauncher can install releases from the DXMT project itself. Its settings offer frame-rate presets and MetalFX spatial upscaling of its output.

### D3DMetal

D3DMetal is Apple's own translator, part of the [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/) that Apple publishes for game developers. It turns Direct3D 11 and 12 directly into Metal, so for Direct3D 12 games it's the one route that doesn't pass through Vulkan. Games that call DLSS can get MetalFX upscaling through D3DMetal on macOS 26 or later. In a WINE that supports it, such as WineCX, the game also sees an NVIDIA GeForce RTX 4090 while D3DMetal handles its DLSS, so it offers its DLSS option in the first place.

D3DMetal runs only on Apple Silicon Macs and only with 64-bit games, and its minimum macOS version depends on the version, which MacLauncher reads from its files. CrossOver includes it, and so do Sikarugir's Template downloads. WineCX doesn't include it, but it loads a D3DMetal version installed in Runtimes. Because D3DMetal is Apple's proprietary software, MacLauncher never builds or hosts it: it comes from those downloads or from your own copy of the toolkit, and Apple's license stays with it. Its settings offer a frame-rate limit and, in versions that support it, Metal 4.

### DXVK, D9VK and the async builds

[DXVK](https://github.com/doitsujin/dxvk) is the translator that Valve's [Proton](https://github.com/ValveSoftware/Proton) uses to run Windows games on Linux. It turns Direct3D 8, 9, 10 and 11 into Vulkan, so on a Mac every DXVK route ends in MoltenVK or KosmicKrisp. Neither DXMT nor D3DMetal handles Direct3D 9 or earlier, which leaves DXVK and WineD3D as the translators for those older games.

DXVK comes in several builds:

- the releases of the DXVK project itself;
- [Gcenx's macOS builds](https://github.com/Gcenx/DXVK-macOS) of DXVK;
- Gcenx's async builds, which add the community [async patch](https://github.com/Sporif/dxvk-async). Without it, the game waits while DXVK compiles the shaders for something it hasn't drawn before, which can show up as stutter. With it, that compiling happens in the background while the game keeps running. The patch only acts when it's turned on, which the [DXVK async](/maclauncher/windows/settings/#compatibility) setting does;
- the three DXVK parts in Sikarugir's Template: `dxvk` for Direct3D 10 and 11, `dxvk3` for Direct3D 8 to 11, and `d9vk`, or D9VK, for Direct3D 8 and 9 only. Sikarugir uses `dxvk3` and D9VK together with KosmicKrisp.

CrossOver includes a DXVK build of its own as well, and so does WineCX, whose current DXVK covers 32-bit games only. DXVK's settings offer the async switch and the DXVK HUD.

### vkd3d-proton

[vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) is Proton's translator for Direct3D 12, which it turns into Vulkan. It's the open-source alternative to D3DMetal for Direct3D 12 games, and it asks a lot of the Vulkan driver underneath: its own documentation lists Vulkan 1.3 and several extensions as hard requirements. For that reason, MacLauncher recommends KosmicKrisp for vkd3d-proton and shows a warning when a game uses it with another driver. On [MacLauncher KosmicKrisp](#maclauncher-kosmickrisp), vkd3d-proton runs and reports Direct3D feature level 12_1, or 12_2 in conformance mode, which [KosmicKrisp](/maclauncher/windows/kosmickrisp/#direct3d-12-games-through-vkd3d-proton) explains. MacLauncher installs vkd3d-proton from the project's releases.

### WineD3D and WINE's vkd3d

WineD3D is WINE's own implementation of Direct3D, built into every WINE version. It draws through OpenGL instead of Metal or Vulkan, handles Direct3D 11 and everything before it, and runs on any Mac. That makes it the translator that's always there: Sikarugir falls back to it when DXMT can't be used, and its settings accept WINE's own WineD3D configuration.

WINE's vkd3d is WINE's own Direct3D 12 library. It translates Direct3D 12 into Vulkan, and it's the Direct3D 12 choice that comes with WINE itself.

### At a glance

| Translator | Translates | Into | Needs | Comes from |
| --- | --- | --- | --- | --- |
| DXMT | Direct3D 10 and 11 | Metal | macOS 14 or later | CrossOver, Sikarugir's Template, WineCX, DXMT releases |
| D3DMetal | Direct3D 11 and 12 | Metal | Apple Silicon and a 64-bit game | CrossOver, Sikarugir's Template, your Game Porting Toolkit |
| DXVK | Direct3D 8 to 11, depending on the build | Vulkan | A Vulkan driver | CrossOver, Sikarugir's Template, WineCX, DXVK and Gcenx releases |
| vkd3d-proton | Direct3D 12 | Vulkan | A Vulkan driver, preferably KosmicKrisp | vkd3d-proton releases |
| WineD3D | Direct3D up to 11 | OpenGL | Nothing extra | WINE itself |
| WINE's vkd3d | Direct3D 12 | Vulkan | A Vulkan driver | WINE itself |

## The Vulkan drivers

Every Vulkan route above, and every game that uses Vulkan directly, ends in a Vulkan driver, which carries out the Vulkan work on Metal. Two drivers exist for the Mac.

A driver has to match the processor that WINE itself is built for. Sikarugir, WineCX and the usual CrossOver releases run WINE as an Intel program, which Rosetta translates on Apple Silicon, so their drivers must contain Intel code. A CrossOver build whose WINE is an ARM64 program, one that leaves the game's Intel code to the FEX emulator, needs Apple Silicon builds instead. MacLauncher reads which kind of WINE it has from WINE's own files and lists only drivers that fit.

### MoltenVK

[MoltenVK](https://github.com/KhronosGroup/MoltenVK) is the long-established Vulkan driver for the Mac, published by the Khronos Group, which also maintains the Vulkan standard. It maps Vulkan onto Metal and runs on both Intel and Apple Silicon Macs. Most of Vulkan maps directly onto Metal, but where the two differ too much, MoltenVK leaves a small part of the specification out, so it [implements a subset of Vulkan](https://github.com/KhronosGroup/MoltenVK#compliance) and reports what it lacks through Vulkan's portability subset extension. Khronos has since deprecated MoltenVK: the project is now maintained by its community, and Khronos recommends it for Intel Macs and KosmicKrisp for Apple Silicon.

CrossOver, Sikarugir's Template and WineCX all include MoltenVK, and MacLauncher can install Khronos's own releases. Its settings offer fast math, argument buffers and an Unreal Engine 4 compatibility option. A separate MoltenVK build, **MoltenVK scene support** from [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), can carry a game's DLSS data from DXVK and vkd3d-proton to MacLauncher's upscalers, and it stands in for MacLauncher KosmicKrisp on Macs that can't run KosmicKrisp; [Effects and upscaling](/maclauncher/windows/effects-and-upscaling/#dlss-games-and-the-selected-upscaler) describes that route.

### KosmicKrisp

[KosmicKrisp](https://docs.mesa3d.org/drivers/kosmickrisp.html) is a newer Vulkan driver from the [Mesa](https://mesa3d.org/) project, developed by LunarG and built on Metal 4. Unlike MoltenVK, it's a [conformant Vulkan 1.4 implementation](https://www.khronos.org/news/permalink/kosmickrisp-achieves-vulkan-1.4-conformance-on-apple-silicon), which means it passes the Khronos Group's conformance tests, and Khronos now [recommends it](https://github.com/KhronosGroup/MoltenVK) for Apple Silicon Macs. Metal 4 also sets its requirements: an Apple Silicon Mac with macOS 26 or later. [KosmicKrisp](/maclauncher/windows/kosmickrisp/) has the whole story.

KosmicKrisp runs only on Apple Silicon, yet Intel WINE needs an Intel build of it, which Rosetta then translates. Such a game can use the KosmicKrisp in Sikarugir's Template, an installed [MacLauncher KosmicKrisp](#maclauncher-kosmickrisp) package that includes an Intel build, or an Intel build you register yourself. MacLauncher also downloads KosmicKrisp from LWJGL's builds, but those contain only Apple Silicon code, so they serve Android games and ARM64 WINE and never reach Intel WINE.

### MacLauncher KosmicKrisp

MacLauncher KosmicKrisp is MacLauncher's own build of KosmicKrisp, published in MacLauncher Builds. It adds Vulkan features that upstream KosmicKrisp lacks, each one implemented on Metal, and several of them are what the translators above ask for:

- wireframe and point fill modes, which DXVK requires
- transform feedback and texel buffer views aligned to a single texel, which vkd3d-proton requires
- transform feedback with primitives-generated queries, which ANGLE, the layer that provides OpenGL ES to Android games, needs before it offers the geometry and tessellation shaders of OpenGL ES 3.2 through Vulkan
- sparse resources, on GPUs where Metal supports them, which Direct3D's tiled resources and feature level 12_0 rest on
- pixel interlock, which vkd3d-proton turns into the rasterizer-ordered views of Direct3D 12 feature level 12_1
- ray tracing, mesh shaders and variable rate shading, which feature level 12_2 adds; ray tracing and variable rate shading are on in conformance mode, where ray tracing runs in shader code instead of on ray tracing hardware and is slow on every Mac

The build adds plenty more, from mesh shaders to 64-bit floating point; [KosmicKrisp](/maclauncher/windows/kosmickrisp/#maclauncher-kosmickrisp) goes through it.

Like KosmicKrisp itself, the build needs an Apple Silicon Mac with macOS 26 or later. It also comes as an Intel build, so CrossOver, Sikarugir and WineCX games can run DXVK, vkd3d-proton or a Vulkan game on it. It's the automatic Vulkan driver for any DXVK or vkd3d-proton you pick from Runtimes, and you can also choose it as the **Vulkan driver** yourself. CrossOver and WineCX include only MoltenVK, so this build also brings KosmicKrisp to their games.

### Proton's graphics path on a Mac

On Linux and the Steam Deck, Valve's Proton runs a Windows game's graphics through DXVK for Direct3D 8 to 11 and vkd3d-proton for Direct3D 12, which turn the game's calls into Vulkan for the Linux GPU driver. Current releases of both need Vulkan features that MoltenVK and upstream KosmicKrisp lack. MacLauncher KosmicKrisp has them, so on a Mac the same two translators can produce the same kind of Vulkan work, and KosmicKrisp turns it into Metal at the end.

Taking this path is a choice you make per game. Pick a release from the DXVK project as the Direct3D engine, or vkd3d-proton for **Direct3D 12**, and leave the **Vulkan driver** on Automatic. MacLauncher then pairs them with MacLauncher KosmicKrisp, so the game goes through Proton's graphics path instead of D3DMetal or DXMT, while your other games keep theirs. Only the graphics path is shared with Proton. WINE itself is still CrossOver's, Sikarugir's or WineCX's, so a game doesn't automatically behave the way it does on Linux.

### MoltenVK or KosmicKrisp

| | MoltenVK | KosmicKrisp |
| --- | --- | --- |
| Vulkan support | A subset of Vulkan 1.4, layered on Metal | Conformant Vulkan 1.4 on Metal 4 |
| Macs | Intel and Apple Silicon | Apple Silicon with macOS 26 or later |
| Status | Deprecated by Khronos, maintained by its community | Recommended by Khronos for Apple Silicon |
| For WINE games | Included with CrossOver, Sikarugir and WineCX, and installable from Khronos's releases | A build for WINE's processor: Sikarugir's own copy or one installed in Runtimes |

On a Mac that can run it, KosmicKrisp is the more compatible driver. That's why Sikarugir's automatic choice prefers it on a real Apple Silicon Mac, and why the automatic driver pairs MacLauncher KosmicKrisp with any DXVK or vkd3d-proton you pick from Runtimes. MoltenVK covers the rest: Intel Macs, macOS versions before 26 and virtual machines. It's also the driver that CrossOver and WineCX include.

## How MacLauncher chooses

A new game starts with every translator setting at its runtime's automatic choice. On CrossOver, that means CrossOver's own logic decides, just as it would outside MacLauncher. Sikarugir's automatic choice depends on your Mac:

- Direct3D 10 and 11 games use DXMT, or WineD3D when DXMT can't be used.
- On an Apple Silicon Mac with macOS 26 or later (a real Mac, not a virtual machine), KosmicKrisp becomes the Vulkan driver, and Direct3D 8 and 9 games run through D9VK.
- On other Macs, Vulkan runs on MoltenVK, and Direct3D 8 and 9 games use WineD3D.

WineCX's automatic choice is the same on every Mac it runs on: its own DXMT for Direct3D 10 and 11, WineD3D for Direct3D 8 and 9, WINE's vkd3d for Direct3D 12, and its MoltenVK for Vulkan.

One exception applies on every runtime: when you pick a DXVK or vkd3d-proton version from Runtimes and leave the Vulkan driver on Automatic, the game runs on MacLauncher KosmicKrisp, or on MacLauncher's MoltenVK build where KosmicKrisp can't run, and the inspector says which one and why.

A game in an [existing bottle or wrapper](/maclauncher/windows/existing-bottles/) starts with that environment's own settings instead, so nothing changes until you choose something else. Whatever the choice, MacLauncher checks it before the game starts, as [the last section](#when-a-translator-cant-load) explains.

## Choosing one yourself

Each game's **Runtime Settings** have a translator control for each graphics API, and **Settings** holds their defaults for all games:

| Control | What it picks |
| --- | --- |
| Default Direct3D engine | The translator for every Direct3D version that has no choice of its own: one included with your WINE runtime, or a DXMT, DXVK or D3DMetal version installed in Runtimes. |
| Direct3D 8, 9, 10 / 10.1 and 11 | A translator for that one Direct3D version, from the installed ones that include it. Choices that share files are linked and change together. |
| Direct3D 12 | WINE's own vkd3d, D3DMetal or vkd3d-proton. |
| Vulkan driver | MoltenVK or KosmicKrisp, for Vulkan translators and Vulkan games. |
| Video codecs | WINE's defaults, or a GStreamer codec folder you registered. |

Every entry names the translator, its version and where it comes from, read from the installed files. Each list starts with the automatic choice, or with the environment's own setting in an existing bottle or wrapper, followed by the versions that come with your WINE runtime and the ones installed in Runtimes. A change applies the next time you press **Play**.

If a game renders wrongly, trying another default Direct3D engine is a good first step. For Direct3D 12 games, D3DMetal and vkd3d-proton are the alternatives to WINE's own vkd3d. [Choosing a translator](/maclauncher/windows/choosing-a-translator/) goes through the choices by kind of game, and [Translator versions](/maclauncher/windows/translator-versions/) explains how to add more versions to these lists.

## When a translator can't load

A translator only works if its files fit the game, the WINE build and your Mac. So before a game starts, MacLauncher reads the files it would load and checks a few hard facts: that every required file is there, that the files are built for the right processor, that none needs a newer macOS than yours, and that WINE provides everything the translator expects from it. Version numbers, vendor names and lists of tested versions play no part in this.

When one of those checks fails, the game still starts. It uses the same translator as included with your CrossOver, Sikarugir or WineCX version, or that runtime's automatic choice when there's no such translator, and your saved choice stays as it was. A warning and the game's inspector show which translator you chose, which one ran, and why.

The inspector always shows the translators a game actually used, so you can check what ran even when nothing went wrong.

Further reading: the [graphics translator reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md) and [How games run on a Mac](/maclauncher/background/how-games-run/#compatibility-layers-translate-the-conversation).
