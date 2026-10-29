# Native binary inspection

**Inspect binary** exports static information from imported native programs. It
is available for native macOS apps and executables, Windows games, native Haxe
builds, mac32 entries and unencrypted iOS packages. Plain scripts remain directly
readable source files.

The managed tool is **Rizin / Ghidra**, supplied by the upstream
[Cutter Apple Silicon distribution](https://github.com/rizinorg/cutter/releases).
It contains [Rizin](https://github.com/rizinorg/rizin) and the native
[rz-ghidra](https://github.com/rizinorg/rz-ghidra) decompiler. The CLI installation
retains the required native libraries, Sleigh processor definitions, Rizin data
and license notices. Qt, the Cutter GUI, Java, Python and compiler tools are not
required for this operation.

| Input | Output | Limit |
| --- | --- | --- |
| PE, ELF and Mach-O binaries, including supported universal Mach-O containers | Binary/format metadata, imports, symbols, strings and function inventories as JSON | Information depends on the binary's retained symbols and format metadata. |
| Functions identified by Rizin analysis | Ghidra C pseudocode in `decompiled.c` | Pseudocode is not the original C++, Objective-C, Swift or Haxe source. Types, names and control flow can be incomplete. |
| Unencrypted iOS IPA | The same native inspection, using a private copy of the main executable | Encrypted executable code requires an unencrypted package. Resources and entitlements are inspected separately by the iOS module. |

The original binary is opened read-only and is never executed. User Rizin
settings, scripts and plugins are disabled; the operation loads only the managed
Ghidra plugin. Results and a tool log remain under the game's
`modules/<module>/native-inspection/` directory. Empty pseudocode exports have an
explicit warning while retaining available metadata and logs.

**Runtimes → Tools → Rizin / Ghidra** manages tool versions. The catalog starts
empty and Refresh retrieves upstream releases. An inspection action obtains
consent for a missing package, installs it and resumes. Installed versions work
offline. Apple Silicon is the tool-host architecture; the inspected program can
target a different supported processor or operating system.
Version labels follow the Cutter distribution release; Rizin and the Ghidra
plugin retain their own component versions within that matched package.

These tools do not change playback. Native macOS, Sikarugir, CrossOver, mac32 and
PlayCover retain their existing runtime and game-data requirements.
