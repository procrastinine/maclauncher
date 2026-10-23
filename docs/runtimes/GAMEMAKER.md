# GameMaker

Import accepts complete Windows/Linux game folders, main executables and data files. MacLauncher distinguishes Classic executables, Studio VM bytecode, native/code-free containers and existing macOS apps. Detection and inspection are offline; Play selects a compatible runtime and asks before a required download.

## Formats and version selection

Studio detection validates `FORM`, chunk lengths, `GEN8`, `STRG`, resource counts and code-entry offsets. A filename such as `data.win` is insufficient. Loose data, adjacent executables, root/assets folders and macOS `Contents/Resources` layouts are supported. A selected data file identifies the game in a folder containing several independent games.

Version detection preserves separate facts:

- The four-part `GEN8` tuple and its offset. Some exports retain placeholders such as `2.0.0.0`; this tuple does not identify an exact official runner build. Compact WAD 8 has no tuple.
- WAD/VM generation, which identifies the bytecode family.
- Structural version bounds: `SEQN` implies 2.3+, `FEAT` 2022.8+, and `UILR` 2024.13+.

Audio groups and embedded sprite sequences add independent bounds. GameMaker 2024.14 introduced `AGRP.Path`; missing/null paths reject 2024.14+ runners. Together with `UILR`, this can identify `2024.13–<2024.14`. Embedded sequence headers expanded from 32 to 40 bytes in 2024.13. A bounded probe of at most 64 sprites and 64 KiB validates track names and offsets: a unique 32-byte layout excludes 2024.13+, while a 40-byte layout requires it. Absent or ambiguous layouts remain unresolved. Definitions come from [UndertaleAudioGroup](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleAudioGroup.cs), [UndertaleSprite](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSprite.cs) and [UndertaleSequence](https://github.com/UnderminersTeam/UndertaleModTool/blob/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib/Models/UndertaleSequence.cs).

| Official runtime | Format candidates | Constraints |
| --- | --- | --- |
| Studio 1.4.9999 | WAD 16 | Intel runner; Rosetta on Apple Silicon; legacy software rendering is unstable |
| Studio 2.2.5.378 | WAD 17; bounded WAD 16 support | Intel; other Studio 2 releases retain their own compatibility records |
| Studio 2.1.x | Unresolved | Mac modules are listed; no automatic VM runner selection |
| Studio 2.2+ | WAD 17 | Structural bounds and exact runtime compatibility records still apply |
| Studio 2.3.7.476 | WAD 17 with compatible older layouts | Universal Mac runner; preferred for older sprite sequences when the format floor permits |
| 2024.13.1.242 / 2026.0.0.23 | WAD 17 | Independent resource bounds apply; 2026 rejects missing AGRP paths |
| WAD 8–15 | No matching managed official runner | Butterscotch supports these VM generations |

Shared graphics follows the selected official runner's verified CPU architecture. Legacy Intel runners use Intel graphics providers, while native ARM and universal runners retain their selected native architecture.

WAD 16 selects the legacy 1.4.9999 family automatically. WAD 17 uses compatible installed/cached builds constrained by its resource layouts. For older sequence layouts, selection prefers 2.3.7.476 when possible, or 2024.11.0.227 for later pre-2024.13 floors. These are compatible format candidates, not inferred compiler builds. Missing recommendations can be resolved during explicit Play; ordinary selection stays offline.

An explicit per-game version in `runtimeData["official-studio"].version` takes priority and must satisfy the detected requirements. Global preferences live under `settings.runtimes["gamemaker-official"]`; incompatible global defaults are skipped, and compatible installed builds are reused before downloads. Older manager-key overrides remain readable. A missing explicit version never becomes a different runner silently.

Classic GM8.0/8.1 detection uses PE/i386 headers, loading-sequence signatures and bounded asset offsets, including the newer encrypted GM8.1 header. OpenGMK separately parses those assets before execution. Studio archives with absent or empty CODE are labeled `native-or-no-code`, covering YYC possibilities without treating every code-free game as YYC. WAD generation and native extension requirements determine the available playback entries; inspection tools use the original data format. Windows PE file/product versions remain game metadata.

The [official capability table](../../src/modules/gamemaker/runtime/official-compatibility.js), pinned [Butterscotch parser](https://github.com/ButterscotchRunner/Butterscotch/blob/d66464857303a2840a5cc5141c0035440847f441/src/data_win.c) and [UndertaleModTool formats](https://github.com/UnderminersTeam/UndertaleModTool/tree/03c7048438347799e0717b6e57a9358d000472e0/UndertaleModLib) keep format support separate from exact runner identities.

## Classic (OpenGMK)

[OpenGMK](https://github.com/OpenGMK/OpenGMK) is the Classic runtime. The Mac profile **0.2.0-9ccc47a9-macos-v7** uses upstream `9ccc47a9cab4681a889866f7233a6b016d36a15e` with `maclauncher-appkit-gl-6`: AppKit windows/input, OpenGL 4.1 and CoreAudio. The package targets Apple Silicon and macOS 13+. Upstream v0.2.0 is a separate source revision with Windows assets.

The matching MacLauncher Builds release commit contains the pinned source, patches and emulator build recipe. The app contains the executable and notices for this backend.

**OpenGMK** selects the Classic interpreter. The Included executable runs directly from read-only resources without a compiler, Wine or runtime copy. Preflight parses assets and extension declarations without running GML or loading DLLs. Explicit Reload lists the bounded upstream release history alongside the Mac profile; earlier explicit Mac builds retain their own versions and overlays.

OpenGMK runs GM8.0/8.1 exports with native window controls and input. Programmatic resizing preserves native title controls and display bounds.

Original resources are read in place. Working files, saves, settings and highscores use `userData/games/<gameId>/modules/gamemaker/classic/writable/`. Append/read-write copies only the affected file.

The **SuperSound string ABI** implements 22 symbols for mono/stereo WAV/Ogg decoding, playback, loops, pause/resume, frequency, DirectSound volume/pan and byte-position/length/rate queries. Both load hints use resident decoding. Limits are 64 MiB per file, 16 million samples per sound and 64 million samples total. Initialization requires an active CoreAudio output callback. Missing symbols and mismatched types fail explicitly. Caster and other Windows extensions require separate native implementations; adjacent unused DLLs do not block Play.

The highscore API supplies a ten-place table, `highscore_value`, `highscore_name`, `highscore_add` and `highscore_clear`, with private persistence and bounded names. The [Game Maker 8 manual](https://web.engr.oregonstate.edu/~mjb/gamemaker/gmaker80.pdf) defines these APIs. The [Mac overlay guide](../../src/modules/gamemaker/overlays/opengmk-macos/README.md) documents the source/build contract.

## Butterscotch Studio

The included build is **d66464857303-appkit**, from [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) revision `d66464857303a2840a5cc5141c0035440847f441`. Its AppKit/OpenGL/miniaudio/physics profile supports [WAD 8–17 VM formats](https://github.com/ButterscotchRunner/Butterscotch#game-compatibility).

**Butterscotch Studio** selects the Studio VM runner. The included build runs directly. A missing selected build follows the normal runtime installation prompt. Original data is passed to the runner unchanged; saves use `userData/games/<gameId>/modules/gamemaker/saves/`.

Game launch arguments use the included **d66464857303-appkit-args-v1** adaptation, which preserves each value through repeated `--game-arg` options, including spaces and empty values. Automatic selects this compatible macOS 13 build when arguments are set; ordinary defaults and explicit version selections stay unchanged. Explicit older stock builds may reject `--game-arg`; lossless forwarding requires the adaptation or a compatible later build.

Explicit Reload finds the latest successful public main-branch [AppKit build](https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml). **All versions** checks the five most recent successful runs for unexpired downloads. Both actions replace discovered versions. Its date, exact source commit, CPU, artifact ID and publisher SHA-256 identify the snapshot; archives download through [nightly.link](https://nightly.link/) without a GitHub account or `gh`. Public AppKit builds require macOS 26.0 or later. Automatic Play selects a compatible public build on those hosts and requests download when needed; older supported Macs use the included macOS 13 build. Explicit global and per-game versions remain selected. Expired downloads require Refresh; installed copies remain usable. Butterscotch has no tagged releases or `--version` option.

Development **Build** retains the separate source profile, stages its exact selected commit without changing the submodule, and uses [native tool prerequisites](NATIVE_TOOL_SETUP.md). It requires a local source checkout and does not fetch prerequisites automatically. Ordinary public downloads and Included playback need no compiler. **Runtimes → GameMaker → Butterscotch → Import local build…** registers a matching local build. The original executable remains in place; removing its registration leaves it unchanged. Local registrations retain their checksum and declared source identity.

## Decompilation and inspection

**Inspect only** disables Play/Shortcut while retaining tools. **Decompile** selects the native tool for the detected format, confirms any missing download, installs the exact selected version and continues with a separate export. Included tools run directly without installation. **Reveal latest export** opens it. **Advanced** provides an inspection report for the game and raw Studio chunk exports. Runtime versions, installation and local imports belong in **Runtimes → GameMaker**. Play and Decompile prepare their selected runtime or tool automatically after any required download consent.

- **Studio:** [UndertaleModTool CLI 0.9.2.0](https://github.com/UnderminersTeam/UndertaleModTool), source `03c7048438347799e0717b6e57a9358d000472e0`, has explicit arm64/x86_64 choices and pinned archive hashes. The module invokes only `dump ... --code UMT_DUMP_ALL --strings`, checks its reported version/revision and requires actual GML output. Unsafe/duplicate filenames fail. No YYC machine code, C# scripting, repack or replacement is performed.
- **Classic:** GM8Decompiler **2.2.0-9ccc47a9** uses OpenGMK revision `9ccc47a9cab4681a889866f7233a6b016d36a15e`. Its Included native executable runs directly. Strict checks, preserved events, disabled deobfuscation and one worker produce a separate `.gmk`/`.gm81` project. Inputs are limited to 128 MiB. Exported project loading remains engine-dependent. The [workspace overlay](../../src/modules/gamemaker/overlays/opengmk-macos/README.md#native-decompiler-workspace) builds this tool separately from the emulator.

**Runtimes → GameMaker → UMT → Import local build…** registers a local UndertaleModTool CLI against its matching version. The original files remain in place. Reload lists historical Mac UMT CLI assets with exact tag commits, excluding moving nightlies. Older assets without a CPU label are inspected at installation. Publisher digests are verified when available; otherwise the asset ID and first-download checksum record local integrity. [GM8Decompiler's historical releases](https://github.com/OpenGMK/GM8Decompiler/releases) publish Windows binaries and remain unavailable for Mac installation; matching native builds can be registered explicitly.

Inspection reports contain non-executing game metadata and source hashes. Raw Studio chunk exports preserve payloads, absolute offsets and hashes; they are not rebuilt images/audio, WADs or editor projects. Exports use fresh per-game directories and preserve original archives. [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), [OpenGMK](https://github.com/OpenGMK/OpenGMK), [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool) and [Underanalyzer](https://github.com/UnderminersTeam/Underanalyzer) retain AGPL-3.0, GPL-2.0, GPL-3.0 and MPL-2.0 terms respectively.

## Official Studio runtimes and Igor

**Runtimes → GameMaker → Official** provides exact vendor-version installation and local import. Reload reads the official Stable, LTS 2026, LTS 2022 and Studio 1.4 RSS feeds and replaces the cached release list; runtime history is separate from IDE history. Failed refresh preserves the previous catalog. [Release notes](https://releases.gamemaker.io/release-notes/2026/0), [runtime feeds](https://manual.gamemaker.io/beta/en/Setting_Up_And_Version_Information/IDE_Preferences/Runtime_Feed_Preferences.htm) and the historical [GMClan index](https://gms-updates.gmclan.org/) describe these tracks; managed downloads use official vendor URLs.

Studio 2 installation automatically obtains the selected native Igor tool, downloads the release's required Core/macOS/base/YYC modules, supplies them through a temporary loopback RSS feed and extracts the runner from a read-only DMG. Version 2026.0.0.23 requires approximately 217 MB on ARM64 or 188 MB on Intel, plus Igor's 30.8/32.3 MB archive respectively. No IDE installation or account credentials are required for this flow. Package URLs, lengths and vendor signatures come from HTTPS feeds; independent pinned hashes are used where available, with first-download hashes retained for other packages. Igor can report `Verification Inconclusive no manifest found`; that state remains distinct from the launcher's own archive and payload checks.

Studio **1.4.9999** installs without Igor or a CLR host. Its [legacy update feed](https://store.yoyogames.com/downloads/gm-studio/update-studio.rss) and [release notes](https://store.yoyogames.com/downloads/gm-studio/release-notes-studio.html) identify the final 64-bit Mac module. The 34,471,534-byte official package has SHA-256 `68fbbb50bf281eb856890ca3c7d2a2d2ae7a43bd9158487a3380576e7aaa1f55`. Bounded Node ZipCrypto decoding extracts only `Mac/Mac-YoYoRunner.dmg`, then validates its DMG and x86_64 runner. Earlier legacy versions remain cataloged without an installable native package.

**Install Igor** also works independently. The public bootstrap supplies **2024.0.0.32**, read from `Igor.dll`'s fixed PE version. Its .NET assembly placeholder `1.0.0` and archive checksum are separate values. Complete native Igor directories in installed vendor runtimes provide additional local choices, validated from their DLL metadata, CPU, dependency manifests and file hashes. The chosen Igor persists independently of the game runner version. Repair is available when recorded bytes change.

Global installations use `~/Library/Application Support/maclauncher/runtimes/gamemaker-official/`:

- Runners: `<runtime-version>/`.
- Public Igor: `tools/<bootstrap-sha256>/osx/<arm64|x64>/Igor`.
- Local Igor: `tools/vendor-<tool-version>-<arch>/files/Igor`.
- Downloads: `artifacts/<runtime-version>/` and `tool-artifacts/<bootstrap-sha256>/`.

**Import installed runtime directory** accepts a complete `runtime-<four-part-version>` folder, without downloading or invoking Igor. Common IDE paths are `/Users/Shared/GameMakerStudio2/Cache/runtimes/` and `/Users/Shared/GameMakerStudio2-LTS/Cache/runtimes/`. The version directory contains `receipt.json`, `manifest/` and `mac/Mac-YoYoRunner-Release.dmg` or a complete Mac runner app. Detected and selected versions must agree. Originals remain read-only; imported binaries retain local provenance.

**Official GameMaker** selects a managed vendor runner. Format checks precede downloads, WAD 16 selects the legacy family, and explicit versions remain exact. The catalog's 2026.0.0.23 runner reports its separate internal version `2026.0.0.32908`. Native extensions and external calls require matching Mac implementations. A bare Runner.app is an IDE helper; it must be bound to game data by the launcher.

A small per-game runner copy under `userData/games/<gameId>/modules/gamemaker/official-runner-<version>/` receives a unique bundle ID and ad hoc signature. Original game archives and shared vendor runtimes remain unchanged. A checked bundle-ID alias routes saves to the game's `official-saves/` directory; unrelated aliases are preserved and rejected. Forget removes the launcher-owned alias. AppKit foreground activation runs asynchronously for the launched process without System Events permission.

Positive Steam requirements come from `GEN8` flags, function classifications and SteamAppID. A matching native game library takes priority. Exact runner **1.4.9999** uses the included universal **maclauncher-offline-abi-0.5.0-universal** helper with its pinned SteamClient017 profile. Configuration and state remain under the game's `official-steam/` directory. Runner and interface identities are matched before staging. The helper provides local initialization, callbacks, achievement state and opaque storage through the [offline Steam contract](STEAM_API.md).

### Software OpenGL

Software OpenGL helpers **v1–v5** use explicit local installations;
their native libraries are excluded from the app.
Runtime Settings preserves **Automatic**, **Enabled**, **Disabled** and helper
version choices for existing local installations. Without a helper, Automatic
uses the runner's ordinary graphics path. Native hardware requests and system
graphics settings remain unchanged.

For the 1.4.9999 software path, V3 uses logical coordinates only for `YYGLView`, V4 uses weak view/context caches, and V5 couples the surface preference to context attachment. The helper affects only the staged runner; the original vendor app and system libraries remain unchanged. Butterscotch provides a separate runtime for its supported GameMaker formats. [Native tool setup](NATIVE_TOOL_SETUP.md#gamemaker-software-opengl) describes the helper build inputs and commands.

Official runtimes are downloaded/imported locally rather than bundled from commercial games. The [Desktop runtime licence](https://gamemaker.io/en/legal/gamemaker-runtime-licence-gms2-desktop) governs redistribution with creator content. Existing native game apps remain available as **Game's macOS app**.

## HTML5 exports

The separate `gamemaker-html5` module recognizes complete local browser exports through bounded engine declarations and generated canvas/GML metadata. Detection does not execute JavaScript or follow remote scripts. Obfuscated exports can be recognized without `JSON_game` or `g_pGMFile` names. Generic canvas pages remain Web, and exports without a readable compiler tuple retain an unknown version. Desktop bytecode is not converted to HTML5.
