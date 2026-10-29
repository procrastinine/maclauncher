# AliceSoft, KiriKiri, BGI and VNDS

The `kirikiri` and `alicesoft` modules run native macOS interpreters through the shared Node backend. Detection, runtime registration, launch arguments and save directories live in module code; Electron supplies optional file-picker services. Import and status stay offline. Ordinary Play selects a compatible interpreter and requests download consent when its managed package is missing.

## Managed runtime versions

These native interpreters use versioned packages from MacLauncher Builds. **Runtimes** manages downloads and installed copies; Settings provides engine options, and the inspector selects an exact version for each game. Play installs a missing package after consent and continues automatically. Installed versions work offline without a compiler or manual registration.

The inspector offers game-specific script tools, decompilation and runtime options. Missing interpreters and decompilers install automatically after download consent. Build recipes are in MacLauncher Builds; local registration APIs accept compatible external tools.

| Runtime option | Upstream source | Features |
| --- | --- | --- |
| KiriKiri SDL2 | [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) | KAG3/TJS2, native presentation, fonts and monitor handling |
| AliceSoft System 1–3, SDL2 | [system3-sdl2](https://github.com/kichikuou/system3-sdl2) | System 1, 2 and 3 follow upstream format support |
| AliceSoft System 3.5–3.9 | [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2) | ALD scenarios, SDL2 graphics, audio and live variables |
| AliceSoft System 4 | [xsystem4](https://github.com/nunuhara/xsystem4) | AIN VM, HLL APIs, native fonts, audio and movies |

Each package records its exact upstream source revision. KiriKiri's core is MIT licensed with separate bundled component licenses. The AliceSoft interpreters use GPL-2.0-or-later, and each package includes their upstream notices. The factual System 1–3 identifier resource records its upstream source, revision and license.

System3 packages include classic SDL2, text shaping, fonts and executable-relative MDA resources, with native dependencies built without external Homebrew libraries. The player installs as a complete managed package; no compiler is required. The matching MacLauncher Builds tag contains source pins and build instructions.

Existing local registrations are retained for explicit version selections. Explicit per-game versions stay exact; an unavailable or incompatible selected version reports its requirements without silently choosing another build. The `registerRuntime` backend action registers an exact local executable.

## Game version detection

Runtime build versions and imported game engine versions are separate fields. Game details display detected version, evidence and confidence; an unknown value is preserved rather than filled from the runtime selection.

KAG3 scripts and fonts come from a verified managed krkrsdl2 package. If the selected engine lacks them, preparation reuses a compatible installed package or requests consent to discover and install the resources, then resumes. Explicit engine selections and defaults remain unchanged. Existing verified polyfill caches remain compatible with earlier installed profiles.

KiriKiri source projects require a root `startup.tjs`. Loose `system/Initialize.tjs`, `Initialize.tjs` and `startup.tjs` are inspected for explicit `kagVersion` or `tjsVersion` constants, including UTF-16LE scripts. A KAG `3.32 stable rev. 2` declaration identifies that script version, not the Windows host's KiriKiri 2/Z revision. No scripts execute during detection. The SDL2 profile selects KAG3/TJS2 source declarations. Source projects without explicit constants retain an absent generation value.

Direct `.xp3` imports and archives beside Windows launchers require valid XP3 metadata with a root `startup.tjs` entry. The detector supports bounded raw/zlib indexes, valid bounded chained indexes, and embedded XP3 data in fused Windows EXEs; malformed indexes/chains are rejected. An asset-only XP3 is not a game import. Import reads at most three initialization/startup script entries, each limited to 512 KB, to report explicit KAG/TJS constants without extraction or execution. KAG constants identify the script framework, while the native Windows host generation can remain unknown. Protected XP3 scripts require the verified-plain checks below; encrypted content and known TJS1/KAG2 projects are refused before runtime installation. App imports inspect project data under `Contents/Resources/game`, `Contents/Resources/data` or `Contents/Resources`.

AliceSoft System 1–3 imports require a structurally plausible `ADISK.DAT` plus graphics or `system3.ini` markers. A recognized `game` value in the INI's `[config]` section is reported as declared metadata. Otherwise the first 256 bytes of ADISK/BDISK are checked against the pinned upstream CRC32 game table, which can identify System 1, 2 or 3 with fingerprint evidence. Patched or unfamiliar content remains `unknown (System 1–3)`; a filename cannot establish the exact version.

System 3.x imports require a valid scenario archive ending in `SA.ALD`. The detector reads bounded ALD tables and the first available scenario payload. `S350`, `S351`, `153S`, `S360` and `S380` identify scenario formats. The 3.5/3.6/3.8 format family remains a version range where it does not establish the exact engine revision. A valid `System39.ain` AINI/AIN2 header with supported metadata version alongside a recognized scenario tag identifies the System 3.9 family. Missing tags remain `unknown (System 3.5–3.9)`. `System40.ini` or `AliceStart.ini` excludes a folder from the legacy module even when it also contains ALDs. The detected family filters runtime selection to `system3`, `xsystem35` or `xsystem4`; the launcher does not branch on engine names.

System 4 requires `System40.ini` and its configured local `CodeName` program. Absolute paths, traversal and symlinks escaping the game root are rejected. Bounded compressed `AI2` or legacy encrypted AIN headers identify the family; `VERS` identifies the separate AIN format major. The exact System 4 engine build stays unknown. An AIN format number cannot establish title/HLL compatibility. Malformed System 4 markers never fall back to a System 3 interpreter.

The inspector names detected versions **System 1**, **System 2**, **System 3** or **System 3.9**, or a format family such as **System 3.8–3.9**. Unrecognized data reads **unknown (System 1–3)** or **unknown (System 3.5–3.9)**, and System 4 reads **System 4 (engine build unknown)**. An existing library entry keeps its stored version label until the game is detected again.

## Settings and saves

KiriKiri exposes separate extra option arguments such as `-drawthread=4`. Its `-datapath` is managed by the module. A final slash is required because this SDL2 backend preserves the supplied path and KAG appends filenames directly to `System.dataPath`. Legacy KAG configurations can ignore that path: a known loose-project `saveDataLocation` that resolves relative to `System.exePath` is detected and launch is refused before it can write inside the runtime bundle. Loose native projects are not rewritten. Automatic archived KAG3 preparation redirects only its owned configuration copy to `System.dataPath`.

AliceSoft exposes a local font path, upstream game ID override, text capture (`Off`, `Console`, `Clipboard`) and fullscreen. Console output is observable with a waiting CLI launch. Clipboard capture is an explicit per-game setting. Managed packages supply their verified default fonts: System3 uses gothic, and xsystem35 uses separate gothic/mincho fonts. An explicit local font setting overrides those defaults and supplies both styles for xsystem35. System 4 uses separate packaged gothic/mincho fonts and shaders, native `--save-folder` routing, and optional Console text capture. Its runtime-owned Mac overlay uses Apple OpenGL 3.2 core/GLSL 150 and executable-relative shader lookup. Packaged profiles include FFmpeg movie decoding. Locally registered builds retain upstream font defaults when no path is selected. No generic save codec is provided; the optional xsystem35 debugger backend is described below.

System 4 packages record their xsystem4 and libsys4 source revisions. They include global-reference initialization, case-insensitive AIN lookup, GBK text conversion, TTC fonts and the Mac resource, save and rendering adaptations. Existing explicit selections are preserved.

Both modules default new saves to `userData/games/<gameId>/modules/<moduleId>/saves/` and publish that default through the existing save-location interface, so the inspector shows the managed save location before the first launch. An explicit per-game save-directory override is honored by the native runtime, so save browsing and snapshots target the same active location. Files in the original game folder are untouched unless the user chooses it as the override. Existing portable saves require an explicit import into the chosen save directory; they are not migrated automatically. Removing a game removes its per-game launcher data, including its default saves, according to the existing removal flow. Runtime registrations and saves in external override folders remain separate.

KiriKiri's **Export scripts** action writes readable TJS/KAG scripts into a private
export folder, and **Show export** opens that result in Finder. It uses the
included bounded XP3 reader, verifies archive checksums and applies patch archive
precedence. Exports follow the publisher's declared default language or the
language selected through runtime arguments. Plaintext scripts export directly;
the managed native **msg-tool** also decodes SimpleCrypt scripts. Compiled TJS2
remains bytecode, with a separate constant-pool JSON export for inspection.
Original archives and scripts stay unchanged.

## Native playback

AliceSoft interpreters have separate System 1–3, System 3.5–3.9 and System 4 profiles. They run original Windows game data with separate configuration and saves. Runtimes lists the architectures and minimum macOS of each player and legacy native decompiler package. System 4 inspection uses the separate managed Windows tool described below.

KiriKiri SDL2 runs readable KAG3/TJS2 scripts through the native APIs below. Its macOS host is the krkrsdl2 implementation.

[AI5WIN](AI5.md), [Siglus/RealLive](SIGLUS.md), [Nitroplus](NITROPLUS.md), [Minori](MINORI.md) and [NScripter](NSCRIPTER.md) have their own interpreters and guides.

## Automatic original KAG3 preparation

Play detects runnable XP3 data embedded in an original Windows EXE or stored beside it, and applies sibling XP3 patches in order. An EXE containing only an asset/identifier archive does not hide a runnable sibling `data.xp3`; explicitly selected malformed or asset-only XP3 inputs remain rejected. The `kag3-sdl2-v1` adapter extracts only bounded TJS/KS scripts, decodes UTF-8/UTF-16/Shift-JIS, writes UTF-8 BOM scripts into launcher game data, and references original archive assets directly with storage paths. Images, music, movies and other game assets are not copied. Original files remain unchanged. The owned profile records archive hashes, extracted output hashes, adapter code hash, polyfill source pin, version evidence and every applied change. Changed prepared scripts cannot silently satisfy a cached profile.

XP3's protection flag does not by itself establish encryption. A protected script can enter the `verified-plain-v1` profile only when its required Adler checksum matches the unfiltered decompressed bytes; every extracted protected script is checked independently. Asset-format handling does not alter Steam authentication or execute Windows DLLs.

For source-declared language archives, preparation follows the publisher's default or an explicit `-language=` option and records the available/selected languages. It does not merge mutually exclusive translated scripts. Basename aliases resolve to private adapted scripts. An owned startup host shim exposes the original asset root through `System.exePath` and retains the private datapath when publisher code sets that option; other arguments pass to the native setter. Source comments, strings and quoted KAG expressions stay unchanged. Optional literal Windows-plugin calls whose existing try block contains only that load signal their real unavailability to the publisher's existing catch. The publisher's own fallback remains intact; no service object is simulated.

KiriKiri packages declare the native APIs they provide, and detection records which of them a game's scripts call. `Storages.dirlist` enumerates actual local and XP3 directories, `System.addFont` loads actual FreeType faces for the process, and dialog rectangles are positioned against real SDL monitor work areas. These APIs use real filesystem, FreeType and SDL implementations; they are not permissive placeholders. Without an explicit game or global version, when the automatic choice lacks an API the scripts call, Play recommends the first listed package that provides every required API. An explicitly selected version that lacks one receives a capability error, which names a compatible listed version when there is one.

Complete source, nested dependencies and Mac adaptations for each package are available at the matching MacLauncher Builds release commit.

Warm Play verifies archive and output fingerprints, then reuses the script overlay without decompressing or decoding it again. These files are internal launcher game data; the library always refers to the original Windows input.

The SDL KAG3 polyfill comes from [krkrsdl2/kag3](https://github.com/krkrsdl2/kag3/tree/fe6d40e9a1667293ebb053af7f06374b7dac9292) at `fe6d40e9a1667293ebb053af7f06374b7dac9292`. Its script/font resources remain in the sealed managed package. Preparation verifies the package and resource manifests, records the selected resource revision and manifest hash, and references those files from each prepared profile. Its Ume Gothic O5 font includes the embedded distribution license notice. Saves use `System.dataPath` in the staged configuration, honoring the normal per-game save override.

Stock `MessageLayer.tjs` declares a font variable named `face`, which shadows the inherited native drawing property in this TJS host. Its clear operation can consequently paint an opaque black canvas over the game. The owned script adapter rewrites only explicit, unqualified `face=df*` drawing assignments in that stock class to `super.face=df*`. Font names, child layers and unrelated scripts remain intact. The fix is confined to the private script overlay.

A checksum-bound audio profile selects Wave buffers, preserves playable sound effects and omits MIDI/CDDA declarations and their completion waits. The inspector records the selected audio profile. This branch applies to its recorded executable and patch fingerprint; other readable KAG3 archives receive the shared text, polyfill and save preparation.

The inspector contains game-specific inspection and source tools. Managed players retain version information and execution settings; installation, imports and version controls belong in **Runtimes**. Ren’Py Live2D library support has separate documentation in [RENPY_LIVE2D.md](RENPY_LIVE2D.md).

## AliceSoft live-variable backend

xsystem35 packages that declare the `dap-terminal-nul-v1` debug adapter support the native DAP debugger. The pure Node `dap.js` and `live-variables.js` adapters provide paused variable/string browsing, strict value validation, confirmed writes, Pause/Continue and session ownership. Closing an editor continues the game; explicit Stop uses native disconnect. Ordinary Play does not enable debugging. The private debugger directory contains only generated variable-symbol metadata and original-file links. Scenario archives remain unchanged; debugger instruction changes are in memory only.

**Live variables** in the inspector opens a dedicated editor with variable/string pages, editable values, Pause/Resume and readback after Apply. Opening it starts a stopped game with the selected package's debugger, or pauses the existing debugger session. A game started through ordinary Play must be stopped before opening live tools. Closing the editor resumes its game; Inspector Stop terminates the owned process. Status queries retain a bounded terminal result after native exit, and closing an ended editor is harmless; edits and other controls still require its exact active session. The same backend actions are available to headless hosts. Live-variable editing uses the System 3.5–3.9 interpreter.

## AliceSoft source export

**Decompile** in the inspector selects the tool for the detected scenario generation, requests consent for a missing package, installs it and continues. **Runtimes → AliceSoft** manages the legacy native decompilers under **System1–3 source** and **System3.x source**, and System 4 inspection under **Alice tools**. The selected package manifest or installed receipt supplies the tool identity. The reported executable and version are checked, and the result records the actual tool version. Installed tools work offline without a compiler.

| Scenario family | Managed tool | Packages | Source |
| --- | --- | --- | --- |
| System 1–3 DRI/DAT | `sys3-decompiler` / `sys3dc` | MacLauncher Builds | [sys3c](https://github.com/kichikuou/sys3c) |
| System 3.5–3.9 ALD/SCO, optional System39 AIN metadata | `xsys35-decompiler` / `xsys35dc` | MacLauncher Builds | [xsys35c](https://github.com/kichikuou/xsys35c) |
| System 4 AIN | `alice-tools` / `alice.exe` | Upstream releases selected in Runtimes → AliceSoft → Alice tools | [Alice tools](https://github.com/nunuhara/alice-tools) |

Upstream sys3c and xsys35c releases provide Windows tools; Runtimes lists them as source references beside the Mac packages.

Legacy exports contain UTF-8 ADV source and compiler configuration below `userData/games/<id>/modules/alicesoft/source/`. System 4 exports contain `scenario.jam` disassembly and `dialogue.txt`, produced by the upstream Windows CLI through a private Sikarugir or CrossOver tool prefix. JAM is an AIN assembly representation, not reconstructed original source. **Reveal export** opens the last successful result. Originals are read directly; graphics/audio archives are excluded, and no complete game copy is created. Sequential System3.x output names and validated library names prevent archive-controlled output paths. The private report records the exact tool, source/overlay and input/output identities. Failed or cancelled legacy exports remove only their new output directory.

Legacy input validation limits exports to 32 regular scenario files, 128 MiB per file, 256 MiB total and 4096 scenario pages. DRI/ALD pointers, SCO headers and optional AIN sections are checked before installing or running the tool. Legacy output is limited to 8192 supported source/configuration files and 64 MiB. Original scenario hashes are verified after export. System 4 accepts one bounded original AIN file up to 128 MiB and verifies its source hash after dumping.

Both tools use GPL-2.0-or-later. The managed tools install automatically after consent in the inspector. The `registerDecompiler` backend action registers an external tool after checking its reported version. Game-facing actions remain `decompile` and `revealSourceExport`.

Source recovery is separate from rebuilding edited scenarios. The corresponding compilers and System4 `sys4dc`/sys4lang tools are not integrated.

## BGI / Ethornell

**Export text** complements the included archive/program inspection with managed
native **msg-tool** message extraction. Completed script messages remain available
when other scripts fail; the result reports failures and retains the per-script
log. This message export does not reconstruct original scenario source.

The `bgi` module imports ARC20/PackFile games whose `system.arc` contains an `ipl._bp` boot program. It inspects the original executable’s PE resources separately. A fixed version becomes an engine version when product/description metadata identifies BGI/Ethornell. The compatibility declaration, product version and archive format are displayed separately.

**Inspect programs** scans bounded indexes and decodes compiled Buriko `._bp` programs using the pinned DSC1 Huffman/LZ format. **Export programs** writes only those decoded programs and a source-hash report below `userData/games/<id>/modules/bgi/exports/`. It does not extract assets, execute programs or modify originals. The exporter selects matching archive profiles and validates each program’s filename and byte range. Limits are 128 archives, 16 MiB total indexes, 1024 programs and 32 MiB total decoded scripts.

Play runs the game's Windows executable through a registered
[CrossOver](CROSSOVER.md) application when one is available, otherwise through
managed [Sikarugir (Wine)](SIKARUGIR.md), which downloads after consent. The game's
runtime selector can choose either backend, and the detected engine version and program
tools stay available with either one. An import without a compatible Windows executable
remains inspection-only. The archive and program tools use [OpenBGI](https://github.com/Cytlan/openbgi/tree/e2500e0badd04aab472e4620477747973e5e5544) format references and need no compiler or additional installation.

## VNDS

Converted VNDS exports run through [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) and [LÖVE](https://love2d.org/) `11.5`. The adapted VNDS-LOVE interpreter is a separate [MacLauncher Builds package](https://procrastinine.github.io/maclauncher-builds/#vnds-love). Play obtains consent for missing interpreter and host downloads, installs them automatically and starts the game. Installed runtimes are shared between games and remain usable offline.

**Runtimes → VNDS** lists interpreter packages from the Builds catalog. Explicit
game and global versions remain exact. The selected package seals its source
revision and interpreter profile; compatible source revisions do not require a
launcher version pin. Runtime status reports the installed package's identity.

Original game directories and supported ZIP archives are read in place. Saves and session settings use the private game directory; incompatible AAC/M4A audio is converted once and cached there. The inspector provides save editing and script-folder access.

## Local registration

Registrations are stored in `userData/runtimes/<runtimeId>/<version>/runtime.json`. They retain version, upstream revision, executable path, SHA-256 and registration date. Local registration stores the supplied source identity with `provenanceVerified: false`. The executable remains at its original location. Unregistering a local build removes the launcher record and leaves the external build intact. Replacing it requires removing the old registration and registering again. Status and launch verify its checksum. Managed binary installations additionally preserve and revalidate the complete shipped file manifest, dependency inventory and build provenance. A registered external executable still needs its complete native libraries/resources; registration alone does not package them.

The shared `local-native.js` helper checks absolute local paths, executable permission, thin/universal 64-bit Mach-O headers, executable type, bounded slices and host CPU support. x86_64-only builds on Apple silicon explicitly use the existing Rosetta process path. Shell scripts, ELF/PE files and Mach-O libraries are rejected as executables. Arguments pass directly to the process launcher without a shell.

Downloaded KiriKiri executables use the shared bounded Mach-O load-command reader to check each CPU slice, macOS deployment metadata and system-library closure before signing the private installation. Binary installation needs no Xcode or Command Line Tools.
