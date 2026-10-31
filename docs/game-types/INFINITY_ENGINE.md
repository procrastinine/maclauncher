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

Play prepares a private configuration, resource aliases and save folders automatically. The generated `GemRB.cfg`, its cache and the saves live in `userData/games/<gameId>/modules/gemrb/`. **Prepare configuration**, in the **Advanced** group, runs this step without starting the game; per-game configuration needs the GemRB command-line runtime, which stock GUI apps cannot use.

GemRB reads the game through a per-game folder of links and copies, which keeps configuration writes out of the imported folder:

- Known static engine resources, including BIF archives, KEY and TLK tables and graphics and audio resources, are linked for reading.
- INI settings, logs, path files, character exports and unknown extra files are copied privately.
- New files are written inside the private tree.
- Symbolic links in the source folder are ignored.

## Saves

`SavePath` in the generated configuration points to the game's save folder in launcher data, and GemRB creates its own `save` and `mpsave` folders inside it. A per-game save-folder override is respected. Existing portable saves are not copied from the original game automatically.

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

**Custom game profile** selects a third-party GUIScripts profile by its lowercase identifier, which must be a safe name. **Folder containing GUIScripts** is the parent folder of a `GUIScripts/` folder. The selected scripts run inside the native game process, and the small GUI script tree is copied privately before launch. The resource and plugin paths of the GemRB command-line bundle are supplied automatically, and the optional directory settings replace these default locations.

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
