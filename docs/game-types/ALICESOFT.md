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

Detection identifies the engine generation from the original game data and, where the data allows it, the exact engine version. The inspector shows this detected version separately from the version of the selected runtime, together with its evidence and a confidence level. An unknown value stays unknown and is never filled in from the runtime selection.

### System 1–3 data

A System 1 to 3 import needs a structurally plausible `ADISK.DAT` together with graphics files or `system3.ini` markers. The version can then come from two places. If the `[config]` section of `system3.ini` has a recognized `game` value, that value is reported as declared metadata. Otherwise, the first 256 bytes of `ADISK.DAT` and `BDISK.DAT` are compared with the upstream CRC32 game table, which can identify System 1, 2 or 3 from that fingerprint. Patched or unfamiliar content stays `unknown (System 1–3)`, since a file name alone cannot establish the exact version.

### System 3.5–3.9 data

A System 3.x import needs a valid scenario archive whose name ends in `SA.ALD`. Within size limits, the detector reads the ALD tables and the first available scenario payload, whose scenario tag (`S350`, `S351`, `153S`, `S360` or `S380`) identifies the scenario format. The 3.5, 3.6 and 3.8 formats share a family, however, so a format does not always establish the exact engine revision; in that case the result stays a version range. The System 3.9 family is identified by a valid `System39.ain` with an AINI or AIN2 header, a supported metadata version and a recognized scenario tag. Without a tag, the result is `unknown (System 3.5–3.9)`.

A folder that contains `System40.ini` or `AliceStart.ini` is never treated as a System 3.x game, even when it also contains ALD archives.

### System 4 data

A System 4 import needs `System40.ini` and the local program that its `CodeName` entry names. Absolute paths, path traversal and symbolic links that lead outside the game folder are rejected. The System 4 family is identified by a compressed `AI2` header or an older encrypted AIN header, and the `VERS` field gives the major version of the AIN format, which is separate from the engine version. The exact System 4 engine build therefore stays unknown, and an AIN format number cannot establish whether a title's HLL libraries are compatible either. Malformed System 4 markers never fall back to a System 3 interpreter.

### Version names in the inspector

A detected version appears in the inspector as System 1, System 2, System 3 or System 3.9, or as a format family, such as System 3.8 to 3.9. Unrecognized data reads `unknown (System 1–3)` or `unknown (System 3.5–3.9)`, and System 4 games read `System 4 (engine build unknown)`. An existing library entry keeps its stored version label until the game is detected again.

The detected family also limits runtime selection to the matching interpreter: `system3`, `xsystem35` or `xsystem4`.

## Saves

Ordinary Play uses the original game folder as the working directory and leaves the default save location to the native interpreter. Where that is depends on the engine family: System 1 to 3 and System 3.5 to 3.9 use their original relative save paths and the game's configuration, while System 4 uses its native home directory (`XSYSTEM4_HOME`, `XDG_DATA_HOME/xsystem4` or `HOME/.xsystem4`), followed by the game's name and configured save folder. Native configuration can change these locations, and a per-game save-folder override is passed to the interpreter as an explicit absolute folder.

