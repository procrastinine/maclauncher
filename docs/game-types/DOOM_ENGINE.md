# Doom engine (UZDoom)

This game type covers games made for the Doom engine and its descendants: Doom, Doom II, Final Doom, Heretic, Hexen, Strife, Chex Quest, Freedoom and other standalone games that ship a main game file. MacLauncher plays them with [UZDoom](https://github.com/UZDoom/UZDoom), a source port that runs as a native macOS application and reads the game's original data in place.

| Runtime | Description |
| --- | --- |
| UZDoom (default) | The publisher's macOS application |

## Accepted inputs

Import accepts a main game file, known to the engine as an IWAD, or a folder that holds one at its top level:

- a `.wad` file whose header is `IWAD`;
- an `.ipk3` file;
- a `.pk3` file whose ZIP directory contains an `iwadinfo` definition.

Add-on files (`PWAD` files and `.pk3` mods without a game definition) need a main game and are not imported on their own. A folder that holds several main game files, such as Freedoom's two phases, asks for one of them, and each one becomes a separate entry.

Detection of this game type runs after every other game type. A folder that another game type accepts keeps that game type. For example, a DOS release with its original executable is a [DOS](DOS.md) game, and a Windows release is a [Windows](WINDOWS.md) game; selecting the main game file in such a folder imports it here instead. Entries are named after the game the file belongs to, for example *Freedoom: Phase 1*, or after the file name. A [DOS](DOS.md#uzdoom-raze-and-dreamm) game whose folder holds one main game file also offers UZDoom as its runtime.

## Preparation and saves

Play starts UZDoom with `-iwad <file>` in the game's folder. The game files stay unchanged. UZDoom runs with its user folders (Preferences, Application Support and Documents) inside the game's launcher data, so its configuration, saves, screenshots and logs stay with the game and are removed when the game is removed from the library. The inspector has no save location for this game type. Stop asks UZDoom to quit and ends it when it is still running after 5 seconds.

## Settings

UZDoom has no runtime settings in MacLauncher. Video, audio and controls are set in the engine's own menus. Game arguments from the shared argument field follow `-iwad`, so add-ons can be loaded with `-file <path>` and console commands passed with `+<command>`.

## Runtimes

### UZDoom

**Runtimes → UZDoom** lists the stable releases from the publisher's [GitHub releases](https://github.com/UZDoom/UZDoom/releases). Each release's macOS download is found by its platform and CPU words; preview releases are not listed, and a release without a macOS download stays visible with that reason. When GitHub publishes a SHA-256 digest for the download, the file is checked against it; otherwise its checksum is recorded at installation. The installed application states its CPUs and its macOS requirement.

Installation keeps the publisher's application unchanged, and Play runs its executable directly. Versions follow the [shared selection rules](../runtimes/README.md#versions), and installations are stored under `userData/runtimes/uzdoom/<arm64|x64>/<version>/`.

## Licenses

UZDoom is licensed under GPL 3, with its branding under CC BY-SA 4.0. Game data is not part of MacLauncher or the runtime and comes from the imported game.
