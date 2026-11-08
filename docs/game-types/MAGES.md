# MAGES.

MAGES. games keep their scripts and system data in MPK archives, with the scripts compiled as SC3 programs. MacLauncher plays the Windows HD game data natively with Impacto Windows HD, a macOS player adapted from [Impacto](https://github.com/CommitteeOfZero/impacto), and provides archive inspection and script export for MPK editions.

| Runtime | Description |
| --- | --- |
| Impacto Windows HD (default) | Native player for the supported Windows HD profile, Apple Silicon with macOS 13 or later |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts a complete Windows game folder, its executable or `USRDIR/script.mpk`, and identifies MPK 2.0 script and system archives and SC3 programs. To identify them, import reads only the script and system indexes, one small boot script and the PE and patch metadata, all within size limits.

## Detection and versions

Impacto describes each game edition that it supports in a game profile. MacLauncher adds one more, the Windows HD profile, for the Windows HD edition, which is identified by combining MAGES. product metadata, `_STARTUP_WIN.SCX` and a Bink 2 companion file. The inspector reports the original PE file and product versions separately from the archive and bytecode versions, together with the data edition, the archive and script formats, the version source and whether a native runtime supports the game. A game's product version is not treated as a shared engine version.

## Archive and script tools

These tools work with every MPK edition, and no executable or game script runs during them.

- **Inspect archives** reports member counts, compression and archive-format diagnostics.
- **Inspect scripts** validates SC3 label and string ranges and hashes the decoded bytes.
- **Export compiled scripts** writes the original SCX files and a hash report to `userData/games/<id>/modules/mages/exports/`. It does not decompile scripts.
- **Export text** writes readable UTF-8 dialogue for the recognized Windows HD profile with [sc3tools](https://github.com/CommitteeOfZero/sc3tools). Because sc3tools is an upstream Windows tool, it runs in an automatically prepared private Wine or CrossOver environment, and it is listed under **Runtimes → MAGES. → sc3tools**. The output is written beside the exported SCX files, each text count is checked against the original SC3 string table, and failures are listed in the report. The readable dialogue is not reconstructed SC3 source, and other editions have inspection and compiled export only.

When some members cannot be read, inspection reports them and keeps the readable scripts.

## Runtimes

### Impacto Windows HD

Impacto Windows HD, the default runtime, runs Windows HD game data on Apple Silicon with macOS 13 or later and provides native input, script execution, voice, sound effects, Bink 2 video, save and load, and the backlog. The game window uses the game's title from the library.

Its packages are published by MacLauncher Builds and listed in **Runtimes → MAGES. → Impacto**. For each game, MacLauncher creates only a private profile, configuration and logs in `userData/games/<id>/modules/mages/session/`, and the MPK archives and movies stay where they are.

The player needs a supported layout of the original Windows executable, because it reads the input regions and mouse-selector behavior from that executable. The resulting input table is generated in the private session folder and records the recognized layout and UI-mode declarations before startup.

Each package's manifest declares the versions of MacLauncher's Windows adaptation interfaces it uses, the checksum of its game profile and a check for the Bink 2 decoder. Play reads the interfaces and game profile that the package supplies. A downloaded package is never refused for needing a newer MacLauncher: Play uses the declared interfaces whose versions this MacLauncher implements and leaves the others unused. For a Windows HD game that needs the Bink 2 decoder, the package must also provide that decoder. Installation checks the selected package, its native dependencies, its architecture and its macOS version, and Runtimes lists each package's architectures and minimum macOS version.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows games can also use [Sikarugir (Wine)](../runtimes/SIKARUGIR.md) or an available [CrossOver](../runtimes/CROSSOVER.md) application. The module declares `Launcher.exe` as its Windows entry when it is present beside the original game program, or the game program otherwise. A present launcher is marked as required, so an imported game program identifies the game and Play still starts `Launcher.exe`. The **Windows executable** runtime setting and a publisher entry recorded with a Steam download take precedence. The original game program remains the source of edition and input metadata for Impacto. Windows playback uses the original game files and a separate Windows environment, and the archive and script tools stay available.

## Adapted source

[Impacto 0.10.8.810](https://github.com/CommitteeOfZero/impacto/releases/tag/0.10.8.810), at revision [`ba51381fb65da70697be29e6a817dc4af5c98d19`](https://github.com/CommitteeOfZero/impacto/tree/ba51381fb65da70697be29e6a817dc4af5c98d19), publishes native ARM64 and x64 packages and reads MPK 2.0. Its [upstream console profile](https://github.com/CommitteeOfZero/impacto/blob/ba51381fb65da70697be29e6a817dc4af5c98d19/profiles/sgps3/game.lua), however, uses different CPK mounts, big-endian layouts, 1280×720 presentation and `InstructionSet.SGPS3`. For the Windows HD data, MacLauncher's Windows adapter therefore provides its own little-endian resource and voice layouts, per-script return conventions, VM and UI operands and title sprites. The adapter reads the original compiled scripts directly, with no Windows DLL loading and no console assets.

MacLauncher's changes to Impacto are overlays: patches and scripted edits applied to an unchanged upstream checkout. The current [Windows adaptation](../../src/modules/mages/native/current-windows.patch) and its [overlay record](../../src/modules/mages/native/current-windows-overlay.json) target upstream `0.10.8.937`, commit `fd42cb8a4783e4f7b2c5231ca45ad8e9c891bff0`. The adaptation connects Windows script and string buffers and typed Lua profiles to the native player. The [source overlay](../../src/modules/mages/native/impacto-overlay.json) records the adapted source files and their hashes.

In the adapted player, native input keeps quick taps, and the renderer composites the original Bink 2 alpha frames. Bink 2 video is decoded with [FFmpeg 7.1.2](https://ffmpeg.org/releases/), the LGPL [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core/blob/3b502d4ed79ec2c14066ca09f514db1e2ebb5265/bink2.patch) and an alpha-flag correction, with YUVA420 and full-range video handling.

The adapted player is built from these layers:

| Layer | Source |
| --- | --- |
| Windows input and UI | [Input session](../../src/modules/mages/native/windows-ui-session.js), [native input](../../src/modules/mages/native/windows-input.cpp) |
| Voice and sound | [Audio overlay](../../src/modules/mages/native/windows-audio-overlay.js), [sound-effect overlay](../../src/modules/mages/native/windows-sfx-overlay.js) |
| Save checkpoints and backlog | [Checkpoint overlay](../../src/modules/mages/native/windows-checkpoint-overlay.js), [backlog overlay](../../src/modules/mages/native/windows-backlog-overlay.js) |
| Support for earlier installed profiles | [Adapter](../../src/modules/mages/native/adapter.js), [source patches](../../src/modules/mages/native/source-patches.js) |

The [runtime manager](../../src/modules/mages/native/manager.js) lists the MacLauncher Builds packages.

The [MacLauncher Builds recipe](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/maclauncher/src/modules/mages/native) contains the exact upstream commits, portable native dependency definitions, patches, notices and build scripts. Packages are built without CMake dependency downloads or Homebrew library lookups, and the build removes build-machine paths from compiled code and generated configuration.

## Format limits

- Archive tools allow 64 archives, 65,535 entries per archive and 24 MiB of indexes.
- MPK members need valid 64-bit ranges and unique IDs and names. Decoding and export reject path traversal, absolute paths, ambiguous names, overlapping payloads and archives behind symbolic links.
- Script tools allow 1,024 scripts, 32 MiB per script and 64 MiB each of stored and decoded data.

[Attributions](../ATTRIBUTIONS.md) lists the licenses of the source, decoder and dependencies.
