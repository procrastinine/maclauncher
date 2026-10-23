# AliceSoft, KiriKiri, BGI and VNDS

The `kirikiri` and `alicesoft` modules run native macOS interpreters through the shared Node backend. Detection, runtime registration, launch arguments and save directories live in module code; Electron supplies optional file-picker services. Import and status stay offline. Ordinary Play selects a compatible interpreter and requests download consent when its managed package is missing.

## Managed runtime versions

These adapted backends use exact versioned profiles from MacLauncher Builds. Their sections in **Runtimes** manage available versions and installed copies. Settings retains engine options and the inspector retains each runtime’s name and exact version. Binary installation needs no compiler or registration; installed profiles work offline. Inventory, hash, permission, CPU, macOS and signature checks precede execution. A corrupt selected profile fails rather than silently selecting another build. Existing exact local installations remain available.

The inspector offers game-specific script tools, decompilation and runtime options. Missing interpreters and decompilers install automatically after download consent. Source builders and local registration APIs remain available for development; they do not add game inspector controls or an automated upstream-update flow.

| Runtime option | Selected version | Pinned source revision | Scope |
| --- | --- | --- | --- |
| KiriKiri SDL2 | `MCLv1-1001` | `124bdf841f09e7ce02aa99b7b55791a0f7a900ff` | Full-frame Mac presentation and real directory/font/monitor APIs for compatible KAG3 |
| AliceSoft System 1–3, SDL2 | `1.8.0-MCLv1` | `461673bec729e7e0ec905921fc3e03aecf977a70` | ARM64, macOS 13; System 1, 2 and 3 follow upstream format support |
| AliceSoft System 3.5–3.9 | `2.20.0-macos-v2` | `82c8b76a58a19ff1f87b4bdadbaef169c4b37f46` | System 3.x ALD scenarios |
| AliceSoft System 3.5–3.9 source snapshot | `MCLv1-1019` | `fbb12f67950601d547f65ef37c4fba4a10cc3822` | SDL2, macOS 13; SDL compatibility and audio backend separation |
| AliceSoft System 4 | `snapshot-04333ad-macos-v2` | `04333ad689d7e517a93d58141bb214c19ba16129` | System 4 AIN VM; selected HLL APIs, portable SDL2/font/audio/movie resources |

Each runtime version is pinned to the listed commit. Upstream sources remain Git submodules under `src/external/` and are read-only. KiriKiri's core is MIT licensed with separate bundled component licenses. The AliceSoft interpreters use GPL-2.0-or-later; retain their upstream notices when distributing builds. The factual System 1–3 identifier resource records its upstream source, revision and license.

System3 `1.8.0-MCLv1` includes classic SDL2, text shaping, fonts and executable-relative MDA resources. Its native dependencies are built for macOS 13 without external Homebrew libraries. The player installs as a complete managed package; no compiler is required. Earlier `1.8.0` selections remain separate. The matching MacLauncher Builds tag contains source pins and build instructions. Source developers use `buildPortableSystem3` with its six pinned dependency archives; the older generic builder cannot build this profile.

Existing local registrations are retained for explicit version selections. Explicit per-game versions stay exact; an unavailable or incompatible selected version reports its requirements without silently choosing another build. Developer integrations can register an exact local executable through the module API.

Registrations are stored in `userData/runtimes/<runtimeId>/<version>/runtime.json`. They retain version, upstream revision, executable path, SHA-256 and registration date. Local registration stores the supplied source identity with `provenanceVerified: false`. The executable remains at its original location. Unregistering a local build removes the launcher record and leaves the external build intact. Replacing it requires removing the old registration and registering again. Status and launch verify its checksum. Managed binary installations additionally preserve and revalidate the complete shipped file manifest, dependency inventory and build provenance.

The developer source builder validates an exact clean Git revision and all recursively initialized pinned submodules, then copies only tracked source files into its runtime installation's disposable `build-source/` directory. Compiler output lives in `build-output/`. The source checkout is never changed. CMake FetchContent updates/downloads and Meson wrap downloads are disabled; compiler tools and native dependencies must already be installed. Missing or mismatched source/dependencies fail clearly and do not publish a runtime registration. The developer API accepts an explicit `sourceDir` payload for a separate clean checkout.

Successful builds register automatically with `provenanceVerified: true`, the pinned commit, staged source-tree SHA-256, compatibility-overlay SHA-256, configure options, host architecture and a bounded build log. CMake builds set `CMAKE_OSX_DEPLOYMENT_TARGET=13.0`; the System 4 Meson build sets `MACOSX_DEPLOYMENT_TARGET=13.0` explicitly. Dependency deployment floors remain independent: a macOS 13 executable linked to a macOS 27 library is not a macOS 13 distribution. Build cancellation terminates compiler processes and publishes no successful registration. Duplicate builds of a registered version require removing that registration first. Removing an installation also removes managed compiler output; externally registered executables remain untouched.

