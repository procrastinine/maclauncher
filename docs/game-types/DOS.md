# DOS

This game type covers DOS programs, which MacLauncher runs with [DOSBox Staging](https://www.dosbox-staging.org/) through its `dosbox` module.

## Accepted inputs

Import accepts DOS MZ executables, COM programs, and batch launchers that start a matching DOS program. Windows PE, Windows NE and non-DOS OS/2 executables are separate formats and do not match. Data from a recognized engine keeps that engine's preferred runtime.

A folder with one DOS program is detected automatically. In a folder with several programs, the game's EXE, COM or BAT file has to be selected directly. The whole containing game folder supplies the companion data.

## Preparation and saves

By default, Play opens the selected original program and uses its containing directory as the DOS drive and working directory. The game reads and writes its own files there, including saves, and Play neither copies nor lists the game's files.

With a save-location override, Play uses a writable copy of the complete DOS drive at the chosen location, because DOSBox, as MacLauncher runs it, has no separate save-folder option. Saves and modified files in that copy stay unchanged, while source assets that the copy has not changed are refreshed there. This copy is used only with an override.

Files in the private `drive-c` folders of earlier MacLauncher versions are recovered once into the original game folder, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. An original file that differs stays unchanged, and the recovered version is kept beside it as a separate copy. Drive copies at an active save-location override, including overlapping folders, stay untouched.

Each game gets its own DOSBox configuration and keyboard mapper from MacLauncher, so separate DOSBox preferences and local `dosbox.conf` files are not loaded. The shared network setting controls network access for the game process.

## Settings

DOSBox Staging has three runtime settings: **Fullscreen**, **Machine** and **CPU cycles**, which accepts `auto`, `max` or a positive number.

Game arguments use the shared argument field, without DOS command redirection or variable expansion. A program launched with arguments is started by its DOS 8.3 executable name.

## Graphics

Shared graphics controls apply to the DOSBox game window. A small per-game application bundle, cached in launcher data, keeps the player's JIT permissions and lets the shared graphics processor load. It reuses the resources and native libraries of the installed DOSBox Staging application, which stays unchanged.

## Inspector tools

**Inspect program** exports DOS executable headers, entry-register values, file sizes and companion file names. Inspecting a batch file keeps the original script and adds a text preview.

**Decompile** uses the [Rizin/Ghidra tools](../tools/NATIVE_INSPECTION.md) to export binary metadata, strings, functions and C pseudocode:

- MZ programs use the architecture information from the executable parser.
- Raw COM programs are analyzed as 16-bit real-mode x86 at origin `0x100`.
- Batch files export their existing source directly.

**Show export** reveals the latest result.

Exports are stored under the game's private `modules/dosbox/` directory. The C pseudocode describes the recovered machine-code behavior; original source names and comments are not reconstructed.

## Runtimes

### DOSBox Staging

**Runtimes → DOSBox** lists the stable DOSBox Staging releases from its universal Mac generation, and MacLauncher installs the publisher's own application. A release without a suitable Mac archive stays visible with its download requirement. DOSBox Staging 0.83.0 requires macOS 12.0 and includes Apple Silicon and Intel executables. Each older version keeps its own platform requirements.

The application includes DOSBox Staging's own dependency notices, and Runtimes and Credits link to its source and license.

### CrossOver and Sikarugir (Wine)

When the game folder also includes a compatible x86 or x64 Windows executable, the [Windows runtimes](WINDOWS.md#windows-executables-in-other-game-types) Sikarugir and CrossOver are offered for it. They do not run DOS programs themselves.
