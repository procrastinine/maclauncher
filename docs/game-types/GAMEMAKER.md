# GameMaker

This game type covers desktop games made with GameMaker, from Classic GM8.0/8.1 executables to GameMaker Studio games. Import accepts complete Windows or Linux game folders, main executables and data files. MacLauncher tells apart Classic executables, Studio VM bytecode, native or code-free Studio containers and existing macOS apps. Browser exports are a separate game type, [GameMaker HTML5](GAMEMAKER_HTML5.md).

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

Studio detection validates the `FORM` container, chunk lengths, `GEN8`, `STRG`, resource counts and code-entry offsets. A file name such as `data.win` is not enough. Loose data files, data next to the executable, root and `assets` folders, and macOS `Contents/Resources` layouts are supported. In a folder containing several independent games, the selected data file identifies the game.

Version detection records these facts separately:

- The four-part `GEN8` tuple and its offset. Some exports keep placeholders such as `2.0.0.0`, so the tuple does not identify an exact official runner build. Compact WAD 8 has no tuple.
- The WAD or VM generation, which identifies the bytecode family.
- Structural version bounds: `SEQN` implies 2.3 or later, `FEAT` 2022.8 or later, and `UILR` 2024.13 or later.

Audio groups and embedded sprite sequences add further, independent bounds:

- GameMaker 2024.14 introduced `AGRP.Path`, so missing or null paths rule out 2024.14 and later runners. Together with `UILR`, this can narrow a game to `2024.13+ (before 2024.14)`.
- Embedded sequence headers grew from 32 to 40 bytes in 2024.13. A probe of at most 64 sprites and 64 KiB validates track names and offsets. A unique 32-byte layout rules out 2024.13 and later, while a 40-byte layout requires it. Absent or ambiguous layouts stay unresolved.

These definitions come from [UndertaleAudioGroup](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleAudioGroup.cs), [UndertaleSprite](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSprite.cs) and [UndertaleSequence](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSequence.cs).

| Official runtime generation | Format candidates | Constraints |
| --- | --- | --- |
| Studio 1.4 | WAD 16 | The selected Mac runner must support a usable 64-bit CPU architecture |
| Studio 2.0–<2.2 | Unresolved | No automatic VM format match |
| Studio 2.2–<2.3 | WAD 16 | Structural version bounds still apply |
| Studio 2.3+ | WAD 17 | Sprite sequences, audio groups and other resource bounds still apply |
| WAD 8–15 | No matching official runner | Butterscotch supports these VM generations |

Studio archives whose CODE chunk is absent or empty are labeled `native-or-no-code`. The label covers games compiled with YYC without assuming that every game without code is a YYC build.

### Classic

Classic GM8.0/8.1 detection uses PE/i386 headers, loading-sequence signatures and asset offsets read within fixed limits, including the newer encrypted GM8.1 header. OpenGMK parses those assets again on its own before running the game.

### Playback choices and metadata

The WAD generation and the native extension requirements decide which runtimes are offered, while the inspection tools work on the original data format. Windows PE file and product versions are kept as game metadata.

