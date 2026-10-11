# Siglus and RealLive

The `siglus` module uses [siglus_rs](https://github.com/xmoezzz/siglus_rs) to interpret original game assets on macOS. [RLVM](https://github.com/eglaysher/rlvm) is an additional runtime option for RealLive games with a SEEN.TXT archive. siglus_rs remains the default. Detection, installation, launch preparation and save discovery are plain Node modules; importing or launching through the backend does not require Electron.

## Detection and versions

The detector validates script data before reading the original executable's bounded `RT_VERSION` resource:

- Siglus: a signed `pack_scn` or legacy `Scene.pck` header, scene counts, index ranges and sampled payload ranges.
- RealLive: `Gameexe.ini`, its optional `FOLDNAME.TXT` location, the complete 10,000-entry `SEEN.TXT` table and sampled scenario headers. Loose four-digit scenarios are also recognized.
- AVG32: a bounded `PACL` scenario archive with validated index and entry ranges.

Executable names do not determine the engine: a filename containing Siglus can wrap validated RealLive data. Original PE engine versions, game-edition strings, scenario compiler/header revisions, secondary XOR and add-on declarations remain separate facts. The runtime reads Windows add-on data only where upstream implements its API; it does not execute Windows DLLs.

The current native RealLive parser accepts header 464 and compiler 10002, 110002 or 1110002. Other recognizable revisions remain detectable and are blocked before downloading an incompatible interpreter. The upstream binary also contains a UK2 interpreter; UK2 detection and save handling are unsupported.

## Runtime acquisition

The pinned native build is **1.0.0-preview.5f358ef1360b**, from full upstream revision `5f358ef1360b0439e92aed2b749e8f25d8721954`. Its actual publisher tag is `pre-release`, which moves; the immutable revision is part of the local version name.

**Runtimes → siglus_rs** manages the interpreter for supported Siglus, RealLive and AVG32 formats. Included and installed versions remain visible while opening the tab stays offline. Exact build and source pins remain available for compatible Play selections. Explicit Reload uses the shared GitHub release/tag provider, including prereleases and all available history within the shared 500-entry bound. Refresh replaces the remote catalog and deduplicates its rows; a failed query keeps the previous valid list. Source releases without published Mac binaries are labeled accordingly; they are not advertised as downloadable native players.

Official published archives:

| Mac | Archive | Publisher SHA-256 |
| --- | --- | --- |
| Apple Silicon | `siglus-macos-arm64.app.tar.gz`, 13,493,403 bytes | `5ad165e007bc71abfca665d01fb9e120add85002a79bbd78ce7a2fafa43c5cfd` |
| Intel | `siglus-macos-x86_64.app.tar.gz`, 14,046,748 bytes | `ac7d516fd04910e271fec062cedba248ef03a394551c33415fc4bbb83c57518c` |

Play requests the shared missing-runtime download confirmation. The installer verifies the archive, native library architecture and code signature, direct C API exports, and system-library dependency closure. It keeps the native library and a bundled, signed universal direct host. The publisher's separate launcher UI is omitted. **Users do not need Cargo, Xcode or a command-line tool installation.**

Architecture, exports, platform, deployment version and library paths are read from bounded Mach-O headers in Node. Signature checks use macOS's built-in `codesign`; installation does not invoke `nm`, `otool` or a compiler. A different CPU, missing API, non-macOS image or external library dependency stops installation before publication.

Runtime files install under `~/Library/Application Support/maclauncher/runtimes/siglus/<version>/`. The checked-in direct host is rebuilt only during development/release preparation; its source, exact compile arguments and hashes are in `src/modules/siglus/resources/native-host/manifest.json`. A source rebuild requires Apple's Command Line Tools at `/Library/Developer/CommandLineTools` (`xcode-select --install`). That requirement does not apply to normal runtime installation.

## RLVM for RealLive

Select **RLVM** in a RealLive game’s runtime selector, then Play. The first launch offers the official Mac download and installs it automatically. **Runtimes → RLVM** provides explicit release refresh, version selection and removal; opening it makes no network request. RLVM 0.14 is an Intel app and requires Rosetta on Apple Silicon. The shared launch flow requests Rosetta installation when needed. No Python, Homebrew, compiler, terminal commands or manual game-folder picker is required.

The default download is upstream `rlvm_0.14.dmg` (2,024,263 bytes), release `release-0.14`, commit `a85b19c2bce61f9b1328220148aeb13b62929eea`. Its pinned SHA-256 is `b6e206bb35a0824a60588e461d6c9334556f11ebff00eda89ed36228c925e8b4`. MacLauncher retains the published app and its license notices. A small included Cocoa adapter supplies the selected game directory. Native dependencies are system libraries, and the game uses its supplied font or a Japanese macOS font.

RLVM accepts the RealLive script revisions described above and includes upstream rlBabel translation support. It does not run Siglus or AVG32 data, loose scenarios without an archive, or arbitrary Windows DLLs. Game-specific extensions and translated editions still affect compatibility. The original executable is used for import and identification; RLVM runs the game’s data.

A small per-game directory links to the original assets and exposes SEEN.TXT at the location RLVM expects. Game files remain in place. RLVM saves are stored under `userData/games/<gameId>/modules/siglus/rlvm/saves/`, with an upstream REGNAME subdirectory. A save-folder override changes that root. Switching back to siglus_rs retains both sets of saves; their formats are not interchangeable.

## Original assets and saves

With siglus_rs, RealLive and AVG32 read the original game in place. Their upstream `REALLIVE_SAVE_DIR` and `AVG32_SAVE_DIR` interfaces direct writes to `userData/games/<gameId>/modules/siglus/saves/`.

Siglus writes `key.toml` and `savedata` relative to its project. Its private project contains top-level symbolic links to the original assets, a small independent key configuration and independent saves. Original keys and saves are never linked as writable files. There is no complete prepared game copy. The private project and key cache live under `userData/games/<gameId>/modules/siglus/` and are removed when forgetting the game.

Text encoding defaults to the upstream automatic RealLive metadata selection. Runtime Settings also expose explicit encodings and historical Siglus string decoding. Inspector save tools work with the native save directory. Save editing, cheats and script decompilation are unavailable.

## siglus_rs compatibility limits

Native menus, dialogue and private slot creation depend on the accepted dialect and add-on requirements. Slot restore and complete gameplay remain compatibility limits.

The native build implements EF00/PT00/DT00 add-ons and returns zero for unknown DLL calls. Other add-on behavior, including translation extensions, remains unsupported; a declaration alone does not establish a compatible API. No Windows DLL is executed.
