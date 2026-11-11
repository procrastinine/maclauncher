# AI5WIN

AI5WIN is a Windows visual novel engine. Its games are configured by an INI file and keep their scripts in ARC or DAT archives. MacLauncher plays original-edition AI5WIN games natively with AI5-SDL2, an interpreter built from [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) that provides native menus, dialogue, audio and saves.

| Runtime | Description |
| --- | --- |
| AI5-SDL2 (default) | Native interpreter for original AI5WIN game data |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Importing games

Import accepts an original Windows game folder, its executable or its AI5 INI file. The interpreter then runs from that folder, which also holds the game's saves and, in `Screenshots/`, its screenshots. Preparation adds one small adapted configuration file and keeps it in the game's launcher data.

## Detection and versions

AI5WIN games are recognized by their configuration, so detection starts only when the game has one of the known original INI files: `AI5ENG.INI`, `AI5WIN.INI`, `syuusaku.ini` or `aiwin.ini`.

- Each INI file is read up to 64 KiB, in UTF-8, UTF-16LE or Shift-JIS. An existing `AI5SDL2.INI` is merged in, and repeated fields and archive aliases keep the native order of their assignments.
- Files named in the INI must resolve inside the original game folder, and their case must match unambiguously. A path with an old Windows drive prefix can still resolve to an existing local file with the same base name. Path traversal, UNC references and symbolic links that lead outside the game, however, fail.
- A game is recognized as AI5 only when its configuration is coherent and its script index is valid and contains the `STARTMES` entry that the configuration names. To read the index, detection follows libai5 for the ordinary ARC XOR variants, DAT XOR and the shuffled indexes that some editions use. Every entry is checked in chunks of limited size, but only a small sample of names and the start-script entry are kept. Detection never decompresses game data or runs the executable.
- Loose scripts have no identifying signature, so a game with loose scripts also needs an independently identified original AI5WIN executable.

Version information comes from the original executable. MacLauncher's PE reader, which other game types share, inspects only its `RT_VERSION` resource, within a size limit, and the original file and product versions found there are reported separately from the interpreter version. A fixed file version is taken as the engine version only when `ProductName` or `FileDescription` explicitly names AI5, AI5WIN or AIWIN; marketing versions and a zero fixed version are never used to guess one. The archive type and the game profile, which identifies the edition, are also reported separately.

The inspector shows the game profile, the original file version, the version source and the script archive format. **Inspect data**, in the inspector's **Advanced** group, runs the same inspection on demand.

## Original data and private state

The interpreter runs in the original game folder and reads archives and loose assets there directly. The game's configuration, however, can contain Windows references, and these are normalized in a single private UTF-8 INI file. The interpreter receives the original INI as its game argument and reads this adapted configuration through its configuration setting. Preparation files that have not changed are reused. Portable font paths also replace the build machine's path prefix.

### Disc images

Interpreters with original-disc support can also read original ISO9660 and MODE1/2352 disc images directly. If a game uses a disc layout and the selected interpreter lacks that support, the requirement is reported before launch. Because the disc check is expensive, it runs on Play and only for a game already identified as AI5.

- A disc's INI files must declare the same game profile as the game, and several matching disc folders are rejected as ambiguous.
- Disc metadata is read according to [ECMA-119](https://ecma-international.org/publications-and-standards/standards/ecma-119/), with size-limited volume and directory reads, paired endian checks, extent validation and cycle limits. The reader accepts single-extent, non-interleaved records in these disc formats.

English translation layouts can keep the base graphics and music inside an original disc image. For these layouts, automatic preparation writes small range descriptors to `modules/ai5/disc/`, and a native `funopen` stream reads those ranges across raw sectors, so neither the archives nor the game folder is copied. Translation archives take precedence, and members missing from them fall back to validated base archives. Nested voice containers are read only. Missing save slots can also be filled from the disc's default saves, although existing saves take precedence.

## Saves

Saves are stored in the original game folder unless an explicit save-folder override is selected, and the inspector opens the save folder in use.

With an override, an absent save slot can be filled from an existing save in the original game, which is read through a size-limited read-only handle. Saves already in the override folder take precedence. Screenshots and debugger image exports are not redirected by an override; they always go to `Screenshots/` in the original game folder.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Game profile | Automatic | **Automatic** selects the edition from the game's original configuration. A specific profile can be chosen as an override. |
| Text capture | Off | Off, Console or Clipboard. The chosen mode overrides the setting in an older companion INI. |
| Custom font | | Optional. Suitable fonts are installed with the runtime automatically. |

## Runtimes

### AI5-SDL2

AI5-SDL2 is the default runtime, and MacLauncher Builds publishes it as Mac packages. These are built from [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) together with libai5 and nulib, with libsndfile for audio and FFmpeg for movie playback. Compared with upstream AI5-SDL2, the Mac packages also recognize the Japanese YU-NO voice-patch title, read original data and disc images directly and allow an explicit save folder to be selected. Each package contains the interpreter, all of its native dependencies, fonts and license notices, and Runtimes lists its architectures and minimum macOS version.

The packages are listed in **Runtimes → AI5WIN** and need neither Wine nor Windows fonts. Installed versions are stored in `~/Library/Application Support/maclauncher/runtimes/ai5/<arm64|x64>/<version>/`, and their source, patches and build scripts are in the MacLauncher Builds repository.

### CrossOver, Sikarugir and WineCX

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application, [Sikarugir](../runtimes/SIKARUGIR.md) or [WineCX](../runtimes/WINECX.md). The detected version and the inspector tools stay available with each of these runtimes.