Format support is defined by the [official capability table](../../src/modules/gamemaker/runtime/official-compatibility.js), the [Butterscotch parser](https://github.com/ButterscotchRunner/Butterscotch/blob/d66464857303a2840a5cc5141c0035440847f441/src/data_win.c) and the [UndertaleModTool formats](https://github.com/UnderminersTeam/UndertaleModTool/tree/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib), and is kept separate from the records of individual runner builds.

## Decompilation and inspection

**Decompile** picks the native tool for the detected format and writes a separate export, which **Reveal latest export** opens. The **Advanced** group adds **Export inspection report** and **Export raw Studio chunks**, and **Runtimes → GameMaker** lists the tool versions and imports local builds.

### Studio: UndertaleModTool

For Studio games, Decompile uses the [UndertaleModTool CLI](https://github.com/UnderminersTeam/UndertaleModTool). MacLauncher lists its upstream releases and their Mac architectures, and checks each download against the publisher's digest or a recorded archive checksum. Decompilation first checks that the installed CLI starts, then runs `dump ... --code UMT_DUMP_ALL --strings` and requires actual GML output. Unsafe or duplicate code file names make it fail.

**Export textures and sprites** uses the same tool with `--textures --sprites` to export embedded texture pages and padded normal sprite frames as PNG files, also from data without VM code. Vector and skeletal sprites are subject to the CLI's limits. YYC machine code is not decompiled, and the tool's C# scripting, repacking and replacement features are not used.

**Runtimes → GameMaker → UMT → Import local build…** registers a local UndertaleModTool CLI under its version and leaves its files in place. Reload lists the Mac UMT CLI assets of past releases with their tag commits, and leaves out the nightly builds, which keep changing. Older assets without a CPU label are inspected at installation. A CLI download under another name, archive format or CPU label, including a universal build, is listed as well, and `UndertaleModCli` is found in a folder inside the archive. Publisher digests are verified when available; otherwise, the asset ID and the checksum of the first download are recorded for later checks.

### Classic: GM8Decompiler

For Classic games, Decompile uses GM8Decompiler, packaged by MacLauncher Builds. It runs with strict checks, preserved events, deobfuscation disabled and a single worker, and produces a separate `.gmk` or `.gm81` project from an input of at most 128 MiB. MacLauncher Builds [builds the decompiler](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/README.md#native-decompiler-workspace) separately from the OpenGMK emulator.

[GM8Decompiler's historical releases](https://github.com/OpenGMK/GM8Decompiler/releases) publish only Windows binaries and cannot be installed on a Mac. Matching native builds can be registered explicitly.

### Reports and exports

Inspection reports contain game metadata gathered without running the game, plus source hashes. Each game keeps one current `inspection.json`. A new report replaces older report-only inspection directories; chunk, source and image exports, and directories with added files, are kept. Raw Studio chunk exports preserve the payloads, absolute offsets and hashes, and are not rebuilt into images, audio, WAD files or editor projects. Each export uses a new per-game directory.

## Runtimes

### Butterscotch

[Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) is the default runtime and runs Studio VM bytecode. MacLauncher Builds packages it with AppKit, OpenGL, miniaudio and physics support for the [WAD 8–17 VM formats](https://github.com/ButterscotchRunner/Butterscotch#game-compatibility). The original data is passed to the runner unchanged. The working directory and default save location are the data file's original folder. An explicit save-folder override supplies `--save-folder` without moving the game data.

#### Versions

In **Runtimes → GameMaker → Butterscotch**, the refresh control lists the newest successful public main-branch [AppKit build](https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml). **All versions** lists the five most recent successful runs whose downloads have not expired. Each listed build is identified by its date, source commit, CPU, artifact ID and publisher SHA-256. Archives download through [nightly.link](https://nightly.link/) without a GitHub account or `gh`. Butterscotch has no tagged releases and no `--version` option.

A renamed or universal Mac artifact is listed as well, and the AppKit artifact is preferred when a run offers several. Installation reads the CPU and minimum macOS from the downloaded executable, checks that its `--help` output lists `--save-folder` and `--renderer`, and finds the executable in a folder inside the archive. A build may include its own libraries, but one that loads a library found neither in macOS nor in its archive is not installed.

Public AppKit builds require macOS 26.0 or later. Refresh reads command-line support and the minimum macOS version from each build's source commit. A download that has expired on GitHub needs a new Refresh; installed copies are unaffected.

**Runtimes → GameMaker → Butterscotch → Import local build…** registers a matching local build. The executable stays in place, and removing the registration leaves it unchanged. A registration records the executable's checksum and the source it declares.

#### Version selection and launch arguments

Game launch arguments use the Mac package's `--game-arg` option, which preserves spaces and empty values. For a game with arguments, the recommendation is the first build that forwards them, and Play uses that build unless the game has an explicit version. An explicit version that cannot forward arguments reports that limitation.

Games without arguments follow the usual [version order](../runtimes/README.md#versions).

#### Save locations

Butterscotch and OpenGMK keep the original game's save location. Import assigns a separate folder only when another library game uses the same effective save location. Existing explicit save-folder overrides take precedence. Assigning the folder leaves the game data, launch arguments and other runtime settings unchanged, and later launches keep using it.

### Classic (OpenGMK)

[OpenGMK](https://github.com/OpenGMK/OpenGMK) is the Classic runtime. It runs GM8.0/8.1 exports with native window controls and input, and programmatic resizing keeps the native title controls and display bounds. MacLauncher Builds packages it with AppKit windows and input, OpenGL 4.1 and CoreAudio, and Runtimes lists each package's architectures and minimum macOS. The matching MacLauncher Builds release commit contains the exact upstream source, MacLauncher's patches and the build script; the package contains the executable, native dependencies and notices.

OpenGMK needs no Wine, and before launch a check parses the assets and extension declarations without running GML or loading DLLs. The publisher's own releases contain only Windows binaries, so **Runtimes** lists the MacLauncher Builds packages.

Original resources are read in place. The interpreter runs from the original executable's folder, and working files, saves, settings and highscores keep the engine's original paths. An explicit save-folder override supplies `--working-directory`; ordinary Play creates no private writable folder or copy of the game. The asset check before launch is reused within the same preparation and launch only while the source content and the selected runtime are unchanged.

#### Extensions and highscores

For games that use the SuperSound extension, the **SuperSound string ABI** provides 22 symbols for mono and stereo WAV/Ogg decoding, playback, loops, pause and resume, frequency, DirectSound volume and pan, and byte-position, length and rate queries. Both load hints use resident decoding, limited to 64 MiB per file, 16 million samples per sound and 64 million samples in total, and initialization requires an active CoreAudio output callback. Missing symbols and mismatched types fail with an explicit error. Caster and other Windows extensions need their own native implementations; unused DLLs next to the game do not block Play.

The highscore API, as defined in the [Game Maker 8 manual](https://web.engr.oregonstate.edu/~mjb/gamemaker/gmaker80.pdf), provides a ten-place table with `highscore_value`, `highscore_name`, `highscore_add` and `highscore_clear`, persistent storage and length-limited names. The [MacLauncher Builds notes for OpenGMK](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/README.md) describe how the Mac version is built.

### Official GameMaker

**Official GameMaker** runs a Studio game with an official vendor runner, after format checks that run before any download. Public runtime versions are kept apart from any separately recorded internal runner versions, and native extensions and external calls need matching Mac implementations. Because a bare Runner.app is an IDE helper, MacLauncher points it at the game data.

MacLauncher downloads official runtimes from the vendor or imports a local installation, and never takes them from commercial games. The [Desktop runtime licence](https://gamemaker.io/en/legal/gamemaker-runtime-licence-gms2-desktop) governs redistribution with creator content.

#### Version selection

Official selection filters the installed and published catalog rows by the detected bytecode and resource requirements. When the game provides format evidence, its recommendation is the first compatible installed runner, ranked first by the runner candidates specific to that format, such as those for WAD 16 and legacy sequence layouts, and then by version. Without format evidence, the recommendation is the first compatible listed runner.

An explicit per-game version is stored in `runtimeData["official-studio"].version` and takes priority over the global choice under `settings.runtimes["gamemaker-official"]`. Overrides stored under the older manager key remain readable.

#### Catalog and installation

**Runtimes → GameMaker → Official** installs vendor versions and imports local ones. Reload reads the official Stable, LTS 2026, LTS 2022 and Studio 1.4 RSS feeds, whose runtime history is separate from the IDE history. The [release notes](https://releases.gamemaker.io/release-notes/2026/0), [runtime feeds](https://manual.gamemaker.io/beta/en/Setting_Up_And_Version_Information/IDE_Preferences/Runtime_Feed_Preferences.htm) and the historical [GMClan index](https://gms-updates.gmclan.org/) describe these tracks. Downloads use official vendor URLs. A release that cannot be read is left out while the feed's other releases stay listed, and a channel that does not answer keeps its earlier list while the other channels refresh. A listed version this Mac cannot install, such as one without a base module for its CPU, shows the reason.

For Studio 2 runtimes, installation obtains the selected native Igor tool, downloads the release's required Core, macOS, base and YYC modules, supplies them through a temporary loopback RSS feed and extracts the runner app, `YoYo Runner.app` or another app with a `Mac_Runner` executable, from a read-only DMG. No IDE installation or account credentials are needed. Package URLs, lengths and vendor signatures come from HTTPS feeds. Downloaded package hashes are recorded and checked when the cache is reused. When YoYo Games replaces a package at the same address, the feed's new length and signature replace the earlier identity and the package downloads again. The installation record keeps the hashes of the installed DMG, runner and app tree. Igor can report `Verification Inconclusive no manifest found`; that message is unrelated to MacLauncher's own checks of the downloads and installed files.

Studio 1.4 installation uses the selected release from the [legacy update feed](https://store.yoyogames.com/downloads/gm-studio/update-studio.rss), without Igor or a CLR host. A Node ZipCrypto decoder with fixed limits extracts only `Mac/Mac-YoYoRunner.dmg`. The extracted runner must provide a supported 64-bit Mac architecture, and its DMG, executable and app-tree hashes are recorded. The [release notes](https://store.yoyogames.com/downloads/gm-studio/release-notes-studio.html) describe the upstream versions.

**Import installed runtime directory** accepts a complete `runtime-<four-part-version>` folder without downloading anything or invoking Igor. Common IDE locations are `/Users/Shared/GameMakerStudio2/Cache/runtimes/` and `/Users/Shared/GameMakerStudio2-LTS/Cache/runtimes/`. The version directory contains `receipt.json`, `manifest/`, and `mac/Mac-YoYoRunner-Release.dmg` (or another runner disk image in `mac/`) or a complete Mac runner app. The detected and selected versions must agree. The imported files are not changed, and the installation records that they came from a local import.

#### Igor

Igor installs Studio 2 modules and is not needed for ordinary runner launches. **Install Igor** also works on its own. The public Igor comes from YoYo Games' `igor_osx-arm64.zip` or `igor_osx-x64.zip`, which the vendor replaces with newer builds at the same address. A download is accepted when it holds `Igor` and `Igor.dll` for the Mac's CPU, normally in `osx/<arm64|x64>/` and otherwise found in another folder of the archive, and its native `Igor` executable passes `codesign --verify --strict` against YoYo Games' Developer ID (team `C9E7J7HL3D`). These checks read the files without running them. The installed version is the file version in the fixed PE version resource of `Igor.dll`, not its .NET assembly placeholder `1.0.0`; a differing product version is recorded. Each public installation is stored under its archive's SHA-256 together with its version and the hashes of every file in the Igor folder, so earlier installations stay usable offline after the vendor replaces the download.

Complete native Igor directories inside installed vendor runtimes provide more local choices, validated from their DLL metadata, CPU, dependency manifests and file hashes. The chosen Igor persists independently of the game's runner version. Without a chosen Igor that is still present, the newest installed public Igor is used, or **Install Igor** downloads the current one. Repair is available when the installed files no longer match their recorded hashes; repairing a public installation downloads the current public Igor.

#### Storage and launch

Global installations use `~/Library/Application Support/maclauncher/runtimes/gamemaker-official/`:

- Runners: `<runtime-version>/`.
- Public Igor: `tools/<archive-sha256>/osx/<arm64|x64>/Igor`, or the folder the archive uses.
- Local Igor: `tools/vendor-<tool-version>-<arch>/files/Igor`.
- Runtime package downloads: `artifacts/<runtime-version>/`.

The runner receives the original game data and uses its parent folder as the working directory. Import compares the selected runner's bundle identifier with the original native game's identifier. When the identifiers match, the native save identity stays unchanged. When a shared runner replaces the original identity, saves use the original game's Application Support folder. Different original bundle identifiers retain separate save identities even with the same selected runner. For loose game data without an original Mac identifier, saves use `saves/<gameId>/` inside the original game folder. A save-identity collision with another library entry also selects a separate per-game folder. For an original Mac app, that folder stays beside the app, outside its signed bundle. Existing explicit overrides remain unchanged. If the selected runner's identity is unavailable, import leaves the direct launch unchanged.

Without a save-folder adjustment or graphics helper, Play uses the installed runner directly. An active software OpenGL helper requires a separately signed copy under the game's launcher data and preserves the vendor bundle identity. A selected save folder uses a separate runner identity and a bundle-ID alias to that folder. The alias identity includes the chosen destination; an existing alias that points elsewhere is kept, and the launch stops with an error. Runner copies use filesystem cloning where supported, their source and staged file hashes are checked, and the installed vendor runtime stays unchanged. Forgetting the game removes only an alias MacLauncher created. AppKit foreground activation runs asynchronously for the launched process and needs no System Events permission.

Private saves from MacLauncher 0.5.1 are recovered once into the matching current save folder. Existing files there stay unchanged, and a recovered file that differs is kept beside it under a conflict name. When the runner's identity is unavailable or the destination path is unsafe, the old files stay where they are and the reason is recorded, rather than being moved to a guessed folder.

Shared graphics follows the selected runner's verified CPU architecture, so legacy Intel runners use Intel graphics providers while native ARM and universal runners keep their selected native architecture.

#### Steam

Whether a game requires Steam is decided from its `GEN8` flags, function classifications and SteamAppID. A matching native library from the game takes priority. Runner **1.4.9999** uses the included universal **maclauncher-offline-abi-0.5.0-universal** helper, which is set up for the SteamClient017 interface once MacLauncher has checked that the runner and interface versions match. The helper keeps its configuration and state under the game's `official-steam/` directory and provides local initialization, callbacks, achievement state and opaque storage, as described in [Steam API support](../runtimes/STEAM_API.md#offline-steam-api-helper).

#### Software OpenGL

MacLauncher's universal software OpenGL renderer is a [MacLauncher Builds package](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers/gamemaker-opengl-helper), listed under **Runtimes → GameMaker → Graphics helper** and installed with an official runner that draws through OpenGL. Whether a runner draws through OpenGL is read from its executable, which links the OpenGL framework, so runners released after the helper use it as well. Installed helpers are checked for their archive, files, CPU, signature and minimum macOS.

Runtime Settings provide **Graphics fallback** (**Automatic**, **Enabled** or **Disabled**), which uses software rendering when hardware OpenGL is unavailable, and **Graphics helper**. **Use Runtimes selection** uses the version chosen in **Runtimes** or the only compatible installed version; MacLauncher never picks a helper version itself. Installed versions v1–v5 and local choices remain usable, with their source and file checks. Native hardware requests and system graphics settings are not changed.

The helper package names the runners that use logical coordinates (1.4.9999); other runners keep AppKit's coordinates. For the 1.4.9999 software path, V3 uses logical coordinates only for `YYGLView`, V4 uses weak view and context caches, and V5 ties the surface preference to context attachment. The helper affects only the game's copy of the runner; the vendor app and system libraries stay unchanged. [Native tool setup](../runtimes/NATIVE_TOOL_SETUP.md#gamemaker-software-opengl) describes the helper's build inputs and commands.

### Game's macOS app

A game that already ships a native macOS app can keep using it through **Game's macOS app**.

### Inspect only

**Inspect only**, the choice for formats without a compatible player, disables Play and Shortcut and keeps the tools.

### CrossOver and Sikarugir (Wine)

Windows executables, including Classic games, can also play through [Sikarugir (Wine) or CrossOver](WINDOWS.md#windows-executables-in-other-game-types).

## Licenses

[Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), [OpenGMK](https://github.com/OpenGMK/OpenGMK), [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool) and [Underanalyzer](https://github.com/UnderminersTeam/Underanalyzer) are licensed under AGPL-3.0, GPL-2.0, GPL-3.0 and MPL-2.0 respectively.
