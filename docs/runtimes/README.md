# Runtime guides

Import accepts a complete game folder or supported package. **Play** detects
the format, selects a matching runtime and asks before downloading a missing
version. Installed versions are reused offline. The game format and version
determine the runtime selection.

## Runtime downloads

Game engines and versioned tools use **managed** packages: downloads follow consent and installed versions are reused locally. Runtimes provides Refresh, Install and exact version selection. The launcher includes its minimal core graphics and internal-helper closure; it does not bundle individual game engines.

The tables group registered game types and their runtime choices. Each linked
guide describes playback, settings, supported formats and available tools.
The [module reference](../MODULES.md#modules-and-backends) lists the corresponding
module and runtime identifiers, and the [settings reference](SETTINGS_REFERENCE.md)
lists every backend, runtime setting and inspector action by game type.

[Sikarugir (Wine)](SIKARUGIR.md) supplies managed Windows runtime versions.
[CrossOver](CROSSOVER.md) applications can also be registered locally. Multiple
application paths remain separate choices, including installations reporting
the same version. Compatible x86/x64 Windows games expose Sikarugir and any
available CrossOver application alongside their engine's other backends.

## HTML and web exports

Electron is included; NW.js versions are managed downloads. **NW.js (Patched)**
adds the module's optional compatibility settings. Games with a supplied compatible
macOS app can also use **Native app**.

| Game type | Backends | Guide |
| --- | --- | --- |
| RPG Maker MV | Electron, NW.js, NW.js (Patched) | [HTML hosts](RUNTIMES.md), [saves and cheats](../MVMZ_SAVE_EDITOR.md) |
| RPG Maker MZ | Electron, NW.js, NW.js (Patched) | [HTML hosts](RUNTIMES.md), [saves and cheats](../MVMZ_SAVE_EDITOR.md) |
| Construct 2/3 | Electron, NW.js, NW.js (Patched) | [HTML hosts](RUNTIMES.md) |
| Tyrano / TyranoBuilder | Electron, NW.js, NW.js (Patched) | [HTML hosts](RUNTIMES.md) |
| GameMaker HTML5 | Electron, NW.js | [HTML hosts](RUNTIMES.md) |
| Other HTML games | Electron, NW.js, NW.js (Patched) | [HTML hosts](RUNTIMES.md) |

## Desktop game engines

| Game type | Backends and delivery | Formats and guide |
| --- | --- | --- |
| RPG Maker XP/VX/VX Ace | **MKXP-Z**, managed | [RGSS configuration, scripts and assets](MKXPZ.md); ordinary Play needs no authenticated download. |
| RPG Maker 2000/2003 | **EasyRPG Player**, managed | [Database/map projects, private saves and player settings](EASYRPG.md) |
| WOLF RPG Editor | **Browser Woditor**, managed | [Archives, loose data and automatic preparation](WOLFRPG.md) |
| ScummVM adventure games | **ScummVM**, managed | [Recognized game layouts and automatic runtime detection](SCUMMVM.md) |
| DOS programs | **DOSBox Staging**, managed | [EXE/COM/BAT playback, private game data and program inspection](DOSBOX.md) |
| Windows executables | **Sikarugir (Wine)**, managed; **CrossOver**, locally registered applications | [Managed Wine versions and graphics](SIKARUGIR.md), [CrossOver application versions and private bottles](CROSSOVER.md); optional for recognized Windows engines, Sikarugir is the default for generic Windows games. |
| GameMaker Classic | **OpenGMK**, managed | [GM8.0/8.1 interpreter](GAMEMAKER.md); Windows executable playback also uses Sikarugir or CrossOver. |
| GameMaker Studio | **Butterscotch**, managed; **official GameMaker runners**, managed | [Studio VM formats and exact runner versions](GAMEMAKER.md). |
| Godot | **Godot**, managed | [Versioned engine and original project data](RUNTIMES.md#godot). |
| Unity Mono | **Unity Mono player**, managed | [Exact-version Mac player replacement for Mono games](UNITY.md). |
| XNA/FNA | **FNA**, managed adapted host with .NET, FNA3D and FAudio | [Managed assembly and native API compatibility](FNA.md). |
| LÖVE | **LÖVE**, managed | [Archives, fused executables and AppImages](LOVE.md). |
| Java | **Eclipse Temurin**, managed | [JVM versions and JAR requirements](RUNTIMES.md#temurin--vineflower). |
| Flash | **Adobe Flash Player**, managed universal projector; **Ruffle**, managed | [SWF playback and player options](RUNTIMES.md#ruffle--flash-player). |
| Existing macOS applications, scripts and native executables | **Native macOS**, supplied with the game or its installed interpreter; **mac32**, managed for i386-only apps | [Native launch and app quarantine handling](../README.md#add-and-play), [32-bit Intel apps, version management and requirements](MAC32.md). |

GameMaker, Godot, Unity, XNA/FNA and LÖVE also offer **Native app** when the game
supplies a compatible macOS build. GameMaker retains an inspection-only choice
for formats without a compatible player.

Generic i386-only macOS app imports select mac32 automatically; recognized
engines retain their preferred runtime. The mac32 host requires macOS 26 or
later and Rosetta on Apple Silicon.

## Visual novel engines

| Game type | Backends and delivery | Formats and guide |
| --- | --- | --- |
| Ren'Py | **Ren'Py SDK**, managed; **Ren'Py Patch** prepares Mac runtime files; supplied **Native app** | [Python-generation and SDK selection](RUNTIMES.md#renpy), [Live2D libraries](RENPY_LIVE2D.md). |
| KiriKiri / KAG | **krkrsdl2**, managed | [Readable KAG3 projects and matching XP3 archive profiles](VN_ENGINES.md). |
| AliceSoft System 1–3 | **System3 / system3-sdl2**, managed | [System 1, 2 and 3 formats](VN_ENGINES.md). |
| AliceSoft System 3.5–3.9 | **xsystem35 / xsystem35-sdl2**, managed | [ALD scenario formats](VN_ENGINES.md). |
| AliceSoft System 4 | **xsystem4**, managed | [AIN virtual machine and supported HLL APIs](VN_ENGINES.md). |
| NScripter | **ONScripter-Yuri** and **ONScripter-EN**, managed; **ONScripter-Yuri Web**, managed with an NW.js host; optional **External runtime** | [Script formats, player differences and save locations](NSCRIPTER.md). |
| AI5WIN | **AI5-SDL2**, managed | [Supported archive/configuration and original-disc profiles](AI5.md). |
| Siglus / RealLive / AVG32 | **siglus_rs**, managed; **RLVM**, managed alternative for RealLive archives | [Bytecode dialects, add-on support and separate saves](SIGLUS.md). Intel-only RLVM apps use Rosetta on Apple Silicon. |
| MAGES. | **Impacto**, managed Windows HD adapter | [Supported MPK/SC3 profile](MAGES.md). |
| Nitroplus | **NPengine / libnpengine** with **libnpa**, managed | [NPA/NSS formats](NITROPLUS.md). |
| Minori | **ReMinori**, managed | [Selected PAZ profiles](MINORI.md). |
| FAVORITE / FVP | **RFVP**, managed | [HCB scenarios, BIN resources and text settings](FVP.md). |
| VNDS | **VNDS-LOVE**, managed interpreter using managed **LÖVE** | [Already-converted VNDS exports, saves and controls](VN_ENGINES.md#vnds); original games are not automatically converted to VNDS. |

## Consoles, mobile platforms and video

| Game type | Backends and delivery | Formats and guide |
| --- | --- | --- |
| Android | **MacLauncher Android** (common/JVM and ART packages with managed Java 21), **Mac.apk** releases and the adapted **AIM** host on Apple Silicon, all managed | [APK and split-package playback, providers and storage](ANDROID.md), [runtime architecture](ANDROID_ARCHITECTURE.md), [store downloads](../GOOGLE_PLAY.md). |
| iOS / iPadOS | **PlayCover** PlayTools, managed, on Apple Silicon | [Unencrypted ARM64 `.ipa` packages](IOS.md). |
| Nintendo Switch | **nxnative**, upstream snapshots with managed MacLauncher Builds host and tools; **Inspection** | [NSP/NSZ/XCI/XCZ containers, preparation and Metal shaders](NXNATIVE.md). |
| PlayStation 5 | **AnyPS5**, managed; optional **Prosper** under Rosetta; **Inspection** | [Unpacked PS5 programs, PKG inspection and decompilation](ANYPS5.md), [Prosper](PROSPER.md). |
| Video | **mpv**, managed | [Local video playback with shared graphics effects](VIDEO.md). |

## Other native engines

| Game type | Backends and delivery | Formats and guide |
| --- | --- | --- |
| Infinity Engine | **GemRB**, managed CLI player with embedded Python | [Game profiles, saves and configuration](OTHER_ENGINES.md#gemrb). |
| MUGEN-compatible content | **Ikemen GO**, managed | [Character, stage and configuration compatibility](OTHER_ENGINES.md#ikemen-go). |
| HashLink | **HashLink**, managed MacLauncher Builds ABI profiles and upstream development snapshots | [Bytecode and native-module ABI selection](OTHER_ENGINES.md#hashlink); Intel VM profiles require Rosetta on Apple Silicon. |

## Inspection and export tools

The [complete tool coverage tables](../GAME_TOOLS.md) map every game type and
primary runtime to its inspection actions, output formats and concrete limits.
Compatible alternative playback backends retain the detected engine's tools.

| Game type | Tools | Playback |
| --- | --- | --- |
| BGI / Ethornell | [BGI archive and compiled-program tools](VN_ENGINES.md#bgi--ethornell), using OpenBGI format references | Windows playback through a registered CrossOver application, otherwise Sikarugir. |
| CatSystem2 | [KIF, CatScene, CSTL, FES and HG-3 tools](CATSYSTEM2.md), with an included KIF cipher helper | Windows playback through a registered CrossOver application, otherwise Sikarugir. |
| Native Windows Haxe builds | [hxcpp / Lime metadata](OTHER_ENGINES.md#game-formats-and-runtimes), [Rizin / Ghidra binary inspection](../NATIVE_INSPECTION.md) | Compiled Windows C++ code plays through a registered CrossOver application, otherwise Sikarugir; HashLink bytecode uses its separate bytecode tools. |

## Game tools and shared dependencies

| Purpose | Included or managed components | Guide |
| --- | --- | --- |
| GameMaker source tools | Managed **GM8Decompiler**; managed **UndertaleModTool CLI**; managed **Igor** for official Studio runtime modules | [GameMaker tools](GAMEMAKER.md) |
| Godot project recovery | Managed **GDRE Tools / gdsdecomp** | [Godot](RUNTIMES.md#godot) |
| C# decompilation | Managed **ILSpy** and compatible .NET host | [FNA](FNA.md), [Unity](UNITY.md) |
| Android packages | Managed **JADX** for Java/resource recovery and **Apktool** for smali, manifest and resource decoding | [Android](ANDROID.md), [complete coverage](../GAME_TOOLS.md) |
| Unity IL2CPP code recovery | Managed **Cpp2IL** upstream Apple Silicon builds, with **ILSpy** for C# export | [Unity](UNITY.md) |
| Unity asset inspection and export | Managed **AssetRipper**, using native Apple Silicon releases | [Unity](UNITY.md) |
| Java decompilation | Managed **Vineflower** with compatible Temurin | [Java tools](RUNTIMES.md#temurin--vineflower) |
| Lua and LuaJIT source recovery | Managed **LJD** with included Python and **unluac** with managed Temurin; plaintext Lua exports directly | [LÖVE tools](LOVE.md) |
| MUGEN / Ikemen sprites | Managed **SFF Tools** WebAssembly decoder for sprite PNG and group/palette metadata export | [Ikemen](OTHER_ENGINES.md#ikemen-go), [complete coverage](../GAME_TOOLS.md) |
| HashLink bytecode | Managed **hlbc** through Sikarugir or CrossOver; metadata, bytecode listings and entrypoint pseudocode | [HashLink](OTHER_ENGINES.md#hashlink) |
| Flash source and assets | Managed **JPEXS FFDec** with compatible Temurin | [Flash tools](../FLASH_TOOLS.md) |
| Infinity Engine resources | Managed **Near Infinity** with compatible Temurin | [Infinity Engine tools](../INFINITY_TOOLS.md) |
| ScummVM resources | Managed **ScummVM Tools**, with format-specific extraction | [ScummVM](SCUMMVM.md) |
| RPG Maker 2000/2003 inspection | Included **rpgrt** library for LCF JSON and text export | [EasyRPG](EASYRPG.md) |
| WOLF RPG Editor assets and projects | Included archive readers; managed **UberWolf** extraction and **WolfTL** DAT/MPS project JSON export through Sikarugir or CrossOver | [WOLF RPG Editor](WOLFRPG.md) |
| FAVORITE / FVP assets | Included scenario inspection, BIN inventories and unchanged asset exports | [FAVORITE / FVP](FVP.md) |
| KiriKiri scripts | Included readable TJS/KAG export with patch and language selection | [KiriKiri / KAG](VN_ENGINES.md) |
| AliceSoft source export | Managed **sys3dc** from **sys3c**, and **xsys35dc** from **xsys35c** | [System 1–3 and 3.5–3.9 source export](VN_ENGINES.md#alicesoft-source-export) |
| AliceSoft System 4 source inspection | Managed **Alice tools** through Sikarugir or CrossOver for AIN disassembly and dialogue text | [AliceSoft](VN_ENGINES.md#alicesoft-source-export) |
| Siglus source recovery | Managed **Siglus SceneScript Utility** with included Python | [Siglus and RealLive](SIGLUS.md) |
| RealLive source inspection | Managed **RLdev** through Sikarugir or CrossOver for supported SEEN disassembly and text; per-scenario failures remain explicit | [Siglus and RealLive](SIGLUS.md) |
| Visual-novel messages and compiled constants | Managed native **msg-tool**, complementing BGI/FVP/KiriKiri format readers | [BGI](VN_ENGINES.md#bgi--ethornell), [FVP](FVP.md), [KiriKiri](VN_ENGINES.md) |
| MAGES text | Managed **sc3tools** through Sikarugir or CrossOver for the supported Windows HD character-set profile | [MAGES](MAGES.md) |
| Native program inspection | Managed **Rizin / Ghidra** CLI components from the upstream Cutter Apple Silicon distribution | [Native binary inspection](../NATIVE_INSPECTION.md) |
| Media stream inspection | Existing managed **mpv**, with a private local metadata export script | [Video](VIDEO.md) |
| RPG Maker archive and script tools | Included **RPGMakerDecrypter**, RGSS archive readers and script tools | [RGSS tools](../RGSS_TOOLS.md) |
| Ren'Py archive, script and cheat tools | Included **UnRen**, **unrpyc**, **rpatool**, **0x52's URM** and **Universal Ren'Py Walkthrough** integrations | [Ren'Py tools](../RENPY_TOOLS.md) |
| Installer and executable extraction | Managed **innoextract**; included **7-Zip**, **Python** and **evbunpack** | [Offline installer imports](INSTALLERS.md), [distribution](RUNTIME_DISTRIBUTION.md#distribution-policy) |
| Native Steam integration | Included offline API helper, **LuaSteam** bridge, **steamworks4j** JNI profiles and ticket-loader adapter; genuine compatible libraries where required | [Steam support](STEAM_API.md), [LÖVE](LOVE.md), [Java](JAVA_STEAM.md) |
| NW.js Steam integration | Managed **Greenworks** with exact NW.js and Steamworks SDK compatibility | [Greenworks](GREENWORKS.md) |

Missing managed tools are acquired with consent when their inspector action runs,
then the action resumes. Internal extraction helpers need no manual Python or
7-Zip installation and have no runtime-selection tabs. The included MKXP-Z
configuration helper prepares per-game settings for the selected managed player. Engine-owned
save, cheat and script helpers are described in the [tools guide](../README.md#saves-cheats-and-source-tools).

## Version management and shared services

- [Offline installer imports](INSTALLERS.md): managed Inno Setup reader, companion parts and one owned extraction cache.
- [Steam support](STEAM_API.md): shared offline API, exact native/managed consumer contracts and genuine SDK mode.
- [Runtime system](RUNTIMES.md): selection, installation and module-manager contracts.
- [Release catalogs](RUNTIME_CATALOGS.md): shared providers, complete bounded histories and refresh semantics.
- [Distribution policy](RUNTIME_DISTRIBUTION.md#distribution-policy): managed downloads, included helpers and Settings; source/package identities and integrity checks.
- [Settings reference](SETTINGS_REFERENCE.md): every backend, runtime setting and inspector action by game type.
- [Native tool setup](NATIVE_TOOL_SETUP.md): package sources, system components, managed decompilers and included helpers.
- [Custom runtime layouts](CUSTOM_RUNTIME_LAYOUTS.md): accepted forms for locally registered runtimes.
- [GitHub metadata transport](GITHUB_TRANSPORT.md): shared release-metadata requests, caching and limits.
- [Network isolation](NETWORK_ISOLATION.md): per-game Internet and local-network blocking.
- [Rosetta](ROSETTA.md): automatic Intel-runtime prerequisite checks on Apple Silicon.
- [Shared graphics processing](GRAPHICS.md): renderer-specific graphics controls and provider acquisition.

The [user guide](../README.md) describes saves and inspector actions.
[Preparation and storage](../GAME_PREPARATION.md) describes original-file handling.
