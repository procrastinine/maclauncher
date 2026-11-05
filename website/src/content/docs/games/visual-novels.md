---
title: Visual novels
description: "Windows visual novels on macOS through native interpreters for KiriKiri, Siglus and RealLive, NScripter, AliceSoft, MAGES., Nitroplus, Minori, FAVORITE, AI5WIN and VNDS."
head:
  - tag: title
    content: "Visual novels on Mac: KiriKiri, Siglus, RealLive and NScripter | MacLauncher"
sidebar:
  order: 2
---

[Visual novels](https://en.wikipedia.org/wiki/Visual_novel) that were only ever released for Windows can often run natively on a Mac, with proper fonts, audio and fullscreen. This is possible because most visual-novel engines are interpreters: the game is a set of script and asset archives, and the engine reads them. Fan and preservation communities have written open-source interpreters for many of these engines, and MacLauncher builds and manages them for macOS.

[Ren'Py](/maclauncher/games/desktop-engines/#renpy), the most popular modern engine, is covered on the desktop engines page, and Tyrano runs with the other [web games](/maclauncher/games/desktop-engines/#web-games) there.

## Game types and runtimes

Each engine below is its own game type, linked to its guide.

| Game type | Runtime on macOS |
| --- | --- |
| [KiriKiri](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/KIRIKIRI.md) (KAG) | <span id="runtime-krkrsdl2"></span>[krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) with [KAG3](https://github.com/krkrsdl2/kag3) |
| [Siglus / RealLive](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SIGLUS.md) (Key, Visual Arts) | <span id="runtime-siglus"></span>[siglus_rs](https://github.com/xmoezzz/siglus_rs), or <span id="runtime-rlvm"></span>[RLVM](https://github.com/eglaysher/rlvm) for RealLive |
| [NScripter](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/NSCRIPTER.md) | <span id="runtime-onsyuri_mac"></span>[ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri), or MacLauncher's port of <span id="runtime-onscripter_en"></span>[ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) |
| [AliceSoft](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ALICESOFT.md) (System 1–4) | <span id="runtime-system3"></span>[System3](https://github.com/kichikuou/system3-sdl2), <span id="runtime-xsystem35"></span>[xsystem35](https://github.com/kichikuou/xsystem35-sdl2) or <span id="runtime-xsystem4"></span>[xsystem4](https://github.com/nunuhara/xsystem4), depending on the engine generation |
| [MAGES.](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MAGES.md) | <span id="runtime-impacto"></span>[Impacto](https://github.com/CommitteeOfZero/impacto) |
| [Nitroplus](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/NITROPLUS.md) | <span id="runtime-npengine"></span>[NPengine](https://github.com/FGRE/libnpengine) with [libnpa](https://github.com/FGRE/libnpa) |
| [Minori](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MINORI.md) | <span id="runtime-reminori"></span>MacLauncher's port of [ReMinori](https://github.com/luoyily/ReMinori) |
| [FAVORITE / FVP](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/FVP.md) | <span id="runtime-rfvp"></span>[RFVP](https://github.com/xmoezzz/rfvp) |
| [AI5WIN](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/AI5.md) (elf) | <span id="runtime-ai5"></span>MacLauncher's port of [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) |
| [VNDS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/VNDS.md) (Nintendo DS conversions) | <span id="runtime-vnds_love"></span>[VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) |
| [BGI / Ethornell](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/BGI.md) | No native interpreter; see [below](#engines-without-a-native-interpreter) |
| [CatSystem2](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/CATSYSTEM2.md) | No native interpreter; see [below](#engines-without-a-native-interpreter) |

When a game includes a compatible Windows executable, its game type also offers [Sikarugir and CrossOver](/maclauncher/games/windows/) as runtimes.

Support depends on the engine and its format, and the same game can use different engines or formats across platforms and re-releases. To find out which engine a release uses, check [VNDB](https://vndb.org/), the visual novel database, which lists the engine on many release pages. Each interpreter supports the formats its own project supports, and some engines changed formats over the years, so the guides list exactly which variants work.

## What to expect

### Saves

Interpreters such as siglus_rs and RFVP keep their own save files, separate from the original Windows engine's. Your Windows saves stay where they were, and MacLauncher's save tools show where the new ones are.

### Fonts and languages

Many visual novels are Japanese and expect Japanese system fonts. The native interpreters, however, handle text shaping and fonts themselves, and fan translations and patches that the engine supports also keep working.

### Script tools

Most of these game types come with tools for reading the script. KiriKiri scripts export as readable TJS and KAG, AliceSoft and Siglus scenarios can be decompiled, and RealLive, NScripter, Nitroplus, Minori and CatSystem2 scripts can be exported. BGI, FAVORITE and MAGES. games have message and text exporters. See [Decompilers and extractors](/maclauncher/tools/decompilers-and-extractors/#visual-novels).

### Engines without a native interpreter

<span id="runtime-bgi-tools"></span><span id="runtime-catsystem2-tools"></span>BGI (also called Ethornell) and CatSystem2 have no native interpreter. MacLauncher still recognizes their games and offers their archive and script tools, and it plays the original Windows executable through [CrossOver or Sikarugir](/maclauncher/games/windows/).
