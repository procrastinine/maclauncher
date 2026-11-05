# Data model

MacLauncher stores its state in Electron's `userData` directory. This page describes the directory layout, the global `settings.json` file, the per-game `game.json` record and its normalization, the runtime settings layers and how stored documents are written and recovered.

## Storage locations

On macOS, the default `userData` directory is `~/Library/Application Support/maclauncher/`. Paths on this page are relative to it.

Each game's record and launcher data live under `games/<gameId>/`. Android runtimes keep application data separately: the Klepton runtime under `android/apps/<gameId>/data/`, and Mac.apk and AIM under `android/apps/<gameId>/providers/<runtimeId>/`. Shared module and runtime installations never contain per-game state.

| Path | Contents |
| --- | --- |
| `settings.json` | Launcher, module and runtime-manager settings, without the game list; see [settings.json](#settingsjson) |
| `games/<gameId>/` | Per-game data; see [per-game directory](#per-game-directory) |
| `android/apps/<gameId>/providers/<runtimeId>/` | Provider-specific Android packages, files, caches and launch configuration, kept apart from existing application storage |
| `modules/<moduleId>/` | Module assets shared by all games |
| `runtimes/<managerId>/` | Shared runtime installations |
| `runtimes/<runtimeId>/settings.json` | Global runtime defaults |
| `runtimes/automatic-installs.json` | Runtime versions that Play installed on its own, for [derived data upkeep](#derived-data-upkeep) |
| `logs/main.log` | Launcher log |
| `updates/` | The latest update check, a downloaded update waiting to be installed, and the installation script and its log; see [app updates](../UPDATES.md#files) |
| `graphics/reshade-filters.json` | Registered local shader files, with their names, paths and cached classification |
| `graphics/effects-presets.json` | Named snapshots of Advanced effects. Applying a preset copies it into the game record. |
| `graphics/shaders/<provider>/<content-hash>/` | Shared, immutable prepared shader resources. Shader selections and parameters stay per game. |
| `graphics/compute-sessions/<launch-hash>/` | Private GPU compute requests and the compute host's authenticated replies. Image pixels use native GPU transport. |
| `graphics/payload-bindings/` | The launcher's record of which graphics processor each launch uses, with an unchanging copy of its manifest, for live edits |
| `steam/` | Steam account metadata, the index of completed downloads and optional encrypted sign-ins |
| `external/downloads/<store>/` | Downloaded game versions, kept apart from store installations. Custom destinations stay indexed by path; [external-library storage](../library/EXTERNAL.md#storage) describes the layout. |
| `Partitions/` | Electron storage partitions |

MacLauncher links each game's Electron partition to `games/<gameId>/partition/`, so deleting the game directory also removes the partition data.

### Per-game directory

| Path under `games/<gameId>/` | Contents |
| --- | --- |
| `game.json` | The game record, which is the source of truth for the game's information; see [game records](#game-records) |
| `metadata.json` | Cached detection, icon and save facts; see [library records](BACKEND.md#library-records) |
| `shortcuts.json` | Saved `.command` paths and script digests; edited scripts are marked stale and preserved |
| `.relocation-backups/` | The latest relocation's original records and links, and the marker of a relocation in progress |
| `cheats.json` | The cheat payload; see [cheats](#cheats) |
| `cheats.json.tools-bootstrap.log` | Tools bootstrap log, for patched runtimes |
| `cheats.json.tools-runtime.log` | Tools runtime log, for patched runtimes |
| `cheats.json.rgss-teleports.json` | RGSS teleport slots, when used |
| `icons/` | Icon cache |
| `save-snapshots/` | Immutable, checksummed recovery snapshots and their manifests, kept until the game itself is removed; see [save snapshots](../tools/SAVE_SNAPSHOTS.md) |
| `logs/` | Tool and host logs |
| `effects/reshade/` | Prepared effects, the ordered runtime plan, launch bindings, window selection state and the effect log |
| `effects/reshade/reshade.log`, `effects/reshade/reshade.log.previous` | The current and previous launch's native graphics logs, each limited to 512 KiB |
| `effects/app-copy/` | A [private copy](../graphics/INPUTS_AND_ADAPTERS.md#private-copies-of-restricted-apps) of a Mac app whose code signature refuses the graphics processor, with its ownership record. Files and folders that the game creates in the copy's real directories, and links that it replaces, survive refreshes and keep the copy from being removed automatically |
| `effects/app-copy/recovered/<snapshot-id>/` | Copied executables or `Info.plist` files that had changed when the copy was refreshed, under `files/` at their relative paths, with `record.json`. These snapshots are never launched, rewritten or removed automatically |
| `modules/<moduleId>/` | Module-specific data |
| `runtimes/<runtimeId>/` | Runtime-specific data, such as wrappers, profiles and staging |
| `partition/` | Target of the game's Electron storage partition link |

File-change records compare a file's size, modification time and inode. They leave out the device number, so unchanged game files on a reconnected volume still match. Records from earlier MacLauncher versions that list the device number are compared without it. Metadata and archive hashes from earlier versions stay usable while they match; a hash that does not match leads to one ordinary refresh, which records the file's size, modification time and inode instead. Existing archive folders stay in place.

Cached metadata observations also record the change time. Where change times have only whole-second precision, an observation also needs a content hash of each regular file up to 16 MB and a list of each directory's entries with their types. Each observation or validation pass reads at most 32 MB of file contents and 8,192 directory entries. Inputs beyond those limits, and coarse-timestamp inputs that cannot be read, are never reused from the cache. Observations from earlier versions that recorded only file status are refreshed once; original game files and extracted archive folders stay in place.

### Per-game module data

Examples of `games/<gameId>/modules/<moduleId>/` contents:

| Module | Contents |
| --- | --- |
| `renpy` | Application builds made on request, patch and export work, extraction where a game needs it, icons and the helper scripts used only for Steam. Ordinary SDK launches use the original project directory. |
| `godot` | `extracted/` and `gdre-detect/` |
| `java` | `extracted/` (Vineflower output) and `icons/` (the cached JAR icon) |
| `flash` | `exports/`: FFDec script and asset exports |
| `unity` | `assets/`: AssetRipper workspaces, preferences and exports |
| `kirikiri` | `script-export/`: readable script exports |
| `love` | `appimage/`: the extracted AppImage cache, when applicable |
| `rgss` | `extracted/`: decrypted RGSS assets |
| `mv`, `mz` | `extracted/`: decrypted assets |
| `construct`, `tyrano` | `extracted/`: extracted NW.js bundles |
| `nscripter` | `extracted/`: extracted packaged assets |
| `easyrpg` | Exports made on request. Ordinary Play uses the original project, which is also where saves go by default, and the player's default configuration and log locations. An explicit save folder is passed to the player with `--save-path` and changes only where saves go; the project and working folder stay the same, and the folder is created at launch if it is missing. |
| `scummvm` | Private ScummVM configuration, saves and logs |
| `dosbox` | DOSBox configuration, mapper, runtime application wrapper and program exports. By default, the DOS drive is the selected program's original directory; with a save-folder override, the writable copy of the complete drive is kept at the chosen location. |
| `anyps5` | The PS5 runtime container: `launch/app0/` assets, the converted Mach-O program and modules with their import registries, the `launch/libs` alias to the runtime, conversion records, and Rizin and Ghidra exports. `launch/data` and `launch/_sd` use the game's selected save folder, and `_sd_mem` stays in the container. |
| `nxnative` | Preparation specific to the input and runtime, native launch metadata, extracted resources and shader caches, separate `saves/` and `temp/` folders, and inspection and NSO ELF exports. Runtime settings keep the key paths without copying the key contents. |
| `fvp` | Host logs, diagnostic frame output, asset exports and, for nonstandard layouts or an existing selected save location, the script and archive adapter. A game whose original folder has a compatible layout runs from it directly. |
| `gemrb` | The generated `GemRB.cfg`, an engine cache that can be rebuilt, and exports made on request. Game resources and default saves stay in the original game folder. |
| `hashlink` | Tool outputs made on request. Ordinary Play reads the original bytecode and uses the directory that contains it as the working directory. |
| `wolfrpg` | Prepared WOLF data and browser-player state |

### Per-game runtime data

Examples of `games/<gameId>/runtimes/<runtimeId>/` contents:

| Runtime | Contents |
| --- | --- |
| `nwjs`, `nwjs-patched` | `wrappers/` and `profiles/` |
| `onsyuri_mac`, `onsyuri_web` | `wrappers/` |
| `mkxpz` | `<version>/sessions/<launch-id>/`: the MKXP-Z configuration, launch snapshot and native log of one launch. Every session uses the same shared executable and helper, and no runtime app is copied here. |
| `crossover` | The private Wine bottle and writable game files |
| `sikarugir` | Private Wine prefixes, renderer views, writable game files and logs |

### Shared module data

| Path | Contents |
| --- | --- |
| `modules/rgss/assets/generations/<source-hash>-<generation>/` | Immutable shared RTP, Kawariki and SF2 trees. Each launch keeps the exact generation paths in its configuration. Staging again keeps earlier generations, and concurrent first launches reuse identical content. Explicit removal is refused while an MKXP-Z game uses the assets. |
| `modules/rgss/cheats/` | The shared RGSS cheat runtime, `maclauncher-cheats.rb` |
| `modules/nscripter/assets/` | The shared fallback font |
| `modules/godot/gdre-user/` | The GDRE Tools user environment |

### Shared runtime installations

Runtime managers install shared runtimes under `runtimes/<managerId>/`, for example:

| Path | Contents |
| --- | --- |
| `runtimes/mkxpz/<architecture>/<version>/` | MKXP-Z packages from MacLauncher Builds; the package architecture is `arm64`, `x64` or `universal` |
| `runtimes/mkxpz/<version>/` | Publisher Actions builds and compatible older shared MKXP-Z installations |
| `runtimes/nwjs/<version>/<platformKey>/<variant>/` | NW.js |
| `runtimes/greenworks/<nwjsVersion>/` | Greenworks for one NW.js version |
| `runtimes/greenworks-sdk/<sdkVersion-and-library-hashes>/` | One explicit native SDK input, shared by Greenworks games |
| `runtimes/graphics-shader-library/<pack>/<version>/` | Downloaded shader collection files, dependencies, notices and metadata |
| `runtimes/graphics-neural-models/<content-hash>/` | An imported neural model's manifest and weights, with their verified checksums |
| `runtimes/graphics-xess/<version>/` | The original XeSS runtime, or a verified registration of an existing compatible DLL |
| `runtimes/onsyuri/mac/<version>/<arch>/`, `runtimes/onsyuri/web/<version>/` | ONScripter-Yuri players |
| `runtimes/sdk/<major>/<version>/` | Ren'Py SDKs |
| `runtimes/godot/<version>/mono/` | Godot |
| `runtimes/gdsdecomp/<version>/` | GDRE Tools |
| `runtimes/java/<line>/<version>/<variant>/` | Java runtimes |
| `runtimes/love/stable/<version>/`, `runtimes/love/nightly/<buildKey>/` | LÖVE releases and nightlies |
| `runtimes/vineflower/<version>/` | Vineflower |
| `runtimes/ruffle/<version>/` | Ruffle |
| `runtimes/python/evbunpack/venv/` | The evbunpack Python environment |

A manager directory can contain `custom-runtimes.json`, which records registered local paths and their compatible section IDs. The selected absolute path is the registration's version ID, and the engine version metadata is stored separately. Manager settings keep custom defaults by section in `customDefaults`, and per-game version overrides use the same path IDs. Removing a registration does not delete the referenced files.

Local CrossOver applications stay at their registered paths, which `runtimes/crossover/registrations.json` records. Removing a runtime registration leaves the application installed. A registered version is identified by its application path as well as its version number, so separate installations of the same version can coexist.

### Removing a game

Forgetting a game deletes all of its launcher data: its `games/<gameId>/` directory, including any unpacked or staged assets stored outside the original game directory, and any module-owned application storage, such as `android/apps/<gameId>/`. The original game files stay unchanged. If module or runtime cleanup fails, the library entry stays available so that removal can be retried.

### Derived data upkeep

Some files under `userData` are derived: the app writes them for a single launch or download and either rebuilds them when needed or never reads them again. The launcher runs one upkeep pass each time it starts, in a backend worker, about two minutes after startup. While a game is running or being prepared, or a download is in progress, the pass waits until the launcher is idle; it then runs once, and nothing repeats until the next start. The pass records only what it removed, in `logs/main.log`, and shows nothing in the interface. Before every removal it checks again whether the launcher is busy: if a game starts preparing or running, or a download starts, the pass stops before its next removal.

A pass reads only the folders listed below and the entries it removes. It does not read the entries it keeps or the whole data folder, and it computes no hashes. It never removes an entry modified within the last hour or anything on another volume, such as a mounted disk image. Each entry is first renamed to a hidden `.maclauncher-trash-<id>` name in the same folder, so the store never shows a partly removed entry, and then deleted. Deletion never follows symbolic links or enters another volume, and directories that the app made read-only are made writable first. If the app quits or becomes busy during a pass, or a deletion fails, the trash entry stays and the next pass finishes it before anything else. An error keeps the entry, is recorded once per store in `logs/main.log`, and does not affect the other stores or the launcher.

| Store | Kept | Removed |
| --- | --- | --- |
| Per-launch graphics channels in `games/<gameId>/effects/reshade/`: `source-control-<launch>.json`, `source-status-<launch>.json`, `presentation-control-<launch>.json`, `presentation-status-<launch>.json`, `runtime-status-<launch>.bin` and `browser-source-<launch>.state` | The files of the launch that the game's `launch.json` names | The files of earlier launches. Each new launch of the game removes them before it starts, unless the earlier launch's process is still running. |
| `graphics/payload-bindings/<hash>.json` | Bindings for the launches that games' `launch.json` files name, and bindings whose process is still running | Bindings for ended launches |
| `graphics/payload-bindings/snapshots/` | Snapshots that a kept binding names | All other snapshots |
| `graphics/compute-sessions/<launch-hash>/` | Sessions for the launches that games' `launch.json` files name | Sessions for earlier launches |
| `runtimes/graphics-neural-models/.source-archives/` | Nothing | Model source archives, which are kept only until the model inside has been extracted and verified. Installing another model from the same archive downloads it again, with the usual consent. |
| `games/<gameId>/runtimes/mkxpz/<version>/sessions/` | The two newest sessions of each version, with their logs | Older sessions |
| `graphics/compute-hosts/<identity>/`, the Windows environment, loaders and graphics views that a GPU compute helper uses with one CrossOver application location or Sikarugir version | Hosts of every CrossOver location that Runtimes knows, including an application that is missing or on a disconnected drive, hosts of every installed Sikarugir version, including damaged ones, and any host changed within the last day | Hosts of CrossOver locations and Sikarugir versions removed from Runtimes. Adding or installing one again rebuilds its host at the next launch that needs it. |
| `runtimes/.maclauncher-trash-<id>` | Nothing | A runtime version folder that a removal in Runtimes moved to trash and did not finish deleting |
| `games/<gameId>/effects/.maclauncher-trash-<id>` | Nothing | A private graphics copy of a Mac app that Play removed or replaced and did not finish deleting |
| `runtimes/.maclauncher-removing-<id>` and its `.json` record: a runtime version folder set aside while its manager decides on a removal | Folders whose removing process still runs. After an exit, a folder whose version its manager still lists returns to its place | After an exit, a folder whose version its manager no longer lists takes the trash name |
| `graphics-loader/<identity>/` under `games/<gameId>/runtimes/crossover/` and `graphics/compute-hosts/<identity>/` | The two newest signed loaders in each folder, and any loader created within the last day | Older loaders. A loader that is needed again is rebuilt at the next launch. |
| Temporary folders that an interrupted launch or download left: `modules/rgss/assets/generations/.prepare-<random>`, `.stage-<random>` and `.game-<random>` under `games/<gameId>/modules/hashlink/` and `games/<gameId>/modules/gemrb/`, `prepare-<random>` beside CrossOver graphics loaders, and `runtimes/graphics-neural-models/.download-<random>` | Folders changed within the last day | Older folders. The next launch or download creates a new one. |
| `external/tools/` | The newest GOG download helper for each CPU, the newest Legendary version and the newest Legendary version that can confirm Epic builds | Earlier helper versions that pass verification. Folders that are not recognized as complete helpers stay. |

Two other kinds of data have their own limits. When graphics are prepared for a launch, the game's diagnostic streams (`diagnostics-<launch>.<pid>.jsonl`, `diagnostics-<launch>.neural.<pid>.jsonl` and `gpu-timing-<launch>.<pid>.jsonl`) are pruned to the 32 most recent completed streams, up to 8 MB in total, and streams that a running process is still writing stay. `logs/main.log` holds at most 2 MB, and one earlier segment of up to 2 MB stays in `main.log.previous`. Electron's caches (`Cache`, `Code Cache`, `GPUCache` and each game partition's cache) are limited by Chromium.

Upkeep never touches game records, saves, save snapshots, settings, imported or downloaded games, games' Wine bottles and prefixes, browser profiles or [private game folders from earlier MacLauncher versions](../library/GAME_PREPARATION.md#earlier-private-game-folders), such as earlier FNA overlays. Missing game files, such as those on a disconnected drive, never make a game's data removable; that data stays while the game is in the library. Upkeep works only inside `userData` and never follows symbolic links. Installed runtime versions are removed only through the same removal as **Uninstall** in Runtimes: by the user, or for a version that Play installed as the runtime's own default, recorded in `runtimes/automatic-installs.json`, once the section's current default is a newer usable installed version and nothing names or resolves to the recorded one, as [Runtimes](../runtimes/README.md) describes. Explicit **Install**, **Set default** and removal clear a version's record. The [module system](MODULES.md#standard-module-layout) describes how modules declare their derived stores.

## settings.json

`settings.json` stores only global settings and never per-game data. It has three top-level keys:

- `modules`: settings for each module, keyed by module ID;
- `runtimes`: settings for each runtime manager, keyed by manager ID;
- `launcher`: global launcher settings.

Example:

```json
{
  "modules": {
    "example": {
      "defaultRuntime": "electron",
      "runtimeSettings": {
        "electron": {
          "enableProtections": true
        }
      }
    }
  },
  "runtimes": {
    "nwjs": {
      "defaultVersion": null,
      "greenworksDefaultVersion": "0.103.1"
    },
    "onsyuri": {
      "mac": {
        "defaultVersion": "0.7.5",
        "defaultVariant": "arm64"
      },
      "web": {
        "defaultVersion": "0.7.5"
      }
    }
  },
  "launcher": {
    "appearance": "system",
    "networkAccess": false,
    "startSteamClient": "ask",
    "showIcons": true,
    "showNonDefaultTags": true,
    "library": {
      "version": 2,
      "order": [
        "e4f0f1e2c7f24b6aa1b4d6b1c9e5a8f2"
      ],
      "sort": {
        "mode": "custom",
        "direction": "asc"
      },
      "favorites": []
    }
  }
}
```

The launcher fills in missing fields when it loads the file.

### Launcher settings

- `launcher.appearance` is `"system"`, `"light"` or `"dark"`. A missing or unknown value becomes `"system"`. The value sets Electron's `nativeTheme.themeSource` at startup and whenever it changes.
- `launcher.networkAccess` is the initial network choice for newly imported games. Each game record has its own boolean `networkAccess`, which applies to every runtime. Changing the global default does not change saved game choices, and the value is separate from runtime settings.
- `launcher.startSteamClient` is the "Steam client on Play" setting: `"ask"` (the default), `"automatic"` or `"never"`. A game record's optional `startSteamClient` overrides it for that game, and a record without the field uses the launcher setting. An earlier boolean value reads as `"ask"` when `true` and as `"never"` when `false`. See [Steam API support](../runtimes/STEAM_API.md).
- `launcher.showIcons` and `launcher.showNonDefaultTags` are the global toggles for game icons and non-default tags.
- `launcher.checkForUpdatesAtLaunch` turns on the [update check](../UPDATES.md) at each start. Only `true` turns it on, and it defaults to `false`.
- `launcher.graphicsShortcuts` maps the graphics shortcut actions `bypass`, `screenshot` and `windowGraphics` to accelerators such as `"Control+Option+Command+B"`. An action without an entry has no shortcut. Loading keeps only valid, distinct assignments of known actions, by the rules in [Graphics shortcuts](UI_GUIDE.md#graphics-shortcuts).
- `launcher.graphicsScreenshotFolder` is the absolute path of the folder for processed screenshots. A `null` or relative value is removed, and without the field screenshots go to `~/Pictures/MacLauncher`.
- `launcher.library` holds the library state described below.

### Library state

`settings.launcher.library` stores the library order, the sort preference and the favorites. The manual order is independent of the active sort, search and filters. New games are added at the top, and updating, importing again or playing an existing game keeps its position.

- `version`: the library state schema version, currently 2. Version 1's unused sort metadata migrates once to Default, keeping the manual order and the favorites. Version 2 stores the active sort.
- `order`: the ordered array of `gameId` values, which is the Default (manual) order.
- `sort`: the active mode (`custom`, `recent`, `added`, `alphabetical` or `type`) and direction (`asc` or `desc`). `custom` is labeled Default and always uses the manual order in ascending direction. Other modes change only the presentation. Ties keep the manual order, and unknown dates stay last in either direction.
- `favorites`: the starred game IDs. Only the Default sort shows favorites in their own group above Games; every other sort places them normally. Reordering one group in Default keeps the other group's underlying positions.

The renderer receives the complete saved library. `launcher:setGameFavorite` and `launcher:setLibrarySort` update their fields independently, save the settings atomically through the existing settings writer and broadcast the updated state. Forgetting or deleting a game removes its favorite along with its order entry. Search, the game-type filter and the scope filter apply after sorting.

Bulk selection and missing-path results are temporary renderer state. Changing a filter drops selections that become hidden, and bulk requests include only the visible selected paths. Missing-game checks run through `launcher:findMissingGames` after an explicit user action. They use the shared availability check and count games whose files are not found, including those on a disconnected drive, as missing, while files that cannot be read or a location that does not respond count as unavailable but not missing. While a game's original files are not on disk, its entry in the renderer state carries `availability` with `reason` (`missing`, `unresponsive` or `unreadable`) and a `message` naming the cause. This field is never written to `game.json`. `launcher:forgetGames` removes the selected library entries and their userData. `launcher:deleteGames` asks once in a native dialog and moves the games to the Trash. Both batch requests check the paths against the saved library, remove duplicates and return the successful removals together with any failures for each path.

`launcher:locateGame` takes one game path and resolves to the game's new path, or `null` when the chooser is canceled. The backend asks for the new location through the host's chooser, runs import detection there and accepts the result only when its module is the entry's `moduleId`. The record in `games/<gameId>/game.json` then receives the new `gamePath`, or the new `importPath` when MacLauncher keeps the playable copy and the imported file is the game's root, such as an installer that MacLauncher unpacked. Absolute paths stored inside the old root, in any field except `name` and `notes`, are rebased onto the new root, a forced metadata refresh replaces the detected data, and the metadata cache is written for the new location. The `gameId`, settings and everything stored under `games/<gameId>/` stay. The main process moves its notices for the old path, refreshes availability and pushes the state; the renderer keeps the inspector on the same `gameId`. A refusal, such as a different detected module (`GAME_TYPE_MISMATCH`) or a location already used by another entry (`GAME_LOCATION_IN_USE`), rejects with a one-sentence reason and leaves the record unchanged.

Relocation also rewrites the launcher's own JSON records under `games/<gameId>/`, such as extraction receipts and maps keyed by paths: every absolute path inside the old root, as a value or as a key, moves to the same place under the new root. A path that only shares the old root's prefix, such as `/Games/Foobar` for `/Games/Foo`, is not inside it. Symbolic links whose targets lie inside the old root are replaced by links to the same place under the new root; no link is followed, and other links stay. Folders whose contents belong to the game or its runtime are not walked: `saves`, `save-snapshots`, `logs`, `partition`, `profiles`, `prefixes`, `bottles`, `home`, `files`, `extracted`, `game`, `play`, `drive-c`, `app0`, `appimage`, `mono-projects`, `source-projects`, `assets`, `exports` and `decompiled`. At the top of such a folder, only JSON files with `maclauncher` in their names, such as `.maclauncher-godot-extract.json`, are read, and `.relocation-backups/` is never read. Files larger than 32 MiB, files that are not valid JSON, documents nested more than 256 levels deep and documents whose keys would overlap after the rewrite stay byte-for-byte unchanged. A JSON file named with the SHA-256 of its own bytes, such as `receipt-<sha256>.json`, keeps its name and bytes; the rewritten document is written to a new file named with its own SHA-256, and references to the old name in the other records are updated.

Before its first change, relocation writes `.relocation-backups/<id>.in-progress.json`, which names the move, and it keeps the original bytes and links under `.relocation-backups/<id>/`. An error part-way through restores them. After a complete relocation, the marker and every older backup folder are removed, so only the latest relocation's originals remain. At the next start after an interrupted relocation, a relocation whose `game.json` still has the old root is undone from its backups; otherwise it had finished, and only its marker is removed. For a container import, such as an installer, the record's source paths, including companion files in the import's folder, move before the container reader verifies the new input. A refused location restores the original records and removes any unpacked copy that the attempt added under `containers/`; copies that existed before stay.

`shortcuts.json` lists the `.command` files MacLauncher saved for the game with the SHA-256 of each script. Relocation rewrites a listed script that still has that digest and names the old root as its game path, and also rewrites and lists such unchanged generated scripts found directly on the Desktop; an edited script is marked `stale` and kept. `game.json` keeps `shortcutPathHashes`, the SHA-256 hashes of the game's earlier `gamePath` and `importPath` values. When a command's game path no longer exists and is not a current library path, the command runs the one library game whose hashes include it.

### Module settings

Module settings are stored under `settings.modules[<moduleId>]`, with defaults taken from the manifest's `settingsDefaults`. A module without settings still has an empty section in the UI. Default runtime settings for the game type live under `settings.modules[<moduleId>].runtimeSettings`.

### Runtime manager settings

Runtime manager settings are stored under `settings.runtimes[<managerId>]`, and each runtime manager defines how its settings are normalized and updated.

- NW.js keeps `greenworksDefaultVersion` for older libraries. The Greenworks section shows the selected NW.js host as its pair default, and setting a pair default explicitly selects that host. Installations, SDK imports and refreshes keep the defaults, and per-game NW.js versions still take priority.
- ONScripter-Yuri settings live under `settings.runtimes.onsyuri.mac` and `settings.runtimes.onsyuri.web`.
- Ren'Py SDK settings live under `settings.runtimes.sdk.v7` (Ren'Py 7 and earlier, Python 2) and `settings.runtimes.sdk.v8`.
- Java settings live under `settings.runtimes.java`: `defaultLine`, `lines.<line>.defaultVersion`, `lines.<line>.defaultVariant` and `vineflower.defaultVersion`.
- LÖVE settings live under `settings.runtimes.love`: `stable.defaultVersion` and `nightly.defaultVersion`.
- Ruffle's default version is `settings.runtimes.ruffle.defaultVersion`.
- The neural model manager's `defaultVersions` keeps a separate preference for each operation, and falls back to a compatible legacy `defaultVersion`.

## Game records

Each game receives a unique `gameId` on import, and its directory `games/<gameId>/` holds its record, `game.json`.

The current game-record schema version is 2. A record in an older format is converted once and saved in the current format; records in the current or a newer format skip the conversion.

Example:

```json
{
  "schemaVersion": 2,
  "gameId": "e4f0f1e2c7f24b6aa1b4d6b1c9e5a8f2",
  "order": 0,
  "createdAt": 1717000000000,
  "updatedAt": 1717000100000,
  "gamePath": "/Games/MyGame",
  "importPath": "/Games/MyGame",
  "name": "MyGame",
  "networkAccess": false,
  "moduleId": "renpy",
  "gameType": "scripted",
  "indexDir": null,
  "indexHtml": null,
  "contentRootDir": "/Games/MyGame",
  "defaultSaveDir": "/Users/<user>/Library/RenPy/MyGame",
  "saveDirOverride": null,
  "nativeAppPath": null,
  "runtimeId": "sdk",
  "runtimeData": {},
  "runtimeSettings": {},
  "moduleData": {},
  "cheats": {},
  "iconPath": "/Users/<user>/Library/Application Support/maclauncher/games/e4f0.../icons/icon-app.png",
  "iconSource": "app",
  "lastPlayedAt": 1717000100000,
  "lastBuiltAt": null
}
```

### Game IDs

`gameId` values are random hexadecimal identifiers. They are not derived from `gamePath`, and the older stable hash IDs are no longer used. The ID is stored in `game.json` and names the game's directory under `games/`.

### Normalization

`normalizeGameEntry` in `src/main/main.js` normalizes every entry. The main fields are:

Identity and paths:

- `gameId`: the unique game ID and directory name.
- `gamePath`: the absolute path to the game root.
- `importPath`: the original import path, file or folder, when available.
- `contentRootDir`: the path used for runtime content.
- `releaseRootDir`: the release folder around `gamePath`, when detection proves one, such as the NW.js release around an imported `www` folder. Absent otherwise.
- `indexDir`, `indexHtml`: the resolved web index paths, if any.

Module:

- `moduleId`: the module ID used for settings and hooks.
- `moduleLabel`, `moduleShortLabel`, `moduleFamily`: module metadata.
- `gameType`: the module's game type label.
- `moduleRuntimeSupport`: the runtime IDs supported for this game.
- `moduleSupports`: the capability flags `cheats`, `cheatsPatcher`, `saveEditing` and `saveLocation`.
- `moduleData`: module-specific metadata and overrides, such as library versions and tools-button overrides; see [module data](#module-data).

Runtime:

- `runtimeId`: the selected runtime.
- `runtimeData`: per-runtime overrides such as the version and, when supported, the variant; see [runtime data](#runtime-data).
- `runtimeSettings`: the game's runtime settings overrides, when set.

Saves:

- `defaultSaveDir`: the save directory detected by the module.
- `saveDirOverride`: the game's save folder override.
- `saveLocations`: directories derived from engine detection, each with a role, source and confidence. The optional `resolveSaveLocations` module hook refreshes them; they are not stored as user-authored paths.

User choices:

- `name`: the display name; see [display names](#display-names).
- `notes`: plain text written by the user. It defaults to empty, survives detection and launches and is stored only in the game's `game.json`. An update can hold at most 65,536 characters.
- `networkAccess`: whether the game may use the network, for every runtime.
- `startSteamClient`: the optional per-game "Steam client on Play" choice, `"ask"`, `"automatic"` or `"never"`, which overrides `launcher.startSteamClient`. The field is absent when the game uses the launcher setting.
- `launchArguments`: additional startup arguments as quoted text, stored once per game and independent of runtime settings. Detection, runtime changes and saved `.command` shortcuts keep the value. Parsing keeps quoted empty arguments and performs no shell expansion. The limits are 32,768 characters of text, 256 arguments and 16,384 characters per argument.

Icons, cheats and timestamps:

- `iconPath`: the absolute path to the cached or module-provided icon image.
- `iconSource`: where the icon came from: `module`, `module-default`, `app` or `exe`, or `null` when unset.
- `cheats`: the normalized cheat payload, if the module supports cheats; see [cheats](#cheats).
- `createdAt`, `updatedAt`: timestamps for record maintenance.
- `lastPlayedAt`: when the game was last played.
- `lastBuiltAt`: when the last build or patch action ran.
- `ephemeral`: `true` for a session entry that exists only while its session runs, such as a window that receives graphics. The library shows such an entry first, with only the controls of its session. An `ephemeral` marker file in its directory marks the entry and its directory for removal when the session ends, or at the next start after a crash.
- `order`: the legacy UI order. The library order in the launcher settings decides the list, and this field places only games that order does not include. Reordering or removing a game copies the library order into every record. A new game gets a value below every other record, and the other records are not rewritten.

### Display names

A title from the game's own metadata is kept. A readable folder title replaces a compact file or package identifier, an engine's default executable name or a name that carries a window-title key hint such as `(F1: Help)`. Otherwise, a trailing key hint is removed. A name edited by the user survives metadata refreshes.

### Graphics fields

`entry.effects` stores the canonical ordered effect graph that both the Simple and Advanced views use. Switching views keeps the graph, and semantic shader tags do not decide how a row runs. Records from MacLauncher v0.4.0 that still hold `entry.reshade` and `entry.graphics` selections are [upgraded](../graphics/EFFECT_PLANS.md#upgrading-v040-settings) to `effects` when they are read.

- Schema 2 has explicit Downsample and Upscale rows, extents for each row and shared output settings.
- `output.toneMapping` stores an optional final color policy, shared with export.
- `depthInput` stores the game's non-default ReShade depth-input definitions for `.fx` rows that read depth.
- A model-backed Image filter keeps its shader parameters and an optional `settings.modelPath`, where `null` selects Automatic. The model's validated descriptor supplies the model operation. Scalar estimates remain attachments and never become renderer scene guides or standalone RGB neural rows.

Games start with scaling turned off, and newly imported videos use native Lanczos Sharp filtering. The [graphics pipeline](../graphics/PIPELINE.md) describes the plan schema, processing dimensions, source allocation and model bindings.

### Cheats

Cheat data belongs to the game, not to the module. The record's `cheats` field and `games/<gameId>/cheats.json` hold the same payload. When `cheats.json` exists, the launcher loads the record's cheats from it, and it writes every update back to the file, so runtime helpers can read a stable per-game cheat file. The [per-game directory](#per-game-directory) lists the related tool logs and RGSS teleport slots.

### Module data

`moduleData` holds module-specific data: library version overrides (`libVersions`), module UI overrides such as tools-button visibility, and any other data the module keeps. The fields of several modules follow.

Java:

- `jarPath`: the detected JAR used for launch.
- `mainClass`: the manifest `Main-Class`, when available.
- `requiredJava`: the minimum runtime major version, detected from JAR metadata and bytecode.
- `recommendedJava`: the recommended runtime major version, when multi-release entries are present.
- `minimumLine`: the lowest Java LTS line that runs the detected bytecode. A per-game version is valid at or above it.
- `runtimeLine`: the Java LTS line used by Auto and for mapping the runtime section.
- `java8Dependencies`: the sorted Java 8 platform dependencies found by detection, such as `javax.xml.bind`, `javax.script engine` or `macOS native libraries without arm64`. Any entry keeps Auto on Java 8 for Java 8 bytecode.
- `detectedJavaSource`: `bytecode`, `manifest`, `mixed` or `fallback`.
- `detectedJavaConfidence`: `high`, `medium` or `low`.
- `extractedRoot`: the game's Vineflower output folder.

LÖVE:

- `sourceKind`: the source type, such as `archive`, `source`, `app`, `windows-fused`, `linux-fused`, `linux-dir` or `appimage`.
- `packagedPath`: the original packaged input, when the launch uses a staged target.
- `launchTargetPath`: the resolved path passed to the LÖVE runtime.
- `embeddedLovePath`: the embedded `.love` path inside a fused bundle, when available.
- `detectedVersion`, `detectedVersionNormalized`, `detectedVersionSource`: version metadata from app bundles, archives or packaged libraries.
- `saveIdentity`: `t.identity` from `conf.lua`, when detected.
- `appImageExtractRoot`, `appImageLaunchRelativePath`, `appImageReady`, `appImageExtractedAt`: the state of the extracted AppImage cache.
- `resolvedChannel`: the effective manager section, `stable` or `nightly`, used for UI routing.
- `runtimePromptSuppressedFor`: the game's suppression key for declined runtime install prompts.
- `extractedReady`: whether extracted output exists.
- `extractedAt`: when extraction last ran.

Flash:

- `swfPath`: the absolute path to the imported `.swf` file.

RGSS:

- `rgssVersion`: the detected version, `RGSS1`, `RGSS2` or `RGSS3`.
- `rtpId`: the detected RTP, `Standard`, `RPGVX` or `RPGVXAce`.
- `execName`: the detected base name of the Windows executable.
- `assetsStaged`: whether the bundled assets are staged.
- `runtimeSource`: the source of the installed runtime, such as `MacLauncher Builds` or `GitHub Actions`.
- `archivePath`: the detected RGSS archive used for extraction.
- `decryptedRoot`: the extraction output folder in userData.
- `decryptedReady`: whether extracted output exists.
- `decryptedAt`: when extraction last ran.
- `decryptedMode`: `decrypt` or `reconstruct`.

RPG Maker MV and MZ:

- `clipboardPluginInstalled`: whether Clipboard_llule is installed and enabled.
- `saveSlotsPluginInstalled`: whether CustomizeMaxSaveFile is installed and enabled.
- `decryptedRoot`, `decryptedReady`, `decryptedAt`, `decryptedMode`: the extraction state, as for RGSS.

Ren'Py:

- `version`: the detected Ren'Py version.
- `major`: the normalized major version, 7 for Ren'Py 7 and earlier and 8 for Ren'Py 8.
- `baseName`: the base name of the launcher script.
- `gameOnly`: true for game-only imports.
- `patched`, `partial`: the patch status.
- `builtSdkVersion`: the SDK used for the last build.
- `extractedRoot`: the extraction output folder in userData.
- `extractedReady`: whether extraction output exists.
- `extractedAt`: when extraction last ran.
- `extractedIconPath`: the cached icon path from extracted sources.
- `extractedOverridesFromExtraction`: true when icon or save overrides came from extracted files.

Godot:

- `packagedType`: `app-bundle`, `pck`, `exe-embedded`, `exe-sibling-pck`, `elf-embedded`, `elf-sibling-pck` or `project-dir`.
- `packagedPath`: the detected input path.
- `packPath`: the PCK or executable path, when applicable.
- `packOffset`, `packSize`: the embedded pack location in a packaged launcher binary.
- `projectRoot`: the project directory of a `project-dir` input.
- `detectedVersion`: the detected engine version, such as `4.2.1` or `3.1.x`.
- `detectedMajor`, `detectedMinor`: the detected major and minor versions.
- `detectedSource`: `PCK header`, `Project config` or `GDRE Tools`.
- `detectedLabel`: the derived display string for version detection, such as `3.4.1 (PCK header)`.
- `detectedBytecodeRevision`, `detectedBytecodeVersion`: the result of the last GDRE Tools detection.
- `runtimePromptSuppressedFor`: the suppression key, `version:<ver>` or `major:<major>`.
- `extractedRoot`: the GDRE Tools output folder.
- `extractedReady`: whether extraction output exists.
- `extractedAt`: when extraction last ran.
- `extractedIconPath`: the cached icon path from extracted sources.
- `extractedOverridesFromExtraction`: true when icon overrides came from extracted files.
- `gdreInstalled`, `gdreVersion`: whether GDRE Tools is installed, and its version.
- `gdreLabel`: the derived display string for the GDRE Tools status, such as `GDRE Tools (2.4.0)`.
- `gdreLastAction`, `gdreLastActionAt`, `gdreLastActionStatus` (`success` or `error`), `gdreLastActionTarget`, `gdreLastActionOutput`, `gdreLastActionError`: the ID, time, status, input path, output path and error of the last GDRE Tools action.

Tyrano:

- `version`: the detected Tyrano version.
- `packagedType`: `zip-exe`, `package.nw` or `asar`.
- `packagedPath`: the path to the packaged payload.
- `extractedRoot`: the extracted bundle folder in userData.
- `extractedReady`: whether the extraction is ready.
- `bundleRevealPath`: the path that the Reveal action opens.

Construct:

- `constructRuntime`: the detected Construct runtime, 2 or 3.
- `packagedType`: `zip-exe` or `package.nw`.
- `packagedPath`: the path to the packaged payload.
- `extractedRoot`: the extracted bundle folder in userData.
- `extractedReady`: whether the extraction is ready.

NScripter:

- `packagedType`: `zip-exe` or `7z-exe`.
- `packagedPath`: the path to the packaged payload.

### Runtime data

`runtimeData` stores per-runtime overrides, which runtime managers interpret when they launch a game:

- `runtimeData[<runtimeId>].version`: the runtime version.
- `runtimeData[<runtimeId>].variant`: the runtime variant, when the manager supports variants.
- `runtimeData[<runtimeId>].line`: a manager-specific line, when supported; Java uses it.

Flash uses `runtimeData.ruffle.version`, and LÖVE uses `runtimeData.love.channel` and `runtimeData.love.version`. The ONScripter-Yuri manager also reads `runtimeData.onsyuri` as a shared override for the NScripter runtimes.

## Runtime settings

Runtime settings combine four layers. Each layer overrides the one before it:

1. the defaults in the runtime's settings schema;
2. global runtime defaults, in `runtimes/<runtimeId>/settings.json`;
3. game type defaults, in `settings.modules[<moduleId>].runtimeSettings[<runtimeId>]`;
4. per-game overrides, in the `runtimeSettings[<runtimeId>]` field of `games/<gameId>/game.json`.

A game without its own override uses the game type default. An override that matches the inherited value is omitted, so later changes to the defaults reach every game that does not override them. Cached settings distinguish schemas that share a runtime ID, and reading settings never rewrites defaults.

## Writes and damaged files

The Node backend and the Electron launcher use the same per-game record paths. Folder, executable and index imports are matched again by the detected game path, so different inputs for the same game keep its game ID and overrides.

Settings, game records, cheats and explicit metadata are written through a temporary file and an atomic rename. Cheat subscriptions watch the parent directory, so replacing the file does not leave them on an old inode. Rename notifications reread the file even when the operating system reports only the temporary filename. Replacing the directory reopens its watcher on the new directory. A watcher whose directory is missing, or that fails, is set up again after a backoff of 100 ms to 2 s and reports one change once it is active. A newly opened watcher also schedules an initial read to cover edits made during registration.

A settings change is merged into the stored document as it is read at that moment, and then written atomically. Long-running command-line module actions compare the settings before and after they run and merge only their own changes into the current file, and per-game action changes work the same way. These writes are atomic, but they are not cross-process transactions and there is no global library lock, so the same setting should not be edited in two hosts at once. [Settings writes](BACKEND.md#settings-writes) describes the backend transaction.

A stored document that cannot be read is never replaced with defaults. After a read error, the change fails and the document stays unchanged. A `settings.json` that is not a JSON object is first copied byte for byte, atomically, to `settings.unreadable-<time>.json` before any save, and one notice names the copy. Its complete top-level settings up to the first damaged one stay in use, and the rest use their defaults.

Before a change, the other durable documents follow the same rule. These are the global runtime defaults (`runtimes/<runtimeId>/settings.json`), game records (`game.json`), per-game cheat settings, the Steam and external store installation indexes and video playback positions. A damaged document is copied byte for byte beside the original as `<name>.unreadable-<time>.json`, one notice names the copy and its readable top-level members are kept. A game whose record is damaged is left out of the library until it is imported again; the new record then replaces the damaged one, which remains as the copy.

When a document cannot be read at all, it is not replaced, and the change fails in its own way:

- a runtime defaults change, a game record update or an installation index update fails with its reason;
- a cheat edit fails, while a launch keeps the stored cheat file for the game to read;
- playback positions are not saved for that session.

### Existing Windows environments

The per-game CrossOver and Sikarugir runtime settings store `environmentReference`: `private`, or a JSON-encoded record with `kind`, absolute `path`, and optional `name` and `bottleId`. Existing environment contents remain at that path. Runtime metadata retains the external reference alongside the resolved bottle or prefix path. Private initialization requires an ownership capability issued for launcher-owned game or compute data. Removal and profile adoption refuse directories containing a referenced external environment.