Kiri source builds map compiler file/debug/macro paths to logical source/build roots. The shared builder retains these C flags when adding its compatibility header. Published package metadata retains the source revisions and build options without local build paths.

The shared `local-native.js` helper checks absolute local paths, executable permission, thin/universal 64-bit Mach-O headers, executable type, bounded slices and host CPU support. x86_64-only builds on Apple silicon explicitly use the existing Rosetta process path. Shell scripts, ELF/PE files and Mach-O libraries are rejected as executables. Arguments pass directly to the process launcher without a shell.

Downloaded KiriKiri executables use the shared bounded Mach-O load-command reader to check each CPU slice, macOS deployment metadata and system-library closure before signing the private installation. Binary installation needs no Xcode or Command Line Tools. Source builds keep their separate developer prerequisites.

## Game version detection

Runtime build versions and imported game engine versions are separate fields. Game details display detected version, evidence and confidence; an unknown value is preserved rather than filled from the runtime selection.

KiriKiri source projects require a root `startup.tjs`. Loose `system/Initialize.tjs`, `Initialize.tjs` and `startup.tjs` are inspected for explicit `kagVersion` or `tjsVersion` constants, including UTF-16LE scripts. A KAG `3.32 stable rev. 2` declaration identifies that script version, not the Windows host's KiriKiri 2/Z revision. No scripts execute during detection. The SDL2 profile selects KAG3/TJS2 source declarations. Source projects without explicit constants retain an absent generation value.

Direct `.xp3` imports and archives beside Windows launchers require valid XP3 metadata with a root `startup.tjs` entry. The detector supports bounded raw/zlib indexes, valid bounded chained indexes, and embedded XP3 data in fused Windows EXEs; malformed indexes/chains are rejected. An asset-only XP3 is not a game import. Import reads at most three initialization/startup script entries, each limited to 512 KB, to report explicit KAG/TJS constants without extraction or execution. KAG constants identify the script framework, while the native Windows host generation can remain unknown. Protected XP3 scripts require the verified-plain checks below; encrypted content and known TJS1/KAG2 projects are refused before runtime installation. App imports inspect project data under `Contents/Resources/game`, `Contents/Resources/data` or `Contents/Resources`.

AliceSoft System 1–3 imports require a structurally plausible `ADISK.DAT` plus graphics or `system3.ini` markers. A recognized `game` value in the INI's `[config]` section is reported as declared metadata. Otherwise the first 256 bytes of ADISK/BDISK are checked against the pinned upstream CRC32 game table, which can identify System 1, 2 or 3 with fingerprint evidence. Patched or unfamiliar content remains `unknown (System 1–3)`; a filename cannot establish the exact version.

System 3.x imports require a valid scenario archive ending in `SA.ALD`. The detector reads bounded ALD tables and the first available scenario payload. `S350`, `S351`, `153S`, `S360` and `S380` identify scenario formats. The 3.5/3.6/3.8 format family remains a version range where it does not establish the exact engine revision. A valid `System39.ain` AINI/AIN2 header with supported metadata version alongside a recognized scenario tag identifies the System 3.9 family. Missing tags remain `unknown (System 3.5–3.9)`. `System40.ini` or `AliceStart.ini` excludes a folder from the legacy module even when it also contains ALDs. The detected family filters runtime selection to `system3`, `xsystem35` or `xsystem4`; the launcher does not branch on engine names.

System 4 requires `System40.ini` and its configured local `CodeName` program. Absolute paths, traversal and symlinks escaping the game root are rejected. Bounded compressed `AI2` or legacy encrypted AIN headers identify the family; `VERS` identifies the separate AIN format major. The exact System 4 engine build stays unknown. An AIN format number cannot establish title/HLL compatibility. Malformed System 4 markers never fall back to a System 3 interpreter.

## Settings and saves

KiriKiri exposes separate extra option arguments such as `-drawthread=4`. Its `-datapath` is managed by the module. A final slash is required because this SDL2 backend preserves the supplied path and KAG appends filenames directly to `System.dataPath`. Legacy KAG configurations can ignore that path: a known loose-project `saveDataLocation` that resolves relative to `System.exePath` is detected and launch is refused before it can write inside the runtime bundle. Loose native projects are not rewritten. Automatic archived KAG3 preparation redirects only its owned configuration copy to `System.dataPath`.

