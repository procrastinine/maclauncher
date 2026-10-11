# MacLauncher guide

MacLauncher runs compatible Windows and Linux game data through native macOS engines, with optional CrossOver playback for Windows executables. It manages the runtimes and tools needed to play games already stored on the Mac.

## Add and play

1. Drag a game folder, its main executable or a supported game package into the launcher, use **File → Open…** (`Cmd+O`), or choose **Open With → MacLauncher** in Finder.
2. Select the game to open its inspector. Click it again to return to the library.
3. Press **Play**. The launcher uses a compatible included/installed runtime or asks to download the required version.

Keep the complete game together, including the archives, scripts and assets beside its executable. The inspector shows the detected engine and version.

Preparation is automatic. Original assets stay in place; generated configuration, converted scripts, cache and saves use private launcher storage. Large immutable assets are linked or read directly. [Preparation and storage](GAME_PREPARATION.md) describes the engine-specific exceptions.

For a macOS `.app`, use the native app runtime. **Remove quarantine** in its inspector can resolve Gatekeeper quarantine; it does not repair corrupt files or replace missing dependencies.

## Runtimes and settings

**Settings**, **Runtimes** and **Credits** open separate macOS windows. Reopening a view focuses its existing window. The library stays usable, changes appear across windows, and native close controls or Cmd-W close the focused window.

**Runtimes** lists versions for players and tools with download or update management. **Reload** replaces the cached release list. Ordinary release catalogs show their complete bounded history; slower artifact catalogs can offer a reduced query. Opening the launcher or runtime list does not fetch remote releases.

[EasyRPG](runtimes/EASYRPG.md), [ScummVM](runtimes/SCUMMVM.md),
[RFVP](runtimes/FVP.md) and [Browser Woditor](runtimes/WOLFRPG.md) support managed downloads and multiple
versions. [CrossOver](runtimes/CROSSOVER.md) registers local applications,
including separate installations of the same version. Known Windows engines
retain their usual backend default. An unrecognized Windows executable uses
CrossOver; an unrecognized folder must contain exactly one top-level Windows
executable. Select a particular executable when a folder has several candidates.

Included runtimes run without installation, a compiler or network connection. Fixed built-ins have options in **Settings** and version information in the inspector, without a download tab. Writable runtime preparation is automatic. Managed runtimes download after an explicit request, including consent during Play. Catalogs distinguish installable versions from source-only releases. A runtime's minimum macOS version and CPU architecture can differ from the launcher's requirements.

Automatic selection combines detected format requirements with the global runtime preference. An explicit per-game version remains an override; a missing explicit version does not silently become another build. Runtime versions, original game versions and archive/bytecode generations are recorded separately.

Use **Settings** for engine defaults and **Runtime Settings** in an inspector for that game. GameMaker groups official runtimes, Igor, Butterscotch and Classic tools together; Igor installs Studio 2 modules and is not needed for ordinary runner launches. Ren'Py SDK installations expose version-matched Live2D setup.

See [runtime behavior](runtimes/RUNTIMES.md), [release catalogs](runtimes/RUNTIME_CATALOGS.md), [distribution](runtimes/RUNTIME_DISTRIBUTION.md) and [optional development tools](runtimes/NATIVE_TOOL_SETUP.md).

## Saves, cheats and source tools

Open **Save tools** from the inspector to locate saves, take recovery snapshots and open the dedicated save editor. Available editing depends on the engine:

| Engine | Available tools | Limits |
| --- | --- | --- |
| RPG Maker MV/MZ | Structured save editing, snapshots, cheats and source/asset tools | Game plugins can define additional data and behavior. |
| RPG Maker XP/VX/VX Ace | Marshal graph inspection, Ruby script export/repack, cheats | Arbitrary save rewriting is unsupported. |
| RPG Maker 2000/2003 | LCF project JSON/text export, save locations and snapshots | Windows DLL plug-ins and some engine patches have limited EasyRPG compatibility. |
| WOLF RPG Editor | Supported archive listing/extraction, save locations and snapshots | Customized encryption may require unpacked data; binary events/maps are not decompiled. |
| ScummVM games | Edition identification and managed format-specific archive extraction | ScummVM Tools supports selected resource formats and uses Rosetta on Apple Silicon. |
| FAVORITE / FVP | Scenario metadata, resource inventory and unchanged asset exports | RFVP saves differ from the original Windows engine; scenario decompilation and save editing are unavailable. |
| Ren'Py | Save metadata/location discovery, RPA extraction, script decompilation, console and cheat add-ons | Offline pickle state editing and signature verification are unsupported. |
| GameMaker | Format inspection, Studio GML decompilation and Classic project export | Native/YYC code is not recovered; generic saves and cheats are unsupported. |
| Java / FNA | Java or C# decompilation | Exports are stored separately from the original game. |
| Unity | Managed ILSpy C# decompilation and AssetRipper asset inspection/export | IL2CPP assets can be inspected; original C# source is not reconstructed. |
| Flash | Managed FFDec ActionScript and asset export | Export support depends on SWF features and obfuscation. |
| Infinity Engine | Managed Near Infinity resource inspector | Saving from the external editor changes original game files. |
| KiriKiri | Readable TJS/KAG script export | Unknown encryption and compiled bytecode are unsupported. |
| Windows / CrossOver | Private writable files and optional Wine settings | No universal save editor or decompiler; recognized engines retain their own source tools. |
| NScripter / BGI | Script or compiled-program export | BGI is not yet supported for play. |
| AliceSoft System 1–3 / 3.5–3.9 | Native ADV source decompilation with included tools | System4 source recovery, compiler round-trips and generic save editing are unsupported. |
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

See [backend and CLI](BACKEND.md) for host requirements and module actions. [Development](DEVELOPMENT.md) covers source setup, tests and packaging. [Repository guide](REPO_GUIDE.md) indexes the architecture and technical contracts.
