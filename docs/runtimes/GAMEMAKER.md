# GameMaker

Import accepts complete Windows/Linux game folders, main executables and data files. MacLauncher distinguishes Classic executables, Studio VM bytecode, native/code-free containers and existing macOS apps. Detection and inspection are offline; Play selects a compatible runtime and asks before a required download.

## Formats and version selection

Studio detection validates `FORM`, chunk lengths, `GEN8`, `STRG`, resource counts and code-entry offsets. A filename such as `data.win` is insufficient. Loose data, adjacent executables, root/assets folders and macOS `Contents/Resources` layouts are supported. A selected data file identifies the game in a folder containing several independent games.

Version detection preserves separate facts:

- The four-part `GEN8` tuple and its offset. Some exports retain placeholders such as `2.0.0.0`; this tuple does not identify an exact official runner build. Compact WAD 8 has no tuple.
- WAD/VM generation, which identifies the bytecode family.
- Structural version bounds: `SEQN` implies 2.3+, `FEAT` 2022.8+, and `UILR` 2024.13+.

Audio groups and embedded sprite sequences add independent bounds. GameMaker 2024.14 introduced `AGRP.Path`; missing/null paths reject 2024.14+ runners. Together with `UILR`, this can identify `2024.13–<2024.14`. Embedded sequence headers expanded from 32 to 40 bytes in 2024.13. A bounded probe of at most 64 sprites and 64 KiB validates track names and offsets: a unique 32-byte layout excludes 2024.13+, while a 40-byte layout requires it. Absent or ambiguous layouts remain unresolved. Definitions come from [UndertaleAudioGroup](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleAudioGroup.cs), [UndertaleSprite](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSprite.cs) and [UndertaleSequence](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSequence.cs).

| Official runtime generation | Format candidates | Constraints |
| --- | --- | --- |
| Studio 1.4 | WAD 16 | The selected Mac runner must support a usable 64-bit CPU architecture |
| Studio 2.0–<2.2 | Unresolved | No automatic VM format match |
| Studio 2.2–<2.3 | WAD 16 | Structural version bounds still apply |
| Studio 2.3+ | WAD 17 | Sprite sequences, audio groups and other resource bounds still apply |
| WAD 8–15 | No matching managed official runner | Butterscotch supports these VM generations |

Shared graphics follows the selected official runner's verified CPU architecture. Legacy Intel runners use Intel graphics providers, while native ARM and universal runners retain their selected native architecture.

Official selection filters installed and published catalog rows by the detected bytecode and resource requirements. When the game provides format evidence, its recommendation is the first compatible installed runner, ranked by the format's specific runner candidates, such as those for WAD 16 and legacy sequence layouts, and then by version; otherwise it is the first compatible listed runner. The game's explicit version comes first, followed by the game recommendation and the runtime default. A saved default takes precedence over the manager default: the newest compatible stable listed runner, or the newest ready installed runner when none is listed. Clearing a saved default restores the manager default. Cold Play requests consent before discovering releases or downloading.

An explicit per-game version in `runtimeData["official-studio"].version` takes priority, followed by the global choice under `settings.runtimes["gamemaker-official"]`. Both remain exact when missing or incompatible, with an explanation of the unmet requirement. Older manager-key overrides remain readable.

Classic GM8.0/8.1 detection uses PE/i386 headers, loading-sequence signatures and bounded asset offsets, including the newer encrypted GM8.1 header. OpenGMK separately parses those assets before execution. Studio archives with absent or empty CODE are labeled `native-or-no-code`, covering YYC possibilities without treating every code-free game as YYC. WAD generation and native extension requirements determine the available playback entries; inspection tools use the original data format. Windows PE file/product versions remain game metadata.

