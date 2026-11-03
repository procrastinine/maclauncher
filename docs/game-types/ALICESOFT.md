# AliceSoft

AliceSoft games are Windows games built on AliceSoft's System engines, from System 1 to System 4. MacLauncher plays them with three native interpreters, one for each engine generation, and reads the original Windows game data in place.

| Runtime | Engine generations | Upstream source |
| --- | --- | --- |
| System 1–3 (default) | System 1, 2 and 3, following upstream format support | [system3-sdl2](https://github.com/kichikuou/system3-sdl2) |
| System 3.5–3.9 | ALD scenarios, with SDL2 graphics, audio and live variables | [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2) |
| System 4 | AIN virtual machine with HLL APIs, native fonts, audio and movies | [xsystem4](https://github.com/nunuhara/xsystem4) |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable | |

The detected engine generation decides which interpreter a game can use.

## Detection and versions

The inspector shows the game's detected engine version separately from the version of the selected runtime, with its evidence and a confidence level. An unknown value stays unknown; it is never filled in from the runtime selection.

### System 1–3 data

A System 1–3 import needs a structurally plausible `ADISK.DAT` together with graphics files or `system3.ini` markers. A recognized `game` value in the `[config]` section of `system3.ini` is reported as declared metadata. Otherwise the first 256 bytes of `ADISK.DAT` and `BDISK.DAT` are compared with the upstream CRC32 game table, which can identify System 1, 2 or 3 from that fingerprint. Patched or unfamiliar content stays `unknown (System 1–3)`; a file name alone cannot establish the exact version.

### System 3.5–3.9 data

A System 3.x import needs a valid scenario archive whose name ends in `SA.ALD`. The detector reads the ALD tables and the first available scenario payload, within size limits. The scenario tags `S350`, `S351`, `153S`, `S360` and `S380` identify scenario formats. The 3.5, 3.6 and 3.8 formats share a family, so where the format does not establish the exact engine revision the result stays a version range. A valid `System39.ain` with an AINI or AIN2 header, a supported metadata version and a recognized scenario tag identifies the System 3.9 family. Without a tag, the result is `unknown (System 3.5–3.9)`.

A folder that contains `System40.ini` or `AliceStart.ini` is never treated as a System 3.x game, even when it also contains ALD archives.

### System 4 data

A System 4 import needs `System40.ini` and the local program named by its `CodeName` entry. Absolute paths, path traversal and symbolic links that lead outside the game folder are rejected. A compressed `AI2` header or an older encrypted AIN header identifies the System 4 family, and the `VERS` field gives the separate major version of the AIN format. The exact System 4 engine build stays unknown, and an AIN format number cannot establish whether a title's HLL libraries are compatible. Malformed System 4 markers never fall back to a System 3 interpreter.

### Version names in the inspector

The inspector shows a detected version as System 1, System 2, System 3 or System 3.9, or as a format family such as System 3.8–3.9. Unrecognized data reads `unknown (System 1–3)` or `unknown (System 3.5–3.9)`, and System 4 games read `System 4 (engine build unknown)`. An existing library entry keeps its stored version label until the game is detected again.

The detected family limits runtime selection to the matching interpreter: `system3`, `xsystem35` or `xsystem4`.

## Saves

Ordinary Play uses the original game folder as its working directory and leaves the default save location to the native interpreter. System 1–3 and System 3.5–3.9 use their original relative save paths and game configuration. System 4 uses its native home directory: `XSYSTEM4_HOME`, `XDG_DATA_HOME/xsystem4`, or `HOME/.xsystem4`, followed by the game's name and configured save folder. Native configuration can change these locations.

A per-game save-folder override passes that explicit absolute folder to the interpreter. Save browsing and snapshots use the native default or the effective configured folder, including authored INI settings, home-directory configuration and save-folder arguments. When the configuration is ambiguous or unsupported, the save location stays unknown to these tools, and the native launch is unchanged. Removing launcher data leaves ordinary native saves in their original locations. There is no general save editor for AliceSoft games; [live variables](#live-variables) edit a running System 3.5–3.9 game instead.

## Settings

Each interpreter has its own settings.

| Setting | System 1–3 | System 3.5–3.9 | System 4 |
| --- | --- | --- | --- |
| Version | Yes | Yes | Yes |
| Font override | Yes | Yes, for both text styles | Yes, for both text styles |
| Game ID override | Yes | Yes | No |
| Text capture | Off, Console, Clipboard | Off, Console, Clipboard | Off, Console |
| Start fullscreen | Yes | Yes | No |

- **Font override** takes a local TTF or OTF font. The MacLauncher Builds packages include default fonts: System 1–3 uses a gothic font, and System 3.5–3.9 and System 4 use separate gothic and mincho fonts. An explicit font replaces those defaults, and for System 3.5–3.9 it supplies both styles. A locally registered build keeps its upstream font defaults when no font is selected.
- **Game ID override** sets the upstream game ID, for translated or modified games.
- **Text capture** prints game text to the console or copies it to the clipboard. Console output is visible when the game is started from the command line with a waiting launch. Clipboard capture is always an explicit per-game choice.

## Live variables

**Live variables**, in the inspector's **Live** group, opens an editor for the variables and strings of a running System 3.5–3.9 game. It has separate pages for variables and strings, editable values, Pause and Resume, and reads each value back after **Apply**.

Opening the editor starts a stopped game with the selected package's debugger, or pauses the debugger session that is already running. A game started through ordinary Play must be stopped before the live tools can open. Closing the editor resumes the game, and Stop in the inspector ends the game process with a native debugger disconnect. After the game exits, status queries still report its final result, and closing the editor of an ended game does no harm. Edits and the other controls work only on the exact session that is still active.

The editor works with xsystem35 packages that declare the `dap-terminal-nul-v1` debug adapter. The Node modules `dap.js` and `live-variables.js` provide browsing of variables and strings while paused, strict value validation, confirmed writes, and Pause and Continue. Ordinary Play never enables the debugger. The private debugger folder holds only generated variable-symbol metadata and links to the original files. Scenario archives are never changed, and changes the debugger makes to instructions exist only in memory. The same backend actions are available to hosts without a user interface.

Live-variable sessions use the explicit save-folder override when present, otherwise `userData/games/<gameId>/modules/alicesoft/saves/`. Only the live-variable tool uses this folder; ordinary Play keeps the native save location.

## Source export

**Decompile**, in the inspector's **Source** group, chooses the tool for the detected scenario generation. **Reveal export** opens the last successful result.

| Scenario family | Tool | Packages | Upstream source |
| --- | --- | --- | --- |
| System 1–3 DRI/DAT | `sys3-decompiler` (`sys3dc`) | MacLauncher Builds | [sys3c](https://github.com/kichikuou/sys3c) |
| System 3.5–3.9 ALD/SCO, with optional System39 AIN metadata | `xsys35-decompiler` (`xsys35dc`) | MacLauncher Builds | [xsys35c](https://github.com/kichikuou/xsys35c) |
| System 4 AIN | `alice-tools` (`alice.exe`) | Upstream releases | [Alice tools](https://github.com/nunuhara/alice-tools) |

**Runtimes → AliceSoft** lists the native System 1–3 and System 3.x decompilers under **System1–3 source** and **System3.x source**, and the System 4 tool under **Alice tools**. The upstream sys3c and xsys35c releases provide only Windows tools, so their Mac packages come from MacLauncher Builds. MacLauncher checks the executable and version the tool reports, and the export records the tool version that ran.

System 1–3 and 3.x exports contain UTF-8 ADV source and compiler configuration in `userData/games/<id>/modules/alicesoft/source/`. System 4 exports contain a `scenario.jam` disassembly and `dialogue.txt`, produced by the upstream Windows command-line tool in a private Sikarugir or CrossOver prefix. JAM is an assembly representation of AIN; it is not reconstructed original source.

Export reads the scenario files in place, skips graphics and audio archives and makes no copy of the game. System 3.x outputs get sequential names and library names are validated, so archive contents cannot choose output paths. A report in the launcher data records the exact tool, its source, MacLauncher's changes to it, and the input and output files. A failed or cancelled System 1–3 or 3.x export removes only its own new output folder.

Export limits:

- System 1–3 and 3.x: at most 32 regular scenario files, 128 MiB per file, 256 MiB in total and 4096 scenario pages. DRI and ALD pointers, SCO headers and optional AIN sections are checked before the tool is installed or run. Output is limited to 8192 supported source and configuration files and 64 MiB. The original scenario hashes are checked again after export.
- System 4: one original AIN file up to 128 MiB, with its hash checked again after the dump.

The sys3c and xsys35c tools are licensed under GPL-2.0-or-later. The `registerDecompiler` backend action registers an external tool after checking its reported version. The game-facing actions are `decompile` and `revealSourceExport`. MacLauncher does not rebuild edited scenarios: the matching compilers and the System 4 `sys4dc` and sys4lang tools are not integrated.

## Runtimes

MacLauncher Builds packages the three interpreters, and all three run the original Windows game data with their own configuration and saves. **Runtimes → AliceSoft** has a section for each (**System 1–3**, **System 3.5–3.9** and **System 4**) and lists the architectures and minimum macOS version of every interpreter and decompiler package, while the interpreter options are in Settings.

### System 1–3

System 1–3 is the default runtime, built from [system3-sdl2](https://github.com/kichikuou/system3-sdl2). Its packages include classic SDL2, text shaping, fonts and MDA resources, which the player finds relative to its executable. Native dependencies are built into the package, with no Homebrew libraries. The CRC32 game table that identifies System 1–3 games records its upstream source, revision and license.

### System 3.5–3.9

System 3.5–3.9, built from [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2), reads ALD scenarios, provides SDL2 graphics and audio, and is the interpreter that supports [live variables](#live-variables).

### System 4

System 4 is built from [xsystem4](https://github.com/nunuhara/xsystem4) and runs the AIN virtual machine with its HLL APIs. Packages record their xsystem4 and libsys4 source revisions. They contain separate gothic and mincho fonts, shaders, native `--save-folder` routing and optional Console text capture, and they decode movies with FFmpeg. The Mac adaptations add global-reference initialization, case-insensitive AIN lookup, GBK text conversion, TTC font support, and changes to resource handling, saves and rendering. MacLauncher's rendering changes use Apple OpenGL 3.2 core with GLSL 150, and the player finds its shaders relative to the executable.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the source tools stay available with either runtime.

## Local registration

The `registerRuntime` backend action registers a local interpreter executable as an exact version; the **Version** setting chooses the version. The registration is stored in `userData/runtimes/<runtimeId>/<version>/runtime.json`, where the runtime ID is `system3`, `xsystem35` or `xsystem4`, with the version, upstream revision, executable path, SHA-256 and registration date. The source information supplied with it is recorded as unverified, with `provenanceVerified: false`. The executable stays where it is, and runtime status and launch verify its checksum. Replacing it means removing the registration, which deletes only the launcher record, and registering again. Existing local registrations remain available to explicit version selections.

Registration checks that the path is absolute and executable and that it is a thin or universal 64-bit Mach-O executable whose slices are within size limits and supported by this Mac. An x86_64-only build runs under Rosetta on Apple Silicon. Shell scripts, ELF and PE files, and Mach-O libraries are rejected. Arguments go directly to the process without a shell. A registered executable still needs all of its native libraries and resources; registration does not package them.

## Implementation and licenses

The `alicesoft` module handles detection, runtime registration, launch arguments and save folders in the shared Node backend; Electron supplies only optional file-picker dialogs.

Each package records its upstream source revision, and the matching MacLauncher Builds release tag contains the exact upstream commits and build instructions. An installation keeps its complete file manifest, dependency list and build record, and MacLauncher checks them again.

The AliceSoft interpreters are licensed under GPL-2.0-or-later, and each package includes the upstream notices.
