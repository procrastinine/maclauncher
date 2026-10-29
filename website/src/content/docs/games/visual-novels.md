---
title: Visual novels
description: KiriKiri, Siglus and RealLive, NScripter, AliceSoft, MAGES., Nitroplus, Minori, FAVORITE, AI5WIN and VNDS, played natively.
sidebar:
  order: 2
---

[Visual novels](https://en.wikipedia.org/wiki/Visual_novel) are one of the happiest corners of native Mac gaming. Most visual-novel engines are interpreters: the game is a set of script and asset archives, and the engine reads them. Fan and preservation communities have written open-source interpreters for many of these engines, and MacLauncher builds and manages them for macOS. That means classics that only ever shipped for Windows can run natively, with proper fonts, audio and fullscreen.

[Ren'Py](/maclauncher/games/desktop-engines/#renpy), the most popular modern engine, is covered with the desktop engines.

## The engines

| Engine | Runtime on macOS |
| --- | --- |
| **KiriKiri / KAG** | <span id="runtime-krkrsdl2"></span>[krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) with [KAG3](https://github.com/krkrsdl2/kag3) |
| **Siglus / RealLive** (Key, Visual Arts) | <span id="runtime-siglus"></span>[siglus_rs](https://github.com/xmoezzz/siglus_rs), or <span id="runtime-rlvm"></span>[RLVM](https://github.com/eglaysher/rlvm) for RealLive |
| **NScripter** | <span id="runtime-onsyuri_mac"></span>[ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri), or MacLauncher's port of <span id="runtime-onscripter_en"></span>[ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) |
| **AliceSoft System 1–4** | <span id="runtime-system3"></span>[System3](https://github.com/kichikuou/system3-sdl2), <span id="runtime-xsystem35"></span>[xsystem35](https://github.com/kichikuou/xsystem35-sdl2), <span id="runtime-xsystem4"></span>[xsystem4](https://github.com/nunuhara/xsystem4) |
| **MAGES.** | <span id="runtime-impacto"></span>[Impacto](https://github.com/CommitteeOfZero/impacto) |
| **Nitroplus** | <span id="runtime-npengine"></span>[NPengine](https://github.com/FGRE/libnpengine) with [libnpa](https://github.com/FGRE/libnpa) |
| **Minori** | <span id="runtime-reminori"></span>MacLauncher's port of [ReMinori](https://github.com/luoyily/ReMinori) |
| **FAVORITE / FVP** | <span id="runtime-rfvp"></span>[RFVP](https://github.com/xmoezzz/rfvp) |
| **AI5WIN** (elf) | <span id="runtime-ai5"></span>MacLauncher's port of [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) |
| **VNDS** (Nintendo DS conversions) | <span id="runtime-vnds_love"></span>[VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) |

What matters is the engine and its format, not the title: the same game can use different engines or formats across platforms and re-releases. Not sure which engine a game uses? [VNDB](https://vndb.org/), the visual novel database, lists the engine on many release pages. Each interpreter supports the formats its project supports, and some engines changed formats over the years, so the guides list exactly which variants work.

## A few things worth knowing

**Saves live separately.** Interpreters like siglus_rs and RFVP keep their own save files, separate from the original Windows engine's. Your Windows saves stay where they were, and MacLauncher's save tools show where the new ones are.

**Fonts and languages.** Many visual novels are Japanese and expect Japanese system fonts. The native interpreters handle text shaping and fonts themselves, and fan translations and patches that the engine supports keep working.

**Script tools.** Several engines come with tools for reading the script: KiriKiri scripts can be exported as readable TJS/KAG, AliceSoft scenarios can be decompiled, and there are message and text extractors for Siglus, RealLive, BGI, FVP and MAGES. See [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/).

<span id="runtime-bgi-tools"></span><span id="runtime-catsystem2-tools"></span>**When there's no native interpreter.** Some engines, such as BGI/Ethornell and CatSystem2, have no native player yet. MacLauncher still offers their archive and script tools, and plays the game through [Sikarugir or CrossOver](/maclauncher/games/windows/).

## Guides

- [KiriKiri, AliceSoft, BGI and VNDS](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/VN_ENGINES.md)
- [Siglus and RealLive](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIGLUS.md)
- [NScripter](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NSCRIPTER.md)
- [MAGES.](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/MAGES.md)
- [Nitroplus](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/NITROPLUS.md)
- [Minori](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/MINORI.md)
- [FAVORITE / FVP](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/FVP.md)
- [AI5WIN](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/AI5.md)
- [CatSystem2](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CATSYSTEM2.md)
