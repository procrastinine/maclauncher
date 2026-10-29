# Infinity Engine, MUGEN, HashLink and native Haxe builds

GemRB, Ikemen and HashLink use the shared Node backend and native macOS processes. They do not
load Electron, execute Windows programs, or use Wine. Startup, runtime status and
selection stay offline. Explicit Refresh loads bounded official release metadata;
Play preflights the game and requests installation of the exact missing runtime. Managed installation and supported local imports are in Runtimes. Imported game files are
kept intact.

Compatible x86/x64 Windows exports also offer [Sikarugir (Wine)](SIKARUGIR.md)
and locally registered [CrossOver](CROSSOVER.md), preserving the detected engine
and its inspection tools. Native runtime constraints below apply to the engine
backend.

## Game formats and runtimes

| Game type | Imported data | Native runtime |
| --- | --- | --- |
| Classic Infinity Engine | Game resource index, dialog tables and original game data | GemRB packages from MacLauncher Builds, native with embedded Python |
| MUGEN / Ikemen | Character, stage and motif files with game configuration | Upstream Ikemen GO macOS releases, native Apple Silicon |
| HashLink | `.hl` or `hlboot.dat` bytecode and its resources | Matching MacLauncher Builds 1.9/1.12 ABI profile or upstream VM snapshot; Intel with Rosetta |
| Native Windows Haxe | Windows executable and Lime support libraries | Inspection and Windows playback through Sikarugir or CrossOver |

The inspector displays detected engine, data-format and runtime versions
separately. Playback selects the matching format and native-module API.

## GemRB

Import accepts an unpacked game directory or its executable/resource index. Play downloads a missing CLI package from MacLauncher Builds after consent, then prepares private configuration, resource aliases and save directories automatically. **Runtimes → GemRB** manages versions; Settings and the inspector retain engine options. Installed packages work offline without a compiler.

Each package contains embedded Python, SDL2, SDL2_mixer and the selected
game-format plugins; Runtimes lists its architectures and minimum macOS.
The optional upstream demo is omitted. Without a game or global choice, Play uses the newest installed version
that runs on this Mac, otherwise the newest listed version. Older CLI installations remain separately selectable.

Packages add native CLI/Cocoa integration and include the SDL2, audio and Python
dependencies. Existing exact installed versions remain selectable.

