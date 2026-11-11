# Siglus / RealLive

This game type covers three Windows visual novel formats: Siglus, RealLive and AVG32. MacLauncher plays all three natively with [siglus_rs](https://github.com/xmoezzz/siglus_rs), which interprets the original game assets on macOS. RealLive games with a `SEEN.TXT` archive can use [RLVM](https://github.com/eglaysher/rlvm) as well.

| Runtime | Formats |
| --- | --- |
| Siglus (default) | Siglus, RealLive and AVG32, through siglus_rs |
| RealLive (RLVM) | RealLive games with a `SEEN.TXT` archive |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Detection and versions

Before it reads the original executable's `RT_VERSION` resource, within a size limit, detection validates each format's script data:

- Siglus: a signed `pack_scn` or older `Scene.pck` header, scene counts, index ranges and sampled payload ranges.
- RealLive: `Gameexe.ini`, the optional `FOLDNAME.TXT` location it names, the complete 10,000-entry `SEEN.TXT` table and sampled scenario headers. Loose four-digit scenario files are also recognized.
- AVG32: a `PACL` scenario archive, within a size limit, with validated index and entry ranges.

Executable names do not decide the engine: an executable whose name contains Siglus can wrap validated RealLive data. The original PE engine version, game edition strings, scenario compiler and header revisions, the secondary XOR key and add-on declarations are each reported as separate facts. The inspector shows the format and the script compiler, and **Inspect scripts**, in the **Advanced** group, runs the inspection on demand.

The RealLive parser in siglus_rs accepts header 464 with compiler 10002, 110002 or 1110002. Other recognizable revisions are still detected, but they are blocked before an incompatible interpreter is downloaded.

When the game's configuration has a caption, the library title uses it. For icons, loose ICO artwork is converted to a cached PNG from its largest supported PNG or bitmap frame, and the original executables and the module artwork remain the fallbacks.

## Saves

With siglus_rs, an ordinary launch runs from the original game directory and keeps the save location that upstream uses for each format: `savedata` for Siglus, `savedata_rs` for RealLive and, for AVG32, the save filename that the game configures in its original directory. When an explicit save-folder override is set, it is passed through the interpreter's save-directory interface where one is available.

Siglus writes `key.toml` relative to its project. With automatic string decoding, the original project is used directly. An explicit string-decoding setting or save-folder override, however, needs a small project adapter, because siglus_rs reads those settings from its project layout. This adapter uses the original assets and keeps its own key configuration, and it directs saves to the original `savedata` directory or to the explicit override. Interpreter caches remain in launcher data.

RLVM, by contrast, keeps its saves separately, as described under [RealLive (RLVM)](#reallive-rlvm). The inspector's save tools work with the native save folder, and save editing and cheats are not available.

## Settings

The Siglus runtime has two settings:

| Setting | Default | Values |
| --- | --- | --- |
| Text encoding | Automatic | Automatic, Japanese, UTF-8, Windows-1252, Simplified Chinese, Traditional Chinese, Korean |
| Siglus strings | Automatic | Automatic, XOR, Plain, Detect historical encoding |

With **Automatic** text encoding, RealLive games use their encoding metadata, as upstream does, and unsupported script revisions stop before launch. **Siglus strings** either selects the string decoding explicitly or detects historical Siglus string encodings.

## Source tools

**Decompile**, in the inspector's **Source** group, recovers source in two ways, depending on the format, and **Reveal source** opens the export.

- For Siglus `Scene.pck` scripts, it uses the [Siglus SceneScript Utility](https://github.com/Jirehlov/SiglusSceneScriptUtility), listed under **Runtimes → Siglus → Siglus SceneScript Utility**, to write `.ss` and `.inc` source and disassembly to `games/<gameId>/modules/siglus/source/`. The tool is a pure Python package, so it runs on MacLauncher's included Python. Reconstructed source can be incomplete.
- For recognized RealLive SEEN archives, it uses the upstream [RLdev Go](https://github.com/yoremi-trad-fr/rldev2026-go-edition) Windows tool, listed under **Runtimes → RealLive (RLVM) → RLdev**, in an automatically prepared private Wine or CrossOver environment. It exports `.org` scripts and `.utf` text resources, using the detected interpreter version and, when needed, a recognized secondary key. Scripts with warnings go to a `partial/` folder, and the report lists their failures. The installed tool keeps the original KFN and RLdev notices, and the publisher provides no separate Go license file.

Source recovery does not support loose RealLive scenarios, unknown protected keys or AVG32 games.

## Runtimes

### Siglus

Siglus, the default runtime, uses siglus_rs as packaged by MacLauncher Builds. For each package, MacLauncher Builds either packages a publisher release or compiles the declared source revision, and the source and download digests are retained. Every package is built and attested on GitHub and contains the native library, a signed host program that calls the library's C API directly, and license texts. The publisher's separate launcher UI is left out.

These interpreter packages are listed under **Runtimes → Siglus**, from the [MacLauncher Builds catalog](https://github.com/procrastinine/maclauncher-builds). During installation, MacLauncher verifies the archive digest listed in the catalog, the safety of the archive's paths, the native architecture and the code signatures, and it never compiles a host or copies one from MacLauncher. In the package metadata, the interpreter's upstream revision is recorded separately from the MacLauncher Builds source revision. Runtime files are installed in `~/Library/Application Support/maclauncher/runtimes/siglus/<architecture>/<version>/`.

Packages are also checked when they are built: MacLauncher Builds checks the selected publisher download, the C API that the host calls, the CPU slices, the deployment version, the signatures and the system-library dependencies. The host source, compile arguments, hashes and packaging script are kept in [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/vn-adaptations).

#### Add-ons

The siglus_rs package implements the EF00, PT00 and DT00 add-ons and returns zero for calls to unknown DLLs. The runtime reads Windows add-on data only where upstream implements the add-on's API, and no Windows DLL is ever run. Translation extensions that need other add-on APIs therefore require a runtime that implements them.

### RealLive (RLVM)

RLVM is an alternative runtime for RealLive games, whereas Siglus games, AVG32 games and loose RealLive scenarios use the Siglus runtime. RLVM accepts the RealLive script revisions listed under [Detection and versions](#detection-and-versions) and includes upstream rlBabel translation support. The original executable is used for import and identification, while RLVM runs the game's data.

This runtime has two parts, which are installed separately: the upstream RLVM Mac app and an adapter from MacLauncher Builds. RLVM is downloaded directly from its upstream releases, as the release's disk image or, when the release renames or repackages it, another Mac archive. Wherever the download places the app, installation finds it and reads its minimum macOS version from the executable. Each installation also records its release, commit, archive size and SHA-256.

The adapter, an attested MacLauncher Builds package, is a Cocoa library for both Mac CPU architectures. It passes the game folder to RLVM, so the folder never has to be chosen in RLVM. Native dependencies are system libraries, and the game uses its own font or a Japanese macOS font.

The RLVM releases are listed under **Runtimes → RealLive (RLVM)**, and the adapter versions are in its **MacLauncher adapter** section. On Apple Silicon, Intel-only RLVM apps need Rosetta, which the shared launch flow requests when needed.

To launch, a small per-game folder links to the original assets and exposes `SEEN.TXT` where RLVM expects it. RLVM saves are stored in `userData/games/<gameId>/modules/siglus/rlvm/saves/`, in a subfolder named after the game's REGNAME, as upstream does, and a save-folder override changes that root. Switching back to the Siglus runtime keeps both sets of saves, although their formats are not interchangeable.

### CrossOver, Sikarugir and WineCX

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application, [Sikarugir](../runtimes/SIKARUGIR.md) or [WineCX](../runtimes/WINECX.md). With each of these runtimes, the detected version and the inspector tools stay available.

## Implementation

The `siglus` module handles detection, installation, launch preparation and save discovery in plain Node modules, so importing or launching a game through the backend does not require Electron.
