# GameMaker

This game type covers desktop games made with GameMaker, from Classic GM8.0/8.1 executables to GameMaker Studio games; browser exports are a separate game type, [GameMaker HTML5](GAMEMAKER_HTML5.md). Import accepts complete Windows or Linux game folders, main executables and data files. Because these forms run on different players, MacLauncher tells apart Classic executables, Studio VM bytecode, native or code-free Studio containers and existing macOS apps.

| Runtime | Plays |
| --- | --- |
| [Butterscotch](#butterscotch), default | Studio VM bytecode, WAD 8–17 |
| [OpenGMK](#classic-opengmk) | Classic GM8.0/8.1 executables |
| [Official GameMaker](#official-gamemaker) | Studio games whose bytecode matches an official vendor runner |
| [Game's macOS app](#games-macos-app) | The game's own macOS build |
| [Inspect only](#inspect-only) | Nothing; the tools stay available |
| [Sikarugir (Wine) and CrossOver](#crossover-and-sikarugir-wine) | Compatible Windows executables |

## Formats and version detection

### Studio

A Studio game keeps its code and resources in a data file, which detection examines structurally. It validates the `FORM` container, chunk lengths, `GEN8`, `STRG`, resource counts and code-entry offsets, so a file name such as `data.win` is not enough. The data file can be loose, next to the executable, in a root or `assets` folder, or in a macOS `Contents/Resources` layout. In a folder that contains several independent games, the selected data file identifies the game.

Several facts bear on a Studio game's version, and detection records them separately:

- The four-part `GEN8` tuple and its offset. Some exports keep placeholders such as `2.0.0.0`, so the tuple does not identify an exact official runner build. Compact WAD 8 has no tuple.
- The WAD or VM generation, which identifies the bytecode family.
- Structural version bounds: `SEQN` implies 2.3 or later, `FEAT` 2022.8 or later, and `UILR` 2024.13 or later.

Audio groups and embedded sprite sequences add further, independent bounds:

- GameMaker 2024.14 introduced `AGRP.Path`, so missing or null paths rule out 2024.14 and later runners. Together with `UILR`, this can narrow a game to `2024.13+ (before 2024.14)`.
- Embedded sequence headers grew from 32 to 40 bytes in 2024.13. To tell the two apart, a probe of at most 64 sprites and 64 KiB validates track names and offsets. A unique 32-byte layout then rules out 2024.13 and later, while a 40-byte layout requires it; absent or ambiguous layouts stay unresolved.

The structure definitions behind these bounds come from [UndertaleAudioGroup](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleAudioGroup.cs), [UndertaleSprite](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSprite.cs) and [UndertaleSequence](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSequence.cs).

| Official runtime generation | Format candidates | Constraints |
| --- | --- | --- |
| Studio 1.4 | WAD 16 | The selected Mac runner must support a usable 64-bit CPU architecture |
| Studio 2.0–<2.2 | Unresolved | No automatic VM format match |
| Studio 2.2–<2.3 | WAD 16 | Structural version bounds still apply |
| Studio 2.3+ | WAD 17 | Sprite sequences, audio groups and other resource bounds still apply |
| WAD 8–15 | No matching official runner | Butterscotch supports these VM generations |

A Studio archive whose CODE chunk is absent or empty is labeled `native-or-no-code`. Games compiled with YYC have no VM code, and the label covers them without assuming that every game without code is a YYC build.

### Classic

Classic GM8.0/8.1 games are Windows executables with their assets embedded. Detection identifies them from PE/i386 headers, loading-sequence signatures and asset offsets, which are read within fixed limits and include the newer encrypted GM8.1 header. Before running the game, OpenGMK parses those assets again on its own.

### Playback choices and metadata

The WAD generation and the native extension requirements decide which runtimes are offered, while the inspection tools work on the original data format. Windows PE file and product versions are kept as game metadata.

Which formats each player supports comes from the [official capability table](../../src/modules/gamemaker/runtime/official-compatibility.js), the [Butterscotch parser](https://github.com/ButterscotchRunner/Butterscotch/blob/d66464857303a2840a5cc5141c0035440847f441/src/data_win.c) and the [UndertaleModTool formats](https://github.com/UnderminersTeam/UndertaleModTool/tree/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib). This format support is kept separate from the records of individual runner builds.

## Decompilation and inspection

**Decompile** picks the native tool for the detected format and writes a separate export, which **Reveal latest export** opens. The **Advanced** group adds **Export inspection report** and **Export raw Studio chunks**. The tool versions are listed in **Runtimes → GameMaker**, which can also import local builds.

### Studio: UndertaleModTool

For Studio games, Decompile uses the [UndertaleModTool CLI](https://github.com/UnderminersTeam/UndertaleModTool), whose upstream releases MacLauncher lists together with their Mac architectures. Each download is checked against the publisher's digest or a recorded archive checksum. Decompilation first checks that the installed CLI starts and then runs `dump ... --code UMT_DUMP_ALL --strings`, and it requires actual GML output; unsafe or duplicate code file names make it fail.

**Export textures and sprites** uses the same tool, with `--textures --sprites`, to export embedded texture pages and padded normal sprite frames as PNG files. This also works for data without VM code, although vector and skeletal sprites are subject to the CLI's limits. YYC machine code is not decompiled, and the tool's C# scripting, repacking and replacement features are not used.

In **Runtimes → GameMaker → UMT**, Reload lists the Mac CLI assets of past UndertaleModTool releases with their tag commits. The nightly builds keep changing, so they are left out. A CLI download under another name, archive format or CPU label, including a universal build, is listed as well, and older assets without a CPU label are inspected at installation. Inside the archive, `UndertaleModCli` is found in whichever folder holds it. Publisher digests are verified when they are available; otherwise, the asset ID and the checksum of the first download are recorded for later checks. **Runtimes → GameMaker → UMT → Import local build…** registers a local UndertaleModTool CLI under its version and leaves its files in place.

### Classic: GM8Decompiler

For Classic games, Decompile uses GM8Decompiler. From an input of at most 128 MiB, it produces a separate `.gmk` or `.gm81` project, running with strict checks, preserved events, deobfuscation disabled and a single worker. MacLauncher Builds packages the decompiler and [builds it](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/README.md#native-decompiler-workspace) separately from the OpenGMK emulator.

[GM8Decompiler's historical releases](https://github.com/OpenGMK/GM8Decompiler/releases) publish only Windows binaries, which cannot be installed on a Mac. Matching native builds can, however, be registered explicitly.

### Reports and exports

An inspection report contains game metadata gathered without running the game, together with source hashes, and each game keeps one current `inspection.json`. A new report replaces older inspection directories that hold only a report, while chunk, source and image exports, and directories with added files, are kept. Raw Studio chunk exports preserve the payloads, absolute offsets and hashes; they are not rebuilt into images, audio, WAD files or editor projects. Each export uses a new per-game directory.

## Runtimes

### Butterscotch

[Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) is the default runtime and runs Studio VM bytecode. MacLauncher Builds packages it with AppKit, OpenGL, miniaudio and physics support for [WAD VM format versions 8 to 17](https://github.com/ButterscotchRunner/Butterscotch#game-compatibility). The runner receives the original data unchanged, and the data file's original folder is both its working directory and its default save location. An explicit save-folder override is passed to the runner as `--save-folder`, and the game data stays where it is.

#### Versions

Butterscotch has no tagged releases, so its versions are builds of its public main branch. In **Runtimes → GameMaker → Butterscotch**, the refresh control lists the newest successful [AppKit build](https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml), and **All versions** lists the five most recent successful runs whose downloads have not expired. Each listed build is identified by its date, source commit, CPU, artifact ID and publisher SHA-256, and the runner itself has no `--version` option. Archives are downloaded through [nightly.link](https://nightly.link/), so neither a GitHub account nor `gh` is needed.

When a run offers several artifacts, the AppKit artifact is preferred, and a renamed or universal Mac artifact is listed as well. Installation finds the executable in whichever folder of the archive holds it, reads its CPU and minimum macOS, and checks that its `--help` output lists `--save-folder` and `--renderer`. A build may include its own libraries; however, a build that loads a library found neither in macOS nor in its archive is not installed.

Public AppKit builds require macOS 26.0 or later. During Refresh, each build's command-line support and minimum macOS version are read from its source commit. Because these downloads expire on GitHub, an expired download needs a new Refresh, although installed copies are unaffected.

A matching local build can be registered with **Runtimes → GameMaker → Butterscotch → Import local build…**. The registration records the executable's checksum and the source it declares, while the executable stays in place and is left unchanged when the registration is removed.

#### Version selection and launch arguments

Game launch arguments are passed with the Mac package's `--game-arg` option, which preserves spaces and empty values. Not every build forwards them, so for a game with arguments the recommendation is the first build that does, and Play uses that build unless the game has an explicit version. An explicit version that cannot forward arguments reports that limitation instead.

Games without arguments follow the usual [version order](../runtimes/README.md#versions).

#### Save locations

Butterscotch and OpenGMK both keep the original game's save location. Import assigns a separate folder only when another game in the library uses the same effective save location, and an existing explicit save-folder override takes precedence over this. Assigning the separate folder leaves the game data, launch arguments and other runtime settings unchanged, and later launches keep using it.

### Classic (OpenGMK)

[OpenGMK](https://github.com/OpenGMK/OpenGMK) is the Classic runtime. It runs GM8.0/8.1 exports with native window controls and input, and when a game resizes its window programmatically, the native title controls and display bounds are kept. MacLauncher Builds packages it with AppKit windows and input, OpenGL 4.1 and CoreAudio. Each package contains the executable, native dependencies and notices, and its matching MacLauncher Builds release commit contains the exact upstream source, MacLauncher's patches and the build script. Runtimes lists each package's architectures and minimum macOS.

The publisher's own releases contain only Windows binaries, which is why **Runtimes** lists the MacLauncher Builds packages. OpenGMK needs no Wine. Before launch, a check parses the assets and extension declarations without running GML or loading DLLs.

OpenGMK reads original resources in place and runs from the original executable's folder. Working files, saves, settings and highscores therefore keep the engine's original paths, and ordinary Play creates no private writable folder or copy of the game. An explicit save-folder override is passed as `--working-directory`. The asset check before launch is reused within the same preparation and launch, but only while the source content and the selected runtime are unchanged.

#### Extensions and highscores

Classic games can declare Windows extension DLLs, and an extension that a game uses needs a native implementation on the Mac. For games that use the SuperSound extension, this is the **SuperSound string ABI**, which provides 22 symbols for mono and stereo WAV/Ogg decoding, playback, loops, pause and resume, frequency, DirectSound volume and pan, and byte-position, length and rate queries. Both of its load hints use resident decoding, limited to 64 MiB per file, 16 million samples per sound and 64 million samples in total, and initialization requires an active CoreAudio output callback. Missing symbols and mismatched types fail with an explicit error. Caster and other Windows extensions need their own native implementations, but unused DLLs next to the game do not block Play.

OpenGMK also provides the highscore API as the [Game Maker 8 manual](https://web.engr.oregonstate.edu/~mjb/gamemaker/gmaker80.pdf) defines it: a ten-place table with `highscore_value`, `highscore_name`, `highscore_add` and `highscore_clear`, persistent storage and length-limited names. How the Mac version is built is described in the [MacLauncher Builds notes for OpenGMK](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/README.md).

### Official GameMaker

**Official GameMaker** runs a Studio game with an official vendor runner, after format checks that run before anything is downloaded. Public runtime versions are kept apart from any separately recorded internal runner versions, and native extensions and external calls need matching Mac implementations. Because a bare Runner.app is an IDE helper, MacLauncher points it at the game data.

Official runtimes are downloaded from the vendor or imported from a local installation, and they are never taken from commercial games. Their redistribution with creator content is governed by the [Desktop runtime licence](https://gamemaker.io/en/legal/gamemaker-runtime-licence-gms2-desktop).

#### Version selection

To choose an official runner, MacLauncher filters the installed and published catalog entries by the game's detected bytecode and resource requirements. When the game provides format evidence, the recommendation is the first compatible installed runner. Runners are ranked first by the candidates specific to that format, such as those for WAD 16 and legacy sequence layouts, and then by version. Without format evidence, the recommendation is the first compatible listed runner.

An explicit per-game version is stored in `runtimeData["official-studio"].version` and takes priority over the global choice under `settings.runtimes["gamemaker-official"]`. Overrides stored under the older manager key remain readable.

#### Catalog and installation

**Runtimes → GameMaker → Official** installs vendor versions and imports local ones. The vendor publishes its runtimes in RSS feeds, whose runtime history is separate from the IDE history, and Reload reads the official Stable, LTS 2026, LTS 2022 and Studio 1.4 feeds. These tracks are described in the [release notes](https://releases.gamemaker.io/release-notes/2026/0), the [runtime feeds](https://manual.gamemaker.io/beta/en/Setting_Up_And_Version_Information/IDE_Preferences/Runtime_Feed_Preferences.htm) documentation and the historical [GMClan index](https://gms-updates.gmclan.org/). Downloads use official vendor URLs. If a release cannot be read, it is left out while the feed's other releases stay listed, and a channel that does not answer keeps its earlier list while the other channels refresh. A listed version that this Mac cannot install, such as one without a base module for its CPU, shows the reason.

Studio 2 runtimes are installed with Igor, the vendor's tool for installing runtime modules, which is described under Igor below. Installation obtains the selected native Igor, downloads the release's required Core, macOS, base and YYC modules and supplies them through a temporary loopback RSS feed. It then extracts the runner app, `YoYo Runner.app` or another app with a `Mac_Runner` executable, from a read-only DMG. No IDE installation or account credentials are needed. Package URLs, lengths and vendor signatures come from HTTPS feeds, and the hashes of downloaded packages are recorded and checked when the cache is reused. When YoYo Games replaces a package at the same address, the feed's new length and signature replace the earlier identity, and the package is downloaded again. The installation record keeps the hashes of the installed DMG, runner and app tree. Igor itself can report `Verification Inconclusive no manifest found`; that message is unrelated to MacLauncher's own checks of the downloads and installed files.

Studio 1.4 runtimes need neither Igor nor a CLR host. Installation takes the selected release from the [legacy update feed](https://store.yoyogames.com/downloads/gm-studio/update-studio.rss), and a Node ZipCrypto decoder with fixed limits extracts only `Mac/Mac-YoYoRunner.dmg` from it. The extracted runner must provide a supported 64-bit Mac architecture, and the hashes of its DMG, executable and app tree are recorded. The upstream versions are described in the [release notes](https://store.yoyogames.com/downloads/gm-studio/release-notes-studio.html).

A runtime that a GameMaker IDE has already installed can be imported instead. **Import installed runtime directory** accepts a complete `runtime-<four-part-version>` folder without downloading anything or invoking Igor; common IDE locations are `/Users/Shared/GameMakerStudio2/Cache/runtimes/` and `/Users/Shared/GameMakerStudio2-LTS/Cache/runtimes/`. Such a version directory contains `receipt.json`, `manifest/`, and `mac/Mac-YoYoRunner-Release.dmg` (or another runner disk image in `mac/`) or a complete Mac runner app. The detected and selected versions must agree. The imported files are not changed, and the installation records that they came from a local import.

#### Igor

Igor is needed only to install Studio 2 modules, not for ordinary runner launches, and **Install Igor** can also install it on its own. The public Igor comes from YoYo Games' `igor_osx-arm64.zip` or `igor_osx-x64.zip`, which the vendor replaces with newer builds at the same address. A download is accepted when it holds `Igor` and `Igor.dll` for the Mac's CPU, normally in `osx/<arm64|x64>/` but otherwise in another folder of the archive, and when its native `Igor` executable passes `codesign --verify --strict` against YoYo Games' Developer ID (team `C9E7J7HL3D`). These checks read the files without running them. The installed version is the file version in the fixed PE version resource of `Igor.dll`, not its .NET assembly placeholder `1.0.0`, and a differing product version is recorded. Each public installation is stored under its archive's SHA-256, together with its version and the hashes of every file in the Igor folder. As a result, earlier installations stay usable offline after the vendor replaces the download.

Installed vendor runtimes can also contain complete native Igor directories. These provide more local choices once they are validated from their DLL metadata, CPU, dependency manifests and file hashes. The chosen Igor persists independently of the game's runner version. If no chosen Igor is still present, the newest installed public Igor is used, or **Install Igor** downloads the current one. When the installed files no longer match their recorded hashes, Repair is available; repairing a public installation downloads the current public Igor.

#### Storage and launch

Global installations use `~/Library/Application Support/maclauncher/runtimes/gamemaker-official/`:

- Runners: `<runtime-version>/`.
- Public Igor: `tools/<archive-sha256>/osx/<arm64|x64>/Igor`, or the folder the archive uses.
- Local Igor: `tools/vendor-<tool-version>-<arch>/files/Igor`.
- Runtime package downloads: `artifacts/<runtime-version>/`.

The runner receives the original game data and uses its parent folder as the working directory. Where the runner saves depends on its bundle identifier, so import compares the selected runner's identifier with that of the original native game. When the identifiers match, the native save identity stays unchanged. When a shared runner replaces the original identity, saves use the original game's Application Support folder instead, so games with different original bundle identifiers keep separate save identities even when they use the same runner. Loose game data has no original Mac identifier; its saves use `saves/<gameId>/` inside the original game folder.

A save-identity collision with another library entry also selects a separate per-game folder. For an original Mac app, that folder is placed beside the app, outside its signed bundle. Existing explicit overrides remain unchanged, and if the selected runner's identity is unavailable, import leaves the direct launch unchanged.

Play uses the installed runner directly unless the game has a save-folder adjustment or graphics helper, because each of these needs a copy of the runner. An active software OpenGL helper requires a separately signed copy under the game's launcher data, and that copy keeps the vendor bundle identity. A selected save folder, by contrast, uses a separate runner identity and a bundle-ID alias to that folder. The alias identity includes the chosen destination. If an alias already exists and points elsewhere, it is kept, and the launch stops with an error. Runner copies use filesystem cloning where it is supported, the hashes of the source files and of the copied files are checked, and the installed vendor runtime stays unchanged. Forgetting the game removes only an alias that MacLauncher created. AppKit foreground activation runs asynchronously for the launched process and needs no System Events permission.

Private saves from MacLauncher 0.5.1 are recovered once into the matching current save folder. Existing files there stay unchanged, and a recovered file that differs is kept beside its counterpart under a conflict name. If the runner's identity is unavailable or the destination path is unsafe, the old files are not moved to a guessed folder; they stay where they are, and the reason is recorded.

Shared graphics follows the selected runner's verified CPU architecture, so legacy Intel runners use Intel graphics providers while native ARM and universal runners keep their selected native architecture.

#### Steam

Whether a game requires Steam is decided from its `GEN8` flags, function classifications and SteamAppID. For such a game, a matching native library from the game itself takes priority. Otherwise, runner **1.4.9999** uses the included universal **maclauncher-offline-abi-0.5.0-universal** helper, which is set up for the SteamClient017 interface once MacLauncher has checked that the runner and interface versions match. The helper keeps its configuration and state under the game's `official-steam/` directory and provides local initialization, callbacks, achievement state and opaque storage, as described in [Steam API support](../runtimes/STEAM_API.md#offline-steam-api-helper).

#### Software OpenGL

Official runners that draw through OpenGL can fall back to software rendering when hardware OpenGL is unavailable. For this, MacLauncher has a universal software OpenGL renderer, the graphics helper, which is a [MacLauncher Builds package](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers/gamemaker-opengl-helper). It is listed under **Runtimes → GameMaker → Graphics helper** and is installed together with an official runner that draws through OpenGL. Whether a runner does so is read from its executable, which links the OpenGL framework, so runners released after the helper use it as well. Installed helpers are checked for their archive, files, CPU, signature and minimum macOS.

Two Runtime Settings control the helper. **Graphics fallback** (**Automatic**, **Enabled** or **Disabled**) uses software rendering when hardware OpenGL is unavailable, and **Graphics helper** selects the helper version. Its **Use Runtimes selection** option uses the version chosen in **Runtimes** or the only compatible installed version; MacLauncher never picks a helper version itself. Installed versions v1 to v5 and local choices remain usable, with their source and file checks. Native hardware requests and system graphics settings are not changed.

The helper package names the runners that use logical coordinates (1.4.9999), while other runners keep AppKit's coordinates. On the 1.4.9999 software path, the helper versions differ: V3 uses logical coordinates only for `YYGLView`, V4 uses weak view and context caches, and V5 ties the surface preference to context attachment. The helper affects only the game's copy of the runner, and the vendor app and system libraries stay unchanged. [Native tool setup](../runtimes/NATIVE_TOOL_SETUP.md#gamemaker-software-opengl) describes the helper's build inputs and commands.

### Game's macOS app

A game that already ships a native macOS app can keep using it through **Game's macOS app**.

### Inspect only

**Inspect only** is the choice for formats without a compatible player. It disables Play and Shortcut but keeps the tools available.

### CrossOver and Sikarugir (Wine)

Windows executables, including Classic games, can also play through [Sikarugir (Wine) or CrossOver](WINDOWS.md#windows-executables-in-other-game-types).

## Licenses

[Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), [OpenGMK](https://github.com/OpenGMK/OpenGMK), [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool) and [Underanalyzer](https://github.com/UnderminersTeam/Underanalyzer) are licensed under AGPL-3.0, GPL-2.0, GPL-3.0 and MPL-2.0 respectively.
