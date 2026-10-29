# MacLauncher guide

MacLauncher plays browser games, macOS applications, Android and iOS packages, and Windows and Linux game data through native macOS engines. Sikarugir (Wine) and CrossOver also run Windows executables. The library brings together runtime versions, graphics effects, store downloads and tools for game files and saves.

## Add and play

Game folders, main executables and supported packages enter the library through drag and drop, **File → Open…** (`Cmd+O`) or Finder’s **Open With → MacLauncher**. Selection opens the game inspector; selecting it again returns to the library. **Play** uses the selected runtime, with download consent when a required version is absent.

Game input includes the archives, scripts and assets beside the executable. The inspector shows the detected engine and version.

Preparation is automatic. Original assets stay in place; generated configuration, converted scripts, cache and saves use private launcher storage. Large immutable assets are linked or read directly. [Preparation and storage](GAME_PREPARATION.md) describes each engine's layout.

macOS applications use their supplied native executable. Generic i386-only app imports select the managed [mac32 runtime](runtimes/MAC32.md), with download consent during Play; recognized engines retain their preferred runtime. mac32 requires macOS 26 or later and Rosetta on Apple Silicon. Publisher application folders with `Contents/Info.plist` and a declared Mac executable also import without an `.app` suffix; their original files and launch script stay in place. **Remove quarantine** in an app inspector clears Gatekeeper quarantine.

**macOS Game** also accepts selected `.sh`, `.command`, `.bash` and `.zsh` launchers, executable shebang scripts (including `.py`) and standalone macOS Mach-O executables, including files without an extension. Play runs the selected file from its containing directory with its installed interpreter. Shell launchers do not need an executable permission bit. **Make executable** in the script inspector adds executable permissions to that selected file. Script contents stay unchanged; importing a folder does not choose an arbitrary script. Recognized engine launchers, including Ren'Py `.sh` and `.py` files, keep their engine-specific behavior. Native window tracking connects launched game windows to the shared graphics controls.

## Store libraries and downloads

[External](EXTERNAL.md) aggregates locally installed Steam, Epic, GOG and itch.io games
for offline discovery and batch import. Separate store tabs browse account libraries
and select game versions, platforms and languages for managed or custom downloads.
Import after download is optional and enabled by default.

[Android app downloads](GOOGLE_PLAY.md) covers Google Play, F-Droid and IzzyOnDroid,
shared account selection, device profiles and APK versions.

## Runtimes and settings

**Settings**, **Runtimes** and **Credits** open separate macOS windows. Reopening a view focuses its existing window. The library stays usable, changes appear across windows, and native close controls or Cmd-W close the focused window.

**Runtimes** manages player and tool downloads, local imports, available builds, versions and removal. Refresh replaces each source's cached release list. MacLauncher Builds and upstream downloads have separate version selectors and refresh controls; installed versions remain available together in the game inspector. Opening the launcher or runtime list uses local state without fetching remote releases.

[EasyRPG](runtimes/EASYRPG.md), [ScummVM](runtimes/SCUMMVM.md),
[RFVP](runtimes/FVP.md), [Browser Woditor](runtimes/WOLFRPG.md) and
[Sikarugir (Wine)](runtimes/SIKARUGIR.md) support managed downloads and multiple
versions. [CrossOver](runtimes/CROSSOVER.md) registers local applications,
including separate installations of the same version. Compatible Windows exports
offer both Windows runtimes while known engines retain their usual backend
default. An unrecognized Windows executable uses Sikarugir; an unrecognized
folder must contain exactly one top-level Windows executable. A selected executable identifies the game when a folder has several candidates.

Game runtimes download after an explicit request, including consent during Play, and installed versions work offline. The app includes core graphics and internal import, extraction and integration helpers. Runtime preparation is automatic; ordinary Play needs no compiler or source checkout. Catalogs identify each package's CPU architecture and minimum macOS version.

[Network isolation](runtimes/NETWORK_ISOLATION.md) can block Internet and local-network access for an individual game across runtimes. Every game's inspector includes **Network access**; changes apply on its next launch.

Runtime selection uses the game's explicit version, then the version its detected format recommends, then the global default. A missing explicit version does not become another build. Runtime versions, original game versions and archive/bytecode generations are recorded separately.

**Settings** holds engine defaults; **Runtime Settings** in an inspector holds per-game overrides. GameMaker groups official runtimes, Igor, Butterscotch and Classic tools together; Igor installs Studio 2 modules and is not needed for ordinary runner launches. Ren'Py SDK installations expose version-matched Live2D setup.