GemRB requests foreground activation through the shared native launch helper and
the child-only [SDL foreground hint](https://wiki.libsdl.org/SDL2/SDL_HINT_MAC_BACKGROUND_APP).
The helper waits for an owned window and makes one bounded AppKit request;
launcher interaction remains responsive. Accessibility and system preference
changes are unnecessary.

The matching MacLauncher Builds release commit contains the pinned Git source,
dependency definitions, module adaptations, notices and the build entry. Its
overlay adds the CLI entry consuming `-c <config>` and exports shared
scripting-reference classes; the optional Cocoa settings nib is unnecessary.

Generated `GemRB.cfg`, cache and saves live below
`userData/games/<gameId>/modules/gemrb/`. `SavePath` points to the managed save
root; GemRB creates its own `save`/`mpsave` subdirectories. Existing portable saves
are not automatically copied from the original game. The save location override
is respected. GemRB cheat keys can be enabled explicitly in Runtime Settings;
this is the upstream engine toggle, with no game script patching or save codec.
The game data is staged through a per-game asset tree; mutable INI settings and
character exports are copied, while resource files are linked for reading. This
keeps ordinary game configuration writes away from the imported directory.

The overlay aliases known static engine resource formats, including BIF archives, KEY/TLK tables and graphics/audio resources. INI settings, logs, path files, character exports and unknown sidecars are private copies. Source symlinks are ignored. New-file writes stay in the owned overlay.

Optional data, GUI script and plugin directory overrides replace the default
locations. The module supplies the CLI bundle's resource and plugin paths
automatically.

The Custom Game Profile field explicitly selects a third-party GUIScripts
profile by its safe lowercase identifier. GUIScripts Folder
means the parent folder containing `GUIScripts/`; the selected scripts execute
inside the native game process. A standalone `game/` folder with a unique sibling `GUIScripts/<profile>/Start.py` supplies its profile automatically. The small GUI script tree is privately copied; unrelated Python files do not establish a profile or version.

The inspector's **Open Near Infinity** action opens a managed resource editor
with the game's key file already selected. Missing tool and compatible Java
downloads request consent, install automatically and resume. The tool's update
checks and game-launch controls are disabled. Browsing is read-only; saving from
the external editor changes original game files. [Infinity Engine tools](../INFINITY_TOOLS.md) contains the corresponding reference.

## Ikemen GO

Play offers the compatible Ikemen GO download when needed; versions can also be managed in **Runtimes → Ikemen GO**. Input is a complete MUGEN/Ikemen distribution
containing its character, stage and configuration files. Detection prefers the
motif declared in `data/mugen.cfg`, then `data/system.def`, then an unambiguous
`data/<screenpack>/system.def`. A shipped `.app` can be imported when its complete
game data is alongside it.

Launch uses the actual ARM64 executable, avoiding upstream shell wrappers. It
stages a per-game overlay of engine defaults and game assets, then passes
`-r <motif>`. The selected engine supplies its Lua support scripts; imported
foreign scripts are not silently injected. Asset files are linked for reading;
mutable config, statistics, replays and logs go to the managed save root through
the wrapper's `save` link. Runtime changes rebuild the asset overlay while
preserving that save root. Original directories are not patched. Existing linked
files reflect edits; newly added/removed files require rebuilding the staged asset
tree. Source directory symlinks are conservatively skipped by these staging paths.

Upstream 1.x macOS archives contain an ARM64 executable. Ikemen interprets the
selected character, stage, motif and Lua definitions through its original engine.
Game-defined saves remain in the private save root.

Ikemen aliases static resources, including potentially large 3D GLB/GLTF assets, and preserves a full unchanged runtime app beside per-game assets because the Mac
runner resets its working directory to the app's parent. Save/config/log writes
stay in the managed save directory; the author's initial config is copied only
when no player config exists. Automatic preparation adds aliases inside the owned stage for missing DEF resources that have exactly
one matching filename. Ambiguous or traversal references are left unresolved;
existing resources and source DEFs are not rewritten. For the Ikemen GO 1.0.0 release (commit `81c6da71`), automatic preparation also converts legacy numeric `MugenVersion < 1.0` / `>= 1.0` script expressions to equivalent `MugenVersion(major)` comparisons. Only affected scripts are copied privately; their other encoding bytes, comments and quoted text remain intact. This follows the [current trigger contract](https://github.com/ikemen-engine/Ikemen-GO/wiki/Triggers-(new)#mugenversion); unknown comparisons are not guessed.

### Sprite export

**Export sprites** uses managed [SFF Tools](https://github.com/openkakutou/sff)
to read SFF v1/v2 archives in the imported game. A missing tool downloads after
consent under **Runtimes → Ikemen GO → SFF Tools**. The matched upstream WebAssembly
module and Go runtime execute in a private Node worker; no Go installation,
compiler or Wine is required. Game scripts are not executed.

Output contains PNG images and JSON group/image identifiers, dimensions, axis
points and palette references below the game's launcher data. Originals stay
unchanged. Individual file/sprite errors remain in `sprites-export.json` beside
useful output. Linked/shared v2 pixel data is unsupported by this decoder;
its metadata remains inspectable. Empty sprites have metadata without an image.
SND audio is outside this action's scope.

Bounds are 1,024 SFF files, 128 MiB per file, 512 MiB total input, 20,000 sprites,
4,096 pixels per axis, 64 MiB per decode batch and 512 MiB requested pixel data.
Cancellation or an export with no decoded sprites preserves the preceding
successful export. SFF Tools 0.3.1 is pinned to source
[`37f178383dbe9fd98bbe2d397144f078763852b3`](https://github.com/openkakutou/sff/tree/37f178383dbe9fd98bbe2d397144f078763852b3),
with SHA-256 verification of both published runtime files. Downloads retain
the MIT and BSD license notices.

## HashLink

Import accepts `.hl`, `hlboot.dat` or a directory with an unambiguous bytecode
entry. An adjacent Windows launcher can identify `hlboot.dat` without executing
the EXE. **Play** selects a compatible runtime and requests download when needed. The game's bytecode recommends a published Intel package whose bytecode version, SDL event ABI and exact native-primitive profile match and whose macOS requirement this Mac meets: the newest matching public development snapshot, otherwise the matching MacLauncher Builds package with the newest upstream version. Older typed SDL Event imports therefore receive a 1.9 package with the `typed-1.9-macos-v2` primitive profile when their required primitives match, and legacy fmt imports with dynamic SDL events and OpenAL effects receive a 1.12 package with the `legacy-dynamic-1.12-macos-v1` profile. Dynamic imports alone do not identify a compatible runtime: required primitive names and signatures must match the selected native modules. An explicit per-game version precedes the recommendation, and the global default applies when the bytecode provides no SDL or native-primitive evidence or no listed package matches. The recommendation is used for preparation and launch checks without being saved as a per-game choice. **Runtimes → HashLink** lists published releases, development snapshots and the older Mac profiles. Installed runtimes work offline and are shared between games.

The bytecode VM runs as Intel 64-bit, including the Intel slice of universal distributions. Shared graphics uses that same architecture when selecting compatible providers.

Snapshots of the [public development archive](https://github.com/HaxeFoundation/hashlink/releases/tag/latest) report `2.0.0` and are identified as `2.0.0-dev-<commit>`, with the full source commit and publisher SHA-256. They contain the Intel VM, fmt, Heaps, SDL, OpenAL, SQLite, SSL, UI and libuv modules. Their Mac libraries are contained in the archive; Homebrew is unnecessary. Apple Silicon uses Rosetta. These snapshots are upstream development builds, distinct from a stable `2.0.0` release.

Refresh resolves the moving `latest` tag to an exact commit and matches it to the Intel asset filename and publisher digest. A new snapshot reads its reported version, bytecode bounds, SDL primitive declaration and deployment target from that exact source revision. Unrecognized source contracts are rejected. Installation verifies the source header, actual native CPU and macOS requirements, dependency closure and required VM/SDL exports. Launch verifies the installed native files and library aliases. Bytecode requirements are checked against the pinned native signatures before downloading or launching. The public snapshot is available for matching imports.

The 1.9 Mac packages are MacLauncher Builds package identities, not upstream HashLink releases. Their VM, bytecode reader and typed SDL primitive ABI remain at the exact upstream 1.9 commit. Compiler maps replace private source/build/temp/cache/home/workspace roots with logical identities in every compiled component. Existing exact installed versions retain their original hashes and are never silently rebound to another profile.

The 1.12 Mac packages retain the [HashLink 1.12](https://github.com/HaxeFoundation/hashlink/tree/68daa125ad115a1f1d1db65d38e6045858d55013) VM and native signatures. It supplies the older `fmt@mp3_open` byte argument, dynamic SDL event callbacks and complete OpenAL effects primitives. They include a matching SDL2 and OpenAL-soft dependency closure. The newer public snapshot has different fmt signatures and fewer OpenAL effects primitives, so sharing a bytecode format or SDL event ABI does not make the two packages interchangeable. Automatic compares every required native primitive before selecting a profile; it does not rewrite bytecode or substitute a different native type. The matching MacLauncher Builds release commit contains the source pins, Mac build adapters, notices and build entry.

**Runtimes → HashLink** can import a complete matching native distribution: select its version and choose **Import local build…**. Its Intel process uses
Rosetta on Apple Silicon; Play can request its installation with explicit Apple license consent.

The module inspects required native library names without loading them. Standard
and built-in imports use the runtime. Other imports search an optional custom
macOS module directory, the runtime directory and the bytecode directory; launch
passes those directories through `DYLD_LIBRARY_PATH`. Required missing libraries
and Windows/mismatched CPU `.hdll` files block launch with a useful diagnostic.
Optional missing imports remain optional. A Mach-O library still needs matching
HashLink primitive signatures and dependent libraries. Known native signatures are
compared with the bytecode requirements without executing the game; custom modules
with unknown signatures are identified separately in the report. No save path is inferred for arbitrary Haxe programs.

The `HLB5` bytecode version is checked separately from each native module’s API. Bytecode can require `std`, `fmt`, `ui`, `sdl` and `openal` with the typed
SDL Event signature found in [HashLink 1.9](https://github.com/HaxeFoundation/hashlink/blob/1.9/libs/sdl/sdl.c);
[1.10 and later](https://github.com/HaxeFoundation/hashlink/blob/1.10/libs/sdl/sdl.c)
changed that primitive to a dynamic argument. A newer VM with the same bytecode
format can therefore reject bytecode requiring the older native ABI. The inspector reads the serialized
argument type and distinguishes typed Event from dynamic arguments. Known
incompatible selected versions are blocked before launch; unknown native
primitive ABIs are reported as unknown. It does not coerce native types. The exact
1.9 VM uses matching fmt/SDL/OpenAL modules.

HashLink runs from a managed overlay. Known static images/audio/resource packs are aliased, and the selected VM reads original bytecode directly. Windows EXEs/DLLs/HDLLs are omitted. Configuration and unknown writable sidecars remain private. Native writes and relative save/config files remain in owned data. Existing player files
persist between launches. A changed source-bytecode digest blocks
launch/restaging so unknown game saves are not silently discarded. Migration removes unchanged obsolete bytecode/native-module copies while retaining relative player saves. No generic
Haxe save format or exact save filename is inferred.

**Export bytecode** uses managed [hlbc](https://github.com/Gui-Yom/hlbc) to export metadata, function opcodes and entrypoint pseudocode (hlbc's experimental decompiler output) for bytecode versions 4 and 5. The published CLI can fail on some functions or compiler output; exports retain available metadata, partial listings, tool logs and explicit warnings. This does not recover a complete Haxe source project. The existing metadata inspector supports bytecode versions 2–6 independently of hlbc. The tool downloads after consent and runs in a private Windows environment through Sikarugir or CrossOver; a missing Sikarugir engine can download after separate consent.

## Backend actions

Offline inspection is available through `pnpm launch --game /path/to/game --inspect`. HashLink exposes `--action inspectBytecode`; GemRB exposes `--action inspectGame`.

[FNA](FNA.md) and [visual novel adapters](VN_ENGINES.md) have separate guides.

## Haxe native builds

[Haxe's C++ target](https://haxe.org/manual/target-cpp-getting-started.html)
compiles game logic into platform-specific machine code through
[hxcpp](https://github.com/HaxeFoundation/hxcpp).
Replacing `lime.ndll` with a Mac library does not convert a Windows executable.
A macOS, Flash, HTML5 or HashLink export is needed for native playback. Play runs a
Windows hxcpp/Lime build through a registered [CrossOver](CROSSOVER.md) application
when one is available, otherwise through managed [Sikarugir (Wine)](SIKARUGIR.md);
detection and **Inspect binary** stay available with either backend.

The detector distinguishes this target through native PE/CFFI exports and CPU
types. OpenFL class metadata can identify the framework after that structural
check. Available hxcpp versions come from support-library build strings and
remain explicitly reported; they do not identify the Haxe compiler, OpenFL
release or game patch. Missing metadata stays unknown.

[Lime](https://lime.openfl.org/docs/project-files/xml-format/) supports several
separate compilation targets. Its native libraries can contain Neko and
HashLink adapters without containing the game in those bytecode formats.
Embedded Flash clips can likewise be supporting assets rather than a playable
Flash export. Metadata detection remains offline and starts no runtime or compiler.
**Inspect binary** uses the managed [Rizin / Ghidra tools](../NATIVE_INSPECTION.md)
to export native metadata and C pseudocode without executing the game.
HashLink exports use the separate HashLink module.

## Runtime records and selection

The shared `pinned-native-manager.js` implements the existing manager contract.

Selection uses the game's exact version, then a recommendation from the game's data, then the runtime default. A saved default takes precedence over the manager default: the newest compatible stable published version, or the newest ready installed version when no compatible version is listed. Clearing a saved default restores the manager default. Explicit per-game and saved default versions remain exact. Installing the first version from Runtimes saves it as the default when no default is saved. Managers that declare `supportsDefault: false`, such as Unity Mono and the mpv plugins, offer no **Set default**. Equal release versions identified only by source hashes retain their catalog ordering rather than treating a hash as a version number.
Available downloads start empty or use cached discovery. Explicit Refresh reads
the selected MacLauncher Builds or upstream catalog, then saves that source's
current list under the manager runtime directory. Ordinary Refresh lists
all proper releases within a 500-release bound. Historical and source-only versions retain their installation requirements. Refresh replaces remote entries rather than
accumulating old results, canonicalizes numeric `v` prefixes, and retains pinned
Mac builds once. Installed records keep their original catalog pin even when a
release disappears or its metadata changes. Startup does not contact a server. A per-game `runtimeData.<managerId>.version` wins over the
game's recommendation and the manager default; a missing selected version does not switch to another
installed version. Releases are installed under
`userData/runtimes/<managerId>/<version>/` through a temporary directory after
digest verification. Publisher SHA-256 is checked when provided. Historical
GitHub assets without a publisher digest record the downloaded archive’s hash. Host architecture matching runs before downloading; actual Mach-O contents are checked after extraction.

Each `runtime.json` records the revision, executable digest, install source and
date. Launch verifies the recorded executable identity. Replacing the executable
requires removing and registering/installing that version again. Local
registrations store the supplied source identity, executable path and digest. Damaged records
and incomplete builds remain visible as rows that can be removed in Runtimes;
they are excluded from launch and default-version fallback. Uninstalling a local registration does not delete the external
executable.

HashLink primitive profiles bind each native package to its exact upstream revision and signatures:

| Profile | Upstream revision | Native ABI |
| --- | --- | --- |
| `typed-1.9-macos-v2` | `4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6` | Typed SDL Event ABI with matching fmt, SDL and OpenAL modules |
| `legacy-dynamic-1.12-macos-v1` | `68daa125ad115a1f1d1db65d38e6045858d55013` | Legacy fmt, dynamic SDL events and OpenAL effects |
| `stock-2.0.0-d049add0a84d` | `d049add0a84dc6ae43088a6c386992dbba8604dc` | Public Intel development archive `8fd6d320861c4ca149a5eaff13f3b5ccc9c35d24c8a15147a3b12e9eef4e251b` |
| `stock-2.0.0-10b77768ab91` | `10b77768ab913ab7ba4c776791d1db2d15db8db3` | Public Intel development archive `1638e5e881b4d8ef963f623c04abdf8057a88cac678960dc812d313c58b21e3d` |

Real published tags such as `1.16`, `1.15`, `1.14` and `1.12` retain their literal
upstream tags and exact commits. HashLink's ARM libraries do not contain the
bytecode VM: the upstream JIT emits x86 code. An ARM HashLink/C support library is
not a replacement for the Intel bytecode VM.

## Primary references and licenses

- [GemRB installation and configuration](https://gemrb.org/Install),
  [source and GPL-2.0-or-later license](https://github.com/gemrb/gemrb/tree/b33f0e7275ea1fc8a82459b418f6a7b5f1b40108),
  [GAME importer format handling](https://github.com/gemrb/gemrb/blob/b33f0e7275ea1fc8a82459b418f6a7b5f1b40108/gemrb/plugins/GAMImporter/GAMImporter.cpp).
- [Ikemen GO 1.0.0](https://github.com/ikemen-engine/Ikemen-GO/releases/tag/v1.0.0),
  [CLI and configuration implementation](https://github.com/ikemen-engine/Ikemen-GO/blob/81c6da71d689625e20db79586815b695da00dd6d/src/main.go),
  [licensing](https://github.com/ikemen-engine/Ikemen-GO/blob/81c6da71d689625e20db79586815b695da00dd6d/LICENCE.txt).
  Engine code is MIT; bundled screenpack assets carry Creative Commons licenses
  and bundled FFmpeg carries LGPL-2.1 terms. The distribution's license files stay
  in the installed runtime directory.
- [HashLink pinned bytecode reader](https://github.com/HaxeFoundation/hashlink/blob/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14/src/code.c),
  [native module loader](https://github.com/HaxeFoundation/hashlink/blob/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14/src/module.c),
  [MIT source license](https://github.com/HaxeFoundation/hashlink/tree/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14).
- [FNA source](https://github.com/FNA-XNA/FNA).
