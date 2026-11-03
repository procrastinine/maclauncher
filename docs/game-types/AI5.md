# AI5WIN

AI5WIN is a Windows visual novel engine. Its games are configured by an INI file and keep their scripts in ARC or DAT archives. MacLauncher plays original-edition AI5WIN games natively with AI5-SDL2, an interpreter built from [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) that provides native menus, dialogue, audio and saves.

| Runtime | Description |
| --- | --- |
| AI5-SDL2 (default) | Native interpreter for original AI5WIN game data |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts an original Windows game folder, its executable or its AI5 INI file. The interpreter runs from that folder, where saves stay and screenshots go to `Screenshots/`. Preparation keeps one small adapted configuration file in the game's launcher data.

## Detection and versions

Detection starts only when the game has one of the known original INI files: `AI5ENG.INI`, `AI5WIN.INI`, `syuusaku.ini` or `aiwin.ini`.

- The detector reads at most 64 KiB of each INI file and handles UTF-8, UTF-16LE and Shift-JIS. It merges an existing `AI5SDL2.INI` and keeps the native order of assignments for repeated fields and archive aliases.
- Files named in the INI must resolve inside the original game folder, with unambiguous case matching. An old Windows drive prefix may resolve to an existing local file with the same base name. Path traversal, UNC references and symbolic links that lead outside the game fail.
- An AI5 game is recognized only when its configuration is coherent and its script index is valid and contains the `STARTMES` entry the configuration names. Index inspection follows libai5 for the ordinary ARC XOR variants, DAT XOR and the shuffled indexes some editions use. Every entry is checked in chunks of limited size, and only a small sample of names and the start-script entry are kept. Detection never decompresses game data or runs the executable.
- Loose scripts have no identifying signature, so a game with loose scripts also needs an independently identified original AI5WIN executable.

The shared PE reader inspects only the `RT_VERSION` resource of the original executable, within a size limit. The original file and product versions are reported separately from the interpreter version. A fixed file version becomes the engine version only when `ProductName` or `FileDescription` explicitly names AI5, AI5WIN or AIWIN. Marketing versions and a zero fixed version never become guessed engine versions. The archive type and the game profile, which identifies the edition, are reported separately.

The inspector shows the game profile, the original file version, the version source and the script archive format. **Inspect data**, in the inspector's **Advanced** group, runs this inspection on demand.

## Original data and private state

The interpreter runs in the original game folder and reads archives and loose assets directly. A single private UTF-8 INI file normalizes the Windows references written in the game's configuration. The interpreter receives the original INI as its game argument and reads the adapted configuration through its configuration setting. Unchanged preparation files are reused. Portable font paths replace the build machine's path prefix.

### Disc images

Interpreters with original-disc support also read original ISO9660 and MODE1/2352 disc images directly. If a game uses a disc layout and the selected interpreter lacks that support, the requirement is reported before launch. The disc check is expensive, so it runs on Play and only for a game already identified as AI5.

- A disc's INI files must declare the same game profile as the game. Several matching disc folders are rejected as ambiguous.
- Disc metadata is read according to [ECMA-119](https://ecma-international.org/publications-and-standards/standards/ecma-119/), with size-limited volume and directory reads, paired endian checks, extent validation and cycle limits. The reader accepts single-extent, non-interleaved records in these disc formats.

English translation layouts can keep the base graphics and music inside an original disc image. Automatic preparation then writes small range descriptors to `modules/ai5/disc/`, and a native `funopen` stream reads those ranges across raw sectors without copying the archives or the game folder. Translation archives take precedence, and missing members fall back to validated base archives. Nested voice containers are read only. Missing save slots can be filled from the disc's default saves; existing saves take precedence.

## Saves

Saves are stored in the original game folder, or in an explicit save-folder override. The inspector opens the game's save folder.

When an override is selected, an absent save slot can be filled from an existing save in the original game through a size-limited read-only handle. Existing saves in the override folder take precedence. Screenshots and debugger image exports go to `Screenshots/` in the original game folder.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Game profile | Automatic | **Automatic** selects the edition from the game's original configuration. A specific profile can be chosen as an override. |
| Text capture | Off | Off, Console or Clipboard. The chosen mode overrides the setting in an older companion INI. |
| Custom font | | Optional. Suitable fonts are installed with the runtime automatically. |

## Runtimes

### AI5-SDL2

AI5-SDL2 is the default runtime. MacLauncher Builds publishes Mac packages built from [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) with libai5 and nulib, libsndfile audio and FFmpeg movie playback. Each package contains the interpreter, all of its native dependencies, fonts and license notices, and Runtimes lists its architectures and minimum macOS version. The Mac packages add recognition of the Japanese YU-NO voice-patch title, direct reading of original data and disc images, and explicit save-folder selection.

**Runtimes → AI5WIN** lists these packages. They need no Wine or Windows fonts, and installed versions are stored in `~/Library/Application Support/maclauncher/runtimes/ai5/<arm64|x64>/<version>/`. Their source, patches and build scripts are in the MacLauncher Builds repository.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the inspector tools stay available with either runtime.
