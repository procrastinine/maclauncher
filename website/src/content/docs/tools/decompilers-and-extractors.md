---
title: Decompilers and extractors
description: Unpack archives, decrypt assets and recover scripts and source code for most of the engines MacLauncher supports.
sidebar:
  order: 3
---

Curious how a game is put together? Want to translate it, mod it, rescue its music, or just read the script? Most engines MacLauncher supports come with tools in the game's inspector for exactly that.

They all follow the same pattern. You press the action, and if it needs a tool that isn't installed yet, MacLauncher asks before downloading it, then picks up where it left off. Results go into a separate export folder; the game's original files are never changed.

## By engine

| Engine | What you can do |
| --- | --- |
| **[Ren'Py](https://www.renpy.org/)** | Extract RPA archives, decompile `.rpyc` scripts back to readable `.rpy` ([unrpyc](https://github.com/CensoredUsername/unrpyc), [rpatool](https://github.com/shizmob/rpatool) and UnRen) |
| **[RPG Maker](https://www.rpgmakerweb.com/) MV/MZ** | Decrypt images and audio, read scripts and the database |
| **RPG Maker XP/VX/VX Ace** | Decrypt `.rgssad`/`.rgss3a` archives, export and repack the Ruby scripts, inspect save and data files |
| **RPG Maker 2000/2003** | Export the database and maps to JSON or text |
| **[WOLF RPG Editor](https://www.silversecond.com/WolfRPGEditor/)** | List and extract archives, export project data |
| **[Godot](https://github.com/godotengine/godot)** | Recover the project, including GDScript ([GDRE Tools](https://github.com/GDRETools/gdsdecomp)) |
| **[GameMaker](https://gamemaker.io/)** | Decompile Studio games' GML ([UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool)), export classic GameMaker 8 projects ([GM8Decompiler](https://github.com/OpenGMK/OpenGMK)) |
| **[Unity](https://unity.com/)** | Decompile Mono code to C# ([ILSpy](https://github.com/icsharpcode/ILSpy)), recover [IL2CPP](https://docs.unity.com/en-us/engine/current/manual/programming-environment/scripting-backends) metadata ([Cpp2IL](https://github.com/SamboyCoding/Cpp2IL)), browse and export assets ([AssetRipper](https://github.com/AssetRipper/AssetRipper)) |
| **[XNA](https://en.wikipedia.org/wiki/Microsoft_XNA)/[FNA](https://fna-xna.github.io/)** | Decompile to C# with ILSpy |
| **Java** | Decompile to Java ([Vineflower](https://vineflower.org/)) |
| **[LÖVE](https://love2d.org/)** | Recover Lua and LuaJIT source |
| **Flash** | Export ActionScript, images, sounds, fonts and text ([JPEXS FFDec](https://github.com/jindrapetrik/jpexs-decompiler)) |
| **Android** | Recover Java source and resources ([JADX](https://github.com/skylot/jadx)), or decode smali, the manifest and resources ([Apktool](https://github.com/iBotPeaches/Apktool)) |
| **Infinity Engine** | Browse and edit resources and saves ([Near Infinity](https://github.com/Argent77/NearInfinity)) |
| **[ScummVM](https://www.scummvm.org/) games** | Identify the edition and extract resource archives ([ScummVM Tools](https://wiki.scummvm.org/index.php/ScummVM_Tools)) |
| **Visual novels** | Export KiriKiri TJS/KAG scripts, decompile AliceSoft scenarios, and extract messages and text from Siglus, RealLive, BGI, FAVORITE, CatSystem2 and MAGES games |
| **PS5 and Switch** | Inspect programs and export functions, strings and C pseudocode ([Rizin](https://github.com/rizinorg/rizin) and [Ghidra](https://github.com/NationalSecurityAgency/ghidra)) |
| **Native programs** | Inspect Mac apps, Windows games and unencrypted iOS apps with Rizin and Ghidra |

That's the highlight reel. The [complete tool coverage table](https://github.com/procrastinine/maclauncher/blob/master/docs/GAME_TOOLS.md) lists every action, output format and limit per engine.

## Installers and packed games

Plenty of games don't arrive as a plain folder. MacLauncher opens the common wrappers on import, so you can usually drag the download straight in.

**Installers.** [GOG](https://www.gog.com/)'s offline Windows installers, like many others, are built with [Inno Setup](https://jrsoftware.org/isinfo.php): a `setup_….exe`, often with numbered `.bin` parts beside it. MacLauncher reads the installer as data with [innoextract](https://github.com/dscharrer/innoextract), without running it, then detects the engine inside like any other folder. So a GOG Windows installer of a Ren'Py, GameMaker or RPG Maker game can end up on a native runtime, with no Windows or [WINE](https://www.winehq.org/) at any step. [Stores and downloads](/maclauncher/tools/stores-and-downloads/) gets those installers, older versions included, from inside MacLauncher. Encrypted installers aren't supported.

**Packed games.** Some games ship entirely inside one `.exe`, and the engine's module reads it in place:

- TyranoScript, [Construct](https://www.construct.net/) and LÖVE games with their data appended to the executable as a ZIP;
- Godot games with their data embedded in the executable;
- RPG Maker XP/VX/VX Ace and NScripter games inside self-extracting archives (ZIP, RAR, 7z, NSIS, Inno Setup or CAB), opened with [7-Zip](https://www.7-zip.org/);
- RPG Maker games packed with Enigma Virtual Box, unpacked with [evbunpack](https://github.com/mos9527/evbunpack).

The original download is never changed. The unpacked copy lives in MacLauncher's own game data, and importing the same installer again reuses it. innoextract downloads the first time it's needed, after you agree; 7-Zip and evbunpack are included.

Guide: [Offline installer imports](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/INSTALLERS.md)

## A note on what you get back

[Decompiled](https://en.wikipedia.org/wiki/Decompiler) output is a faithful reading of what the game shipped, not the developer's original project. Script engines like Ren'Py, RPG Maker and KiriKiri come back very readable. Compiled code (C#, Java) usually decompiles well. Machine code from native programs comes back as pseudocode, which is great for understanding and terrible for rebuilding.
