# LucasArts (DREAMM)

This game type covers LucasArts titles that [DREAMM](https://dreamm.aarongiles.com/) runs and that no other game type covers. DREAMM, an emulator by Aaron Giles for LucasArts, Lucasfilm and Lucas Learning games, runs as a native macOS application, emulates the original DOS or Windows release and reads the game's files in place.

| Runtime | Description |
| --- | --- |
| DREAMM (default) | The publisher's macOS application |

## Accepted inputs

Import accepts the main data file of one of these games, or a folder that holds one at its top level:

| Game | Main data file |
| --- | --- |
| Star Wars: Dark Forces | `DARK.GOB`, whose header is `GOB` followed by a line feed |
| Outlaws | `OUTLAWS.LAB` |
| Star Wars: Yoda Stories | `YODESK.DTA` |
| Indiana Jones and His Desktop Adventures | `DESKTOP.DAW` |

DREAMM itself identifies the exact release, language or demo from the files in the game's folder.

Detection of this game type runs after every other game type, so the SCUMM adventures, which [ScummVM](SCUMMVM.md) plays, keep that game type. A game folder that holds the original DOS executables is a [DOS](DOS.md) game; selecting the main data file in that folder imports it here instead. A [DOS](DOS.md#uzdoom-raze-and-dreamm) game whose folder holds one of these main data files also offers DREAMM as its runtime.

## Preparation and saves

Play starts DREAMM with `-run <folder>`, which identifies the game in the folder and starts it without DREAMM's Game Manager. DREAMM runs with its user folders (Preferences, Application Support and Documents) inside the game's launcher data. The files a game writes, saves included, and DREAMM's own settings stay there with the game and are removed when the game is removed from the library, while the game folder stays unchanged. The inspector has no save location for this game type. Stop asks DREAMM to quit and ends it if it is still running after 5 seconds.

## Settings

DREAMM has no runtime settings in MacLauncher; video, audio and input options are set in DREAMM itself. Game arguments from the shared argument field follow the game folder.

## Runtimes

### DREAMM

**Runtimes → DREAMM** lists the versions from the publisher's site. The current macOS disk image is the one that the download page links. Versions that the update feed, `version.xml`, announces are also listed while the site still serves their disk image under the same file name pattern; other versions stay visible with that reason. Because the site publishes no checksums, the disk image's checksum is recorded at installation. The installed application states which CPUs it supports and which macOS it requires.

Installation copies the application from the publisher's disk image unchanged, and Play runs its executable directly. Versions follow the [shared selection rules](../runtimes/README.md#versions), and installations are stored under `userData/runtimes/dreamm/<arm64|x64>/<version>/`.

## Licenses

DREAMM is freeware by Aaron Giles, who holds its copyright. It is distributed as a free download from its site, and its source code is not published. The libraries that DREAMM includes are listed in its own **License Details**. Game data is not part of MacLauncher or the runtime; it comes from the imported game.
