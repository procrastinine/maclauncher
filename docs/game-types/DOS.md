# DOS

This game type covers DOS programs, which MacLauncher runs with [DOSBox Staging](https://www.dosbox-staging.org/) through its `dosbox` module. A DOS release of a Doom-engine, Build-engine or DREAMM game can also run on that engine's source port or emulator, as [UZDoom, Raze and DREAMM](#uzdoom-raze-and-dreamm) describes.

## Accepted inputs

Import accepts DOS MZ executables, COM programs, and batch launchers that start a matching DOS program. Windows PE, Windows NE and non-DOS OS/2 executables, by contrast, are separate formats and do not match. If a game's data belongs to an engine that MacLauncher recognizes, the game keeps that engine's preferred runtime.

A folder with one DOS program is detected automatically, but in a folder with several programs, the game's EXE, COM or BAT file has to be selected directly. In either case, the whole containing game folder provides the companion data.

## Preparation and saves

By default, Play opens the selected original program and uses its containing directory as both the DOS drive and the working directory. The game reads and writes its own files there, saves included, and Play neither copies nor lists them.

DOSBox, as MacLauncher runs it, has no separate save-folder option. A save-location override is therefore the only case in which Play uses a copy: a writable copy of the complete DOS drive, kept at the chosen location. Saves and other files modified in that copy stay unchanged, while source assets that the copy has not changed are refreshed there.

Earlier MacLauncher versions ran each game from a private `drive-c` copy. Files in those folders are recovered once into the original game folder, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. When an original file differs, it stays unchanged, and the recovered version is kept beside it as a separate copy. Drive copies at an active save-location override stay untouched, including overlapping folders.

Each game gets its own DOSBox configuration and keyboard mapper from MacLauncher, so separate DOSBox preferences and local `dosbox.conf` files are not loaded. Network access for the game process follows the shared network setting.

## Settings

DOSBox Staging has three runtime settings: **Fullscreen**, **Machine** and **CPU cycles**, which accepts `auto`, `max` or a positive number.

Game arguments are entered in the shared argument field and passed without DOS command redirection or variable expansion. When a program is launched with arguments, it is started by its DOS 8.3 executable name.

## Graphics

Shared graphics controls apply to the DOSBox game window. To make this possible, MacLauncher creates a small application bundle for each game and caches it in launcher data. This bundle keeps the player's JIT permissions and lets the shared graphics processor load, and it reuses the resources and native libraries of the installed DOSBox Staging application, which stays unchanged.

## Inspector tools

**Inspect program** exports DOS executable headers, entry-register values, file sizes and companion file names. For a batch file, the export keeps the original script and adds a text preview.

**Decompile** exports binary metadata, strings, functions and C pseudocode with the [Rizin/Ghidra tools](../tools/NATIVE_INSPECTION.md). How a program is analyzed depends on its type:

- MZ programs use the architecture information from the executable parser.
- Raw COM programs are analyzed as 16-bit real-mode x86 at origin `0x100`.
- Batch files export their existing source directly.

**Show export** reveals the latest result.

Exports are stored under the game's private `modules/dosbox/` directory. The C pseudocode describes the behavior recovered from the machine code, but original source names and comments are not reconstructed.

## Runtimes

### DOSBox Staging

MacLauncher installs the publisher's own DOSBox Staging application. **Runtimes → DOSBox** lists the stable releases from its universal Mac generation, and a release without a suitable Mac archive stays visible with its download requirement. DOSBox Staging 0.83.0 requires macOS 12.0 and includes Apple Silicon and Intel executables, while each older version keeps its own platform requirements.

The application includes DOSBox Staging's own dependency notices, and Runtimes and Credits link to its source and license.

### UZDoom, Raze and DREAMM

Import and each library refresh record the main game file of a [Doom-engine](DOOM_ENGINE.md), [Build-engine](BUILD_ENGINE.md) or [DREAMM](DREAMM.md) game when the game folder holds exactly one at its top level, and that engine is then offered as the game's runtime. It runs the game data in place the same way as the engine's own game type, with its configuration and saves in the game's launcher data. A folder holding several main game files of one engine does not offer that engine; selecting one of the files imports it as that engine's own game type. The library checks the game folder's files each time it loads, so a DOS game imported earlier gains the choice without being imported again, and a folder that no longer holds exactly one main game file loses it.

### CrossOver, Sikarugir and WineCX

When the game folder also includes a compatible x86 or x64 Windows executable, the [Windows runtimes](WINDOWS.md#windows-executables-in-other-game-types) Sikarugir, CrossOver and WineCX are offered for it. They do not run DOS programs themselves.
