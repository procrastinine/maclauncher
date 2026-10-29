# MAGES. / Impacto

Impacto runs MAGES. Windows HD game data natively on macOS. Import accepts a complete Windows game folder, its executable or `USRDIR/script.mpk`. The module identifies **MPK 2.0** script/system archives and **SC3** programs, with archive inspection and script export alongside playback.

The inspector keeps original PE file/product versions separate from archive/bytecode versions. Windows HD profile detection combines MAGES. product metadata, `_STARTUP_WIN.SCX` and a Bink 2 companion; a game's product version is not a shared engine version.

## Archive and script tools

**Inspect archives** reports member counts, compression and archive-format diagnostics. **Inspect scripts** validates SC3 label/string ranges and hashes decoded bytes. **Export compiled scripts** writes original SCX files and a hash report under `userData/games/<id>/modules/mages/exports/`. It does not decompile scripts or change game data. Partial inspection reports failed members while retaining readable scripts. No executable or game script runs during these actions.

**Export text** adds readable UTF-8 dialogue for the recognized Windows HD profile using managed [sc3tools](https://github.com/CommitteeOfZero/sc3tools). The upstream Windows tool runs through an automatically prepared private Wine or CrossOver environment. Output stays beside the privately exported SCX files; each text count is checked against its original SC3 string table, and failures remain in the report. Other editions retain inspection and compiled export. Readable dialogue is not reconstructed SC3 source.

## Windows HD runtime

The **Impacto** runtime runs Windows HD game data on **Apple Silicon with macOS 13 or later**. It requires a supported original Windows executable layout for input tables. Play downloads a missing runtime from MacLauncher Builds after consent, then runs its verified installed package; the launcher creates only a private profile/configuration and logs under `userData/games/<id>/modules/mages/session/`. MPK archives and movies remain in their original location. Settings retains explicit version selection; **Runtimes → MAGES. → Impacto** manages available and installed profiles.

Native windows use the game's library title.

The Windows adapter provides native input, script execution, voice, sound effects, Bink 2 video, save/load and backlog. Archive and script tools are also available for other MPK editions.

Compatible x86/x64 Windows games can also select
[Sikarugir (Wine)](SIKARUGIR.md) or an available [CrossOver](CROSSOVER.md)
application. Their original Windows executable runs from separate private game
files and environments; the engine's archive and script tools remain available.

Each MacLauncher Builds package manifest declares its Windows adaptation contracts, game profile checksum and Bink 2 decoder probe. Play accepts any package whose contracts and game profile this launcher implements; a package that declares a newer contract requires a newer MacLauncher, and a package without the Bink 2 decoder does not start. Installed runtimes retain their per-game selections.

The adapter reads input regions and mouse-selector behavior from the original Windows executable. The generated input table stays in the private session directory. The input table records recognized layout and UI-mode declarations before startup.

[Impacto 0.10.8.810](https://github.com/CommitteeOfZero/impacto/releases/tag/0.10.8.810), revision [`ba51381fb65da70697be29e6a817dc4af5c98d19`](https://github.com/CommitteeOfZero/impacto/tree/ba51381fb65da70697be29e6a817dc4af5c98d19), publishes native ARM64/x64 packages and reads MPK 2.0. Its [upstream console profile](https://github.com/CommitteeOfZero/impacto/blob/ba51381fb65da70697be29e6a817dc4af5c98d19/profiles/sgps3/game.lua) uses different CPK mounts, big-endian layouts, 1280×720 presentation and `InstructionSet.SGPS3`. The Windows adapter supplies its own little-endian resource/voice layouts, per-script return conventions, VM/UI operands and title sprites. Original compiled scripts are read directly; this route requires no Windows DLL loading or console assets.

The [source overlay](../../src/modules/mages/native/impacto-overlay.json) records adapted source files and hashes; upstream source remains read-only. Native input retains quick taps, while the renderer composites original Bink 2 alpha frames. The codec uses [FFmpeg 7.1.2](https://ffmpeg.org/releases/), the LGPL [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core/blob/3b502d4ed79ec2c14066ca09f514db1e2ebb5265/bink2.patch) and an alpha-flag correction, with YUVA420/full-range video handling.

The [runtime manager](../../src/modules/mages/native/manager.js) provides separate controls for MacLauncher Builds packages and upstream release/source history. MacLauncher Builds supplies the macOS player adapted for Windows game data. Installation checks the selected package, native dependencies, architecture and macOS version. Detection and status stay offline; installed runtimes work offline. Refresh and consented installation use the network.

## Adapted source

The current [Windows adaptation](../../src/modules/mages/native/current-windows.patch) and its [overlay record](../../src/modules/mages/native/current-windows-overlay.json) target upstream
`0.10.8.903`, commit `914fae7cbb9583f8aa231569a03aab27d8c042f8`. The adaptation connects
Windows script/string buffers and typed Lua profiles to the native player.

The adapted player composes these implementation layers:

| Layer | Source |
| --- | --- |
| Windows input and UI | [Input overlay](../../src/modules/mages/native/windows-ui-overlay.js) |
| Voice and sound | [Audio overlay](../../src/modules/mages/native/windows-audio-overlay.js), [sound-effect overlay](../../src/modules/mages/native/windows-sfx-overlay.js) |
| Save checkpoints and backlog | [Checkpoint overlay](../../src/modules/mages/native/windows-checkpoint-overlay.js), [backlog overlay](../../src/modules/mages/native/windows-backlog-overlay.js) |
| Earlier installed profile support | [Adapter](../../src/modules/mages/native/adapter.js), [source patches](../../src/modules/mages/native/source-patches.js) |

The [MacLauncher Builds producer](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/maclauncher/src/modules/mages/native)
contains the source pins, portable native dependency definitions, owned patches,
notices and build entries. Packages are built without CMake dependency downloads or
Homebrew library lookup. Compiler path mappings and normalized generated
configuration keep build locations out of the native package. Runtimes lists each
package's architectures and minimum macOS.

## Format bounds

Archive tools allow 64 archives, 65,535 entries per archive and 24 MiB of indexes. MPK members require valid 64-bit ranges and unique ids/names. Decoding and export reject traversal, absolute paths, ambiguous names, overlapping payloads and symlinked archives. Import reads only script/system indexes, one small boot script and bounded PE/patch metadata. Script tools allow 1,024 scripts, 32 MiB per script and 64 MiB each of stored/decoded data.

[Attributions](../ATTRIBUTIONS.md) lists source, decoder and dependency licenses.