AliceSoft exposes a local font path, upstream game ID override, text capture (`Off`, `Console`, `Clipboard`) and fullscreen. Console output is observable with a waiting CLI launch. Clipboard capture is an explicit per-game setting. Managed packages supply their verified default fonts: System3 uses gothic, and xsystem35 uses separate gothic/mincho fonts. An explicit local font setting overrides those defaults and supplies both styles for xsystem35. System 4 uses separate packaged gothic/mincho fonts and shaders, native `--save-folder` routing, and optional Console text capture. Its runtime-owned Mac overlay uses Apple OpenGL 3.2 core/GLSL 150 and executable-relative shader lookup. The macOS 13 portable profiles include FFmpeg movie decoding. Locally registered builds retain upstream font defaults when no path is selected. No generic save codec is provided; the optional xsystem35 debugger backend is described below.

System 4 additionally offers `MCLv1-1021`, from upstream commit `de65718ba72d5eb291a4d0ddb691627f1d401909` with libsys4 `e2bf438d0156a2ca70fc6018fddf7c870794a2ca`. This source snapshot includes upstream global-reference initialization, case-insensitive AIN lookup, GBK text conversion and TTC font support. The Mac resource, font, save and rendering adaptations remain applied. `snapshot-04333ad-macos-v2` remains the recommended default, and existing explicit selections are preserved.

Both modules default new saves to `userData/games/<gameId>/modules/<moduleId>/saves/` and publish that default through the existing save-location interface. An explicit per-game save-directory override is honored by the native runtime, so save browsing and snapshots target the same active location. Files in the original game folder are untouched unless the user chooses it as the override. Existing portable saves require an explicit import into the chosen save directory; they are not migrated automatically. Removing a game removes its per-game launcher data, including its default saves, according to the existing removal flow. Runtime registrations and saves in external override folders remain separate.

KiriKiri's **Export scripts** action writes readable TJS/KAG scripts into a private
export folder, and **Show export** opens that result in Finder. It uses the
included bounded XP3 reader, verifies archive checksums and applies patch archive
precedence. Exports follow the publisher's declared default language or the
language selected through runtime arguments. The export reads plaintext scripts;
original archives and scripts stay unchanged.

## Development builds

Normal Play downloads the matching managed package after consent and needs no build tools. Source builds are a developer fallback through the backend action. [Native tool setup](NATIVE_TOOL_SETUP.md) lists compiler and library inputs with their sources and installation locations. Read-only source checkouts use the shared initializer:

```sh
node scripts/init-submodules.cjs -- \
  src/external/krkrsdl2 src/external/system3-sdl2 \
  src/external/xsystem35-sdl2 src/external/xsystem4
```

The module builder applies its Mac presentation, filesystem/font, shader and compiler overlays to private source. Headless builds use the same action:

```sh
pnpm launch --game /path/to/game --action buildRuntime \
  --payload '{"version":"snapshot-124bdf8-macos-v3"}'
```

AliceSoft versions select their corresponding exact interpreter profiles. Build options and source/overlay hashes are stored in the verified installation. CMake/Meson dependency fetching is disabled. A registered external executable still needs its complete native libraries/resources; registration alone does not package them.

The shipped xsystem4 profile also includes the module-owned `xsystem4-macos-v1-reviewed.patch`, which reproduces the native source adaptation from the pinned checkout. Its digest is recorded separately as `reviewedSourcePatchSha256`; the original compatibility-overlay identity remains intact. The recipe keeps the pinned system-zlib dependency rather than discovering an optional replacement.

## Compatibility

AliceSoft interpreters have distinct System1–3, System3.5–3.9 and System4 profiles. Supported formats and native/HLL APIs follow their pinned upstream compatibility matrices. Ordinary game actions run directly from original Windows data with private configuration and saves. The source tools below export legacy scenario formats. System3 `1.8.0-MCLv1`, System3.5–3.9 `2.20.0-macos-v2`, System4 `snapshot-04333ad-macos-v2` and the separate decompiler bundles require macOS 13. Older interpreter profiles retain their higher dependency requirements. A lower executable deployment target does not lower a dependency's requirement.

KiriKiri SDL2 runs readable KAG3/TJS2 scripts through the native APIs below. Its macOS host is the krkrsdl2 implementation.

[AI5WIN](AI5.md), [Siglus/RealLive](SIGLUS.md), [Nitroplus](NITROPLUS.md), [Minori](MINORI.md) and [NScripter](NSCRIPTER.md) have separate edition-specific modules. There is no catch-all visual novel interpreter.

## Automatic original KAG3 preparation

