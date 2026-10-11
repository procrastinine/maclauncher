# Infinity Engine, MUGEN, HashLink and native Haxe builds

GemRB, Ikemen and HashLink use the shared Node backend and native macOS processes. They do not
load Electron, execute Windows programs, or use Wine. Startup, runtime status and
selection stay offline. Explicit Refresh loads bounded official release metadata;
Play preflights the game and requests installation of the exact missing runtime. Global Install, Build and local registration are also available. Imported game files are
kept intact.

## Scope and version evidence

| Module | Detected game evidence | Native runtime option | Limits |
| --- | --- | --- | --- |
| `gemrb` | Valid `KEY V1` resource index plus `TLK V1` dialog table; optional loose `GAMEV*` header and game INI filenames | `0.9.5-cli-v4`, the Included Apple Silicon CLI runtime with embedded Python | Packed GAME data stays unknown. A GAME header is a data format version, not a game patch number. Enhanced Editions and arbitrary mods are outside the supported profile. |
| `ikemen` | Complete `data`, `chars`, `stages` layout and a motif with `[Info]`/`[Files]`; `mugenversion`, `ikemenversion` and `versiondate` declarations | Official Ikemen GO `1.0.0` macOS ARM64 archive | Declarations are author-supplied requirements, not the original runner version. Original Ikemen Windows executables also expose a bounded Go build-info probe with actual revision/date and modified-build metadata; development binaries retain an unknown release version. Up to 64 character definitions are inspected. Requirements newer than MUGEN 1.1 or Ikemen 1.0 are rejected. Unrecognized declarations remain unverified. |
| `hashlink` | Actual `HLB` bytecode header, serialized metadata and native import table, formats 2–6 | Public Intel development snapshots with matching native modules; Mac profiles `1.9-macos-v2` for typed SDL events and `1.12-macos-v1` for legacy fmt/dynamic SDL imports | This does not detect every Haxe output target. Windows `.hdll` files are incompatible; each imported native module must exist as compatible Mach-O code. Apple Silicon requires Rosetta. The ARM archive contains libraries without the bytecode VM. |
| `haxe` | Windows executable with native `hx_cffi` export and a matching-CPU `lime.ndll` exposing Lime CFFI application/window functions | Inspection only | Windows C++ machine code cannot run natively on macOS. The inspector shows its target, CPU and available support-library build metadata; Play is unavailable. |

The Inspect Game/Inspect Bytecode actions expose source and confidence separately
from runtime selection. Missing version evidence is represented as unknown. The
GemRB inspector rejects a recognized but unsupported loose GAME format; HashLink
rejects unsupported bytecode versions; Ikemen checks supported declared version
ranges again at launch. These checks do not establish complete game compatibility.

## Runtime records and selection

The shared `pinned-native-manager.js` implements the existing manager contract.
Its offline catalog lists pinned versions and source revisions. Explicit
Refresh uses shared paginated GitHub release and tag providers, then persists the
current remote list under the manager runtime directory. Ordinary Refresh lists
all proper releases within a 500-release bound. Source-only or unsupported
historical versions remain visible with an availability reason; a release listing
does not determine native compatibility. Refresh replaces remote entries rather than
accumulating old results, canonicalizes numeric `v` prefixes, and retains pinned
Mac builds once. Installed records keep their original catalog pin even when a
release disappears or its metadata changes. Startup does not contact a server. A per-game `runtimeData.<managerId>.version` wins over the
manager default; a missing selected version does not silently switch to another
installed version. Releases are installed under
`userData/runtimes/<managerId>/<version>/` through a temporary directory after
digest verification. Publisher SHA-256 is checked when provided. Historical
GitHub assets without a publisher digest explicitly record a local archive hash
and remain provenance-unverified. Unsupported known host architectures fail
before downloading; actual Mach-O contents are checked after extraction.

Each `runtime.json` records the revision, executable digest, install source and
date. Launch verifies the recorded executable identity. Replacing the executable
requires removing and registering/installing that version again. Local
registrations store an executable path and digest and explicitly mark provenance
as unverified: choosing a release name alone cannot establish how an external
binary was built. Verified source builds additionally record the tracked source
tree digest, overlay digest, configure options and host identity. Damaged records
and incomplete builds remain visible as rows that can be removed in Runtimes;
they are excluded from launch and default-version fallback. Uninstalling a local registration does not delete the external
executable. The GemRB build action puts its owned source/build output inside its
runtime installation, so uninstalling that managed directory removes its build.

Current pins:

