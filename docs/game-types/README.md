# Game types

A game type is a game format that MacLauncher recognizes, such as Ren'Py or RPG Maker MV. Detection assigns each imported game one game type, which decides the runtimes that can play it, the settings that apply and the tools in its inspector. A runtime is one way to play a game type. Some runtimes serve a single game type, and others, such as Electron or Sikarugir, serve several.

Each page below covers one game type: accepted inputs, detection and version evidence, preparation and storage, saves, settings and inspector tools. Its **Runtimes** section has a subsection for each runtime that can play the game type, starting with the default. The [runtime system](../runtimes/README.md) describes runtime selection, versions and managers, and the [settings reference](../runtimes/SETTINGS_REFERENCE.md) lists every runtime setting and inspector action by game type.

## Game types and their runtimes

The table lists game types by the name the app shows. In it, *Windows runtimes* means [Sikarugir (Wine)](../runtimes/SIKARUGIR.md) and [CrossOver](../runtimes/CROSSOVER.md), which a game type offers when the game includes a compatible Windows executable.

| Game type | Default runtime | Other runtimes |
| --- | --- | --- |
| [AI5WIN](AI5.md) | AI5-SDL2 | Windows runtimes |
| [AliceSoft](ALICESOFT.md) | System 1–3 | System 3.5–3.9, System 4, Windows runtimes |
| [Android](ANDROID.md) | MacLauncher Android | Mac.apk, AIM |
| [BGI / Ethornell](BGI.md) | Program tools (inspection only) | Windows runtimes |
| [CatSystem2](CATSYSTEM2.md) | Archive and script tools (inspection only) | Windows runtimes |
| [Construct](CONSTRUCT.md) | Electron | NW.js, NW.js (Patched), Game's macOS app, Windows runtimes |
| [DOS](DOS.md) | DOSBox Staging | Windows runtimes |
| [FAVORITE / FVP](FVP.md) | RFVP | Windows runtimes |
| [Flash](FLASH.md) | Adobe Flash Player | Ruffle |
| [FNA / XNA 4](FNA.md) | FNA | Game's macOS app, Windows runtimes |
| [GameMaker](GAMEMAKER.md) | Butterscotch | OpenGMK, Official GameMaker, Game's macOS app, Inspect only, Windows runtimes |
| [GameMaker HTML5](GAMEMAKER_HTML5.md) | Electron | NW.js, Game's macOS app |
| [Godot](GODOT.md) | Godot | Game's macOS app, Windows runtimes |
| [Half-Life (Xash3D FWGS)](HALF_LIFE.md) | Xash3D FWGS | Windows runtimes |
| [HashLink (Haxe bytecode)](HASHLINK.md) | HashLink (Intel Mac; Rosetta on Apple Silicon) | Windows runtimes |
| [Haxe native build](HAXE.md) | Native build inspection (inspection only) | Windows runtimes |
| [Infinity Engine (GemRB)](INFINITY_ENGINE.md) | GemRB | Windows runtimes |
| [iOS / iPadOS](IOS.md) | PlayCover | |
| [Java](JAVA.md) | Java | |
| [KiriKiri](KIRIKIRI.md) | KiriKiri SDL2 | Windows runtimes |
| [LÖVE](LOVE.md) | LÖVE | Game's macOS app, Windows runtimes |
| [macOS Game](MACOS.md) | Native macOS | 32-bit Mac |
| [MAGES.](MAGES.md) | Impacto Windows HD | Windows runtimes |
| [Minori](MINORI.md) | ReMinori | Windows runtimes |
| [MUGEN / Ikemen GO](MUGEN.md) | Ikemen GO | Windows runtimes |
| [Nintendo Switch](SWITCH.md) | Switch (nxnative) | Inspect only |
| [Nitroplus](NITROPLUS.md) | Nitroplus | Windows runtimes |
| [NScripter](NSCRIPTER.md) | ONScripter-Yuri | ONScripter-EN, ONScripter-Yuri Web, External runtime, Windows runtimes |
| [PlayStation 5](PS5.md) | PS5 (AnyPS5) | Inspect only, Prosper |
| [Ren'Py](RENPY.md) | Ren'Py SDK | Ren'Py Patch, Game's macOS app, Windows runtimes |
| [RPG Maker 2000/2003](RPGMAKER_2000_2003.md) | EasyRPG Player | Windows runtimes |
| [RPG Maker MV](RPGMAKER_MV_MZ.md) | Electron | NW.js, NW.js (Patched), Game's macOS app, Windows runtimes |
| [RPG Maker MZ](RPGMAKER_MV_MZ.md) | Electron | NW.js, NW.js (Patched), Game's macOS app, Windows runtimes |
| [RPG Maker XP/VX/VX Ace](RPGMAKER_XP_VX.md) | MKXP-Z | Windows runtimes |
| [ScummVM](SCUMMVM.md) | ScummVM | Windows runtimes |
| [Siglus / RealLive](SIGLUS.md) | Siglus | RealLive (RLVM), Windows runtimes |
| [Tyrano](TYRANO.md) | Electron | NW.js, NW.js (Patched), Game's macOS app, Windows runtimes |
| [Unity](UNITY.md) | Unity Mono player | Game's macOS app, Windows runtimes |
| [Video](VIDEO.md) | mpv player | |
| [VNDS](VNDS.md) | VNDS-LOVE | Windows runtimes |
| [Web](WEB.md) | Electron | NW.js, NW.js (Patched), Game's macOS app, Windows runtimes |
| [Window](WINDOW.md) | Window capture | |
| [Windows Game](WINDOWS.md) | Sikarugir (Wine) | CrossOver |
| [WOLF RPG Editor](WOLFRPG.md) | Browser Woditor | Windows runtimes |

Window entries are not imported. MacLauncher creates one for each window graphics session, which applies graphics to another app's window or to a display, and the entry exists only while that session runs.

RPG Maker MV and MZ are two versions of one engine with the same runtimes, so they share a page. Prosper and 32-bit Mac are listed separately in the settings reference, but they are runtimes: Prosper belongs to [PlayStation 5](PS5.md#prosper) and 32-bit Mac to [macOS Game](MACOS.md#32-bit-mac).

## Runtimes shared by several game types

### Web runtimes

Construct, GameMaker HTML5, RPG Maker MV and MZ, Tyrano and Web games run in [Electron or NW.js](../runtimes/WEB_RUNTIMES.md). Electron is included with MacLauncher, whereas NW.js versions are downloaded separately. A third choice, **NW.js (Patched)**, adds the game type's optional compatibility settings, although GameMaker HTML5 does not offer it.

### The game's own Mac build

When a game includes a compatible macOS build of its engine, its game type offers that build as the **Game's macOS app** runtime. The table above lists the game types that do. Mac apps without a recognized engine become [macOS Game](MACOS.md) entries instead, and those whose executable is i386 only use [32-bit Mac](MACOS.md#32-bit-mac).

### Windows runtimes

Sikarugir and CrossOver play the [Windows Game](WINDOWS.md) type. They are also offered for other game types whose files include a compatible x86 or x64 Windows executable, and offering them does not change the detected engine and version, the engine's tools or its default runtime. For BGI / Ethornell, CatSystem2 and Haxe native builds, which have no runtime that plays them on macOS, Play runs the Windows executable through one of these two. [Windows executables in other game types](WINDOWS.md#windows-executables-in-other-game-types) describes the rules.

### Inspection-only runtimes

Some runtimes provide a game type's detection and tools but cannot launch the game: **Program tools** for BGI / Ethornell, **Archive and script tools** for CatSystem2, **Native build inspection** for Haxe native builds, and **Inspect only** for GameMaker formats without a compatible player and for Nintendo Switch and PlayStation 5 inputs that cannot be played. When a BGI, CatSystem2 or Haxe import has a compatible Windows executable, automatic selection plays it with a Windows runtime instead.

## Runtime downloads

MacLauncher includes its core graphics component and internal helpers but no game engines. Engines and versioned tools are downloaded when a game first needs them, as described in [downloads and offline use](../runtimes/README.md#downloads-and-offline-use), and [runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md) explains how each runtime is delivered.

## Tools

Each game-type page describes its own inspector tools, and [game inspection and source tools](../tools/README.md) lists every tool, output and limit by game type. A game keeps its detected engine's tools even when another runtime, such as a Windows runtime, is selected. Internal extraction helpers, including Python and 7-Zip, are included with MacLauncher and have no runtime choices.

Some tools apply to every game type that supports them: [save snapshots](../tools/SAVE_SNAPSHOTS.md), [cheats](../tools/CHEATS.md), [native binary inspection](../tools/NATIVE_INSPECTION.md) and the [installer reader](../tools/INSTALLERS.md). [Game preparation and storage](../library/GAME_PREPARATION.md) describes how original files are handled.