Play detects runnable XP3 data embedded in an original Windows EXE or stored beside it, and applies sibling XP3 patches in order. An EXE containing only an asset/identifier archive does not hide a runnable sibling `data.xp3`; explicitly selected malformed or asset-only XP3 inputs remain rejected. The `kag3-sdl2-v1` adapter extracts only bounded TJS/KS scripts, decodes UTF-8/UTF-16/Shift-JIS, writes UTF-8 BOM scripts into launcher game data, and references original archive assets directly with storage paths. Images, music, movies and other game assets are not copied. Original files remain unchanged. The owned profile records archive hashes, extracted output hashes, adapter code hash, polyfill source pin, version evidence and every applied change. Changed prepared scripts cannot silently satisfy a cached profile.

XP3's protection flag does not by itself establish encryption. A protected script can enter the `verified-plain-v1` profile only when its required Adler checksum matches the unfiltered decompressed bytes; every extracted protected script is checked independently. Asset-format handling does not alter Steam authentication or execute Windows DLLs.

For source-declared language archives, preparation follows the publisher's default or an explicit `-language=` option and records the available/selected languages. It does not merge mutually exclusive translated scripts. Basename aliases resolve to private adapted scripts. An owned startup host shim exposes the original asset root through `System.exePath` and retains the private datapath when publisher code sets that option; other arguments pass to the native setter. Source comments, strings and quoted KAG expressions stay unchanged. Optional literal Windows-plugin calls whose existing try block contains only that load signal their real unavailability to the publisher's existing catch. The publisher's own fallback remains intact; no service object is simulated.

Mac v3 uses the recorded native overlay `macos-storage-font-monitor-v1`. `Storages.dirlist` enumerates actual local and XP3 directories, `System.addFont` loads actual FreeType faces for the process, and dialog rectangles are positioned against real SDL monitor work areas. The generic source builder stages these changes in its disposable build tree and records each original/output/resource digest plus overlay identity. These APIs use real filesystem, FreeType and SDL implementations; they are not permissive placeholders. Scripts requiring these APIs select v3 automatically unless the user explicitly chooses an older version, which receives a capability error.

The app includes the pinned Mac v3 payload, which retains Mac v2 presentation and adds the native APIs above. Older registered builds keep their separate identities and explicit selections; they are not duplicated in the app. Complete source, nested dependencies and owned adaptations accompany the matching release separately from the app.

Warm Play verifies archive and output fingerprints, then reuses the script overlay without decompressing or decoding it again. These files are internal launcher game data; the library always refers to the original Windows input.

