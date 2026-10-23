# MacLauncher guide

MacLauncher runs compatible Windows and Linux game data through native macOS engines, with Sikarugir (Wine) and optional CrossOver playback for Windows executables. It manages the runtimes and tools needed to play games already stored on the Mac.

## Add and play

Game folders, main executables and supported packages enter the library through drag and drop, **File → Open…** (`Cmd+O`) or Finder’s **Open With → MacLauncher**. Selection opens the game inspector; selecting it again returns to the library. **Play** uses an included or installed runtime, with download consent when a required version is absent.

Game input includes the archives, scripts and assets beside the executable. The inspector shows the detected engine and version.

Preparation is automatic. Original assets stay in place; generated configuration, converted scripts, cache and saves use private launcher storage. Large immutable assets are linked or read directly. [Preparation and storage](GAME_PREPARATION.md) describes the engine-specific exceptions.

macOS applications use their supplied native executable. Generic i386-only app imports select the managed [mac32 runtime](runtimes/MAC32.md), with download consent during Play; recognized engines retain their preferred runtime. mac32 0.1 requires macOS 26 or later and Rosetta on Apple Silicon. Publisher application folders with `Contents/Info.plist` and a declared Mac executable also import without an `.app` suffix; their original files and launch script stay in place. **Remove quarantine** in an app inspector can resolve Gatekeeper quarantine; it does not repair corrupt files or replace missing dependencies.

**macOS Game** also accepts selected `.sh`, `.command`, `.bash` and `.zsh` launchers, executable shebang scripts (including `.py`) and standalone macOS Mach-O executables, including files without an extension. Play runs the selected file from its containing directory with the required interpreter already installed. Shell launchers do not need an executable permission bit. **Make executable** in the script inspector adds executable permissions to that selected file. Script contents stay unchanged; importing a folder does not choose an arbitrary script. Recognized engine launchers, including Ren'Py `.sh` and `.py` files, keep their engine-specific behavior. Native window tracking follows launched processes on a best-effort basis so shared graphics controls can target a game window; effects also depend on the game accepting graphics injection.

## Runtimes and settings

[External](EXTERNAL.md) aggregates locally installed Steam, Epic, GOG and itch.io games
for offline discovery and batch import. Separate store tabs browse account libraries
and select game versions, platforms and languages for managed or custom downloads.
Import after download is optional and enabled by default.

**Settings**, **Runtimes** and **Credits** open separate macOS windows. Reopening a view focuses its existing window. The library stays usable, changes appear across windows, and native close controls or Cmd-W close the focused window.

**Launch arguments** in every game inspector stores additional startup arguments for that game. The text stays with the game when its runtime changes and is also used by saved `.command` launchers. Quotes keep spaces inside one argument, for example `--windowed --name "Example name"`; shell commands, environment variables and wildcard patterns are not expanded. The selected game or runtime determines which options it recognizes. Explanations are available through the adjacent `?` button.

