# AliceSoft, KiriKiri, BGI and VNDS

The `kirikiri` and `alicesoft` modules run native macOS interpreters through the shared Node backend. Detection, runtime registration, launch arguments and save directories live in module code; Electron supplies optional file-picker services. Import and status stay offline. Ordinary Play selects a compatible Included interpreter automatically.

## Runtime versions and registration

These adapted backends use fixed versioned profiles. Settings retains their engine/runtime options and the inspector retains each runtime's name and exact version; fixed profiles have no Runtimes management tab. Included profiles execute directly from read-only app resources without a runtime copy, registration, compiler or network. Inventory, hash, permission, CPU, macOS and signature checks precede execution. A corrupt profile fails rather than silently selecting another build; an existing exact local installation retains priority.

Advanced **Build Runtime** and **Register Runtime** actions remain available for explicit local builds. They require the listed exact source and build dependencies; ordinary Play uses a compatible Included profile automatically. These advanced actions do not provide an automated upstream-update flow.

| Runtime option | Selected version | Pinned source revision | Scope |
| --- | --- | --- | --- |
| KiriKiri SDL2 | `snapshot-124bdf8-macos-v3` | `124bdf841f09e7ce02aa99b7b55791a0f7a900ff` | Full-frame Mac presentation and real directory/font/monitor APIs for compatible KAG3 |
| AliceSoft System 1–3, SDL2 | `1.8.0-macos-v2` | `461673bec729e7e0ec905921fc3e03aecf977a70` | ARM64, macOS 13; System 1, 2 and 3 follow upstream format support |
| AliceSoft System 3.5–3.9 | `2.20.0-macos-v2` | `82c8b76a58a19ff1f87b4bdadbaef169c4b37f46` | System 3.x ALD scenarios |
| AliceSoft System 4 | `snapshot-04333ad-macos-v2` | `04333ad689d7e517a93d58141bb214c19ba16129` | System 4 AIN VM; selected HLL APIs, portable SDL2/font/audio/movie resources |

Each runtime version is pinned to the listed commit. Upstream sources remain Git submodules under `src/external/` and are read-only. KiriKiri's core is MIT licensed with separate bundled component licenses. The AliceSoft interpreters use GPL-2.0-or-later; retain their upstream notices when distributing builds. The factual System 1–3 identifier resource records its upstream source, revision and license.

