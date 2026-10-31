# Native binary inspection

**Inspect binary** exports static information about an imported native program without running it. The action is available for macOS games and executables, Windows games, Haxe native builds, mac32 entries and unencrypted iOS packages. Plain scripts are already readable source and have no binary to inspect. The **Decompile** actions of [DOS](../game-types/DOS.md#inspector-tools), [PlayStation 5](../game-types/PS5.md#inspector-tools) and [Nintendo Switch](../game-types/SWITCH.md#inspector-tools) games use the same tools.

Inspection does not change playback: native macOS, Sikarugir, CrossOver, mac32 and PlayCover keep their usual runtime and game-data requirements.

## Output

| Input | Output | Limits |
| --- | --- | --- |
| PE, ELF and Mach-O binaries, including supported universal Mach-O files | Binary and format metadata, imports, symbols, strings and a function inventory, as JSON | The detail depends on the symbols and format metadata the binary keeps. |
| Functions found by Rizin's analysis | Ghidra C pseudocode in `decompiled.c` | Pseudocode is not the original C++, Objective-C, Swift or Haxe source. Types, names and control flow can be incomplete. |
| Unencrypted iOS IPA | The same inspection of a private copy of the main executable | Encrypted executables need an unencrypted package. The iOS game type inspects resources and entitlements separately. |

The original binary is opened read-only and never executed. User Rizin settings, scripts and plugins are disabled, and the operation loads only the Ghidra plugin installed with the tool. Results and a tool log are stored in the game's `modules/<module>/native-inspection/` folder. If the pseudocode export is empty, the result says so explicitly and keeps the available metadata and logs.

## Rizin / Ghidra

**Rizin / Ghidra** comes from the upstream [Cutter macOS distributions](https://github.com/rizinorg/cutter/releases), with separate Apple Silicon and Intel builds. It contains [Rizin](https://github.com/rizinorg/rizin) and the native [rz-ghidra](https://github.com/rizinorg/rz-ghidra) decompiler. The installation keeps the command-line tools with their native libraries, the Sleigh processor definitions, Rizin's data files and the license notices. The operation needs no Qt, Cutter GUI, Java, Python or compiler tools.

**Runtimes → Tools → Rizin / Ghidra** manages the tool's versions, and Refresh lists the upstream releases.

The tool runs on Intel and Apple Silicon, and the inspected program can target a different supported processor or operating system. Version labels follow the Cutter release; Rizin and the Ghidra plugin keep their own component versions within that package.
