# Game preparation and storage

MacLauncher imports a game from its original folder, executable or supported package, with no separate preparation step. This page covers how the library loads, how a game is prepared when it is played, where game data is stored, what happens when a game's files are missing, and how games are removed.

**Play** chooses a matching runtime, [installing it if needed](../runtimes/README.md#downloads-and-offline-use), and runs any preparation the game needs as part of the same launch, so no separate prepared copy has to be created and nothing has to be extracted by hand. During preparation and process startup the game shows **Starting**, and **Cancel** stops a pending preparation. **Stop** becomes available as soon as the game process exists, even while its first window is still loading.

## Library loading

At startup the library shows the stored entries straight away and refreshes each game's metadata and runtime choices in the background. Selecting or playing a game moves its pending checks ahead of the others. When a game's files have not changed since the last check, its cached detection, version, icon and save information is reused, while new imports and changed games are detected again. A slow or failed check affects only its own game, so the library and other imports stay responsive.

Several imports can run at once. Repeated requests to import the same file or folder share one import, and a completed import writes only its own game's record. Runtime and availability changes are also collected into one library update, so the list is not redrawn for each change.

## Storage locations

| Contents | Location |
| --- | --- |
| Installed runtimes | `~/Library/Application Support/maclauncher/runtimes/` |
| Per-game runtime files, extracted containers, exports and private saves | `~/Library/Application Support/maclauncher/games/<gameId>/` |

Backend callers can choose a different root with `userDataDir`.

## Original files and private files

When the runtime supports a game's layout, Play uses the selected original game directory directly. If an engine cannot use an input in place, MacLauncher prepares only the platform, script or executable adaptation that the engine needs. Either way, the engine keeps its usual save and configuration locations unless a save-folder override has been chosen for the game, and each game keeps its own library record and settings.

A few tools do write into the game folder. The [NW.js Tools patch](../tools/CHEATS.md#nwjs-patching) used by RPG Maker MV and MZ games and the [Ren'Py cheat add-ons](../tools/CHEATS.md#renpy-cheat-add-ons) add their files there, and **Unpatch** or the add-on's remove button takes them out again. Edits saved in [Near Infinity](../game-types/INFINITY_ENGINE.md#near-infinity) also change the game's resources. For a game inside an archive, these tools work on its extracted project folder instead. Engine-generated caches, compiled scripts and saves are left to the selected engine's normal behavior.

ZIP payloads, archives appended to executables, ASAR files and similar containers are extracted only when the selected runtime cannot read the packaged content directly, and the extracted content stays in the game's private launcher data. Explicit decompilation and Mac application exports write separate output, because they exist to produce extracted source or a distributable app.

What each game type or runtime prepares is described on its own page:

- [Ren'Py SDK projects](../game-types/RENPY.md#renpy-sdk)
- [NW.js projects](../runtimes/WEB_RUNTIMES.md#preparation-and-launch) for web-based game types
- [RPG Maker XP/VX/VX Ace on MKXP-Z](../game-types/RPGMAKER_XP_VX.md#preparation-and-launch)
- [Construct](../game-types/CONSTRUCT.md#preparation) and [Tyrano](../game-types/TYRANO.md#preparation-and-saves)
- [RPG Maker 2000/2003 on EasyRPG](../game-types/RPGMAKER_2000_2003.md#saves)
- [ScummVM](../game-types/SCUMMVM.md#saves-and-storage)
- [FAVORITE / FVP](../game-types/FVP.md#preparation-and-storage)
- [WOLF RPG Editor](../game-types/WOLFRPG.md#detection-and-preparation)
- [CrossOver](../runtimes/CROSSOVER.md#bottles-and-private-game-files) and [Sikarugir](../runtimes/SIKARUGIR.md#private-game-files-and-prefixes)

<a id="writable-input-views"></a>

## Original game paths

Import, metadata, Play and tools all use the game's original source paths. When a game has to be extracted, the extracted folder becomes its writable source folder, and no second writable copy is made from it. Executable or script conversions, generated engine configuration, exports and runtime-specific input adapters are kept apart from the original game.

MacLauncher stores each installed runtime and its shared dependencies only once. Neither a runtime helper nor the private graphics copy of a restricted native app copies or links the whole game tree.

### Earlier private game folders

Earlier MacLauncher versions kept private folders for some games in launcher data. The first startup after an upgrade processes these folders, at most once, and recovers the files that are missing from the original game, returning each to its original relative path. Existing original files stay unchanged; when a private version differs from one, it is kept beside the original as `<filename>.MacLauncher-conflict-<id>`. Recovery creates no separate recovery folder and adds no new links in the original game folder. While it runs, the launcher window shows **Updating the library from an earlier MacLauncher version…** with the number of games processed so far, and the library appears once processing finishes.

If the original location is unavailable or recovery cannot finish safely, the private files stay in place and the reason is recorded. Neither startup, import, Play nor the launcher's [cleanup of derived data](../development/DATA_MODEL.md#derived-data-upkeep) retries them automatically, and games without such a folder are never checked again.

Removing a game that still has such folders brings up a confirmation that names them and the reasons they were kept. **Show in Finder** opens the recorded folder, **Cancel** preserves the game, and **Remove Anyway** deletes its launcher data. The original game files go to the Trash only when the removal is [**Move to Trash**](#removing-games).

## Installer extraction

MacLauncher imports Inno Setup offline installers with the [installer reader](../tools/INSTALLERS.md), which is built from [innoextract](https://github.com/dscharrer/innoextract). An installer keeps its numbered data parts beside it in the same folder. The backend lists the parts it needs, unpacks them once into `games/<gameId>/containers/inno/`, and then detects the extracted game with the ordinary engine registry. When parts are missing, the error names the exact files. Windows installer code never runs.

FreeArc-compressed payloads use this same folder and extraction record. Their archive files stay beside the installer. Native decoders handle built-in methods; SREP and other methods needing the installer's own Windows decoder use the selected Wine in a disposable private prefix. One consent request covers missing tools, Wine and required Rosetta before downloads or extraction start. Neither the installer executable nor `unarc.dll` runs. Game files are not copied into an existing Wine or CrossOver bottle during extraction.

While an extraction runs, a compact progress row shows it and can cancel it. Incomplete output is removed.

Each new extraction checks paths, case collisions, output sizes and file types, and it accepts only regular files. The completed folder becomes the game's writable source folder, where saves, script edits, patches and added assets can stay, and engine preparation uses it directly without making a second writable copy.

### Cache reuse

To decide whether an extraction can be reused, MacLauncher keeps an extraction record with checksums of the installer's bytes and of the reader's extraction format, version and executable. An unchanged installer reuses the completed folder, including on a retry after detection found no matching engine. If the installer's filesystem metadata has changed, its checksums are verified before reuse, although the extracted game contents are not rescanned or hashed. Reuse also requires the extraction folder to still exist as a directory, with no symbolic link in its path.

Extraction records from earlier MacLauncher versions hold only file status. Such a record is converted once, while the installer still matches it. Only the original installer archives are checksummed during the conversion, and the completed game stays in its folder. The earlier record is kept, the extracted files it lists stay marked as not hashed, and later reuse reads the current format. If a conversion cannot finish safely, it is recorded so that it can be resolved; it replaces no game files and is not retried automatically.

Separate library entries keep separate game data. Read-only inspection can use an existing extraction but never creates one, and re-extraction never overwrites existing game files.

## Unavailable game files

A game can live on an external or network drive that is sometimes disconnected, and a game folder can be moved or renamed. Whenever a game's original files are not on disk at their saved location, MacLauncher leaves everything it stored for that game alone: the library entry, saves, settings, chosen runtime versions, snapshots and the prepared files under `games/<gameId>/`. Nothing is detected again, rebuilt, repaired or removed, and no tool follows the game's paths, until the files are back or [**Locate…**](#locating-moved-files) gives the game their new location.

To find out, MacLauncher takes a single look at the game's folder or file and never scans its contents. This check runs when the library loads, when a launcher window becomes active, before **Play** and when missing games are detected. A location that does not answer within a few seconds is reported as not responding, so a slow drive never holds up the library or other games. **Play** shows the game as starting while its check runs, and **Cancel** during the check ends Play before preparation begins. Games found unavailable are listed, each with the location where it was checked, in `library-availability.json` in MacLauncher's data folder. At the next start, a game listed there at the same location shows as unavailable as soon as the library appears, until its own check answers.

An icon stored inside a game's folder is read only after this check confirms that the files are available. Until then, the row shows the preview of that icon saved in an earlier session, when there is one, and otherwise the game type's icon.

An unavailable game's library row shows **Unavailable**, and the inspector gives the reason, such as files that were not found at their saved location. Until the files return:

- **Play** reports the reason instead of starting preparation.
- Patch controls, cheats, **Remove quarantine**, **Create shortcut…** and inspector tools that read or change the game's files are disabled, with the reason as hover text. Results from earlier runs stay visible.
- Favorites, notes, launch arguments, runtime choices and settings, network access, effects and **Forget** keep working.
- Save tools use the save locations recorded when the game was last checked. Saves kept in launcher data or another folder stay usable, and snapshots stay listed. Saves stored inside the game folder become available again with the game; nothing is written to the missing location in the meantime.

Once the files are back at the same path, for example after the drive is connected again, the next check makes the game available without restarting MacLauncher or importing it again, and its details are refreshed as they are at startup. If a game's files disappear while it runs, MacLauncher keeps running and reports that the game stopped because its files became unavailable.

### Locating moved files

When a game's files have moved to another folder or drive, **Locate…** in the inspector's unavailable notice gives the game their new location. For a game saved as a folder it opens a folder chooser, and for a game saved as a single file or app a file chooser, starting in the nearest existing folder above the saved location. At the chosen location, MacLauncher runs the same detection as an import and accepts the location only when detection finds the game's own type. The library entry keeps its game ID, so its saves, snapshots, settings, notes, favorites, runtime choices and effects stay with it. Paths recorded inside the old location, such as a save folder override, a chosen executable or a file imported from inside the game folder, move to the same place in the new location. The game's detected details, icon and save locations are then read again from the new location, and the notice disappears once the files are found there.

**Locate…** refuses a location detected as another game type, a location without a recognized game and a location that another library entry already uses. The reason appears below the notice, and the entry stays unchanged. **Locate…** is also refused while the game is running or another action for it is in progress.

The game's extraction and preparation records receive the new paths as well, and links from prepared files into the old location are pointed at the same files in the new one, so extracted and prepared files stay usable after a move. Prepared WOLF RPG builds are the exception and are rebuilt at the new location. The only things changed are MacLauncher's own JSON records and links that name the old location. Files that belong to the game or its runtime, such as saves, private and extracted copies of the game, Windows prefixes and browser profiles, are not read or changed.

A record that is larger than 32 MiB, is not valid JSON or cannot be rewritten as a whole stays exactly as it is. The game's private launcher data keeps the original records and links of the latest move only. If a move fails part-way, they are restored at once. If MacLauncher stops in the middle of a move, the next start undoes the move when the game's entry still has the old location and otherwise keeps it.

Saved `.command` shortcuts keep opening the same library game. MacLauncher records each shortcut it saves and rewrites it with the new location unless the script was edited. Older, unchanged shortcuts on the Desktop are rewritten and recorded the same way. Edited scripts and older shortcuts saved elsewhere stay as they are; when one of them runs and nothing exists at its game path, it opens the library game that used to be there.

For a game imported from an installer, **Locate…** selects the installer at its new location, and the data files that were in the installer's folder must keep the same places relative to it. If the installer and its data files have the same contents as before, the unpacked game is reused; otherwise the selected installer is unpacked again. Either way, the game ID and its private data stay in place. A refused location leaves the game's records as they were and removes any copy unpacked from the refused installer.

## Removing games

**Forget** removes a game's private launcher data, including extracted containers and runtime wrappers, and keeps the original files. **Move to Trash** does the same and also moves the original game files to the Trash. Before a game can be removed, it must be stopped and its current actions finished. Cleanup runs separately for each game, so other games and the launcher stay responsive.