**Credits → Game port resources** links to [Awesome Decomp Games](https://github.com/SubmitGame/awesome-decomp-games), a community list of game source ports, decompilations and engine remakes. Platforms and game data requirements vary by project. The link opens in the default browser only when **Open** is selected.

**Runtimes** manages player and tool downloads, local imports, available builds, versions and removal. The game inspector runs tools against the selected game: decompilation, extraction, inspection, patches and exports. A game action requests any missing managed prerequisite and resumes after installation. **Reload** replaces the cached release list. Ordinary release catalogs show their complete bounded history; slower artifact catalogs can offer a reduced query. Opening the launcher or runtime list does not fetch remote releases.

[EasyRPG](runtimes/EASYRPG.md), [ScummVM](runtimes/SCUMMVM.md),
[RFVP](runtimes/FVP.md), [Browser Woditor](runtimes/WOLFRPG.md) and
[Sikarugir (Wine)](runtimes/SIKARUGIR.md) support managed downloads and multiple
versions. [CrossOver](runtimes/CROSSOVER.md) registers local applications,
including separate installations of the same version. Compatible Windows exports
offer both Windows runtimes while known engines retain their usual backend
default. An unrecognized Windows executable uses Sikarugir; an unrecognized
folder must contain exactly one top-level Windows executable. A selected executable identifies the game when a folder has several candidates.

Included runtimes run without installation, a compiler or network connection. Fixed built-ins have options in **Settings** and version information in the inspector, without a download tab. Writable runtime preparation is automatic. Managed runtimes download after an explicit request, including consent during Play. Catalogs distinguish installable versions from source-only releases. A runtime's minimum macOS version and CPU architecture can differ from the launcher's requirements.

[Network isolation](runtimes/NETWORK_ISOLATION.md) can block Internet and local-network access for an individual game across runtimes. Every game's inspector includes **Network access**; changes apply on its next launch.

Automatic selection combines detected format requirements with the global runtime preference. An explicit per-game version remains an override; a missing explicit version does not silently become another build. Runtime versions, original game versions and archive/bytecode generations are recorded separately.

**Settings** holds engine defaults; **Runtime Settings** in an inspector holds per-game overrides. GameMaker groups official runtimes, Igor, Butterscotch and Classic tools together; Igor installs Studio 2 modules and is not needed for ordinary runner launches. Ren'Py SDK installations expose version-matched Live2D setup.

The reference covers [runtime behavior](runtimes/RUNTIMES.md), [release catalogs](runtimes/RUNTIME_CATALOGS.md), [distribution](runtimes/RUNTIME_DISTRIBUTION.md) and [optional development tools](runtimes/NATIVE_TOOL_SETUP.md).

## Saves, cheats and source tools

**Save tools** in the inspector provides save locations, recovery snapshots and the dedicated save editor. Engine tools map to these formats:

| Engine | Available tools | Formats and storage |
| --- | --- | --- |
| RPG Maker MV/MZ | Structured save editing, snapshots, cheats and source/asset tools | Game plugins can define additional data and behavior. |
| RPG Maker XP/VX/VX Ace | Marshal graph inspection, Ruby script export/repack, cheats | Marshal values are inspected as an inert object graph. |
| RPG Maker 2000/2003 | LCF project JSON/text export, save locations and snapshots | Windows DLL plug-ins and some engine patches have limited EasyRPG compatibility. |
| WOLF RPG Editor | Supported archive listing/extraction, save locations and snapshots | Customized encryption may require unpacked data; binary events/maps are not decompiled. |
| ScummVM games | Edition identification and managed format-specific archive extraction | ScummVM Tools supports selected resource formats and uses Rosetta on Apple Silicon. |
| FAVORITE / FVP | Scenario metadata, resource inventory and unchanged asset exports | RFVP stores saves separately from the original Windows engine. |
| Ren'Py | Save metadata/location discovery, RPA extraction, script decompilation, console and cheat add-ons | Save inspection reads bounded JSON metadata; state changes use the runtime console. |
| GameMaker | Format inspection, Studio GML decompilation and Classic project export | Studio VM bytecode and Classic project formats use separate exporters. |
| Java / FNA | Java or C# decompilation | Exports are stored separately from the original game. |
| Unity | Managed ILSpy C# decompilation and AssetRipper asset inspection/export | IL2CPP assets can be inspected; original C# source is not reconstructed. |
| Flash | Managed FFDec ActionScript and asset export | Export support depends on SWF features and obfuscation. |
| Infinity Engine | Managed Near Infinity resource inspector | Saving from the external editor changes original game files. |
| KiriKiri | Readable TJS/KAG script export | Exports decode readable source from supported XP3 profiles. |
| Windows | Private writable files and optional Wine settings | Recognized engines retain their format-specific source and save tools. |
| NScripter / BGI | Script or compiled-program export | BGI Windows playback uses Sikarugir or CrossOver. |
| AliceSoft System 1–3 / 3.5–3.9 | Native ADV source decompilation with included tools | Legacy scenario formats map to version-specific source tools. |
| Other engines | Inspector actions declared by the module | Save formats and native extensions vary by game. |

Notes belong to the selected library game. Exports and backups stay separate from originals. [Save snapshots](SAVE_SNAPSHOTS.md), [MV/MZ editing](MVMZ_SAVE_EDITOR.md), [RGSS tools](RGSS_TOOLS.md), [Ren'Py tools](RENPY_TOOLS.md) and [cheats](cheats.md) document supported operations.

## Engine compatibility

The [runtime guides](runtimes/README.md) group engines and hosts in one place.
Each guide describes accepted data formats, version/ABI constraints, automatic
setup and available game tools.

[Attributions](ATTRIBUTIONS.md) links the upstream projects and their licenses.

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