**Launch arguments** stores additional startup arguments for each game and its saved `.command` launcher. Quotes keep spaces inside one argument, for example `--windowed --name "Example name"`; shell commands, environment variables and wildcard patterns are not expanded. Arguments stay with the game when its runtime changes. The adjacent `?` button explains the syntax.

The reference covers [runtime behavior](runtimes/RUNTIMES.md), [release catalogs](runtimes/RUNTIME_CATALOGS.md), [distribution](runtimes/RUNTIME_DISTRIBUTION.md) and [native tool setup](runtimes/NATIVE_TOOL_SETUP.md). The [settings reference](runtimes/SETTINGS_REFERENCE.md) lists every backend, runtime setting and inspector action by game type.

## Graphics and effects

Shared graphics controls apply shaders, upscaling, neural reconstruction and frame generation across game runtimes and video playback. Local ReShade `.fx`, RetroArch `.slangp`/`.slang` and mpv/libplacebo `.glsl`/`.hook` shaders supply custom effects, with editable shader parameters. Managed shader collections are available from **Runtimes → Graphics → Shaders**.

**Simple** controls offer shader, scaling and frame-generation selections. **Advanced…** combines effects in any order, with independent settings, bypass controls and reusable presets. Effects can change live while retaining the game's window and fullscreen behavior. The [graphics guide](GRAPHICS.md) describes the methods and the additional frame inputs used by temporal effects and video-plane shaders.

## Saves, cheats and source tools

The game inspector contains decompilation, extraction, inspection, patches and exports. An action requests any missing managed tool and resumes after installation. **Saves** (**Edit saves** for game types with save editing) opens the save tools: save locations, recovery snapshots and the dedicated save editor. Engine tools map to these formats:

| Engine | Available tools | Formats and storage |
| --- | --- | --- |
| RPG Maker MV/MZ | Structured save editing, snapshots, cheats and source/asset tools | MV/MZ saves, game-defined database labels, decrypted assets and scripts. |
| RPG Maker XP/VX/VX Ace | Marshal graph inspection, Ruby script export/repack, cheats | Marshal values are inspected as an inert object graph. |
| RPG Maker 2000/2003 | LCF project JSON/text export, save locations and snapshots | LCF projects and private EasyRPG saves. |
| WOLF RPG Editor | Archive listing/extraction, save locations and snapshots | WOLF archives, extracted assets and browser-player saves. |
| ScummVM games | Edition identification and managed format-specific archive extraction | Resource archives handled by ScummVM Tools. |
| FAVORITE / FVP | Scenario metadata, resource inventory and unchanged asset exports | RFVP stores saves separately from the original Windows engine. |
| Ren'Py | Save metadata/location discovery, RPA extraction, script decompilation, console and cheat add-ons | Save inspection reads bounded JSON metadata; state changes use the runtime console. |
| GameMaker | Format inspection, Studio GML decompilation and Classic project export | Studio VM bytecode and Classic project formats use separate exporters. |
| Java / FNA | Java or C# decompilation | Exports are stored separately from the original game. |
| Unity | Managed ILSpy C# decompilation and AssetRipper asset inspection/export | Mono assemblies and Unity assets, including IL2CPP asset packages. |
| Flash | Managed FFDec ActionScript and asset export | ActionScript 1/2/3 and SWF images, shapes, audio, fonts and text. |
| Infinity Engine | Managed Near Infinity resource inspector | Game resources, scripts and saved games; editor writes target the original files. |
| KiriKiri | Readable TJS/KAG script export | Exports decode readable source from supported XP3 profiles. |
| Windows | Private writable files and optional Wine settings | Recognized engines retain their format-specific source and save tools. |
| NScripter / BGI | Script or compiled-program export | BGI Windows playback uses a registered CrossOver application, otherwise Sikarugir. |
| AliceSoft System 1–3 / 3.5–3.9 | Native ADV source decompilation with managed tools | Legacy scenario formats map to version-specific source tools. |
| Other engines | Inspector actions declared by the module | Engine-specific files and save locations described in the runtime guides. |

