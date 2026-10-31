# Game preparation and storage

Import accepts the original game folder, executable or supported package. **Play** chooses a matching runtime, [installing it if needed](../runtimes/README.md#downloads-and-offline-use), and runs any preparation the game needs as part of the same launch, so there is no separate prepared copy to create and no manual extraction step. The game shows **Starting** during preparation and process startup, and **Cancel** stops a pending preparation. Once the game process exists, **Stop** is available, even while its first window is still loading.

## Library loading

At startup the library shows the stored entries straight away, and each game's metadata and runtime choices are refreshed in the background. Selecting or playing a game moves its pending checks ahead of the others. A game whose files have not changed since the last check reuses its cached detection, version, icon and save information, while new imports and changed games are detected again. A slow or failed check affects only its own game, and the library and other imports stay responsive.

Several imports can run at once. Repeated requests to import the same file or folder share one import, and a completed import writes only its own game's record. Runtime and availability changes are collected into one library update instead of redrawing the list for each change.

## Storage locations

| Contents | Location |
| --- | --- |
| Installed runtimes | `~/Library/Application Support/maclauncher/runtimes/` |
| Per-game runtime files, extracted containers, exports and private saves | `~/Library/Application Support/maclauncher/games/<gameId>/` |

Backend callers can choose a different root with `userDataDir`.

## Original files and private files

MacLauncher reads the original game files and does not change them unless asked to by one of three tools. The [NW.js Tools patch](../tools/CHEATS.md#nwjs-patching) used by RPG Maker MV and MZ games and the [Ren'Py cheat add-ons](../tools/CHEATS.md#renpy-cheat-add-ons) write their files into the game folder (or, for a game inside an archive, into its private writable copy), and **Unpatch** or the add-on's remove button takes them out again. Edits saved in [Near Infinity](../game-types/INFINITY_ENGINE.md#near-infinity) change the game's resources. Each runtime keeps the saves, configuration, logs and generated files it writes in the game's own folder in launcher data, and links to the original assets wherever the runtime can use them in place.

ZIP payloads, archives appended to executables, ASAR files and similar containers are extracted only when the selected runtime cannot read the packaged content directly. The extracted content stays in the game's private launcher data. Explicit decompilation and Mac application exports create separate output, because their purpose is to produce extracted source or a distributable app.

The game-type and runtime pages describe what each one prepares:

- [Ren'Py SDK projects](../game-types/RENPY.md#renpy-sdk)
- [NW.js projects](../runtimes/WEB_RUNTIMES.md#preparation-and-launch) for web-based game types
- [RPG Maker XP/VX/VX Ace on MKXP-Z](../game-types/RPGMAKER_XP_VX.md#preparation-and-launch)
- [Construct](../game-types/CONSTRUCT.md#preparation) and [Tyrano](../game-types/TYRANO.md#preparation-and-saves)
- [RPG Maker 2000/2003 on EasyRPG](../game-types/RPGMAKER_2000_2003.md#saves)
- [ScummVM](../game-types/SCUMMVM.md#saves-and-storage)
- [FAVORITE / FVP](../game-types/FVP.md#preparation-and-storage)
- [WOLF RPG Editor](../game-types/WOLFRPG.md#detection-and-preparation)
- [CrossOver](../runtimes/CROSSOVER.md#bottles-and-private-game-files) and [Sikarugir (Wine)](../runtimes/SIKARUGIR.md#private-game-files-and-prefixes)

## Writable input views

Some game types need writable scripts, configuration or portable saves. For these, MacLauncher automatically prepares a private writable view of the game for import, launch, tools and save operations. The library keeps the original game's identity and paths, and the backend can hand a temporary view to the runtime or tool.

Actions that read the game's source, such as extraction, decryption and Steam identity detection, use the original files. Runtime, patch and plugin actions use the writable view.

Views are stored in `games/<gameId>/modules/<moduleId>/writable-input/files/`. A view has real directories, private copies of the files that can change, and links to the assets that cannot. Plugin and library changes replace the affected links atomically and leave the files they pointed to unchanged. When the source files and the game type's rules for the view are unchanged, the existing view is reused, and portable saves persist across launches. Read-only backend calls can resolve paths and read an existing view without creating or copying files.

MKXP-Z executables and frameworks stay shared. RGSS save-file metadata is not recursive, so portable saves at the game root are handled separately from nested databases and assets.

Ren'Py uses its own [SDK-specific projects](../game-types/RENPY.md#renpy-sdk) instead, kept in sync with the original game.

## Installer extraction

MacLauncher imports Inno Setup offline installers with the [installer reader](../tools/INSTALLERS.md), built from [innoextract](https://github.com/dscharrer/innoextract). An installer includes its numbered data parts in the same folder. The backend lists the parts it needs, unpacks them once into `games/<gameId>/containers/inno/`, and then detects the extracted game with the ordinary engine registry. If parts are missing, the error names the exact files. Windows installer code never runs.

A compact progress row shows the extraction and can cancel it, and incomplete output is removed.

A completed extraction is never modified afterward. Paths, case collisions, output sizes and file types are checked before it is used, and only regular files are accepted. A module that needs to patch scripts from the extracted files writes its own copies of just those files, because changing the extraction would break its recorded checksums. It does not need a complete copy of the game.

### Cache reuse

The cache records the installer's bytes and the reader's extraction format, version and executable checksums. An unchanged source reuses the cache, including on a retry after detection found no matching engine. An existing game's cache stays reusable when the bytes match, even if filesystem identifiers have changed. Unchanged file metadata takes a quick path, and changed metadata requires checksum verification before reuse.

Compatible older caches are migrated in place only when their contents can be validated. A changed older cache without trustworthy checksums reports an error, so its contents are neither duplicated nor accepted silently. Separate library entries keep separate game data. Read-only inspection can use an existing cache, but it never extracts or migrates an installer.

## Unavailable game files

Games can stay on an external or network drive that is sometimes disconnected, and a game folder can be moved or renamed. Whenever a game's original files are not on disk at their saved location, MacLauncher leaves everything it stored for that game alone: the library entry, saves, settings, chosen runtime versions, snapshots and the prepared files under `games/<gameId>/`. Nothing is detected again, rebuilt, repaired or removed, and no tool follows the game's paths, until the files are back or [**Locate…**](#locating-moved-files) gives the game their new location.

The check is a single look at the game's folder or file, never a scan of its contents. It runs when the library loads, when a launcher window becomes active, before **Play** and when missing games are detected. A location that does not answer within a few seconds is reported as not responding, so a slow drive never holds up the library or other games.

An icon stored inside a game's folder appears after this check confirms that the files are available.

An unavailable game's library row shows **Unavailable**, and the inspector gives the reason, such as files that were not found at their saved location. While the files are unavailable:

- **Play** reports the reason instead of starting preparation.
- Patch controls, cheats, **Remove quarantine**, **Create shortcut…** and inspector tools that read or change the game's files are disabled, with the reason as hover text. Results from earlier runs stay visible.
- Favorites, notes, launch arguments, runtime choices and settings, network access, effects and **Forget** keep working.
- Save tools use the save locations recorded when the game was last checked. Saves kept in launcher data or another folder stay usable, and snapshots stay listed. Saves stored inside the game folder become available again with the game; nothing is written to the missing location in the meantime.

When the files are back at the same path, such as after the drive is connected again, the next check makes the game available without restarting MacLauncher or importing it again, and its details are refreshed as they are at startup. If a game's files disappear while it runs, MacLauncher keeps running and reports that the game stopped because its files became unavailable.

### Locating moved files

Files that moved to another folder or drive are found again with **Locate…** in the inspector's unavailable notice. It opens a folder chooser for a game saved as a folder and a file chooser for a game saved as a single file or app, starting in the nearest existing folder above the saved location. MacLauncher runs the same detection as an import at the chosen location and accepts it only when detection finds the game's own type. The library entry keeps its game ID, so its saves, snapshots, settings, notes, favorites, runtime choices and effects stay with it. Paths recorded inside the old location, such as a save folder override, a chosen executable or a file imported from inside the game folder, move to the same place in the new location. The game's detected details, icon and save locations are then read again from the new location, and the notice disappears once the files are found there.

A location detected as another game type, a location without a recognized game, and a location that another library entry already uses are refused. The reason appears below the notice, and the entry stays unchanged. **Locate…** is also refused while the game runs or another action for it is in progress.

The game's extraction and preparation records receive the new paths as well, and links from prepared files into the old location point to the same files in the new one, so extracted and prepared files stay usable after a move. Prepared WOLF RPG builds are the exception: they are rebuilt at the new location. Only MacLauncher's own JSON records and links that name the old location change. Files that belong to the game or its runtime, such as saves, private and extracted copies of the game, Windows prefixes and browser profiles, are not read or changed.

A record that is larger than 32 MiB, is not valid JSON or cannot be rewritten as a whole stays exactly as it is. Only the latest move's original records and links are kept, in the game's private launcher data. If a move fails part-way, they are restored at once. If MacLauncher stops in the middle of a move, the next start undoes it when the game's entry still has the old location, and otherwise keeps it.

Saved `.command` shortcuts keep opening the same library game. MacLauncher records each shortcut it saves and, unless the script was edited, rewrites it with the new location. Older, unchanged shortcuts on the Desktop are rewritten and recorded the same way. Edited scripts and older shortcuts saved elsewhere are not changed: when one runs and nothing exists at its game path, it opens the library game that was there.

For a game imported from an installer, **Locate…** selects the installer at its new location. Companion data files that were in the installer's folder must be in the same places relative to the installer. When the installer and its data files have the same contents as before, the unpacked game is reused; otherwise the selected installer is unpacked again. The game ID and its private data stay in place. A refused location leaves the game's records as they were and removes any copy unpacked from the refused installer.

## Removing games

**Forget** removes a game's private launcher data, including extracted containers and runtime wrappers, and keeps the original files. **Move to Trash** also moves the original game files to the Trash. A game must be stopped, and its current actions finished, before it can be removed. Cleanup runs separately for each game, so other games and the launcher stay responsive.
