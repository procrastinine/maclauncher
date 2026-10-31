---
title: Decompilers and extractors
description: "Unpack archives, decrypt assets and recover scripts and source code on macOS, for Ren'Py, RPG Maker, Unity, Android and most of the other game types MacLauncher supports."
head:
  - tag: title
    content: "Game decompilers and extractors on Mac | MacLauncher"
sidebar:
  order: 3
---

To translate a game, mod it, rescue its music or read its script, you first need to see inside it, and MacLauncher's decompilers and extractors do that on your Mac. Most game types come with these tools in the inspector.

The tools belong to the game type, so they read the game's original data whichever runtime plays it. They all follow the same pattern. You press the action, and if it needs a tool that isn't installed yet, MacLauncher downloads it and then continues where it left off. Results go into a separate export folder, so the game's files stay as they are. The one exception is Near Infinity, an external editor for Infinity Engine games: edits you save in it can change the game's resources.

## By game type

Each game type links to the tools section of its guide.

### Desktop engines

| Game type | What you can do |
| --- | --- |
| [Ren'Py](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RENPY.md#tools) | Extract RPA archives and decompile `.rpyc` scripts back to readable `.rpy` ([unrpyc](https://github.com/CensoredUsername/unrpyc), [rpatool](https://codeberg.org/shiz/rpatool) and UnRen) |
| [RPG Maker MV and MZ](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_MV_MZ.md#plugins-and-extraction) | Decrypt images and audio into a readable project ([RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter)); the scripts, plugins and database are readable as they are |
| [RPG Maker XP/VX/VX Ace](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_XP_VX.md#ruby-scripts) | Decrypt `.rgssad`/`.rgss3a` archives, export and repack the Ruby scripts, inspect save and data files |
| [RPG Maker 2000/2003](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/RPGMAKER_2000_2003.md#tools) | Export the database and maps to JSON, or the game's text for translation |
| [WOLF RPG Editor](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WOLFRPG.md#tools) | List and extract archives, including WOLF Pro archives ([UberWolf](https://github.com/Sinflower/UberWolf)), and export project data as JSON ([WolfTL](https://github.com/Sinflower/WolfTL)) |
| [Godot](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/GODOT.md#tools) | Recover the project, including GDScript ([GDRE Tools](https://github.com/GDRETools/gdsdecomp)) |
| [GameMaker](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/GAMEMAKER.md#decompilation-and-inspection) | Decompile Studio games' GML and export textures and sprites ([UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool)), rebuild classic GameMaker 8 projects ([GM8Decompiler](https://github.com/OpenGMK/OpenGMK)) |
| [Unity](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/UNITY.md#inspector-tools) | Decompile Mono code to C# ([ILSpy](https://github.com/icsharpcode/ILSpy)), recover [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) assemblies for ILSpy ([Cpp2IL](https://github.com/SamboyCoding/Cpp2IL)), browse and export assets ([AssetRipper](https://github.com/AssetRipper/AssetRipper)) |
| [FNA / XNA 4](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/FNA.md#decompilation) | Decompile to C# with ILSpy |
| [Java](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/JAVA.md#decompilation) | Decompile to Java ([Vineflower](https://vineflower.org/)) |
| [LÖVE](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/LOVE.md#source-export) | Recover Lua and LuaJIT source ([LJD](https://github.com/dol/luajit-decompiler) and [unluac](https://sourceforge.net/projects/unluac/)) |
| [Flash](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/FLASH.md#tools) | Export ActionScript, images, sounds, fonts and text ([JPEXS FFDec](https://github.com/jindrapetrik/jpexs-decompiler)) |
| [Construct](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/CONSTRUCT.md#tools) and [Tyrano](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/TYRANO.md#tools) | Extract the packaged HTML, scripts and resources |

### Visual novels

| Game type | What you can do |
| --- | --- |
| [KiriKiri](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/KIRIKIRI.md#script-export) | Export TJS and KAG scripts |
| [AliceSoft](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ALICESOFT.md#source-export) | Decompile System 1–3 and System 3.5–3.9 scenarios, disassemble System 4 games and export their text, and edit the variables of a running System 3.5–3.9 game |
| [Siglus / RealLive](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SIGLUS.md#source-tools) | Decompile Siglus scripts ([Siglus SceneScript Utility](https://github.com/Jirehlov/SiglusSceneScriptUtility)), export RealLive scripts and text (RLdev) |
| [NScripter](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/NSCRIPTER.md#tools) | Export the script, including encoded scripts |
| [Nitroplus](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/NITROPLUS.md#inspector-tools) | Inspect archives, extract the NSS script source and check it with the script compiler |
| [Minori](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MINORI.md#script-tools) | Export scripts as UTF-8 text |
| [MAGES.](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MAGES.md#archive-and-script-tools) | Inspect archives and scripts, export compiled scripts and, for supported editions, dialogue text |
| [FAVORITE / FVP](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/FVP.md#inspection-and-asset-exports) | Export dialogue ([msg-tool](https://github.com/lifegpc/msg-tool)) and extract assets |
| [BGI / Ethornell](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/BGI.md#inspector-tools) | Export compiled programs and messages (msg-tool) |
| [CatSystem2](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/CATSYSTEM2.md#script-and-archive-export) | Decode archives and export scripts as readable transcripts |
| [AI5WIN](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/AI5.md#detection-and-versions) | Report the game's data and configuration |
| [VNDS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/VNDS.md#game-files-and-saves) | Open the scripts, which are plain text |

### Mobile, consoles and native programs

| Game type | What you can do |
| --- | --- |
| [Android](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/ANDROID.md#apk-decompilation) | Recover Java source and resources ([JADX](https://github.com/skylot/jadx)), or decode smali, the manifest and resources ([Apktool](https://github.com/iBotPeaches/Apktool)) |
| [iOS / iPadOS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/IOS.md#inspector-tools) | Inspect and extract the contents of an IPA, and inspect unencrypted executables |
| [PlayStation 5](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/PS5.md#inspector-tools) and [Nintendo Switch](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SWITCH.md#inspector-tools) | Inspect programs and export functions, strings and C pseudocode ([Rizin](https://github.com/rizinorg/rizin) and [Ghidra](https://github.com/NationalSecurityAgency/ghidra)) |
| [macOS Game](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MACOS.md#inspector-tools), [Windows Game](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/WINDOWS.md#inspector-tools), [DOS](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/DOS.md#inspector-tools) and [Haxe native build](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/HAXE.md#binary-inspection) | Inspect the executable and export C pseudocode with Rizin and Ghidra |

### Other game types

| Game type | What you can do |
| --- | --- |
| [Infinity Engine](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/INFINITY_ENGINE.md#near-infinity) | Browse and edit resources and saves ([Near Infinity](https://github.com/Argent77/NearInfinity)) |
| [ScummVM](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/SCUMMVM.md#inspector-tools) | Identify the edition and extract resource archives ([ScummVM Tools](https://wiki.scummvm.org/index.php/ScummVM_Tools)) |
| [MUGEN / Ikemen GO](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/MUGEN.md#sprite-export) | Export sprites as PNG files |
| [HashLink](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/HASHLINK.md#bytecode-export) | Inspect bytecode and export its opcodes and pseudocode ([hlbc](https://github.com/Gui-Yom/hlbc)) |
| [Video](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/VIDEO.md#preview-and-export) | Report a video's streams, chapters and tags |

The [tool reference](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/README.md) lists every action, output format and limit by game type, and [native binary inspection](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/NATIVE_INSPECTION.md) describes the Rizin and Ghidra exports.

## Installers and packed games

Many games don't arrive as a plain folder. MacLauncher opens the common wrappers on import, so you can usually drag the download straight in.

### Installers

[GOG](https://www.gog.com/)'s offline Windows installers, like many others, are built with [Inno Setup](https://jrsoftware.org/isinfo.php): a `setup_….exe`, often with numbered `.bin` parts beside it. MacLauncher reads the installer as data with [innoextract](https://github.com/dscharrer/innoextract), without running it, then detects the game type inside like any other folder. A GOG Windows installer of a Ren'Py, GameMaker or RPG Maker game can therefore end up on a native runtime, with no Windows or [WINE](https://www.winehq.org/) at any step. [Stores and downloads](/maclauncher/tools/stores-and-downloads/) gets those installers, older versions included, from inside MacLauncher. Encrypted installers aren't supported.

### Packed games

Some games ship entirely inside one `.exe`, and the game type's module reads it in place:

- TyranoScript, [Construct](https://www.construct.net/) and LÖVE games with their data appended to the executable as a ZIP;
- Godot games with their data embedded in the executable;
- RPG Maker XP/VX/VX Ace and NScripter games inside self-extracting archives (ZIP, RAR, 7z, NSIS, Inno Setup or CAB), opened with [7-Zip](https://www.7-zip.org/);
- RPG Maker XP/VX/VX Ace, NScripter and Tyrano games packed with Enigma Virtual Box, unpacked with [evbunpack](https://github.com/mos9527/evbunpack).

The unpacked copy lives in MacLauncher's own game data, and importing the same installer again reuses it. innoextract downloads the first time it's needed; 7-Zip and evbunpack are included.

Guide: [Installer reader](https://github.com/procrastinine/maclauncher/blob/master/docs/tools/INSTALLERS.md)

## What you get back

[Decompiled](https://en.wikipedia.org/wiki/Decompiler) output is a faithful reading of what the game shipped, which is different from the developer's original project. Script engines such as Ren'Py, RPG Maker and KiriKiri come back very readable. Compiled code (C#, Java) usually decompiles well. Machine code from native programs comes back as pseudocode, which is good for understanding a program and useless for rebuilding it.