Notes belong to the selected library game. Exports and backups stay separate from originals. [Save snapshots](SAVE_SNAPSHOTS.md), [MV/MZ editing](MVMZ_SAVE_EDITOR.md), [RGSS tools](RGSS_TOOLS.md), [Ren'Py tools](RENPY_TOOLS.md) and [cheats](cheats.md) document supported operations.

## Engine guides

The [runtime guides](runtimes/README.md) group engines and hosts in one place.
Each guide describes accepted data formats, version/ABI constraints, automatic
setup and available game tools.

[Attributions](ATTRIBUTIONS.md) links the upstream projects and their licenses.
**Credits → Game port resources** also links to [Awesome Decomp Games](https://github.com/SubmitGame/awesome-decomp-games), a community index of source ports, decompilations and engine remakes.

## Files and headless use

Default launcher data lives in `~/Library/Application Support/maclauncher/`:

- `runtimes/` stores shared installed runtime versions and tools.
- `games/<game-id>/` stores library metadata, notes, private runtime files, exports and managed saves.

Ren'Py may also use its configured `~/Library/RenPy/` save directory. Explicit save-directory overrides remain available. Forgetting a game removes its owned launcher data; original files and external save locations remain outside that operation.

The same backend can run without the launcher window:

```sh
pnpm launch --game /path/to/game --inspect
pnpm launch --game /path/to/game --wait
pnpm launch --game /path/to/game --action <action-id>
```

[Backend and CLI](BACKEND.md) describes host requirements and module actions. [Development](DEVELOPMENT.md) covers source setup, tests and packaging. [Repository guide](REPO_GUIDE.md) indexes the architecture and technical contracts.

## Reference index

**Library, stores and storage**

- [External game libraries](EXTERNAL.md): installed Steam, Epic, GOG and itch.io games, store tabs and downloads.
- [Android app downloads](GOOGLE_PLAY.md): Google Play, F-Droid and IzzyOnDroid accounts, device profiles and APK versions.
- [Game detection pipeline](DETECTION.md): import scanning, engine detection and version evidence.
- [Game preparation and storage](GAME_PREPARATION.md): original-file handling and private per-game layouts.
- [Game icons](GAME_ICONS.md) and [app, game and engine icons](ICON_ASSETS.md): artwork extraction and owned icon assets.
- [Save snapshots](SAVE_SNAPSHOTS.md): recovery snapshots and save write transactions.

**Game tools**

- [Game inspection and source tools](GAME_TOOLS.md): every inspector tool, output and limit by game type.
- [RPG Maker MV/MZ save editing](MVMZ_SAVE_EDITOR.md), [cheats](cheats.md), [RGSS tools](RGSS_TOOLS.md) and [Ren'Py tools](RENPY_TOOLS.md).
- [Flash tools](FLASH_TOOLS.md), [Infinity Engine tools](INFINITY_TOOLS.md) and [native binary inspection](NATIVE_INSPECTION.md).

**Runtimes**

- [Runtime guides](runtimes/README.md): every game type, backend and engine guide.
- [Settings reference](runtimes/SETTINGS_REFERENCE.md): backends, runtime settings and inspector actions by game type.
- [Runtime system](runtimes/RUNTIMES.md), [release catalogs](runtimes/RUNTIME_CATALOGS.md), [distribution](runtimes/RUNTIME_DISTRIBUTION.md), [native tool setup](runtimes/NATIVE_TOOL_SETUP.md) and [custom runtime layouts](runtimes/CUSTOM_RUNTIME_LAYOUTS.md).
- [Steam API support](runtimes/STEAM_API.md), [Rosetta](runtimes/ROSETTA.md), [network isolation](runtimes/NETWORK_ISOLATION.md) and [GitHub metadata transport](runtimes/GITHUB_TRANSPORT.md).

**Graphics**

- [Graphics and effects](GRAPHICS.md), [graphics pipeline](GRAPHICS_PIPELINE.md), [neural restoration models](NEURAL_RESTORATION.md) and [shared graphics processing](runtimes/GRAPHICS.md).
- Pipeline references: [effects plans](graphics/EFFECT_PLANS.md), [frame APIs](graphics/FRAME_API.md), [frame sources and adapters](graphics/INPUTS_AND_ADAPTERS.md), [live updates](graphics/LIVE_UPDATES.md), [providers](graphics/PROVIDERS.md), [shaders and media](graphics/SHADERS_AND_MEDIA.md) and [status and delivery](graphics/STATUS_AND_DELIVERY.md).

**Architecture and development**

- [Repository guide](REPO_GUIDE.md), [module system](MODULES.md), [shared backend](BACKEND.md) and [data model](DATA_MODEL.md).
- [Launcher UI guide](UI_GUIDE.md) and [UI styles](UI_STYLES.md).
- [Upstream sources and adaptations](UPSTREAMS.md) and [attributions](ATTRIBUTIONS.md).
- [Development](DEVELOPMENT.md), [macOS app builds](CI.md) and [releases](RELEASING.md).
