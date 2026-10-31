# Inspector tools

Each game type has inspector tools that read, extract or decompile its data. They appear as actions in the **Tools** section of the game's inspector. Tools belong to the game type and read the game's original data, whichever runtime plays it. Each game-type page describes its tools in full.

The tools produce four kinds of output:

- An inspection report describes the original data.
- An extraction copies stored resources or scripts unchanged.
- A decompilation reconstructs readable code from compiled data. Names, comments and control structure can be lost.
- Native C pseudocode describes machine code. It does not reconstruct an original C++, C#, Haxe, Swift or Objective-C project.

None of these outputs changes which runtime can play a game.

Some tools apply to many game types and have their own pages: [native binary inspection](NATIVE_INSPECTION.md), the [installer reader](INSTALLERS.md), [save snapshots](SAVE_SNAPSHOTS.md) and [cheats](CHEATS.md).

## Tools by game type

Actions separated by a semicolon are in different action groups of the inspector.

| Game type | Inspector actions | Tools and output |
| --- | --- | --- |
| [AI5WIN](../game-types/AI5.md#detection-and-versions) | **Inspect data** | Included INI, PE version and ARC/DAT index readers, following libai5, report game, profile and configuration metadata. The action does not export decompiled MES source. |
| [AliceSoft](../game-types/ALICESOFT.md#source-export) | **Decompile**, **Reveal export**; **Live variables** | sys3dc and xsys35dc export System 1–3 and System 3.5–3.9 scenario source. alice-tools exports a System 4 AIN disassembly and dialogue text. **Live variables** edits a running System 3.5–3.9 game. |
| [Android](../game-types/ANDROID.md#apk-decompilation) | **Inspect Android package**, **Decompile APK…**, **Decode APK**, **Reveal decompiled APK** | Included APK readers report package facts. JADX exports Java-like source and resources, and Apktool exports smali, decoded manifests and resources. |
| [BGI / Ethornell](../game-types/BGI.md#inspector-tools) | **Inspect programs**, **Export programs**, **Export text** | Included archive and program readers export compiled programs from recognized `BurikoCompiledScriptVer1.00` scenarios and `._bp` programs. msg-tool exports messages as JSON. |
| [CatSystem2](../game-types/CATSYSTEM2.md#script-and-archive-export) | **Export scripts**; **Inspect archives**, **Inspect scripts**, **Export scene archive** | The included KIF cipher helper and CatScene, CSTL and FES readers export decoded members, typed JSON and UTF-8 transcripts. |
| [Construct](../game-types/CONSTRUCT.md#tools) | **Extract bundle**, **Reveal extracted files**, **Remove extracted files** | Included package extractors export readable HTML, JavaScript and resources. |
| [DOS](../game-types/DOS.md#inspector-tools) | **Inspect program**, **Decompile**, **Show export** | **Inspect program** reports executable headers. Rizin / Ghidra exports C pseudocode for MZ and COM programs. |
| [FAVORITE / FVP](../game-types/FVP.md#inspection-and-asset-exports) | **Export text**; **List assets**, **Extract assets**, **Show assets**, **Remove extracted assets**; **Inspect game data** | Included HCB and asset readers report metadata and export original resources. msg-tool exports dialogue as JSON. |
| [Flash](../game-types/FLASH.md#tools) | **Export ActionScript**, **Export scripts and assets**, **Reveal export** | JPEXS FFDec exports ActionScript 1–3 and SWF resources. |
| [FNA / XNA 4](../game-types/FNA.md#decompilation) | **Decompile**, **Reveal source**; **Inspect managed assemblies** | ILSpy exports C#. The module's managed PE reader reports assembly identity and references. Native plugins and native-AOT code contain no managed IL to recover. |
| [GameMaker](../game-types/GAMEMAKER.md#decompilation-and-inspection) | **Decompile**, **Export textures and sprites**, **Reveal latest export**; **Export inspection report**, **Export raw Studio chunks** | GM8Decompiler rebuilds a Classic `.gmk` or `.gm81` project. UndertaleModTool exports Studio GML, strings, texture pages and sprite frames. |
| [GameMaker HTML5](../game-types/GAMEMAKER_HTML5.md#tools) | None | The shipped HTML and JavaScript are readable directly. |
| [Godot](../game-types/GODOT.md#tools) | **Recover project**, **Detect version**, **List packed files**; **Decompile GDScript…**, **Convert resources to text…**, **Convert resources to binary…** | GDRE Tools recovers projects, resources and GDScript. |
| [HashLink (Haxe bytecode)](../game-types/HASHLINK.md#bytecode-export) | **Export bytecode**, **Inspect bytecode** | The included reader inspects bytecode versions 2–6. hlbc exports metadata, opcodes and entry-point pseudocode for versions 4 and 5. |
| [Haxe native build](../game-types/HAXE.md#binary-inspection) | **Inspect binary** | Rizin / Ghidra exports binary metadata and C pseudocode. |
| [Infinity Engine (GemRB)](../game-types/INFINITY_ENGINE.md#near-infinity) | **Open Near Infinity**; **Inspect game version** | Near Infinity is an external resource browser and editor. An included reader reports resource and version facts. |
| [iOS / iPadOS](../game-types/IOS.md#inspector-tools) | **Inspect IPA**, **Extract IPA contents**, **Reveal extracted contents**, **Inspect binary** | Included ZIP, plist and Mach-O readers report and extract package contents. Rizin / Ghidra inspects unencrypted executables; it does not remove FairPlay encryption. Neither extraction nor pseudocode reconstructs an Xcode project, and inspection does not launch PlayCover. |
| [Java](../game-types/JAVA.md#decompilation) | **Decompile Java**, **Reveal**, **Remove decompiled files** | Vineflower decompiles the JAR's class files to Java. |
| [KiriKiri](../game-types/KIRIKIRI.md#script-export) | **Export scripts**, **Reveal scripts** | The included XP3 reader exports TJS and KAG scripts. msg-tool decodes SimpleCrypt scripts and TJS2 constant pools. Game-specific XP3 filters are not supported. |
| [LÖVE](../game-types/LOVE.md#source-export) | **Export source**, **Reveal source** | Lua text is copied as is. LJD recovers LuaJIT 2.0 and 2.1 bytecode, and unluac recovers standard Lua 5.0–5.4 bytecode. |
| [macOS Game](../game-types/MACOS.md#inspector-tools) | **Inspect binary** | Rizin / Ghidra inspects a Mach-O executable or the executable inside an app bundle. Scripts are readable directly. |
| [MAGES.](../game-types/MAGES.md#archive-and-script-tools) | **Inspect archives**, **Inspect scripts**, **Export compiled scripts**, **Export text** | Included MPK and SC3 readers report archive and script structure and export the original SCX files. sc3tools exports dialogue for the STEINS;GATE Windows HD edition. |
| [Minori](../game-types/MINORI.md#script-tools) | **Extract scripts**, **Reveal scripts**, **Remove scripts**; **Verify archives** | The selected ReMinori profile verifies the PAZ layout and exports UTF-8 scripts. Choosing another runtime does not make an unknown key or archive profile readable. |
| [MUGEN / Ikemen GO](../game-types/MUGEN.md#sprite-export) | **Export sprites**; **Inspect game version** | SFF Tools exports PNG sprites with their SFF metadata. DEF, CNS, ZSS and Lua definitions are plain text. |
| [Nintendo Switch](../game-types/SWITCH.md#inspector-tools) | **Inspect program**, **Decompile**, **Show export** | Decompile converts NSO code to an ARM64 ELF that keeps its memory layout, dynamic metadata and unwind headers, then Rizin / Ghidra exports C pseudocode. |
| [Nitroplus](../game-types/NITROPLUS.md#inspector-tools) | **Inspect archives**; under **More…**, **Extract scripts**, **Check script compiler** and **Log** | The included NPA and NSS reader reports archive metadata and extracts NSS source. The selected libnpengine compiler checks scripts. |
| [NScripter](../game-types/NSCRIPTER.md#tools) | **Export script**, **Reveal source** | The included script decoder exports plaintext and encoded scripts. |
| [PlayStation 5](../game-types/PS5.md#inspector-tools) | **Inspect package**, **Inspect program**, **Decompile**, **Show export** | An included reader reports PKG headers. The selected AnyPS5 runtime extracts decrypted SELF input, and Rizin / Ghidra exports C pseudocode. |
| [Ren'Py](../game-types/RENPY.md#tools) | **Extract**; **Inspect save metadata** | rpatool, unrpyc and the UnRen compatibility routes export archive members and reconstructed `.rpy` scripts. An included reader reports save metadata. |
| [RPG Maker 2000/2003](../game-types/RPGMAKER_2000_2003.md#tools) | **Export project JSON**, **Export game text**, **Reveal export**; **Inspect project** | The included rpgrt LCF readers export project data as JSON and translatable text. |
| [RPG Maker MV and MZ](../game-types/RPGMAKER_MV_MZ.md#plugins-and-extraction) | **Extract**; [save editor](../game-types/RPGMAKER_MV_MZ.md#structured-save-editing) | RPGMakerDecrypter decrypts assets into a readable project tree. JavaScript, plugins and JSON are readable directly. |
| [RPG Maker XP/VX/VX Ace](../game-types/RPGMAKER_XP_VX.md#ruby-scripts) | **Export Ruby scripts**, **Reveal scripts**, **Repack edited scripts**; **Find portable saves**, **Inspect save or database**; **Extract** | Included Ruby Marshal and script-table readers export scripts and inspect saves and databases. RPGMakerDecrypter extracts RGSS archives. |
| [ScummVM](../game-types/SCUMMVM.md#inspector-tools) | **Extract game archives**, **Reveal extracted files**; **Identify game edition** | ScummVM Tools extracts Gob and Kyrandia archives. ScummVM identifies the game edition. |
| [Siglus / RealLive](../game-types/SIGLUS.md#source-tools) | **Decompile**, **Reveal source**; **Inspect scripts** | Siglus SceneScript Utility exports Siglus `.ss`, `.inc` and `.dat` files and disassembly. RLdev exports RealLive `.org` scripts and `.utf` text. |
| [Tyrano](../game-types/TYRANO.md#tools) | **Extract**, **Reveal**, **Remove extracted files** | Included package extractors export the script and resource tree. |
| [Unity](../game-types/UNITY.md#inspector-tools) | **Inspect assets**, **Export assets**, **Reveal assets**; **Decompile**, **Reveal source**; **Inspect** | ILSpy exports C# from Mono assemblies, after Cpp2IL recovers assemblies from IL2CPP games. AssetRipper inspects and exports assets. **Inspect** reports game data and versions. |
| [Video](../game-types/VIDEO.md#preview-and-export) | **Inspect media** | mpv reports container, stream, chapter and tag metadata as JSON. |
| [VNDS](../game-types/VNDS.md#game-files-and-saves) | **Show scripts** | VNDS scripts are plain text in a converted format, so the original game's source project is not reconstructed. |
| [Web](../game-types/WEB.md#tools) | None | The supplied HTML, JavaScript, CSS and data files are readable directly. |
| [Windows Game](../game-types/WINDOWS.md#inspector-tools) | **Open Windows files**, **Inspect binary** | Rizin / Ghidra inspects the original executable. |
| [WOLF RPG Editor](../game-types/WOLFRPG.md#tools) | **List assets**, **Extract assets**, **Extract WOLF Pro assets**, **Export project JSON** | The included archive reader lists and extracts assets. UberWolf extracts WOLF Pro and other encrypted archives, and WolfTL exports project JSON. |

## Downloads, exports and logs

Tools, and the Java or .NET hosts that some of them need, are downloaded and installed like runtimes, as described in [Downloads and offline use](../runtimes/README.md#downloads-and-offline-use).

Each tool's version list comes from its publisher's release metadata, such as GitHub releases, ILSpy's NuGet history and the PyPI files of Siglus SceneScript Utility, which installs from the release's pure-Python wheel. A download is recognized by the tool's name, its platform and a supported archive type, so a release stays listed when the publisher renames a file, adds a file for another platform or changes the archive format. When several files match, the file with the tool's usual name is preferred. The publisher's SHA-256 or SHA-512 digest is verified when one is published; otherwise the SHA-256 of the downloaded file is recorded at installation. Executables, JAR files and their companion files are found at their usual location in the package or, when a release moves them, through a limited search of its folders. msg-tool and any Windows tool whose package has no license file receive the license notice from the tool's repository at the release's commit when the repository has one; a tool whose repository has no notice installs without one.

When a saved tool version is neither listed nor installed, the newest listed version takes its place. A Java tool whose saved Java version is no longer listed installs the newest listed version of that Java line, and the .NET host matches the framework that the selected ILSpy package declares.

Exports go to the game's launcher data folder. Near Infinity is the exception: it is an external editor, and edits saved in it can change the game's original resources.

Each tool's command log rotates when it reaches 8 MiB, keeping one previous log.

## Tools and runtimes

Choosing a different runtime for a game keeps the tools of its detected game type.

- A game detected as another engine can also run through the Windows runtimes, Sikarugir and CrossOver. Unity, GameMaker, visual novel and other engine tools keep reading the detected data, while a game imported as Windows Game gets native binary inspection. [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types) describes when the Windows runtimes are offered.
- Windows-only tools such as alice-tools, RLdev, sc3tools, WolfTL, UberWolf and hlbc run in their own private Sikarugir or CrossOver tool environments, separate from gameplay.
- Inspection-only backends, such as BGI's **Program tools**, CatSystem2's **Archive and script tools**, **Native build inspection** for Haxe and GameMaker's **Inspect only**, provide the tools without an interpreter. When none of a game type's own runtimes can launch a game, a compatible Windows executable plays through a registered CrossOver application or, otherwise, Sikarugir, and the tools stay available.
- [mac32](../game-types/MACOS.md#32-bit-mac) runs eligible 32-bit Intel Mac applications. An app detected as an engine keeps that engine's tools. mac32 does not run Windows or ARM binaries, convert scripts or engine source, add missing managed IL or restore source from stripped machine code.
- Java games choose a Temurin LTS line (8, 11, 17, 21 or 25) or a feature release from the **Other** section. The game's bytecode version and the CPU requirements of its JNI libraries limit the choice. Vineflower, JADX, Apktool, FFDec, Near Infinity and unluac each choose their own compatible Java host, so changing a tool's host does not change a game's Java line.
- Android games use the same package inspection and decompilation actions with every runtime. **MacLauncher Android** groups the JVM and ART execution packages, which share each game's application data and keep separate generated-code caches. Mac.apk and AIM are separate providers and do not replace JADX or Apktool. Inspecting or exporting an APK does not show that the app can run on any of them.
- The Electron and NW.js runtimes leave the shipped JavaScript inspectable, and no runtime recovers authoring sources the game does not ship. NW.js debugging facilities depend on the selected package, and **NW.js (Patched)** applies the module's compatibility preparation to the same game format. **Game's macOS app** runs a supplied macOS application; it adds no debugging interface, source recovery or portable engine.
- Player compatibility and tool compatibility are separate. A working export does not mean the game plays, and a playable game can contain a script or asset version that a tool does not support.

## Where tools appear in Runtimes

These tools are installed in **Runtimes**, where each keeps its own versions apart from game data and runtime installations. A tool that serves one game type is a subtab of that game type's Runtimes entry, and the **Tools** entry holds tools that several game types share.

| Location in Runtimes | Tool | Use | Host |
| --- | --- | --- | --- |
| Tools → Installer reader | [innoextract](https://github.com/dscharrer/innoextract) | Reads Inno Setup offline installers as data during import and RTP preparation. See [Installer reader](INSTALLERS.md). | Native |
| Tools → RPGMakerDecrypter | [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | Extracts RGSS archives and encrypted MV and MZ assets. | Native |
| Tools → ILSpy | [ILSpy](https://github.com/icsharpcode/ILSpy) | Decompiles managed .NET assemblies for Unity and FNA. | Compatible .NET host |
| Unity → Cpp2IL | [Cpp2IL](https://github.com/SamboyCoding/Cpp2IL) | Recovers IL2CPP assemblies for ILSpy, using the upstream self-contained Apple Silicon or Intel build. | Native |
| Unity → AssetRipper | [AssetRipper](https://github.com/AssetRipper/AssetRipper) | Inspects and exports Unity assets with the publisher's application. | Native |
| Tools → Rizin / Ghidra | [Cutter](https://github.com/rizinorg/cutter), [Rizin](https://github.com/rizinorg/rizin), [rz-ghidra](https://github.com/rizinorg/rz-ghidra) | Native binary inspection with the command-line tools and decompiler from the official Apple Silicon or Intel Cutter distribution. The launcher runs the command-line tool with a private configuration and the selected plugin, without the Cutter GUI or a separate Ghidra Java installation. See [Native binary inspection](NATIVE_INSPECTION.md). | Native |
| Tools → JADX | [JADX](https://github.com/skylot/jadx) | Exports Java-like source and resources from APK and DEX files. | Shared Temurin |
| Tools → Apktool | [Apktool](https://github.com/iBotPeaches/Apktool) | Decodes APK smali and resources with the standalone upstream JAR. | Shared Temurin |
| Flash → JPEXS FFDec | [JPEXS FFDec](https://github.com/jindrapetrik/jpexs-decompiler) | Exports Flash scripts and resources. | Shared Temurin |
| GemRB → Near Infinity | [Near Infinity](https://github.com/Argent77/NearInfinity) | Browses and edits Infinity Engine resources. | Shared Temurin |
| LÖVE → LJD | [LJD](https://github.com/dol/luajit-decompiler) | Recovers LuaJIT 2.0 and 2.1 bytecode. Refresh discovers upstream commit snapshots. | Included Python |
| LÖVE → unluac | [unluac](https://sourceforge.net/projects/unluac/) | Recovers standard Lua 5.0–5.4 bytecode with the official SourceForge JAR. | Shared Temurin |
| Siglus → Siglus SceneScript Utility | [Siglus SceneScript Utility](https://github.com/Jirehlov/SiglusSceneScriptUtility) | Recovers and disassembles Siglus scripts with the universal Python package. | Included Python |
| RealLive (RLVM) → RLdev | [RLdev Go edition](https://github.com/yoremi-trad-fr/rldev2026-go-edition) | Recovers RealLive scenarios with the portable Windows tool and its matching KFN definitions. | Private Windows environment |
| AliceSoft → Alice tools | [alice-tools](https://github.com/nunuhara/alice-tools) | Disassembles System 4 AIN files and extracts their text with the portable Windows tool. | Private Windows environment |
| AliceSoft → System1–3 source, System3.x source | [sys3dc](https://github.com/kichikuou/sys3c), [xsys35dc](https://github.com/kichikuou/xsys35c) | Decompiles System 1–3 and System 3.5–3.9 scenarios. They are delivered with the matching engine and tool packages. | Native |
| Tools → msg-tool | [msg-tool](https://github.com/lifegpc/msg-tool) | Exports BGI and FVP messages and inspects KiriKiri SimpleCrypt and TJS2 scripts. | Native |
| MAGES. → sc3tools | [sc3tools](https://github.com/CommitteeOfZero/sc3tools) | Exports SC3 messages from the Windows HD `sghd` edition. | Private Windows environment |
| Ikemen GO → SFF Tools | [openkakutou SFF](https://github.com/openkakutou/sff) | Exports supported SFF sprites with the matching upstream WebAssembly and Go runtime files, without a Go installation or Wine. | Private Node worker |
| WOLF RPG → WolfTL | [WolfTL](https://github.com/Sinflower/WolfTL) | Exports WOLF project data as JSON. | Private Windows environment |
| WOLF RPG → UberWolf | [UberWolf](https://github.com/Sinflower/UberWolf) | Extracts WOLF Pro archives. | Private Windows environment |
| HashLink → hlbc | [hlbc](https://github.com/Gui-Yom/hlbc) | Exports HashLink bytecode, opcodes and hlbc's decompiler pseudocode. | Private Windows environment |
| Godot → GDRE Tools | [GDRE Tools](https://github.com/GDRETools/gdsdecomp) | Recovers Godot projects, scripts and resources. | Native |
| GameMaker → GM8Decompiler, UMT | [GM8Decompiler](https://github.com/OpenGMK/OpenGMK), [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool) | Decompile Classic and Studio VM data. UMT also exports embedded texture pages and normal raster sprite frames. | Native |
| Java (Temurin) → Vineflower | [Vineflower](https://github.com/Vineflower/vineflower) | Decompiles Java classes. The Temurin LTS sections (8, 11, 17, 21 and 25) and the **Other** section manage the Java installations of games and tools. | Compatible Temurin |
| ScummVM → ScummVM Tools | [ScummVM Tools](https://github.com/scummvm/scummvm-tools) | Extracts archives with the published Intel Mac tools. | Native; Rosetta on Apple Silicon |
| mpv player | [mpv](https://mpv.io/) | The player also reads stream and container metadata without opening a window or playing audio. | Native |

## Included readers

MacLauncher includes the readers below, so they need no separate decompiler download. An extraction or compilation that relies on a runtime can still require the selected engine package.

| Reader | Game types and output | Scope |
| --- | --- | --- |
| Package and archive readers | Construct, Tyrano, Ren'Py, RPG Maker XP/VX/VX Ace, LÖVE and supported HTML and application layouts read stored members through their inspector actions. | Extraction keeps the stored bytes and does not reconstruct source from bytecode. Safe paths, format limits and supported encryption decide what is readable. |
| Ren'Py archive, configuration and save-metadata readers | Ren'Py: RPA and RPI metadata, literal configuration from source or compiled scripts, and save facts from ZIP and JSON. | Compiled configuration is read as inert records, without running pickle reducers or game Python. Save inspection does not deserialize the game's objects. unrpyc and UnRen reconstruct source from RPYC files separately. |
| Ruby Marshal and script-table readers | RPG Maker XP/VX/VX Ace: scripts, database and save records, and explicit repacking of edited scripts. | Supported Marshal types are read as data. Ruby classes and code are never run to recover unknown behavior. |
| LCF database and map readers | RPG Maker 2000/2003: project JSON, text and event records. | RPG Maker 2000/2003 records are engine data, not general-purpose source code. |
| WOLF archive reader | WOLF RPG Editor: member lists and supported asset extraction. | Pro and key variants need UberWolf. The reader does not guess unknown keys. |
| KIF cipher and CatScene, CSTL, FES and HG-3 readers | CatSystem2: decrypted archive members, typed script and transcript data, and supported lossless images. | The universal cipher helper is included. Only recognized key resources and layouts are decoded, and scripts are inspected, never run. |
| BGI, XP3, NScripter, MPK/SC3, NPA/NSS, HCB and AI5 metadata readers | BGI / Ethornell, KiriKiri, NScripter, MAGES., Nitroplus, FAVORITE / FVP and AI5WIN: archive and program metadata, and the script exports listed above. | Supported versions, encodings and encryption differ by engine. Message extraction, constant pools and original bytecode exports are kept separate from reconstructed source. |
| Android and iOS package readers | Android: manifest, resource, signing and native-library metadata from APKs. iOS: plist, bundle, entitlement, Mach-O and encryption metadata from IPAs. | Package inspection does not decompile native code, run app code or remove encryption. JADX, Apktool and Rizin / Ghidra are separate actions with their own downloaded tools. |
| PE, Mach-O, ELF and version readers | Unity, FNA, native and mobile game types, and engine detection: executable, assembly and architecture facts. | A product version reported by a file is not an engine or runtime version. Header inspection alone does not recover code. |
| Plain text | JavaScript, HTML, CSS and JSON in web games; VNDS scripts; Ikemen definitions; plain Lua, NSS, Ruby and KAG files. | These are readable without a decompiler. Minification, obfuscation and missing authoring data remain limits of the shipped files. |