The [official capability table](../../src/modules/gamemaker/runtime/official-compatibility.js), pinned [Butterscotch parser](https://github.com/ButterscotchRunner/Butterscotch/blob/d66464857303a2840a5cc5141c0035440847f441/src/data_win.c) and [UndertaleModTool formats](https://github.com/UnderminersTeam/UndertaleModTool/tree/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib) keep format support separate from exact runner identities.

## Classic (OpenGMK)

[OpenGMK](https://github.com/OpenGMK/OpenGMK) is the Classic runtime. MacLauncher Builds packages it with AppKit windows/input, OpenGL 4.1 and CoreAudio; Runtimes lists each package's architectures and minimum macOS.

The matching MacLauncher Builds release commit contains the pinned source, patches and build recipe. The managed package contains the executable, native dependencies and notices.

**OpenGMK** selects the Classic interpreter. Play downloads a missing selected package from MacLauncher Builds after consent; installed copies work offline without a compiler or Wine. Preflight parses assets and extension declarations without running GML or loading DLLs. MacLauncher Builds downloads and upstream source history have separate controls; earlier installed versions remain selectable.

OpenGMK runs GM8.0/8.1 exports with native window controls and input. Programmatic resizing preserves native title controls and display bounds.

Original resources are read in place. Working files, saves, settings and highscores use `userData/games/<gameId>/modules/gamemaker/classic/writable/`. Append/read-write copies only the affected file.

The **SuperSound string ABI** implements 22 symbols for mono/stereo WAV/Ogg decoding, playback, loops, pause/resume, frequency, DirectSound volume/pan and byte-position/length/rate queries. Both load hints use resident decoding. Limits are 64 MiB per file, 16 million samples per sound and 64 million samples total. Initialization requires an active CoreAudio output callback. Missing symbols and mismatched types fail explicitly. Caster and other Windows extensions require separate native implementations; adjacent unused DLLs do not block Play.

The highscore API supplies a ten-place table, `highscore_value`, `highscore_name`, `highscore_add` and `highscore_clear`, with private persistence and bounded names. The [Game Maker 8 manual](https://web.engr.oregonstate.edu/~mjb/gamemaker/gmaker80.pdf) defines these APIs. The [Mac overlay guide](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/README.md) documents the source/build contract.

## Butterscotch Studio

MacLauncher Builds packages [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) with an AppKit/OpenGL/miniaudio/physics profile that supports [WAD 8–17 VM formats](https://github.com/ButterscotchRunner/Butterscotch#game-compatibility).

**Butterscotch Studio** selects the Studio VM runner. A missing selected build follows the normal runtime installation prompt, downloads automatically and continues. Installed builds work offline. Original data is passed to the runner unchanged; saves use `userData/games/<gameId>/modules/gamemaker/saves/`.

Game launch arguments use the managed Mac package's `--game-arg` support, preserving spaces and empty values. When arguments are set, the game's recommendation is the first build that forwards them, and Play uses it unless the game has an explicit version; an explicit version without argument forwarding reports that limit. Without arguments, Play follows the game's version, then the runtime default. A saved default takes precedence over the newest compatible stable listed build; when none is listed, the manager default is the newest ready installed build.

The refresh control lists the newest successful public main-branch [AppKit build](https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml). **All versions** lists the five most recent successful runs with unexpired downloads. Both actions replace discovered versions. Its date, exact source commit, CPU, artifact ID and publisher SHA-256 identify the snapshot; archives download through [nightly.link](https://nightly.link/) without a GitHub account or `gh`. Public AppKit builds require macOS 26.0 or later. Refresh derives command-line support and the macOS floor from each artifact’s exact source commit. Play uses the runtime default: a saved default takes precedence over the newest compatible listed build, or the newest ready installed build when none is listed. A missing selected build downloads after consent. Games with launch arguments require a declared game-argument transport and retain the compatible build recommendation for that transport. Other games use generic compatible version ordering. Explicit global and per-game versions remain selected. Expired downloads require Refresh; installed copies remain usable. Butterscotch has no tagged releases or `--version` option.

Binary downloads and playback need no compiler. **Runtimes → GameMaker → Butterscotch → Import local build…** registers a matching local build. The original executable remains in place; removing its registration leaves it unchanged. Local registrations retain their checksum and declared source identity.

## Decompilation and inspection

**Inspect only** disables Play/Shortcut while retaining tools. **Decompile** selects the native tool for the detected format, confirms any missing download, installs the exact selected version and continues with a separate export. Installed tools work offline. **Reveal latest export** opens it. **Advanced** provides an inspection report for the game and raw Studio chunk exports. Runtime versions, installation and local imports belong in **Runtimes → GameMaker**. Play and Decompile prepare their selected runtime or tool automatically after any required download consent.

- **Studio:** [UndertaleModTool CLI](https://github.com/UnderminersTeam/UndertaleModTool) discovers exact upstream releases and their Mac architecture choices. Publisher digests or recorded archive checksums protect installation and offline reuse. Decompilation invokes `dump ... --code UMT_DUMP_ALL --strings`, checks its reported version/revision and requires actual GML output. Unsafe/duplicate code filenames fail. **Export textures and sprites** uses the same managed tool with `--textures --sprites` to export embedded texture pages and padded normal sprite frames as PNGs, including data without VM code. Vector and skeletal sprites retain the CLI's limits. No YYC machine code, C# scripting, repack or replacement is performed.
- **Classic:** GM8Decompiler uses managed MacLauncher Builds records and their exact source identities. Its selected native executable installs automatically after consent. Strict checks, preserved events, disabled deobfuscation and one worker produce a separate `.gmk`/`.gm81` project. Inputs are limited to 128 MiB. The [workspace overlay](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/README.md#native-decompiler-workspace) builds this tool separately from the emulator.

**Runtimes → GameMaker → UMT → Import local build…** registers a local UndertaleModTool CLI against its matching version. The original files remain in place. Reload lists historical Mac UMT CLI assets with exact tag commits, excluding moving nightlies. Older assets without a CPU label are inspected at installation. Publisher digests are verified when available; otherwise the asset ID and first-download checksum record local integrity. [GM8Decompiler's historical releases](https://github.com/OpenGMK/GM8Decompiler/releases) publish Windows binaries and remain unavailable for Mac installation; matching native builds can be registered explicitly.

Inspection reports contain non-executing game metadata and source hashes. Each game keeps one current `inspection.json`; a new report replaces older report-only inspection directories, while chunk, source and image exports and directories containing added files remain. Raw Studio chunk exports preserve payloads, absolute offsets and hashes; they are not rebuilt images/audio, WADs or editor projects. Exports use fresh per-game directories and preserve original archives. [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), [OpenGMK](https://github.com/OpenGMK/OpenGMK), [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool) and [Underanalyzer](https://github.com/UnderminersTeam/Underanalyzer) retain AGPL-3.0, GPL-2.0, GPL-3.0 and MPL-2.0 terms respectively.

## Official Studio runtimes and Igor

**Runtimes → GameMaker → Official** provides exact vendor-version installation and local import. Reload reads the official Stable, LTS 2026, LTS 2022 and Studio 1.4 RSS feeds and replaces the cached release list; runtime history is separate from IDE history. Failed refresh preserves the previous catalog. [Release notes](https://releases.gamemaker.io/release-notes/2026/0), [runtime feeds](https://manual.gamemaker.io/beta/en/Setting_Up_And_Version_Information/IDE_Preferences/Runtime_Feed_Preferences.htm) and the historical [GMClan index](https://gms-updates.gmclan.org/) describe these tracks; managed downloads use official vendor URLs.

Studio 2 installation automatically obtains the selected native Igor tool, downloads the release's required Core/macOS/base/YYC modules, supplies them through a temporary loopback RSS feed and extracts the runner from a read-only DMG. No IDE installation or account credentials are required for this flow. Package URLs, lengths and vendor signatures come from HTTPS feeds. Downloaded package hashes are recorded and checked during cache reuse; installed DMG, runner and app-tree identities remain in the receipt. Igor can report `Verification Inconclusive no manifest found`; that state remains distinct from the launcher's own archive and payload checks.

Studio 1.4 installation uses its selected release from the [legacy update feed](https://store.yoyogames.com/downloads/gm-studio/update-studio.rss), without Igor or a CLR host. Bounded Node ZipCrypto decoding extracts only `Mac/Mac-YoYoRunner.dmg`. The extracted runner must provide a supported 64-bit Mac architecture; its DMG, executable and app-tree hashes are recorded for offline reuse. The [release notes](https://store.yoyogames.com/downloads/gm-studio/release-notes-studio.html) describe the upstream versions.

**Install Igor** also works independently. The public bootstrap supplies **2024.0.0.32**, read from `Igor.dll`'s fixed PE version. Its .NET assembly placeholder `1.0.0` and archive checksum are separate values. Complete native Igor directories in installed vendor runtimes provide additional local choices, validated from their DLL metadata, CPU, dependency manifests and file hashes. The chosen Igor persists independently of the game runner version. Repair is available when recorded bytes change.

Global installations use `~/Library/Application Support/maclauncher/runtimes/gamemaker-official/`:

- Runners: `<runtime-version>/`.
- Public Igor: `tools/<bootstrap-sha256>/osx/<arm64|x64>/Igor`.
- Local Igor: `tools/vendor-<tool-version>-<arch>/files/Igor`.
- Downloads: `artifacts/<runtime-version>/` and `tool-artifacts/<bootstrap-sha256>/`.

**Import installed runtime directory** accepts a complete `runtime-<four-part-version>` folder, without downloading or invoking Igor. Common IDE paths are `/Users/Shared/GameMakerStudio2/Cache/runtimes/` and `/Users/Shared/GameMakerStudio2-LTS/Cache/runtimes/`. The version directory contains `receipt.json`, `manifest/` and `mac/Mac-YoYoRunner-Release.dmg` or a complete Mac runner app. Detected and selected versions must agree. Originals remain read-only; imported binaries retain local provenance.

**Official GameMaker** selects a managed vendor runner. Format checks precede downloads and explicit versions remain exact. Public runtime versions and any separately recorded internal runner versions remain distinct. Native extensions and external calls require matching Mac implementations. A bare Runner.app is an IDE helper; it must be bound to game data by the launcher.

A small per-game runner copy under `userData/games/<gameId>/modules/gamemaker/official-runner-<version>/` receives a unique bundle ID and ad hoc signature. Original game archives and shared vendor runtimes remain unchanged. A checked bundle-ID alias routes saves to the game's `official-saves/` directory; unrelated aliases are preserved and rejected. Forget removes the launcher-owned alias. AppKit foreground activation runs asynchronously for the launched process without System Events permission.

Positive Steam requirements come from `GEN8` flags, function classifications and SteamAppID. A matching native game library takes priority. Exact runner **1.4.9999** uses the included universal **maclauncher-offline-abi-0.5.0-universal** helper with its pinned SteamClient017 profile. Configuration and state remain under the game's `official-steam/` directory. Runner and interface identities are matched before staging. The helper provides local initialization, callbacks, achievement state and opaque storage through the [offline Steam contract](STEAM_API.md).

### Software OpenGL

The custom universal software renderer is a managed [Builds package](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers/gamemaker-opengl-helper), listed under **Runtimes → GameMaker → Graphics helper**. Refresh lists available versions; the selected version installs separately from the app. Play requests consent when a reviewed official runner needs a missing helper, installs it and resumes preparation. Canceling leaves the game and installations unchanged. Installed helpers remain usable offline, with archive, payload, CPU, signature and macOS-floor checks.

Runtime Settings preserves **Automatic**, **Enabled**, **Disabled** and existing local profile choices. **Use Runtimes selection** follows an explicit managed selection or the sole compatible installed version; no helper version is selected by the app. Existing v1–v5 installations remain usable with their exact source and runner checks. Native hardware requests and system graphics settings remain unchanged.

For the 1.4.9999 software path, V3 uses logical coordinates only for `YYGLView`, V4 uses weak view/context caches, and V5 couples the surface preference to context attachment. The helper affects only the staged runner; the original vendor app and system libraries remain unchanged. Butterscotch provides a separate runtime for its supported GameMaker formats. [Native tool setup](NATIVE_TOOL_SETUP.md#gamemaker-software-opengl) describes the helper build inputs and commands.

Official runtimes are downloaded/imported locally rather than bundled from commercial games. The [Desktop runtime licence](https://gamemaker.io/en/legal/gamemaker-runtime-licence-gms2-desktop) governs redistribution with creator content. Existing native game apps remain available as **Game's macOS app**.

## HTML5 exports

The separate `gamemaker-html5` module recognizes complete local browser exports through bounded engine declarations and generated canvas/GML metadata. Detection does not execute JavaScript or follow remote scripts. Obfuscated exports can be recognized without `JSON_game` or `g_pGMFile` names. Generic canvas pages remain Web, and exports without a readable compiler tuple retain an unknown version. Desktop bytecode is not converted to HTML5.
