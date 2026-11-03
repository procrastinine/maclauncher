# Half-Life (Xash3D FWGS)

This game type covers Half-Life and the Half-Life mods that run on its own game code. MacLauncher plays them with [Xash3D FWGS](https://github.com/FWGS/xash3d-fwgs), an open-source engine compatible with GoldSrc, the engine of the original Half-Life. Xash3D FWGS runs as a native macOS process and reads the game's original data. Playback does not load Electron, run Windows programs or use Wine.

| Runtime | Description |
| --- | --- |
| Xash3D FWGS (default) | The publisher's macOS build for this Mac's CPU |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Accepted inputs

Import accepts a Half-Life folder, such as a Steam installation, as well as its `valve` folder or a mod folder inside it. A Half-Life folder contains a `valve` folder with a game description, `liblist.gam` or `gameinfo.txt`, and Half-Life's game data, `halflife.wad` or `pak0.pak`. File names match regardless of case.

Importing the Half-Life folder or its `valve` folder creates a Half-Life entry. Importing a mod folder, a sibling of `valve` with its own `liblist.gam` or `gameinfo.txt`, creates an entry for that mod, named by the title in its game description. Importing the Windows executable itself, such as `hl.exe`, creates a [Windows Game](WINDOWS.md) entry instead.

## Game libraries

GoldSrc games keep their game code in a server library and a client library. Each Xash3D FWGS build includes Half-Life's libraries for its CPU, compiled from [hlsdk-portable](https://github.com/FWGS/hlsdk-portable), the FWGS port of Valve's Half-Life SDK. The Windows libraries that ship with Half-Life are not used.

A mod is recognized when its game code is available for the engine on this Mac:

- The mod uses Half-Life's game code: its game description names Half-Life's server library, `dlls/hl.dll`, and the mod includes no library of that name or only an unchanged copy of Half-Life's.
- The mod includes a server library built for Xash3D FWGS and this Mac's CPU, named `<library>_arm64.dylib` on Apple Silicon or `<library>_amd64.dylib` on Intel, beside the library its game description names.

Mods with only Windows game libraries do not match this game type, because an Apple Silicon or Intel macOS engine cannot load Windows code. Opposing Force and Blue Shift are among them. They can run through the Half-Life entry's Windows runtimes, where the game argument `-game <folder>` selects the mod. The inspector's **Game library** field shows whether an entry uses Half-Life's code or the mod's own library.

## Preparation and saves

Xash3D FWGS uses the original Half-Life folder as its writable game root and working directory. Configuration, logs and downloaded content use the engine's ordinary locations in that tree; saves use `<game folder>/save/`. Ordinary Play creates no private game tree or save links. The engine receives the selected runtime's native server and client library paths through its `-dll` and `-clientlib` options. Native mod libraries remain in their original folders. The runtime's `extras.pk3` archive supplies menu graphics, fonts and controller mappings at the lowest priority, so game files take precedence.

Because the engine's save subdirectory is fixed, a custom save folder needs a private writable game root. That root reads the original content without writing to it and links only the chosen save folder. Files already in the private root are kept. Removing the library entry keeps the original game files and an explicit custom save folder.

## Settings

The Xash3D FWGS runtime has no settings of its own. Video, audio, controls and multiplayer options are in the engine's own menu, which stores them in the game root. Play starts the engine with `-game <folder>` and the native library options, followed by the shared game arguments.

## Graphics

Shared graphics controls apply to the game window.

## Runtimes

### Xash3D FWGS

**Runtimes → Xash3D FWGS** lists the publisher's builds from its [GitHub releases](https://github.com/FWGS/xash3d-fwgs/releases). The rolling `continuous` release carries the builds of the main branch, and each listing names its date and source commit. Releases named `continuous-<branch>` carry feature-branch builds and are not listed. Numbered releases with macOS archives are listed as well.

The publisher replaces the archives of the rolling release with every build, so a version names the tag and source commit, plus the archive's SHA-256 when GitHub publishes it. A changed published checksum therefore gives the archive a new version, and an installed version stays usable offline after the publisher replaces it.

Apple Silicon and Intel builds are separate archives, `xash3d-fwgs-apple-arm64.tar.xz` and `xash3d-fwgs-apple-amd64.tar.xz`, and the build for this Mac's CPU is selected automatically. A renamed or reformatted macOS archive is found too. A download is checked against GitHub's SHA-256 digest when one is published; otherwise its checksum is recorded at installation, and installation checks that the engine executable is built for the selected CPU.

Installation keeps the publisher's archive unchanged: the `xash3d` launcher, the engine, renderer, menu and file-system libraries, SDL2, Half-Life's game libraries and `extras.pk3`, whose fonts, logos and controller mappings keep their license files inside the archive. Installation also reads the macOS requirement from the engine executable.

Versions follow the [shared selection rules](../runtimes/README.md#versions), and installations live under `userData/runtimes/xash3d-fwgs/<arm64|x64>/<version>/`.

### CrossOver and Sikarugir (Wine)

When the imported folder includes a compatible Windows executable, such as Steam's `hl.exe`, the [Windows runtimes](WINDOWS.md#windows-executables-in-other-game-types) Sikarugir and CrossOver are also offered. They run the original Windows game libraries, including those of mods without macOS libraries.

## Licenses

Xash3D FWGS is licensed under GPL 3 or later, as its source files state. Half-Life's game libraries come from hlsdk-portable under the Half-Life 1 SDK License, and SDL2 keeps its zlib license notice in the installed framework. Half-Life's game data is not part of MacLauncher or the runtime and comes from the imported game.