The SDL KAG3 polyfill comes from the read-only [upstream submodule](https://github.com/krkrsdl2/kag3/tree/fe6d40e9a1667293ebb053af7f06374b7dac9292) at `fe6d40e9a1667293ebb053af7f06374b7dac9292`. Its packaged script/font resources are verified against their manifest, cached once per user-data directory, then referenced by each profile. Its Ume Gothic O5 font includes the embedded distribution license notice. Saves use `System.dataPath` in the staged configuration, honoring the normal per-game save override.

Stock `MessageLayer.tjs` declares a font variable named `face`, which shadows the inherited native drawing property in this TJS host. Its clear operation can consequently paint an opaque black canvas over the game. The owned script adapter rewrites only explicit, unqualified `face=df*` drawing assignments in that stock class to `super.face=df*`. Font names, child layers and unrelated scripts remain intact. The fix is confined to the private script overlay.

A checksum-bound audio profile selects Wave buffers, preserves playable sound effects and omits MIDI/CDDA declarations and their completion waits. The inspector records the selected audio profile. This branch applies to its recorded executable and patch fingerprint; other readable KAG3 archives receive the shared text, polyfill and save preparation.

The inspector contains game-specific inspection and source tools. Managed players retain version information and execution settings; installation, imports and version controls belong in **Runtimes**. Ren’Py Live2D library support has separate documentation in [RENPY_LIVE2D.md](RENPY_LIVE2D.md).

## AliceSoft live-variable backend

The pinned xsystem35 `2.20.0` build supports its native DAP debugger. The pure Node `dap.js` and `live-variables.js` adapters provide paused variable/string browsing, strict value validation, confirmed writes, Pause/Continue and session ownership. Closing an editor continues the game; explicit Stop uses native disconnect. Ordinary Play does not enable debugging. The private debugger directory contains only generated variable-symbol metadata and original-file links. Scenario archives remain unchanged; debugger instruction changes are in memory only.

**Live variables** in the inspector opens a dedicated editor with variable/string pages, editable values, Pause/Resume and readback after Apply. Opening it starts a stopped game with the pinned debugger, or pauses the existing debugger session. A game started through ordinary Play must be stopped before opening live tools. Closing the editor resumes its game; Inspector Stop terminates the owned process. Status queries retain a bounded terminal result after native exit, and closing an ended editor is harmless; edits and other controls still require its exact active session. The same backend actions are available to headless hosts. Current System3 and System4 packages have no supported debugger profile.

## AliceSoft source export

**Decompile** in the inspector selects the tool for the detected scenario generation, requests consent for a missing package, installs it and continues. **Runtimes → AliceSoft** manages tool versions. The result records the exact tool version. Installed tools work offline without a compiler.

| Scenario family | Managed tool | Pinned version | Read-only source revision |
| --- | --- | --- | --- |
| System 1–3 DRI/DAT | `sys3-decompiler` / `sys3dc` | `0.5.0` | [`cc7ceda1bae0a9886f4c56ee3ce031d139ee1764`](https://github.com/kichikuou/sys3c/tree/cc7ceda1bae0a9886f4c56ee3ce031d139ee1764) |
| System 3.5–3.9 ALD/SCO, optional System39 AIN metadata | `xsys35-decompiler` / `xsys35dc` | `1.13.0` | [`c8ac28b83c034c1ec598266ab85daf75869359c8`](https://github.com/kichikuou/xsys35c/tree/c8ac28b83c034c1ec598266ab85daf75869359c8) |

Exports contain UTF-8 ADV source and compiler configuration below `userData/games/<id>/modules/alicesoft/source/`. **Reveal export** opens the last successful result. Originals are read directly; graphics/audio archives are excluded, and no complete game copy is created. Sequential System3.x output names and validated library names prevent archive-controlled output paths. The private report records the exact tool, source/overlay and input/output identities. Failed or cancelled exports remove only their new output directory.

Input validation limits exports to 32 regular scenario files, 128 MiB per file, 256 MiB total and 4096 scenario pages. DRI/ALD pointers, SCO headers and optional AIN sections are checked before installing or running the tool. Output is limited to 8192 supported source/configuration files and 64 MiB. Original scenario hashes are verified after export.

Both tools use GPL-2.0-or-later. Development **Build** stages the unchanged pinned C sources and adds only the owned `alicesoft-decompiler-cmake-v1` target recipe; image utilities and their unused dependencies are excluded. Build inputs are `src/external/sys3c` or `src/external/xsys35c` and the compiler/CMake/Ninja prerequisites in [Native tool setup](NATIVE_TOOL_SETUP.md). The managed tools install automatically after consent in the inspector. Developer integrations can register external tools through `registerDecompiler`, which checks their reported version. Game-facing actions remain `decompile` and `revealSourceExport`.

Source recovery is separate from rebuilding edited scenarios. The corresponding compilers and System4 `sys4dc`/sys4lang tools are not integrated.

## BGI / Ethornell

The `bgi` module imports validated ARC20/PackFile games only when `system.arc` contains a structurally valid `ipl._bp` boot program. It inspects the original executable’s bounded PE resources separately. A fixed version becomes an engine version only when product/description metadata identifies BGI/Ethornell; zero or unrelated executable versions stay unknown. The textual compatibility declaration, product version and archive format remain separate, and none proves native VM/opcode support.

**Inspect programs** scans bounded indexes and decodes compiled Buriko `._bp` programs using the pinned DSC1 Huffman/LZ format. **Export programs** writes only those decoded programs and a source-hash report below `userData/games/<id>/modules/bgi/exports/`. It does not extract assets, execute programs or modify originals. The exporter selects matching archive profiles and validates each program’s filename and byte range. Limits are 128 archives, 16 MiB total indexes, 1024 programs and 32 MiB total decoded scripts.

No native BGI interpreter is included. Compatible Windows games can select
[Sikarugir (Wine)](SIKARUGIR.md) or an available [CrossOver](CROSSOVER.md) application. The archive and program tools use [OpenBGI](https://github.com/Cytlan/openbgi/tree/e2500e0badd04aab472e4620477747973e5e5544) format references and need no compiler or additional installation.

Developer builds use the compiler/SDL2 locations in [Native tool setup](NATIVE_TOOL_SETUP.md).

## VNDS

Compatible converted exports run through [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE), using the pinned `0.0.13-838e47b-mac-v1` adapter and managed [LÖVE](https://love2d.org/) `11.5`. Play downloads the required LÖVE runtime with consent when it is missing. The small adapter is included and shared directly between games, with no separate installation or copy per game.

Original game directories and supported ZIP archives are read in place. Saves and session settings use the private game directory; incompatible AAC/M4A audio is converted once and cached there. The inspector provides save editing and script-folder access.