Save browsing and snapshots follow the folder that is in effect: the native default or the effective configured folder, including authored INI settings, home-directory configuration and save-folder arguments. When that configuration is ambiguous or unsupported, the save location stays unknown to these tools, although the native launch is unchanged. Removing launcher data leaves ordinary native saves in their original locations. There is no general save editor for AliceSoft games; instead, [live variables](#live-variables) can edit a running System 3.5 to 3.9 game.

## Settings

Each interpreter has its own settings.

| Setting | System 1–3 | System 3.5–3.9 | System 4 |
| --- | --- | --- | --- |
| Version | Yes | Yes | Yes |
| Font override | Yes | Yes, for both text styles | Yes, for both text styles |
| Game ID override | Yes | Yes | No |
| Text capture | Off, Console, Clipboard | Off, Console, Clipboard | Off, Console |
| Start fullscreen | Yes | Yes | No |

- **Font override** takes a local TTF or OTF font. Without one, the packages from MacLauncher Builds use their included default fonts: a gothic font for System 1 to 3, and separate gothic and mincho fonts for System 3.5 to 3.9 and System 4. An explicit font replaces those defaults, and for System 3.5 to 3.9 it supplies both styles. A locally registered build keeps its upstream font defaults when no font is selected.
- **Game ID override** sets the upstream game ID, which translated or modified games can need.
- **Text capture** prints game text to the console or copies it to the clipboard. Console output can be seen when the game is started from the command line with a waiting launch, and clipboard capture is always an explicit per-game choice.

## Live variables

**Live variables**, in the inspector's **Live** group, opens an editor for the variables and strings of a running System 3.5 to 3.9 game. Variables and strings have separate pages of editable values, and the editor has Pause and Resume controls. After **Apply**, each value is read back from the game.

The editor needs the game to run under the selected package's debugger. Opening it therefore starts a stopped game with that debugger, or pauses the debugger session that is already running; a game started through ordinary Play must be stopped first. Closing the editor resumes the game, and Stop in the inspector ends the game process with a native debugger disconnect. After the game exits, status queries still report its final result, and closing the editor of an ended game does no harm. Edits and the other controls apply only to the exact session that is still active.

Live variables work with xsystem35 packages that declare the `dap-terminal-nul-v1` debug adapter. On MacLauncher's side, the Node modules `dap.js` and `live-variables.js` handle browsing variables and strings while the game is paused, strict value validation, confirmed writes, and Pause and Continue. The same backend actions are also available to hosts without a user interface. Ordinary Play never enables the debugger. A debugger session uses a private folder that holds only generated variable-symbol metadata and links to the original files. Scenario archives are never changed, and any changes that the debugger makes to instructions exist only in memory.

A live-variable session saves to the explicit save-folder override when one is set, and otherwise to `userData/games/<gameId>/modules/alicesoft/saves/`. That default folder is used only by the live-variable tool, while ordinary Play keeps the native save location.

## Source export

**Decompile**, in the inspector's **Source** group, exports the game's scenarios with the tool that matches the detected scenario generation. **Reveal export** opens the last successful result.

| Scenario family | Tool | Packages | Upstream source |
| --- | --- | --- | --- |
| System 1–3 DRI/DAT | `sys3-decompiler` (`sys3dc`) | MacLauncher Builds | [sys3c](https://github.com/kichikuou/sys3c) |
| System 3.5–3.9 ALD/SCO, with optional System39 AIN metadata | `xsys35-decompiler` (`xsys35dc`) | MacLauncher Builds | [xsys35c](https://github.com/kichikuou/xsys35c) |
| System 4 AIN | `alice-tools` (`alice.exe`) | Upstream releases | [Alice tools](https://github.com/nunuhara/alice-tools) |

The upstream sys3c and xsys35c releases provide only Windows tools, so their Mac packages come from MacLauncher Builds. **Runtimes → AliceSoft** lists these System 1 to 3 and System 3.x decompilers under **System1–3 source** and **System3.x source**, and the System 4 tool under **Alice tools**. MacLauncher checks each tool's executable and the version it reports, and every export records the tool version that ran.

For System 1 to 3 and System 3.x, an export contains UTF-8 ADV source and compiler configuration in `userData/games/<id>/modules/alicesoft/source/`. A System 4 export contains a `scenario.jam` disassembly and `dialogue.txt` instead, which the upstream Windows command-line tool produces in a private Sikarugir or CrossOver prefix. JAM is an assembly representation of AIN, not reconstructed original source.

Export reads the scenario files in place and makes no copy of the game; graphics and audio archives are skipped. For System 3.x, outputs get sequential names and library names are validated, so archive contents cannot choose output paths. Each export also leaves a report in the launcher data that records the exact tool, its source, MacLauncher's changes to it, and the input and output files. If a System 1 to 3 or 3.x export fails or is cancelled, it removes only its own new output folder.

Exports have fixed limits:

- System 1 to 3 and 3.x: at most 32 regular scenario files, 128 MiB per file, 256 MiB in total and 4096 scenario pages. DRI and ALD pointers, SCO headers and optional AIN sections are checked before the tool is installed or run. Output is limited to 8192 supported source and configuration files and 64 MiB. The original scenario hashes are checked again after export.
- System 4: one original AIN file up to 128 MiB, with its hash checked again after the dump.

The sys3c and xsys35c tools are licensed under GPL-2.0-or-later. Besides these packaged tools, the `registerDecompiler` backend action can register an external tool after checking its reported version; the game-facing actions are `decompile` and `revealSourceExport`. MacLauncher does not rebuild edited scenarios, because the matching compilers and the System 4 `sys4dc` and sys4lang tools are not integrated.

## Runtimes

All three interpreters are packaged by MacLauncher Builds, and each one runs the original Windows game data with its own configuration and saves. **Runtimes → AliceSoft** has a section for each of them (**System 1–3**, **System 3.5–3.9** and **System 4**) and lists the architectures and minimum macOS version of every interpreter and decompiler package. The interpreter options are in Settings.

### System 1–3

The System 1 to 3 interpreter is the default runtime and is built from [system3-sdl2](https://github.com/kichikuou/system3-sdl2). Its packages include classic SDL2, text shaping, fonts and MDA resources, which the player finds relative to its executable. Native dependencies are built into the package, so it uses no Homebrew libraries. The CRC32 game table that identifies System 1 to 3 games during detection records its upstream source, revision and license.

### System 3.5–3.9

The System 3.5 to 3.9 interpreter is built from [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2). It reads ALD scenarios, provides SDL2 graphics and audio, and is the interpreter that supports [live variables](#live-variables).

### System 4

The System 4 interpreter is built from [xsystem4](https://github.com/nunuhara/xsystem4) and runs the AIN virtual machine with its HLL APIs. Each package records its xsystem4 and libsys4 source revisions. It contains separate gothic and mincho fonts, shaders, native `--save-folder` routing and optional Console text capture, and it decodes movies with FFmpeg. MacLauncher's Mac adaptations add global-reference initialization, case-insensitive AIN lookup, GBK text conversion and TTC font support, and they also change resource handling, saves and rendering. For rendering, these changes use Apple OpenGL 3.2 core with GLSL 150, and the player finds its shaders relative to the executable.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the source tools stay available with either runtime.

## Local registration

A local interpreter executable can also be used. The `registerRuntime` backend action registers it as an exact version, which the **Version** setting can then choose. The registration is stored in `userData/runtimes/<runtimeId>/<version>/runtime.json`, where the runtime ID is `system3`, `xsystem35` or `xsystem4`, and it records the version, upstream revision, executable path, SHA-256 and registration date. Source information supplied with the executable is recorded as unverified, with `provenanceVerified: false`. The executable itself stays where it is, and runtime status and launch verify its checksum. To replace it, the registration is removed, which deletes only the launcher record, and the executable is registered again. Existing local registrations remain available to explicit version selections.

Registration checks that the path is absolute and executable and that it is a thin or universal 64-bit Mach-O executable whose slices are within size limits and supported by this Mac. Shell scripts, ELF and PE files, and Mach-O libraries are rejected, while an x86_64-only build runs under Rosetta on Apple Silicon. Arguments go directly to the process, without a shell. Registration does not package anything, so a registered executable still needs all of its native libraries and resources.

## Implementation and licenses

Within MacLauncher, the `alicesoft` module handles detection, runtime registration, launch arguments and save folders in the shared Node backend. Electron is used only for optional file-picker dialogs.

Each package records its upstream source revision, and the matching MacLauncher Builds release tag contains the exact upstream commits and build instructions. An installation keeps its complete file manifest, dependency list and build record, which MacLauncher checks again.

The AliceSoft interpreters are licensed under GPL-2.0-or-later, and each package includes the upstream notices.
