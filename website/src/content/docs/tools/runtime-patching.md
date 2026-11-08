---
title: Runtime patching
description: "Why a newer graphics translator or Vulkan driver can make a Windows game run, or run better, on a Mac; how CXPatcher patches a copy of CrossOver; how MacLauncher gives each game its own DXVK, vkd3d-proton, DXMT, D3DMetal or KosmicKrisp without modifying CrossOver or Sikarugir; and a walkthrough in the launcher."
head:
  - tag: title
    content: "Patch DXVK, D3DMetal and KosmicKrisp into CrossOver and Sikarugir per game | MacLauncher"
sidebar:
  order: 0.5
---

When a Windows game runs on a Mac through [CrossOver](https://www.codeweavers.com/crossover/) or [Sikarugir](https://github.com/Sikarugir-App/Sikarugir), a lot of what decides whether it draws correctly, and how fast, happens outside [WINE](https://www.winehq.org/) itself. Two smaller pieces handle the graphics: a graphics translator and, for some routes, a Vulkan driver. Each WINE distribution comes with the versions of these pieces that were current when it was released. Replacing them with other versions is what people usually mean by *patching a runtime*, and it's one of the most useful things to try when a game crashes at startup, draws something wrong or runs slowly.

This page explains what those pieces do and why a different version can help. It then compares how [CXPatcher](https://github.com/italomandara/CXPatcher) and MacLauncher go about it, and finishes with a walkthrough for one game.

## Translators and Vulkan drivers

Windows games draw through Microsoft's Direct3D, and a few draw through [Vulkan](https://www.vulkan.org/). A Mac has neither, because its graphics API is [Metal](https://developer.apple.com/metal/). A **graphics translator** fills that gap by turning each drawing call the game makes into work that Metal understands. Some translators go straight to Metal: [DXMT](https://github.com/3Shain/dxmt) handles Direct3D 10 and 11, and Apple's D3DMetal handles Direct3D 11 and 12. Others, [DXVK](https://github.com/doitsujin/dxvk) for Direct3D 8 to 11 and [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) for Direct3D 12, translate into Vulkan instead.

Vulkan isn't native to the Mac either, so those translators need one more layer. A **Vulkan driver** is a library that implements Vulkan on top of Metal, and the Mac has two of them: [MoltenVK](https://github.com/KhronosGroup/MoltenVK), the long-established one, and [KosmicKrisp](https://docs.mesa3d.org/drivers/kosmickrisp.html), the newer, fully conformant one. A Direct3D 11 game can therefore reach your GPU in more than one way:

```text
Direct3D 11 → DXMT                             → Metal
Direct3D 11 → DXVK → Vulkan → KosmicKrisp      → Metal
Direct3D 12 → D3DMetal                         → Metal
Direct3D 12 → vkd3d-proton → Vulkan → KosmicKrisp → Metal
```

WINE takes care of the rest of Windows, such as files, windows, input and sound. Once a game starts, though, these two layers decide almost everything about how its graphics come out. [Graphics translators](/maclauncher/windows/graphics-translators/) describes each translator and driver in detail.

## Why a different version helps

Translators are active projects. DXVK, vkd3d-proton and DXMT publish new releases regularly, each of which can implement more of Direct3D, fix how particular games draw and make common work faster. A WINE distribution, on the other hand, keeps the versions it shipped with, and every game in it uses them. A newer game may need a Direct3D feature that only a later translator implements. Translation is also never perfect, so a game that draws wrongly with one translator can look right with another, which is why the choice is worth making game by game.

The Vulkan driver matters just as much. Current releases of DXVK and vkd3d-proton ask for Vulkan features that MoltenVK, the driver CrossOver includes, doesn't have, and they refuse to start on it. MacLauncher's own build of KosmicKrisp adds those features, so pairing it with a current DXVK or vkd3d-proton puts a game on the same graphics path that Valve's [Proton](https://github.com/ValveSoftware/Proton) uses on Linux and the Steam Deck. Direct3D 12 games then reach Direct3D feature level 12_1 through vkd3d-proton, which [KosmicKrisp](/maclauncher/windows/kosmickrisp/#direct3d-12-games-through-vkd3d-proton) explains.

D3DMetal is a slightly different case. It's part of Apple's [Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/), which MacLauncher never builds or hosts, but a toolkit you've downloaded yourself can be used with any game, even when it's newer than the copy inside your CrossOver.

## How CXPatcher does it

[CXPatcher](https://github.com/italomandara/CXPatcher) is a popular unofficial tool that brings newer translators to CrossOver by patching the app. It makes a patched copy of CrossOver with newer builds of DXVK, D3DMetal and MoltenVK, and it can also update DXMT to a build you download. Your original CrossOver stays as it was.

The translator versions then belong to that copy of the app. Every bottle that runs in it uses the same versions, and you keep two CrossOver apps on disk. Each new CrossOver release starts out unpatched, so after an update you patch again, with a CXPatcher version that supports that release. CXPatcher's README also notes that CodeWeavers doesn't support patched copies. Its developer has announced [Procyon](https://github.com/italomandara/Procyon) as its successor.

## How MacLauncher does it

MacLauncher gets the same result while leaving CrossOver and Sikarugir exactly as their developers ship them, following the [unchanged source](/maclauncher/tools/#unchanged-source) principle. The translators live in MacLauncher's own storage instead:

- Each version is installed once, in **Runtimes**, from the translator project's own releases, from [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/), from Sikarugir's Template releases or from files you already have. CrossOver's and Sikarugir's own copies are choices too, with nothing to install.
- Each game picks its own translator for every Direct3D version, plus its Vulkan driver, in its runtime settings. **Settings** holds the defaults for games that don't choose.
- When the game starts, MacLauncher links the chosen version into that one launch. If a translator has to replace a file inside a bottle, the original is set aside and put back when you choose something else.
- Before every launch, MacLauncher checks that the chosen files fit the game, the WINE build and your Mac. A choice that can't load falls back to the runtime's own translator, the game still starts, and the inspector says what happened.

In practice, this works out as follows:

| | A patched copy of CrossOver | MacLauncher |
| --- | --- | --- |
| Where translators live | Inside the patched app | In MacLauncher's storage, outside CrossOver and Sikarugir |
| Which games use a version | Every bottle in that copy | The games that choose it, with a default for the rest |
| After a CrossOver update | Patch the new release again | Nothing to redo |
| CrossOver on disk | The original plus a modified copy | The original, unmodified |
| Sikarugir games | Not covered | Use the same installed versions |

[Translator versions](/maclauncher/windows/translator-versions/) covers the sources, the linking and the fallback in more detail.

## Step by step

As an example, suppose a Direct3D 11 game in Sikarugir draws incorrectly, and you'd like to try a current DXVK on KosmicKrisp, with the DXVK HUD on screen to confirm what's running. The same steps work in CrossOver and for other translators.

### 1. Install a translator version

Open **Runtimes** from the toolbar. Under the **Graphics** heading in its sidebar, choose **DirectX → Vulkan** and go to the DXVK section. The first time, the list of versions has to be fetched, so press **Load versions** (it reads **Reload versions** afterwards), which reads the releases from each source. Select a version and press **Install**.

Besides the DXVK project's own releases, Runtimes offers Gcenx's macOS and async builds and **MacLauncher DXVK**, an adapted DXVK 3.1.1 from MacLauncher Builds. A build you already have can be added with **Register custom…**, which accepts a folder, an archive, a disk image or a translator inside an installed app. Translators that go straight to Metal sit in **DirectX → Metal**, and the drivers in **Vulkan drivers**.

### 2. Choose it for the game

Select the game in the library and click the gear next to its runtime menu to open its **Runtime settings**. The translator controls are near the top of the **Basic** group:

- **Default Direct3D engine** picks the translator for every Direct3D version without a choice of its own.
- **Direct3D 8** to **Direct3D 11** each pick a translator for that version alone, and **Direct3D 12** picks the one for Direct3D 12.
- **Vulkan driver** picks the driver beneath the Vulkan translators.

Set the **Default Direct3D engine**, or just **Direct3D 11**, to the DXVK version you installed. Every entry names the translator, its version and where it came from. Leave the **Vulkan driver** on its automatic choice, which reads **Template's automatic choice** in Sikarugir and **CrossOver's automatic choice** in CrossOver. With a DXVK or vkd3d-proton from Runtimes, that choice pairs the translator with MacLauncher KosmicKrisp, and if the driver isn't installed yet, **Play** offers to download it. You can also pick a driver yourself.

To give every game the same choice, set these controls in **Settings → Windows Game** instead, on the runtime's tab. Games without a choice of their own follow it.

### 3. Set its options

The advanced groups of the same window hold each translator's own options, and each option appears only while its translator is selected. For DXVK, **DXVK async** in **Compatibility** turns on background shader compilation in builds that include it, and **DXVK HUD** in **Diagnostics** shows frame rates and other figures on screen, with **FPS**, **Performance** and **Full** presets. **Metal Performance HUD**, also in Diagnostics, shows Apple's own overlay for any translator. [Runtime settings](/maclauncher/windows/settings/#compatibility) lists the options of every translator.

### 4. Add environment variables

Every translator also reads environment variables, and many of its switches exist only there. Further down, the **Environment variables** section lists the variables of each translator this game uses right now: WINE itself, DXVK and KosmicKrisp in this example. Values that come from **Settings → Environment variables** are marked **From Settings**, and you can change them for this game, remove them or add your own. Names are suggested as you type, each with a short description, and **Restore** brings back a value you changed. For example, `DXVK_HUD=fps,gpuload` replaces the HUD preset with your own selection of figures, and `KK_EMULATION=conformance` turns on every feature MacLauncher KosmicKrisp can emulate, as [Performance and conformance](/maclauncher/windows/kosmickrisp/#performance-and-conformance) explains.

### 5. Play and check the inspector

Press **Play**. Anything still missing downloads after you agree, and the game starts with your choices. Afterwards, the inspector lists each translator as *selected → used*: the DXVK version you picked on the Direct3D row, for example, and the driver on the Vulkan row, which also names the processor build that ran, such as **Intel (Rosetta)** for an Intel WINE on Apple Silicon. When the two sides differ, a line underneath explains why MacLauncher fell back.

## Going back

Nothing here is permanent. Set a control back to its automatic choice and the next launch uses the runtime's own translator again, with anything set aside inside a bottle put back. Installing another version changes no game until you pick it. An installed version you no longer need can be deleted in **Runtimes** with **Remove**. A game that used it falls back to the automatic choice.

Further reading: [Choosing a translator](/maclauncher/windows/choosing-a-translator/) for which translator suits which kind of game, [KosmicKrisp](/maclauncher/windows/kosmickrisp/) for the Vulkan driver, and the [graphics translator reference](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/TRANSLATORS.md).