| Runtime | Source revision | Artifact digest / build identity |
| --- | --- | --- |
| GemRB 0.9.5 | `b33f0e7275ea1fc8a82459b418f6a7b5f1b40108` | `0.9.5-cli-v4`; pinned SDL2/audio/Python profiles, module CLI overlay and separate corresponding-source archive |
| Ikemen GO 1.0.0 | `81c6da71d689625e20db79586815b695da00dd6d` | `Ikemen_GO-v1.0.0-macos.zip`: `2b0a8ff44c23b764340d7e428ddbf3a86c4d157c16ee78fe7a960117464bfc12` |
| HashLink 1.16 | `c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14` | Intel VM source build; final executable and tracked-source digest recorded |
| HashLink 1.9 Mac graphics v2 | `4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6` | `1.9-macos-v2`; typed SDL Event ABI, pinned SDL2/OpenAL and full native primitive profile; macOS 13 or later |
| HashLink 1.12 Mac graphics v1 | `68daa125ad115a1f1d1db65d38e6045858d55013` | `1.12-macos-v1`; legacy fmt, dynamic SDL events and OpenAL effects, with a separate corresponding-source archive; macOS 13 or later |
| HashLink 2.0.0 development snapshot | `d049add0a84dc6ae43088a6c386992dbba8604dc` | Public Intel archive: `8fd6d320861c4ca149a5eaff13f3b5ccc9c35d24c8a15147a3b12e9eef4e251b`; macOS 10.13 or later |

The removed HashLink `snapshot-3b7bd74` artifact is retained only to validate
existing installed copies. It is hidden from available versions unless installed
and cannot be downloaded again. Real published tags such as `1.16`, `1.15`,
`1.14` and `1.12` retain their literal upstream tags and exact commits. HashLink's
ARM libraries do not contain the bytecode VM: the upstream JIT emits x86 code.
An ARM HashLink/C support library is not a replacement for the Intel bytecode VM.

## GemRB

Import an unpacked game directory or its executable/resource index and press
**Play**. The launcher runs the pinned CLI v4 package directly from read-only
app resources and prepares private configuration, resource aliases and save
directories automatically. Fixed CLI profiles retain their exact versions and
options in Settings and the inspector; they have no separate management tab.
An Included profile needs no runtime installation copy, compiler or download.

The Included Apple Silicon package requires macOS 13.0. It contains embedded
Python 3.14.8, SDL2 2.32.10, SDL2_mixer 2.8.2 and the selected game-format plugins.
The optional upstream demo is omitted. Automatic selects this profile; explicit
older CLI installations remain separately selectable.

