# DOS

The `dosbox` module runs DOS programs through managed
[DOSBox Staging](https://www.dosbox-staging.org/) versions. Import accepts DOS
MZ executables, COM programs and batch launchers with a matching DOS program.
Windows PE, Windows NE and non-DOS OS/2 executables remain separate formats.
Recognized engine data keeps its existing preferred runtime.

A folder with one DOS program is detected automatically. Folders containing
several programs require selection of the game's EXE, COM or BAT file.
The complete containing game folder supplies its companion data.

## Runtime versions

**Runtimes → DOSBox** provides Refresh, Install and default version selection.
Per-game version choices use the inspector's existing runtime controls.
Stable releases from the universal Mac generation appear after an explicit
Refresh. A release without a suitable Mac archive remains visible with its
download requirement. Installed versions and local detection work offline.

Play requests consent for a missing runtime, installs the selected publisher
application and resumes. DOSBox Staging 0.83.0 requires macOS 12.0 and includes
Apple Silicon and Intel executables. Each older version retains its own
platform requirements.

## Game settings and files

The compact runtime settings provide Fullscreen, Machine and CPU cycles.
CPU cycles accepts `auto`, `max` or a positive number. Game arguments use the
shared argument field; DOS command redirection and variable expansion are
excluded. Programs launched with arguments use DOS 8.3 executable names.

Play prepares a private writable game folder at
`games/<gameId>/modules/dosbox/drive-c/`. The original files remain unchanged.
Saves, configuration and game-generated files stay in this copy. Changed source
assets refresh when the corresponding private file is unchanged; modified
private files, including saves, are retained. The save-location override
selects another private game-data folder outside the original game.

The launcher supplies a per-game DOSBox configuration and keyboard mapper.
Independent DOSBox preferences and local `dosbox.conf` files are not loaded.
The shared network setting controls network access for the game process.

Shared graphics controls apply to the DOSBox game window. A cached per-game
application entry preserves the player's JIT permissions and allows the shared
graphics processor to load. The installed publisher application remains intact;
its resources and native libraries are reused by the owned entry.

## Program tools

**Inspect program** exports DOS executable headers, entry-register values,
file sizes and companion filenames. Batch inspection preserves the original
script and includes a text preview.

**Decompile** uses the managed [Rizin / Ghidra tools](../NATIVE_INSPECTION.md)
to export binary metadata, strings, functions and C pseudocode. MZ programs
use the executable parser's architecture information. Raw COM programs use
16-bit real-mode x86 at origin `0x100`. Batch files export their existing
source directly. **Show export** reveals the latest result.

Tool acquisition uses the existing consent and version catalogs. Exports live
under the game's private `modules/dosbox/` directory. C pseudocode describes
recovered machine-code behaviour; original source names and comments are not
reconstructed.

DOSBox Staging and its included dependency notices accompany each managed
publisher application. Runtime source and license links remain available in
Runtimes and Credits.