System3 `1.8.0-macos-v2` includes classic SDL2, text shaping, fonts and executable-relative MDA resources. Its native dependencies are built for macOS 13 without external Homebrew libraries. The Included player runs directly; no installation or compiler is required. Earlier `1.8.0` selections remain separate. Complete source and offline rebuild instructions accompany the release through the [corresponding-source archive flow](RUNTIME_DISTRIBUTION.md#corresponding-source-archives). Source developers use `buildPortableSystem3` with its six pinned dependency archives; the older generic builder cannot build this profile.

Build the listed revision, open the game's Runtime Settings, choose the version to register, then use **Register Runtime**. An optional absolute local executable or `.app` path can be entered in Runtime Settings; leaving it blank opens the host's file picker. Headless callers pass `{ "version": "…", "runtimePath": "/absolute/path" }` to the `registerRuntime` module action. The Runtimes manager lists registrations and selects the global default; per-game runtime version overrides retain explicit selection. An unavailable selected version never silently falls back to another installed build.

The inspector's registration/build version defaults to **Current selection** (`auto`), resolved through that shared runtime selection. Factory defaults do not force an older pinned tool version; an explicit action payload or tool setting can still choose a pinned version.

Registrations are stored in `userData/runtimes/<runtimeId>/<version>/runtime.json`. They retain version, upstream revision, executable path, SHA-256 and registration date. Local registration stores the supplied source identity with `provenanceVerified: false`. The executable remains at its original location. Unregistering a local build removes the launcher record and leaves the external build intact. Replacing it requires removing the old registration and registering again. Status and launch verify its checksum. Bundled installations additionally preserve and revalidate the complete shipped file manifest, dependency inventory and build provenance.

**Build Runtime** validates an exact clean Git revision and all recursively initialized pinned submodules, then copies only tracked source files into its runtime installation's disposable `build-source/` directory. Compiler output lives in `build-output/`. The source checkout is never changed. CMake FetchContent updates/downloads and Meson wrap downloads are disabled; compiler tools and native dependencies must already be installed. Missing or mismatched source/dependencies fail clearly and do not publish a runtime registration. An optional local source checkout can be chosen through the runtime `Source checkout` field; this is also useful in packaged applications where `.git` metadata is not shipped. The backend action accepts an explicit `sourceDir` payload.

Successful builds register automatically with `provenanceVerified: true`, the pinned commit, staged source-tree SHA-256, compatibility-overlay SHA-256, configure options, host architecture and a bounded build log. CMake builds set `CMAKE_OSX_DEPLOYMENT_TARGET=13.0`; the System 4 Meson build sets `MACOSX_DEPLOYMENT_TARGET=13.0` explicitly. Dependency deployment floors remain independent: a macOS 13 executable linked to a macOS 27 library is not a macOS 13 distribution. Build cancellation terminates compiler processes and publishes no successful registration. Duplicate builds of a registered version require removing that registration first. Removing an installation also removes managed compiler output; externally registered executables remain untouched.

Kiri source builds map compiler file/debug/macro paths to logical source/build roots. The shared builder retains these C flags when adding its compatibility header. Published package metadata retains the source revisions and build options without local build paths.

The shared `local-native.js` helper checks absolute local paths, executable permission, thin/universal 64-bit Mach-O headers, executable type, bounded slices and host CPU support. x86_64-only builds on Apple silicon explicitly use the existing Rosetta process path. Shell scripts, ELF/PE files and Mach-O libraries are rejected as executables. Arguments pass directly to the process launcher without a shell.

Downloaded KiriKiri executables use the shared bounded Mach-O load-command reader to check each CPU slice, macOS deployment metadata and system-library closure before signing the private installation. Binary installation needs no Xcode or Command Line Tools. Source builds keep their separate developer prerequisites.

## Game version detection

Runtime build versions and imported game engine versions are separate fields. Game details display detected version, evidence and confidence; an unknown value is preserved rather than filled from the runtime selection.

KiriKiri source projects require a root `startup.tjs`. Loose `system/Initialize.tjs`, `Initialize.tjs` and `startup.tjs` are inspected for explicit `kagVersion` or `tjsVersion` constants, including UTF-16LE scripts. A KAG `3.32 stable rev. 2` declaration identifies that script version, not the Windows host's KiriKiri 2/Z revision. No scripts execute during detection. KAG2/TJS1 declarations are visible and launch is refused because those generations are unsupported by this backend. A source project without explicit constants reports an unknown generation.

Direct `.xp3` imports and archives beside Windows launchers require valid XP3 metadata with a root `startup.tjs` entry. The detector supports bounded raw/zlib indexes, valid bounded chained indexes, and embedded XP3 data in fused Windows EXEs; malformed indexes/chains are rejected. An asset-only XP3 is not a game import. Import reads at most three initialization/startup script entries, each limited to 512 KB, to report explicit KAG/TJS constants without extraction or execution. KAG constants identify the script framework, while the native Windows host generation can remain unknown. Protected XP3 scripts require the verified-plain checks below; encrypted content and known TJS1/KAG2 projects are refused before runtime installation. Game-specific archive filters and Windows DLL plugins are unsupported. App imports inspect project data under `Contents/Resources/game`, `Contents/Resources/data` or `Contents/Resources`.

AliceSoft System 1–3 imports require a structurally plausible `ADISK.DAT` plus graphics or `system3.ini` markers. A recognized `game` value in the INI's `[config]` section is reported as declared metadata. Otherwise the first 256 bytes of ADISK/BDISK are checked against the pinned upstream CRC32 game table, which can identify System 1, 2 or 3 with fingerprint evidence. Patched or unfamiliar content remains `unknown (System 1–3)`; a filename cannot establish the exact version.

System 3.x imports require a valid scenario archive ending in `SA.ALD`. The detector reads bounded ALD tables and the first available scenario payload. `S350`, `S351`, `153S`, `S360` and `S380` identify scenario formats. The 3.5/3.6/3.8 format family remains a version range where it does not establish the exact engine revision. A valid `System39.ain` AINI/AIN2 header with supported metadata version alongside a recognized scenario tag identifies the System 3.9 family. Missing tags remain `unknown (System 3.5–3.9)`. `System40.ini` or `AliceStart.ini` excludes a folder from the legacy module even when it also contains ALDs. The detected family filters runtime selection to `system3`, `xsystem35` or `xsystem4`; the launcher does not branch on engine names.

System 4 requires `System40.ini` and its configured local `CodeName` program. Absolute paths, traversal and symlinks escaping the game root are rejected. Bounded compressed `AI2` or legacy encrypted AIN headers identify the family; `VERS` identifies the separate AIN format major. The exact System 4 engine build stays unknown. An AIN format number cannot establish title/HLL compatibility. Malformed System 4 markers never fall back to a System 3 interpreter.

## Settings and saves

KiriKiri exposes separate extra option arguments such as `-drawthread=4`. Its `-datapath` is managed by the module. A final slash is required because this SDL2 backend preserves the supplied path and KAG appends filenames directly to `System.dataPath`. Legacy KAG configurations can ignore that path: a known loose-project `saveDataLocation` that resolves relative to `System.exePath` is detected and launch is refused before it can write inside the runtime bundle. Loose native projects are not rewritten. Automatic archived KAG3 preparation redirects only its owned configuration copy to `System.dataPath`; unknown custom save logic is unsupported.

AliceSoft exposes a local font path, upstream game ID override, text capture (`Off`, `Console`, `Clipboard`) and fullscreen. Console output is observable with a waiting CLI launch. Clipboard capture is an explicit per-game setting. Bundled runtimes supply their verified shipped default fonts: System3 uses gothic, and xsystem35 uses separate gothic/mincho fonts. An explicit local font setting overrides those defaults and supplies both styles for xsystem35. System 4 uses separate bundled gothic/mincho fonts and packaged shaders, native `--save-folder` routing, and optional Console text capture. Its runtime-owned Mac overlay uses Apple OpenGL 3.2 core/GLSL 150 and executable-relative shader lookup. The pinned build disables optional FFmpeg while retaining upstream built-in MPEG movie support. Locally registered builds retain upstream font defaults when no path is selected. No generic save codec is provided; the optional xsystem35 debugger backend is described below.

Both modules default new saves to `userData/games/<gameId>/modules/<moduleId>/saves/` and publish that default through the existing save-location interface. An explicit per-game save-directory override is honored by the native runtime, so save browsing and snapshots target the same active location. Files in the original game folder are untouched unless the user chooses it as the override. Existing portable saves require an explicit import into the chosen save directory; they are not migrated automatically. Removing a game removes its per-game launcher data, including its default saves, according to the existing removal flow. Runtime registrations and saves in external override folders remain separate.

KiriKiri's **Export scripts** action writes readable TJS/KAG scripts into a private
export folder, and **Show export** opens that result in Finder. It uses the
included bounded XP3 reader, verifies archive checksums and applies patch archive
precedence. Exports follow the publisher's declared default language or the
language selected through runtime arguments. Unknown encryption and compiled
bytecode remain unsupported; original archives and scripts stay unchanged.

## Development builds

Normal Play uses the matching included package without build tools. Source builds are a developer fallback through the backend action. Install compiler/library prerequisites from [Native tool setup](NATIVE_TOOL_SETUP.md), which lists sources and installation locations. Initialize the selected read-only checkouts with the shared source command:

```sh
node scripts/init-submodules.cjs -- \
  src/external/krkrsdl2 src/external/system3-sdl2 \
  src/external/xsystem35-sdl2 src/external/xsystem4
```

Use the module builder so its Mac presentation, filesystem/font, shader and compiler overlays are applied to private tracked source. A raw upstream build does not include these runtime profiles. Headless builds use the same action:

```sh
pnpm launch --game /path/to/game --action buildRuntime \
  --payload '{"version":"snapshot-124bdf8-macos-v3"}'
```

Choose the corresponding exact version for AliceSoft. Build options and source/overlay hashes are stored in the verified installation. CMake/Meson dependency fetching is disabled. A registered external executable still needs its complete native libraries/resources; registration alone does not package them.

The shipped xsystem4 profile also includes the module-owned `xsystem4-macos-v1-reviewed.patch`, which reproduces the native source adaptation from the pinned checkout. Its digest is recorded separately as `reviewedSourcePatchSha256`; the original compatibility-overlay identity remains intact. The recipe keeps the pinned system-zlib dependency rather than discovering an optional replacement.

## Compatibility

AliceSoft interpreters have distinct System1–3, System3.5–3.9 and System4 profiles. Supported formats and native/HLL APIs follow their pinned upstream compatibility matrices. Ordinary game actions run directly from original Windows data with private configuration and saves. Generic save editing remains unsupported; the source tools below cover legacy scenarios. System3 `1.8.0-macos-v2`, System3.5–3.9 `2.20.0-macos-v2`, System4 `snapshot-04333ad-macos-v2` and the separate decompiler bundles require macOS 13. Older interpreter profiles retain their higher dependency requirements. A lower executable deployment target does not lower a dependency's requirement.

KiriKiri SDL2 runs readable KAG3 scripts using the native APIs below. Unknown encrypted archives, required Windows plugins, KAG2/TJS1 and custom save logic remain unsupported. The historical krkr2 Windows C++Builder/VCL codebase does not supply a native Mac runtime.

[AI5WIN](AI5.md), [Siglus/RealLive](SIGLUS.md), [Nitroplus](NITROPLUS.md), [Minori](MINORI.md) and [NScripter](NSCRIPTER.md) have separate edition-specific modules. There is no catch-all visual novel interpreter.

## Automatic original KAG3 preparation

Play detects runnable XP3 data embedded in an original Windows EXE or stored beside it, and applies sibling XP3 patches in order. An EXE containing only an asset/identifier archive does not hide a runnable sibling `data.xp3`; explicitly selected malformed or asset-only XP3 inputs remain rejected. The `kag3-sdl2-v1` adapter extracts only bounded TJS/KS scripts, decodes UTF-8/UTF-16/Shift-JIS, writes UTF-8 BOM scripts into launcher game data, and references original archive assets directly with storage paths. Images, music, movies and other game assets are not copied. Original files remain unchanged. The owned profile records archive hashes, extracted output hashes, adapter code hash, polyfill source pin, version evidence and every applied change. Changed prepared scripts cannot silently satisfy a cached profile.

XP3's protection flag does not by itself establish encryption. A protected script can enter the `verified-plain-v1` profile only when its required Adler checksum matches the unfiltered decompressed bytes; every extracted protected script is checked independently. Actual encrypted content, missing checksums and mismatches remain unsupported. Asset-format handling does not alter Steam authentication or execute Windows DLLs.

For source-declared language archives, preparation follows the publisher's default or an explicit `-language=` option and records the available/selected languages. It does not merge mutually exclusive translated scripts. Basename aliases resolve to private adapted scripts. An owned startup host shim exposes the original asset root through `System.exePath` and retains the private datapath when publisher code sets that option; other arguments pass to the native setter. Source comments, strings and quoted KAG expressions stay unchanged. Optional literal Windows-plugin calls whose existing try block contains only that load signal their real unavailability to the publisher's existing catch. The publisher's own fallback remains intact; no service object is simulated.

Mac v3 uses the recorded native overlay `macos-storage-font-monitor-v1`. `Storages.dirlist` enumerates actual local and XP3 directories, `System.addFont` loads actual FreeType faces for the process, and dialog rectangles are positioned against real SDL monitor work areas. The generic source builder stages these changes in its disposable build tree and records each original/output/resource digest plus overlay identity. These APIs use real filesystem, FreeType and SDL implementations; they are not permissive placeholders. Scripts requiring these APIs select v3 automatically unless the user explicitly chooses an older version, which receives a capability error.

The app includes the pinned Mac v3 payload, which retains Mac v2 presentation and adds the native APIs above. Older registered builds keep their separate identities and explicit selections; they are not duplicated in the app. Complete source, nested dependencies and owned adaptations accompany the matching release separately from the app.

Warm Play verifies archive and output fingerprints, then reuses the script overlay without decompressing or decoding it again. These files are internal launcher game data; the library always refers to the original Windows input.

The SDL KAG3 polyfill comes from the read-only [upstream submodule](https://github.com/krkrsdl2/kag3/tree/fe6d40e9a1667293ebb053af7f06374b7dac9292) at `fe6d40e9a1667293ebb053af7f06374b7dac9292`. Its packaged script/font resources are verified against their manifest, cached once per user-data directory, then referenced by each profile. Its Ume Gothic O5 font includes the embedded distribution license notice. Saves use `System.dataPath` in the staged configuration, honoring the normal per-game save override.

Stock `MessageLayer.tjs` declares a font variable named `face`, which shadows the inherited native drawing property in this TJS host. Its clear operation can consequently paint an opaque black canvas over the game. The owned script adapter rewrites only explicit, unqualified `face=df*` drawing assignments in that stock class to `super.face=df*`. Font names, child layers and unrelated scripts remain intact. The fix is confined to the private script overlay.

A checksum-bound compatibility branch can omit unavailable MIDI/CDDA class declarations, select Wave buffers, mute an unsupported MIDI soundtrack and skip an incompatible sound-completion wait. The inspector records this audio limitation. It applies only to the recognized executable/patch fingerprint; other readable KAG3 archives receive text/polyfill/save preparation without that audio branch. Native Windows plugins, KAG2/TJS1 and unknown encrypted content remain unsupported.

Inspector runtime diagnostics/register/build actions live in a collapsed **Advanced** group. Included fixed players retain version information and settings in the inspector; managed alternatives have installation and version controls in **Runtimes**. Ren’Py Live2D library support has separate documentation in [RENPY_LIVE2D.md](RENPY_LIVE2D.md).

## AliceSoft live-variable backend

The pinned xsystem35 `2.20.0` build supports its native DAP debugger. The pure Node `dap.js` and `live-variables.js` adapters provide paused variable/string browsing, strict value validation, confirmed writes, Pause/Continue and session ownership. Closing an editor continues the game; explicit Stop uses native disconnect. Ordinary Play does not enable debugging. The private debugger directory contains only generated variable-symbol metadata and original-file links. Scenario archives remain unchanged; debugger instruction changes are in memory only.

**Live variables** in the inspector opens a dedicated editor with variable/string pages, editable values, Pause/Resume and readback after Apply. Opening it starts a stopped game with the pinned debugger, or pauses the existing debugger session. A game started through ordinary Play must be stopped before opening live tools. Closing the editor resumes its game; Inspector Stop terminates the owned process. Status queries retain a bounded terminal result after native exit, and closing an ended editor is harmless; edits and other controls still require its exact active session. The same backend actions are available to headless hosts. Current System3 and System4 packages have no supported debugger profile.

## AliceSoft source export

**Decompile** in the inspector selects the tool for the detected scenario generation and runs its included executable directly. These fixed tools have no download tab or installation step. The result records the exact tool version. No runtime copy, compiler or download is needed for the included builds.

| Scenario family | Included tool | Pinned version | Read-only source revision |
| --- | --- | --- | --- |
| System 1–3 DRI/DAT | `sys3-decompiler` / `sys3dc` | `0.5.0` | [`cc7ceda1bae0a9886f4c56ee3ce031d139ee1764`](https://github.com/kichikuou/sys3c/tree/cc7ceda1bae0a9886f4c56ee3ce031d139ee1764) |
| System 3.5–3.9 ALD/SCO, optional System39 AIN metadata | `xsys35-decompiler` / `xsys35dc` | `1.13.0` | [`c8ac28b83c034c1ec598266ab85daf75869359c8`](https://github.com/kichikuou/xsys35c/tree/c8ac28b83c034c1ec598266ab85daf75869359c8) |

Exports contain UTF-8 ADV source and compiler configuration below `userData/games/<id>/modules/alicesoft/source/`. **Reveal export** opens the last successful result. Originals are read directly; graphics/audio archives are excluded, and no complete game copy is created. Sequential System3.x output names and validated library names prevent archive-controlled output paths. The private report records the exact tool, source/overlay and input/output identities. Failed or cancelled exports remove only their new output directory.

Input validation limits exports to 32 regular scenario files, 128 MiB per file, 256 MiB total and 4096 scenario pages. DRI/ALD pointers, SCO headers and optional AIN sections are checked before installing or running the tool. Output is limited to 8192 supported source/configuration files and 64 MiB. Original scenario hashes are verified after export.

Both tools use GPL-2.0-or-later. Development **Build** stages the unchanged pinned C sources and adds only the owned `alicesoft-decompiler-cmake-v1` target recipe; image utilities and their unused dependencies are excluded. Initialize `src/external/sys3c` or `src/external/xsys35c` and install the compiler/CMake/Ninja prerequisites in [Native tool setup](NATIVE_TOOL_SETUP.md). Native external tools can instead be registered through the inspector's **Advanced** group, with their reported version checked before registration. Headless hosts use the same `decompile`, `revealSourceExport` and `registerDecompiler` module actions.

Source recovery is separate from rebuilding edited scenarios. The corresponding compilers and System4 `sys4dc`/sys4lang tools are not integrated.

## BGI / Ethornell

The `bgi` module imports validated ARC20/PackFile games only when `system.arc` contains a structurally valid `ipl._bp` boot program. It inspects the original executable’s bounded PE resources separately. A fixed version becomes an engine version only when product/description metadata identifies BGI/Ethornell; zero or unrelated executable versions stay unknown. The textual compatibility declaration, product version and archive format remain separate, and none proves native VM/opcode support.

**Inspect programs** scans bounded indexes and decodes compiled Buriko `._bp` programs using the pinned DSC1 Huffman/LZ format. **Export programs** writes only those decoded programs and a source-hash report below `userData/games/<id>/modules/bgi/exports/`. It does not extract assets, execute programs or modify originals. Ambiguous or unsupported unrelated archives are reported as skipped, while strict filename/range validation remains enforced for exported programs. Limits are 128 archives, 16 MiB total indexes, 1024 programs and 32 MiB total decoded scripts.

Not yet supported for play. The archive and program tools use [OpenBGI](https://github.com/Cytlan/openbgi/tree/e2500e0badd04aab472e4620477747973e5e5544) format references and need no compiler or additional installation.

Developer builds use the compiler/SDL2 locations in [Native tool setup](NATIVE_TOOL_SETUP.md).

## VNDS

Compatible converted exports run through [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE), using the pinned `0.0.13-838e47b-mac-v1` adapter and managed [LÖVE](https://love2d.org/) `11.5`. Play downloads the required LÖVE runtime with consent when it is missing. The small adapter is included and shared directly between games, with no separate installation or copy per game.

Original game directories and supported ZIP archives are read in place. Saves and session settings use the private game directory; incompatible AAC/M4A audio is converted once and cached there. The inspector provides save editing and script-folder access.
