# Siglus / RealLive

This game type covers three Windows visual novel formats: Siglus, RealLive and AVG32. MacLauncher plays all three natively with [siglus_rs](https://github.com/xmoezzz/siglus_rs), which interprets the original game assets on macOS. RealLive games with a `SEEN.TXT` archive can also use [RLVM](https://github.com/eglaysher/rlvm).

| Runtime | Formats |
| --- | --- |
| Siglus (default) | Siglus, RealLive and AVG32, through siglus_rs |
| RealLive (RLVM) | RealLive games with a `SEEN.TXT` archive |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Detection and versions

Detection validates the script data before it reads the original executable's `RT_VERSION` resource, within a size limit:

- Siglus: a signed `pack_scn` or older `Scene.pck` header, scene counts, index ranges and sampled payload ranges.
- RealLive: `Gameexe.ini`, the optional `FOLDNAME.TXT` location it names, the complete 10,000-entry `SEEN.TXT` table and sampled scenario headers. Loose four-digit scenario files are also recognized.
- AVG32: a `PACL` scenario archive, within a size limit, with validated index and entry ranges.

Executable names do not decide the engine: an executable whose name contains Siglus can wrap validated RealLive data. The original PE engine version, game edition strings, scenario compiler and header revisions, the secondary XOR key and add-on declarations are reported as separate facts. The inspector shows the format and the script compiler, and **Inspect scripts**, in the **Advanced** group, runs the inspection on demand.

The RealLive parser in siglus_rs accepts header 464 with compiler 10002, 110002 or 1110002. Other recognizable revisions are still detected, and they are blocked before an incompatible interpreter is downloaded.

Library titles use the caption from the game's configuration when it has one. Loose ICO artwork is converted to a cached PNG from its largest supported PNG or bitmap frame. The original executables and the module artwork remain the icon fallbacks.

## Saves

With siglus_rs, ordinary launches use the original game directory and its upstream save locations. Siglus uses `savedata`, RealLive uses `savedata_rs`, and AVG32 uses the save filename configured by the game in its original directory. An explicit save-folder override uses the interpreter's save-directory interface where available.

Siglus writes `key.toml` relative to its project. Automatic string decoding uses the original project directly. An explicit string-decoding setting or save-folder override needs a small project adapter, because siglus_rs reads those settings from its project layout. The adapter uses the original assets, keeps its own key configuration and directs saves to the original `savedata` directory or the explicit override. Interpreter caches remain in launcher data.

RLVM keeps its saves separately, as described under [RealLive (RLVM)](#reallive-rlvm). The inspector's save tools work with the native save folder, and save editing and cheats are not available.

## Settings

The Siglus runtime has two settings:

| Setting | Default | Values |
| --- | --- | --- |
| Text encoding | Automatic | Automatic, Japanese, UTF-8, Windows-1252, Simplified Chinese, Traditional Chinese, Korean |
| Siglus strings | Automatic | Automatic, XOR, Plain, Detect historical encoding |

**Automatic** text encoding uses the encoding metadata of RealLive games, as upstream does. Unsupported script revisions stop before launch. **Siglus strings** selects the string decoding explicitly or detects historical Siglus string encodings.

## Source tools

**Decompile**, in the inspector's **Source** group, recovers source in two ways, depending on the format, and **Reveal source** opens the export.

- For Siglus `Scene.pck` scripts, it uses the [Siglus SceneScript Utility](https://github.com/Jirehlov/SiglusSceneScriptUtility), listed under **Runtimes → Siglus → Siglus SceneScript Utility**, to write `.ss` and `.inc` source and disassembly to `games/<gameId>/modules/siglus/source/`. The tool is a pure Python package and runs on MacLauncher's included Python. Reconstructed source can be incomplete.
- For recognized RealLive SEEN archives, it uses the upstream [RLdev Go](https://github.com/yoremi-trad-fr/rldev2026-go-edition) Windows tool, listed under **Runtimes → RealLive (RLVM) → RLdev**, in an automatically prepared private Wine or CrossOver environment. It exports `.org` scripts and `.utf` text resources, using the detected interpreter version and, when needed, a recognized secondary key. Scripts with warnings go to a `partial/` folder, and the report lists their failures. The installed tool keeps the original KFN and RLdev notices; the publisher provides no separate Go license file.

Loose RealLive scenarios, unknown protected keys and AVG32 games are not supported by source recovery.

## Runtimes

### Siglus

Siglus, the default runtime, uses siglus_rs. MacLauncher Builds packages a publisher release or compiles the declared source revision, retaining the source and download digests. Each package, built and attested on GitHub, contains the native library, a signed host program that calls the library's C API directly, and license texts. The publisher's separate launcher UI is left out.

**Runtimes → Siglus** lists the interpreter packages from the [MacLauncher Builds catalog](https://github.com/procrastinine/maclauncher-builds). Installation verifies the catalog archive digest, safe paths, the native architecture and the code signatures, and it never compiles a host or copies one from MacLauncher. Package metadata records the interpreter's upstream revision separately from the MacLauncher Builds source revision. Runtime files are installed in `~/Library/Application Support/maclauncher/runtimes/siglus/<architecture>/<version>/`.

When MacLauncher Builds builds a package, it checks the selected publisher download, the C API that the host calls, the CPU slices, the deployment version, the signatures and the system-library dependencies. [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/vn-adaptations) contains the host source, compile arguments, hashes and packaging script.

#### Add-ons

The siglus_rs package implements the EF00, PT00 and DT00 add-ons and returns zero for calls to unknown DLLs. The runtime reads Windows add-on data only where upstream implements the add-on's API, and no Windows DLL is ever run. Translation extensions that need other add-on APIs require a runtime that implements them.

### RealLive (RLVM)

RLVM is an alternative runtime for RealLive games. It accepts the RealLive script revisions listed under [Detection and versions](#detection-and-versions) and includes upstream rlBabel translation support. Siglus games, AVG32 games and loose RealLive scenarios use the Siglus runtime. The original executable is used for import and identification, and RLVM runs the game's data.

The upstream RLVM Mac app and an adapter from MacLauncher Builds are installed separately. RLVM downloads directly from its upstream releases: the release's disk image or, when the release renames or repackages it, another Mac archive. Installation finds the app wherever the download places it and reads its minimum macOS version from the executable, and each installation records its release, commit, archive size and SHA-256. The adapter, an attested MacLauncher Builds package, is a Cocoa library for both Mac CPU architectures that passes the game folder to RLVM, so the folder never has to be chosen in RLVM. Native dependencies are system libraries, and the game uses its own font or a Japanese macOS font.

**Runtimes → RealLive (RLVM)** lists the RLVM releases, and its **MacLauncher adapter** section lists the adapter versions. Intel-only RLVM apps need Rosetta on Apple Silicon, and the shared launch flow requests the Rosetta installation when needed.

A small per-game folder links to the original assets and exposes `SEEN.TXT` where RLVM expects it. RLVM saves are stored in `userData/games/<gameId>/modules/siglus/rlvm/saves/`, in a subfolder named after the game's REGNAME as upstream does. A save-folder override changes that root. Switching back to the Siglus runtime keeps both sets of saves; their formats are not interchangeable.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the inspector tools stay available with either runtime.

## Implementation

The `siglus` module handles detection, installation, launch preparation and save discovery in plain Node modules, so importing or launching a game through the backend does not require Electron.
