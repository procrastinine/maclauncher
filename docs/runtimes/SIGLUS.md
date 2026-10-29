# Siglus and RealLive

The `siglus` module uses [siglus_rs](https://github.com/xmoezzz/siglus_rs) to interpret original game assets on macOS. [RLVM](https://github.com/eglaysher/rlvm) is an additional runtime option for RealLive games with a SEEN.TXT archive. siglus_rs remains the default. Detection, installation, launch preparation and save discovery are plain Node modules; importing or launching through the backend does not require Electron.

## Detection and versions

The detector validates script data before reading the original executable's bounded `RT_VERSION` resource:

- Siglus: a signed `pack_scn` or legacy `Scene.pck` header, scene counts, index ranges and sampled payload ranges.
- RealLive: `Gameexe.ini`, its optional `FOLDNAME.TXT` location, the complete 10,000-entry `SEEN.TXT` table and sampled scenario headers. Loose four-digit scenarios are also recognized.
- AVG32: a bounded `PACL` scenario archive with validated index and entry ranges.

Executable names do not determine the engine: a filename containing Siglus can wrap validated RealLive data. Original PE engine versions, game-edition strings, scenario compiler/header revisions, secondary XOR and add-on declarations remain separate facts. The runtime reads Windows add-on data only where upstream implements its API; it does not execute Windows DLLs.

Library titles use the configuration caption when present. Loose ICO artwork is converted to a cached PNG using its largest supported PNG or bitmap frame. Original executables and module artwork remain icon fallbacks; source files remain unchanged.

The current native RealLive parser accepts header 464 and compiler 10002, 110002 or 1110002. Other recognizable revisions remain detectable and are blocked before downloading an incompatible interpreter.

## Runtime acquisition

MacLauncher Builds packages siglus_rs publisher preview builds for Apple Silicon and Intel. Each package records its full upstream revision and the publisher archive digests; the immutable package includes the native library, direct host and required notices.

**Runtimes → Siglus** manages the interpreter for supported Siglus, RealLive and AVG32 formats. Installed versions remain visible while opening the tab stays offline. Refresh reads the [MacLauncher Builds catalog](https://github.com/procrastinine/maclauncher-builds) and replaces its remote list; a failed query keeps the previous valid list. Explicit installed versions remain available offline.

Play requests the shared missing-runtime download confirmation. The installer verifies the Builds archive, sealed file inventory, native architecture and code signatures. The package contains the native library and signed universal direct host together. The publisher's separate launcher UI is omitted. Normal installation requires no Cargo, Xcode or command-line tools.

Package production checks the selected publisher artifact, direct C API profile, CPU slices, deployment version, signatures and system-library dependency closure. Installation checks the immutable package identity and does not compile or copy a host from the launcher.

Runtime files install under `~/Library/Application Support/maclauncher/runtimes/siglus/<version>/`. [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/vn-adaptations) owns the host source, compile arguments, hashes and packaging recipe. Verified installations retain their selected version and host.

## RLVM for RealLive

**RLVM** is an alternative runtime selection for RealLive games. Its upstream Mac app and the MacLauncher adapter install separately after consent. **Runtimes → RealLive (RLVM)** provides explicit catalog refresh, version selection and removal; opening it makes no network request. Intel-only RLVM apps require Rosetta on Apple Silicon. The shared launch flow requests Rosetta installation when needed. No Python, Homebrew, compiler, terminal commands or manual game-folder picker is required.

RLVM downloads directly from its upstream releases; each installation records its release, commit, archive size and SHA-256. The MacLauncher Cocoa game-directory adapter is a separate managed Builds library containing both Mac CPU architectures. Native dependencies are system libraries, and the game uses its supplied font or a Japanese macOS font. Installations retain their verified adapter and remain usable offline.

RLVM accepts the RealLive script revisions described above and includes upstream rlBabel translation support. Siglus, AVG32 and loose RealLive scenarios use siglus_rs. The original executable is used for import and identification; RLVM runs the game’s data.

A small per-game directory links to the original assets and exposes SEEN.TXT at the location RLVM expects. Game files remain in place. RLVM saves are stored under `userData/games/<gameId>/modules/siglus/rlvm/saves/`, with an upstream REGNAME subdirectory. A save-folder override changes that root. Switching back to siglus_rs retains both sets of saves; their formats are not interchangeable.

## Original assets and saves

With siglus_rs, RealLive and AVG32 read the original game in place. Their upstream `REALLIVE_SAVE_DIR` and `AVG32_SAVE_DIR` interfaces direct writes to `userData/games/<gameId>/modules/siglus/saves/`.

Siglus writes `key.toml` and `savedata` relative to its project. Its private project contains top-level symbolic links to the original assets, a small independent key configuration and independent saves. Original keys and saves are never linked as writable files. There is no complete prepared game copy. The private project and key cache live under `userData/games/<gameId>/modules/siglus/` and are removed when forgetting the game.

Text encoding defaults to the upstream automatic RealLive metadata selection. Runtime Settings also expose explicit encodings and historical Siglus string decoding. Inspector save tools work with the native save directory. Save editing and cheats are unavailable.

**Decompile** uses managed [Siglus SceneScript Utility](https://github.com/Jirehlov/SiglusSceneScriptUtility) to recover Siglus `Scene.pck` scripts as `.ss`/`.inc` source and disassembly under `games/<gameId>/modules/siglus/source/`. **Reveal source** opens the export. The pure-Python package uses the included interpreter and requires no pip or compiler. Reconstructed source can be incomplete.

For recognized RealLive SEEN archives, **Decompile** uses the upstream [RLdev Go](https://github.com/yoremi-trad-fr/rldev2026-go-edition) Windows tool in a private automatic Wine or CrossOver environment. It exports `.org` scripts and `.utf` text resources with the detected interpreter version and a recognized secondary key when required. Warning-affected scripts stay under `partial/` and the report lists their failures. The managed download retains the original KFN and RLdev notices; the publisher supplies no separate Go license file. Loose RealLive scenarios, unknown protected keys and AVG32 remain outside this source-recovery action.

## siglus_rs add-ons

The native build implements EF00/PT00/DT00 add-ons and returns zero for unknown DLL calls. Translation extensions requiring other add-on APIs need a runtime that implements them. No Windows DLL is executed.
