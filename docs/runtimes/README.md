# Runtime guides

Drag in a complete Windows or Linux game and press **Play**. MacLauncher detects
the format, selects a compatible runtime and asks before downloading a missing
version. Included runtimes run directly. Compatibility depends on engine,
bytecode, native-library and platform requirements; an engine match does not
promise every game will work.

## Delivery and compatibility

**Included** players run from the app without a separate installation. **Managed**
versions download after consent and are reused locally. Some backends provide both
an included version and managed alternatives. Fixed included players retain their
Settings and inspector version information without a Runtimes download tab.

The tables cover every registered game type and its runtime choices. Each linked
guide describes accepted formats and limits. Native Windows libraries, unsupported
script operations and incompatible saves can still prevent complete gameplay.
The [module reference](../MODULES.md#modules-and-backends) lists the corresponding
module and runtime identifiers.

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

| Game type | Backends and delivery | Scope and guide |
| --- | --- | --- |
| RPG Maker XP/VX/VX Ace | **MKXP-Z**, included fallback plus optional managed versions | [RGSS configuration, scripts and assets](MKXPZ.md); ordinary Play needs no authenticated download. |
| GameMaker Classic | **OpenGMK**, included | [GM8.0/8.1 interpreter](GAMEMAKER.md); protected and other unsupported executable formats remain inspection-only. |
| GameMaker Studio | **Butterscotch**, included; **official GameMaker runners**, managed | [Studio VM formats and exact runner versions](GAMEMAKER.md); YYC/native code and extensions have separate limits. |
| Godot | **Godot**, managed | [Versioned engine and original project data](RUNTIMES.md#godot). |
| Unity Mono | **Unity Mono player**, managed | [Exact-version Mac player replacement](UNITY.md); experimental, with IL2CPP and Direct3D-only data unsupported. |
| XNA/FNA | **FNA**, included adapted host with .NET, FNA3D and FAudio | [Managed assembly and native API compatibility](FNA.md). |
| LÖVE | **LÖVE**, managed | [Archives, fused executables and AppImages](LOVE.md); native Lua modules require matching Mac libraries. |
| Java | **Eclipse Temurin**, managed | [JVM versions and JAR requirements](RUNTIMES.md#temurin--vineflower). |
| Flash | **Adobe Flash Player**, included universal projector; **Ruffle**, managed | [SWF playback and player options](RUNTIMES.md#ruffle--flash-player). |
| Existing macOS applications | **Native app**, supplied with the game | [App launch and quarantine handling](../README.md#add-and-play). |

GameMaker, Godot, Unity, XNA/FNA and LÖVE also offer **Native app** when the game
supplies a compatible macOS build. GameMaker retains an inspection-only choice
for formats without a compatible player.

## Visual novel engines

| Game type | Backends and delivery | Scope and guide |
| --- | --- | --- |
| Ren'Py | **Ren'Py SDK**, managed; **Ren'Py Patch** prepares Mac runtime files; supplied **Native app** | [Python-generation and SDK selection](RUNTIMES.md#renpy), [Live2D libraries](RENPY_LIVE2D.md). |
| KiriKiri / KAG | **krkrsdl2**, included | [Readable KAG3 projects and compatible XP3 archives](VN_ENGINES.md); KAG2/TJS1, unknown encryption and required Windows plugins are unsupported. |
| AliceSoft System 1–3 | **System3 / system3-sdl2**, included | [System 1, 2 and 3 formats](VN_ENGINES.md). |
| AliceSoft System 3.5–3.9 | **xsystem35 / xsystem35-sdl2**, included | [ALD scenario formats](VN_ENGINES.md). |
| AliceSoft System 4 | **xsystem4**, included | [AIN virtual machine and supported HLL APIs](VN_ENGINES.md). |
| NScripter | **ONScripter-Yuri** and **ONScripter-EN**, included; **ONScripter-Yuri Web**, managed with an NW.js host; optional **External runtime** | [Script formats, player differences and save locations](NSCRIPTER.md); web playback has a narrower beta scope. |
| AI5WIN | **AI5-SDL2**, included | [Supported archive/configuration and original-disc profiles](AI5.md). |
| Siglus / RealLive / AVG32 | **siglus_rs**, managed; **RLVM**, managed alternative for RealLive archives | [Bytecode dialects, add-on support and separate saves](SIGLUS.md). RLVM 0.14 uses Rosetta on Apple Silicon. siglus_rs retains slot-restore and complete-gameplay limits. |
| MAGES. | **Impacto**, included Windows HD adapter | [Supported MPK/SC3 profile](MAGES.md); native playback is beta. |
| Nitroplus | **NPengine / libnpengine** with **libnpa**, included | [NPA/NSS formats](NITROPLUS.md); title/menu/opening-story beta, with later script, audio and save limitations. |
| Minori | **ReMinori**, included | [Selected PAZ profiles](MINORI.md); native playback is beta on Apple Silicon. |
| VNDS | **VNDS-LOVE**, included interpreter using managed **LÖVE** | [Already-converted VNDS exports, saves and controls](VN_ENGINES.md#vnds); original games are not automatically converted to VNDS. |

## Other native engines

| Game type | Backends and delivery | Scope and guide |
| --- | --- | --- |
| Infinity Engine | **GemRB**, included CLI player with embedded Python | [Compatible resource sets and game profiles](OTHER_ENGINES.md#gemrb); Enhanced Editions and arbitrary mods are outside the supported profile. |
| MUGEN-compatible content | **Ikemen GO**, managed | [Character, stage and configuration compatibility](OTHER_ENGINES.md#ikemen-go). |
| HashLink | **HashLink**, included 1.9 and 1.12 Mac profiles plus managed snapshots | [Bytecode and native-module ABI selection](OTHER_ENGINES.md#hashlink); Intel VM profiles require Rosetta on Apple Silicon. |

## Inspection and export without native playback

| Game type | Available backend | Limit |
| --- | --- | --- |
| BGI / Ethornell | [BGI archive and compiled-program tools](VN_ENGINES.md#bgi--ethornell), using OpenBGI format references | The incomplete OpenBGI VM is not included as a player. |
| CatSystem2 | [KIF, CatScene, CSTL, FES and HG-3 tools](CATSYSTEM2.md), with an included KIF cipher helper | Native gameplay is unsupported. FelineSystem2 is a source reference, not a distributed interpreter. |
| Native Windows Haxe builds | [hxcpp / Lime build inspection](OTHER_ENGINES.md#scope-and-version-evidence) | Compiled Windows C++ code has no native Mac playback route; HashLink bytecode uses the separate backend above. |

## Game tools and shared dependencies

| Purpose | Included or managed components | Guide |
| --- | --- | --- |
| GameMaker source tools | Included **GM8Decompiler**; managed **UndertaleModTool CLI**; managed **Igor** for official Studio runtime modules | [GameMaker tools](GAMEMAKER.md) |
| Godot project recovery | Managed **GDRE Tools / gdsdecomp** | [Godot](RUNTIMES.md#godot) |
| C# decompilation | Managed **ILSpy** and compatible .NET host | [FNA](FNA.md), [Unity](UNITY.md) |
| Java decompilation | Managed **Vineflower** with compatible Temurin | [Java tools](RUNTIMES.md#temurin--vineflower) |
| AliceSoft source export | Included **sys3dc** from **sys3c**, and **xsys35dc** from **xsys35c** | [System 1–3 and 3.5–3.9 source export](VN_ENGINES.md#alicesoft-source-export) |
| RPG Maker archive and script tools | Included **RPGMakerDecrypter**, RGSS archive readers and script tools | [RGSS tools](../RGSS_TOOLS.md) |
| Ren'Py archive, script and cheat tools | Included **UnRen**, **unrpyc**, **rpatool**, **0x52's URM** and **Universal Ren'Py Walkthrough** integrations | [Ren'Py tools](../RENPY_TOOLS.md) |
| Installer and executable extraction | Included **innoextract**, **7-Zip**, **Python** and **evbunpack** | [Offline installer imports](INSTALLERS.md), [distribution](RUNTIME_DISTRIBUTION.md#distribution-policy) |
| Native Steam integration | Included offline API helper, **LuaSteam** bridge, **steamworks4j** JNI profiles and ticket-loader adapter; genuine compatible libraries where required | [Steam support](STEAM_API.md), [LÖVE](LOVE.md), [Java](JAVA_STEAM.md) |
| NW.js Steam integration | Managed **Greenworks** with exact NW.js and Steamworks SDK compatibility | [Greenworks](GREENWORKS.md) |

Missing managed tools are acquired with consent when their inspector action runs,
then the action resumes. Internal extraction helpers need no manual Python or
7-Zip installation and have no runtime-selection tabs. Included MKXP-Z
configuration and native-host adapters are prepared automatically. Engine-owned
save, cheat and script helpers are described in the [tools guide](../README.md#saves-cheats-and-source-tools).

## Version management and development

- [Offline installer imports](INSTALLERS.md): included Inno Setup reader, companion parts and one owned extraction cache.
- [Steam support](STEAM_API.md): shared offline API, exact native/managed consumer contracts and genuine SDK mode.
- [Runtime system](RUNTIMES.md): selection, installation and module-manager contracts.
- [Release catalogs](RUNTIME_CATALOGS.md): shared providers, complete bounded histories and refresh semantics.
- [Distribution policy](RUNTIME_DISTRIBUTION.md#distribution-policy): managed downloads, automated builds, fixed built-ins and Settings; source/package identities and integrity checks.
- [Native development tools](NATIVE_TOOL_SETUP.md): source initialization, compiler requirements and tool locations.
- [Rosetta](ROSETTA.md): automatic Intel-runtime prerequisite checks on Apple Silicon.

See the [user guide](../README.md) for saves and inspector actions, and
[preparation and storage](../GAME_PREPARATION.md) for original-file handling.
