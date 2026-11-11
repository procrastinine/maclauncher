# Build engine (Raze)

This game type covers games made with Ken Silverman's Build engine: Duke Nukem 3D and its add-ons, Blood, Shadow Warrior, Redneck Rampage, PowerSlave (Exhumed), NAM and World War II GI. MacLauncher plays them with [Raze](https://github.com/ZDoom/Raze), a source port that runs as a native macOS application and reads the game's original data in place.

| Runtime | Description |
| --- | --- |
| Raze (default) | The publisher's macOS application |

## Accepted inputs

Import accepts a game data file, or a folder that holds one at its top level:

- a `.grp` file whose header is `KenSilverman`;
- PowerSlave's `STUFF.DAT`, a GRP archive with the same header;
- Blood's `BLOOD.RFF`, whose header is `RFF` followed by the byte `0x1A`.

A folder that holds several game data files, such as Duke Nukem 3D with an add-on, asks for one of them. Raze identifies the exact game, edition and add-on from the data.

Detection of this game type runs after every other game type. A folder that another game type accepts keeps that game type. For example, a DOS release with its original executable is a [DOS](DOS.md) game; selecting the data file in such a folder imports it here instead. Entries are named after the game the file belongs to, for example *Duke Nukem 3D*, or after the file name. A [DOS](DOS.md#uzdoom-raze-and-dreamm) game whose folder holds one main game file also offers Raze as its runtime.

## Preparation and saves

Play starts Raze in the game's folder with `-gamegrp <file name>`. Raze searches that folder for game data and selects the main file by its name, and an add-on GRP loads the base game it depends on from the same folder. The game files stay unchanged. Raze runs with its user folders (Preferences, Application Support and Documents) inside the game's launcher data, so its configuration, saves, screenshots and logs stay with the game and are removed when the game is removed from the library. The inspector has no save location for this game type. Stop asks Raze to quit and ends it when it is still running after 5 seconds.

## Settings

Raze has no runtime settings in MacLauncher. Video, audio and controls are set in the engine's own menus. Game arguments from the shared argument field follow `-gamegrp`.

## Runtimes

### Raze

**Runtimes → Raze** lists the stable releases from the publisher's [GitHub releases](https://github.com/ZDoom/Raze/releases). Each release's macOS download is found by its platform and CPU words, and a release without a macOS download stays visible with that reason. When GitHub publishes a SHA-256 digest for the download, the file is checked against it; otherwise its checksum is recorded at installation. The installed application states its CPUs and its macOS requirement, and a build without Apple Silicon code runs through Rosetta.

Installation keeps the publisher's application unchanged, and Play runs its executable directly. Versions follow the [shared selection rules](../runtimes/README.md#versions), and installations are stored under `userData/runtimes/raze/<arm64|x64>/<version>/`.

## Licenses

Raze is licensed under GPL 2, and its Build engine code under Ken Silverman's Build Engine license. Game data is not part of MacLauncher or the runtime and comes from the imported game.