GemRB requests foreground activation through the shared native launch helper and
the child-only [SDL foreground hint](https://wiki.libsdl.org/SDL2/SDL_HINT_MAC_BACKGROUND_APP).
The helper waits for an owned window and makes one bounded AppKit request;
launcher interaction remains responsive. Accessibility and system preference
changes are unnecessary.

The separate corresponding-source archive includes the full pinned Git source,
all 16 dependency archives, module adaptations, notices and an offline build entry.
[portable-build-v4.js](../../src/modules/gemrb/runtime/portable-build-v4.js) builds in a
new directory with explicit ARM/macOS 13 settings and no dependency fetching.
Pinned source and shared dependency prefixes remain read-only. Its overlay adds
the CLI entry consuming `-c <config>`, exports shared scripting-reference classes,
and leaves dependency relocation to packaging. The optional Cocoa settings nib
is unnecessary.

The advanced **Build GemRB CLI runtime** action retains the legacy CLI v2
development build. It requires a clean checkout at the listed pin and separately
installed compiler, Python and native dependencies; it does not produce CLI v4.
[Native tool setup](NATIVE_TOOL_SETUP.md) lists build tools and installation
locations. Ordinary Included playback uses none of them.

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

Optional data, GUI script and plugin directory overrides are useful for local
development installations. The module supplies the CLI bundle's resource and
plugin paths automatically. Runtime dependencies remain required on the
building host; this action is not a standalone redistribution packager.

The Custom Game Profile field explicitly selects a third-party GUIScripts
profile by its safe lowercase identifier. GUIScripts Folder
means the parent folder containing `GUIScripts/`; the selected scripts execute
inside the native game process. A standalone `game/` folder with a unique sibling `GUIScripts/<profile>/Start.py` supplies its profile automatically. The small GUI script tree is privately copied; unrelated Python files do not establish a profile or version.

## Ikemen GO

Install `1.0.0` from **Runtimes → Ikemen GO** on Apple Silicon. Import a complete MUGEN/Ikemen
distribution, rather than an isolated character or stage. Detection prefers the
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

The pinned upstream archive contains an ARM64 executable only. Intel Macs are
not offered this release as a compatible managed runtime. MUGEN custom Lua
extensions, unsupported screenpack features and character behavior can require
game-specific work. Save compatibility depends on the game, and no generic save editor or cheat injector is provided.

## HashLink

Import a validated `.hl`, `hlboot.dat`, or a directory with an unambiguous bytecode
entry. An adjacent Windows launcher can identify `hlboot.dat` without executing
the EXE. **Play** selects a compatible runtime and requests download when needed. Older typed SDL Event imports select `1.9-macos-v2` when their required primitives match. Legacy fmt imports with dynamic SDL events and OpenAL effects select `1.12-macos-v1`. Dynamic imports alone do not identify a compatible runtime: required primitive names and signatures must match the selected native modules. Explicit global and per-game versions remain authoritative. **Runtimes → HashLink** lists published releases, development snapshots and the older Mac profiles. Included runtimes run directly; downloads are shared between games.

The [public development archive](https://github.com/HaxeFoundation/hashlink/releases/tag/latest) reports `2.0.0` and is identified as `2.0.0-dev-d049add0a84d`, with its full source commit and publisher SHA-256. It contains the Intel VM, fmt, Heaps, SDL, OpenAL, SQLite, SSL, UI and libuv modules. Its Mac libraries are contained in the archive; Homebrew is unnecessary. Apple Silicon uses Rosetta. This snapshot is a development build, rather than a stable `2.0.0` release.

Refresh resolves the moving `latest` tag to an exact commit and matches it to the Intel asset filename and publisher digest. A new snapshot reads its reported version, bytecode bounds, SDL primitive declaration and deployment target from that exact source revision. Unrecognized source contracts are rejected. Installation verifies the source header, actual native CPU and macOS requirements, dependency closure and required VM/SDL exports. Launch verifies the installed native files and library aliases. Bytecode requirements are checked against the pinned native signatures before downloading or launching. The public snapshot is available for matching imports; its dynamic SDL ABI does not establish compatibility with every dynamic-import game.

`1.9-macos-v2` is a Mac package identity, not an upstream HashLink release. Its VM, bytecode reader and typed SDL primitive ABI remain at the exact upstream 1.9 commit. Compiler maps replace private source/build/temp/cache/home/workspace roots with logical identities in every compiled component. Existing exact `1.9` registrations and installed bundles retain their original hashes and remain usable; the earlier package is not distributed for new installs or silently rebound to v2.

`1.12-macos-v1` retains the [HashLink 1.12](https://github.com/HaxeFoundation/hashlink/tree/68daa125ad115a1f1d1db65d38e6045858d55013) VM and native signatures. It supplies the older `fmt@mp3_open` byte argument, dynamic SDL event callbacks and complete OpenAL effects primitives. Its matching SDL2 2.0.22 and OpenAL-soft 1.24.3 dependency closure requires macOS 13. The newer public snapshot has different fmt signatures and fewer OpenAL effects primitives, so sharing a bytecode format or SDL event ABI does not make the two packages interchangeable. Automatic compares every required native primitive before selecting a profile; it does not rewrite bytecode or substitute a different native type. The matching source archive contains the original source trees, guarded Mac build adapters, notices and an offline build entry.

The advanced **Build** action for
`1.16` produces an Intel VM with standard primitives and the `ui` module using
local CMake/Ninja and Apple compiler tools; dependency downloads are disabled.
This minimal build does not contain fmt/SDL/OpenAL and therefore does not claim
to run Heaps graphics games. The pinned `1.9` source build preserves the older
typed SDL Event ABI and builds matching graphics modules. It stages the exact
old commit in owned data from local Git objects, compiles pinned SDL2 2.0.22, and
uses HashLink's bundled PNG/Vorbis/JPEG sources. The complete audio profile builds pinned OpenAL-soft 1.24.3 because Apple's OpenAL framework omits required EFX wrappers. It changes no vendored checkout
and performs no dependency download. Its optional SDL2 Source Checkout must be
at `53dea9830964eee8b5c2a7ee0a65d6e268dc78a1`; the default source is KiriKiri's
initialized SDL dependency. Register a complete matching native distribution
explicitly using the runtime path and selected version. Its Intel process uses
Rosetta on Apple Silicon; Play can request its installation with explicit Apple license consent.

The module inspects required native library names without loading them. Standard
and built-in imports use the runtime. Other imports search an optional custom
macOS module directory, the runtime directory and the bytecode directory; launch
passes those directories through `DYLD_LIBRARY_PATH`. Required missing libraries
and Windows/mismatched CPU `.hdll` files block launch with a useful diagnostic.
Optional missing imports remain optional. A Mach-O library still needs matching
HashLink primitive signatures and dependent libraries. Known native signatures are
compared with the bytecode requirements without executing the game; custom modules
with unknown signatures remain unverified. These checks do not establish game
semantics. No save path is inferred for arbitrary Haxe programs.

An `HLB5` header does not identify the HashLink release or guarantee the native
module ABI. Bytecode can require `std`, `fmt`, `ui`, `sdl` and `openal` with the typed
SDL Event signature found in [HashLink 1.9](https://github.com/HaxeFoundation/hashlink/blob/1.9/libs/sdl/sdl.c);
[1.10 and later](https://github.com/HaxeFoundation/hashlink/blob/1.10/libs/sdl/sdl.c)
changed that primitive to a dynamic argument. A newer VM with the same bytecode
format can therefore reject bytecode requiring the older native ABI. The inspector reads the serialized
argument type and distinguishes typed Event from dynamic arguments. Known
incompatible selected versions are blocked before launch; unknown native
primitive ABIs remain unverified. It does not coerce native types. The exact
1.9 VM uses matching fmt/SDL/OpenAL modules. Package integrity does not establish complete gameplay, audio or durable save compatibility.

HashLink runs from a managed overlay. Known static images/audio/resource packs are aliased, and the selected VM reads original bytecode directly. Windows EXEs/DLLs/HDLLs are omitted. Configuration and unknown writable sidecars remain private. Native writes and relative save/config files remain in owned data. Existing player files
persist between launches. A changed source-bytecode digest blocks
launch/restaging so unknown game saves are not silently discarded. Migration removes unchanged obsolete bytecode/native-module copies while retaining relative player saves. No generic
Haxe save format or exact save filename is inferred.

Ikemen aliases static resources, including potentially large 3D GLB/GLTF assets, and preserves a full unchanged runtime app beside per-game assets because the Mac
runner resets its working directory to the app's parent. Save/config/log writes
stay in the managed save directory; the author's initial config is copied only
when no player config exists. Automatic preparation adds aliases inside the owned stage for missing DEF resources that have exactly
one matching filename. Ambiguous or traversal references are left unresolved;
existing resources and source DEFs are not rewritten. For the exact pinned Ikemen 1.0.0 runner, automatic preparation also converts legacy numeric `MugenVersion < 1.0` / `>= 1.0` script expressions to equivalent `MugenVersion(major)` comparisons. Only affected scripts are copied privately; their other encoding bytes, comments and quoted text remain intact. This follows the [current trigger contract](https://github.com/ikemen-engine/Ikemen-GO/wiki/Triggers-(new)#mugenversion); unknown comparisons are not guessed.

## Backend actions and compatibility

Offline inspection is available through `pnpm launch --game /path/to/game --inspect`. HashLink exposes `--action inspectBytecode`; GemRB exposes `--action inspectGame` and the legacy `--action buildRuntime`. Commercial Infinity Engine editions, mods, custom MUGEN extensions and native-module ABIs remain engine-specific constraints.

[FNA](FNA.md) and [visual novel adapters](VN_ENGINES.md) have separate format and native-extension limits.

## Haxe native builds

[Haxe's C++ target](https://haxe.org/manual/target-cpp-getting-started.html)
compiles game logic into platform-specific machine code through
[hxcpp](https://github.com/HaxeFoundation/hxcpp).
Replacing `lime.ndll` with a Mac library does not convert a Windows executable.
A macOS, Flash, HTML5 or HashLink export is needed for native playback.

The detector distinguishes this target through native PE/CFFI exports and CPU
types. OpenFL class metadata can identify the framework after that structural
check. Available hxcpp versions come from support-library build strings and
remain explicitly reported; they do not identify the Haxe compiler, OpenFL
release or game patch. Missing metadata stays unknown.

[Lime](https://lime.openfl.org/docs/project-files/xml-format/) supports several
separate compilation targets. Its native libraries can contain Neko and
HashLink adapters without containing the game in those bytecode formats.
Embedded Flash clips can likewise be supporting assets rather than a playable
Flash export. Native-build inspection extracts no embedded program and starts
no runtime, download or compiler. Saves and cheats are unsupported for this
target. Genuine HashLink exports use the separate HashLink module.

## Primary references and licenses

- [GemRB installation and configuration](https://gemrb.org/Install),
  [pinned source and GPL-2.0-or-later license](https://github.com/gemrb/gemrb/tree/b33f0e7275ea1fc8a82459b418f6a7b5f1b40108),
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
- [FNA upstream scope](https://github.com/FNA-XNA/FNA).
