# Infinity Engine (GemRB)

Infinity Engine games are role-playing games such as Baldur's Gate, Icewind Dale and Planescape: Torment. MacLauncher plays them with [GemRB](https://github.com/gemrb/gemrb), which runs the original game data as a native macOS process with embedded Python. Playback does not load Electron, run Windows programs or use Wine.

| Runtime | Description |
| --- | --- |
| GemRB (default) | Native GemRB command-line player from MacLauncher Builds |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts an unpacked game folder, its executable or its resource index (`chitin.key`). The game data consists of the resource index, dialog tables and the other original files.

A standalone game in a `game/` folder supplies its GUI script profile automatically when a single sibling `GUIScripts/<profile>/Start.py` exists. Other Python files do not establish a profile or a version.

## Detection and versions

The inspector shows the detected game type, the GAME format version and the number of indexed resources, with the engine version, data-format version and runtime version in separate fields. **Inspect game version**, in the inspector's **Advanced** group, runs this inspection on demand. Playback uses the format the game was detected with.

## Preparation and storage

Play writes a generated `GemRB.cfg` and a rebuildable cache in `userData/games/<gameId>/modules/gemrb/`. `GamePath` and the working directory point directly to the imported game folder. Resources, configuration files beside them and relative writes use their original paths. **Prepare configuration**, in the **Advanced** group, writes the configuration without starting the game.

## Saves

`SavePath` defaults to the original game folder, following GemRB's normal layout. GemRB reads and writes its `save` and `mpsave` folders there. A per-game save-folder override replaces that default.

Earlier MacLauncher versions kept GemRB saves, configuration writes and a copy of the GUI scripts in private folders in launcher data. During the first startup after an upgrade, those files are recovered once into the original game folder, and GUI script files into the selected **Folder containing GUIScripts**, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Files missing from the original game return to their original relative paths. Existing original files stay unchanged, and private versions that differ are kept beside them as `<filename>.MacLauncher-conflict-<id>`. A script copy made from the runtime's own scripts, and other files the game wrote beside the earlier configuration, have no matching original location, so they stay in place. A private folder that a save-folder override still names stays in use, and Play does not read the other earlier folders.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Version | Default | The GemRB version for this game. |
| Game type | Auto-detect | Baldur's Gate, Baldur's Gate II, Icewind Dale, Icewind Dale II, Planescape: Torment or the GemRB demo. |
| Custom game profile (optional) | | For standalone games: the author's profile name and GUI script and data paths. |
| Width, Height | `800`, `600` | Window size. |
| Fullscreen | Off | |
| Enable GemRB cheat keys | Off | Turns on GemRB's own cheat keys. |
| GemRB data directory (optional) | | Replaces the default data folder. |
| Folder containing GUIScripts (optional) | | Replaces the default GUI script folder. |
| Plugins directory (optional) | | Replaces the default plugin folder. |

The cheat keys setting is the upstream engine toggle; it does not patch game scripts or add a save editor.

**Custom game profile** selects a third-party GUIScripts profile by its lowercase identifier, which must be a safe name. **Folder containing GUIScripts** is the parent folder of a `GUIScripts/` folder. The selected scripts run inside the native game process, and GemRB reads the original script tree directly. The resource and plugin paths of the GemRB command-line bundle are supplied automatically, and the optional directory settings replace these default locations.

## Near Infinity

**Open Near Infinity**, in the inspector's **Game tools** group, opens the game in [Near Infinity](https://github.com/Argent77/NearInfinity), a resource editor with the game's key file already selected. Near Infinity browses resources, decompiles scripts and edits supported Infinity Engine files, including saved games. It works independently of GemRB playback.

Near Infinity opens the original game's resource index. Browsing does not change anything, but edits saved in Near Infinity can change original game files. Files exported from Near Infinity go to the destination chosen in that application.

**Runtimes → GemRB → Near Infinity** lists the tool's versions. Refresh finds stable releases from version 2.4 onward in the maintained upstream repository. If the release list cannot be loaded, a known compatible release built into MacLauncher can still be downloaded.

Near Infinity needs Java 17 or later and runs on the same Temurin installations that [Java](JAVA.md) games use; a missing compatible Java is downloaded with it. Near Infinity's update checks and its own game-launch command are disabled; games are played from the library.

Near Infinity keeps its Java preferences in the normal macOS preferences store. Other files it writes relative to its home folder live in the launcher's runtime data folder, apart from game files and GemRB saves. Its LGPL license and the notices of its bundled dependencies are kept with it.

## Runtimes

### GemRB

GemRB is the default runtime, packaged by MacLauncher Builds, and its engine options are in Settings and the inspector.

Each package contains embedded Python, SDL2, SDL2_mixer and the selected game-format plugins, together with a native command-line and Cocoa integration. The optional upstream demo is left out. Runtimes lists each package's architectures and minimum macOS version.

When neither the game nor the global settings name a version, Play uses the newest installed version that runs on this Mac, or otherwise the newest listed version.

GemRB asks to come to the foreground through the shared native launch helper and the [SDL foreground hint](https://wiki.libsdl.org/SDL2/SDL_HINT_MAC_BACKGROUND_APP), which is set only for the game process. The helper waits for the game's window and makes a single AppKit activation request, so the launcher stays responsive. No Accessibility permission or system setting change is needed.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected engine and its inspector tools stay available with either runtime.

## Versions and installation

GemRB versions follow the [shared selection rules](../runtimes/README.md#versions). Refresh loads the MacLauncher Builds package list, and packages install under `userData/runtimes/gemrb/<arm64|x64>/<version>/`.

## Command-line inspection

`pnpm launch --game /path/to/game --inspect` inspects a game, and `--action inspectGame` runs the GemRB version inspection.

## Source and licenses

Each GemRB package's MacLauncher Builds release commit contains the exact upstream commit, the dependency definitions, MacLauncher's changes, the notices and the build script. MacLauncher's changes add a command-line entry point that reads its configuration from `-c <config>` and exports shared scripting-reference classes. The optional Cocoa settings nib is not needed.

- [GemRB installation and configuration](https://gemrb.org/Install)
- [GemRB source and GPL-2.0-or-later license](https://github.com/gemrb/gemrb/tree/b33f0e7275ea1fc8a82459b418f6a7b5f1b40108)
- [GAME importer format handling](https://github.com/gemrb/gemrb/blob/b33f0e7275ea1fc8a82459b418f6a7b5f1b40108/gemrb/plugins/GAMImporter/GAMImporter.cpp)
