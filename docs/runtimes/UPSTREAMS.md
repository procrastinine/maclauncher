# Upstream sources and adaptations

MacLauncher uses many third-party engines, tools and libraries, called upstream projects here. Some are used unchanged; others need MacLauncher's changes, called adaptations, to work on macOS or with the launcher. The [source inventory](../../scripts/upstream-overlays.json) records the app's source checkouts, copied source and archive adaptations, with exact commits, licenses and owned files. [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) builds and publishes the adapted runtime packages and tracks their producer dependencies. [MacLauncher Android](https://github.com/procrastinine/maclauncher-android) tracks the Android platform sources and their dependencies. [Runtime distribution](RUNTIME_DISTRIBUTION.md) describes the downloaded packages, the included components and where their source is kept.

## External store clients

### Steam

Steam protocol access uses the npm package `steam-user` 5.3.0, and the lockfile fixes the versions of its dependencies. Tracked pnpm patches canonicalize the version metadata of `node-bignumber` and make `@doctormckay/steam-crypto` use synchronous cipher operations for Node.js compatibility. The original licenses stay with those packages. MacLauncher's Steam Families adapter follows the [Steam client protobuf definitions](https://github.com/SteamDatabase/Protobufs/blob/master/steam/steammessages_familygroups.steamclient.proto), and local app-cache parsing follows the documented [SteamAppInfo format](https://github.com/ValveResourceFormat/SteamAppInfo).

### Epic and GOG Galaxy

[Legendary](https://pypi.org/project/legendary-gl/) comes from the newest release on PyPI that has a wheel for the included Python. Each dependency comes from the newest PyPI release that satisfies the requirement in that wheel's own metadata and has a wheel the included Python accepts; optional extras are left out. PyPI's SHA-256 verifies every wheel, and the included Python extracts the wheels and their license directories without a source build. The installation records each package's version, file and SHA-256.

PyPI is checked once per session when an Epic action needs Legendary, and the newest installed Legendary is used when PyPI does not answer. MacLauncher confirms an exact Epic build through Legendary's manifest lookups. A newer release without those lookups is still installed, but the newest installed Legendary that has them stays in use, and a Legendary without them still downloads the current build.

[GOGdl](https://github.com/Heroic-Games-Launcher/heroic-gogdl) comes from the newest Heroic release that offers a Mac executable for this Mac's CPU, including a renamed or universal one. The download is checked as described in [Runtime release catalogs](RUNTIME_CATALOGS.md#integrity), and the installation records the release's tag commit. When the release list is unavailable, the newest installed GOGdl is used. Both tools download when a store action needs them and are used internally, with no entry in **Runtimes**. New versions come from published registry packages or release downloads, never from Git checkouts that can change.

### GOG and itch.io

GOG and itch.io use MacLauncher's own HTTPS adapters, which follow [gog-cli](https://github.com/aleksandarristic/gog-cli) and the [official itch.io consumer SDK](https://github.com/itchio/go-itchio). Public itch.io game links use the site's download-page forms and need no API key or additional helper. [External libraries](../library/EXTERNAL.md) describes the account, content-version and download mappings of each store.

## Graphics components

### Building the graphics component

MacLauncher includes a graphics component, which is built and staged with `node scripts/build-graphics-runtime.mjs --work <directory> --stage`. Its [build recipe](../../scripts/graphics-runtime.json) lists the core CMake targets, the recipe of each optional provider, the Git sources with the files that record their commits, and the binary build inputs with their checksums.

- `--check` resolves every input without building, and reports uninitialized submodules, differing commits and missing inputs.
- `--fetch` downloads the inputs that have a fixed URL and checksum: the LLVM-MinGW toolchain, the FSR 4 Lite 2 weights, the Streamline 2.9.0 SDK, the DXMT renderer template, MoltenVK 1.4.2, and the Homebrew bottles of libplacebo, shaderc and Little CMS. Each is checked against its recorded SHA-256 before use.
- `--only`, `--skip` and `--reuse <provider>=<payload>` select components and reuse existing verified builds.
- `--source` and `--input` supply other checkouts or files, which are checked against the recorded commits and checksums.

The libplacebo adapter compiles against the core headers produced by the same build. The core requires the macOS 27 SDK and CMake. Provider recipes use their declared tools: Cargo, Swift, uv, Meson and Ninja, and the Python that runs Meson provides Jinja2 for libplacebo's code generator. Shader translation uses the DXC and SPIRV-Cross binaries included in the FSR 4 source.

`--fetch` does not cover package-manager dependencies:

- the neural provider's Swift packages at the revisions in its `Package.resolved`, including the MLX and MLX C submodules of MLX Swift, and the checksummed MLX Metal library archive;
- the RetroArch provider's crates at the versions in librashader's `Cargo.lock`, which its offline Cargo builds read from the Cargo cache;
- the Python 3.12 interpreter that uv runs for FSR 4 shader translation.

The neural and FSR 4 recipes keep their package copies and caches under `--work`. Windows helpers link with a zero PE timestamp. The Cargo builds of the RetroArch Slang provider record the absolute paths of the librashader checkout and of the generated helper workspace in crate metadata, which feeds Rust symbol hashes. The bytes of its `librashader.dylib` and `retroarch-prepare` therefore depend on those two locations as well as on the exact sources and toolchain.

`materialize-source.mjs` assembles the core, and CMake builds it. Staging runs `node scripts/stage-reshade.mjs <source-directory> <build-directory>` with the resulting provider builds. Each staging run creates a new copy of the component under `src/resources/native-runtimes/reshade`. After selecting the new copy, staging removes older copies except the previously selected one; incomplete copies and copies that a running process uses are kept. The module's distribution record lists binary hashes, CPU slices, the actual macOS requirement, upstream commits and license notices. MacLauncher's adapter source and the compiler sources it uses ship with the binary.

### Components with their own licenses

The CPU-only Lossless model inspector and the native spatial and temporal processors use MAKO's resource reader, validators and graph sources, which are under GPL-3.0-or-later. Their source, notices and MacLauncher's compatibility adapters are included with the combined compiler and native library.

LS1 shader translation uses the separately loaded vkd3d-shader 2.1 library (LGPL-2.1-or-later), built for both Mac architectures from commit `fb7f9ff3c1f8d972ee6f1b8c6a92caf6c8ba1e10`. Its notice and corresponding source are included. MacLauncher's loader loads this adjacent library directly, and neither Wine nor a Vulkan driver is required.

FSR1 uses AMD's MIT-licensed EASU and RCAS headers from FidelityFX-FSR commit `a21ffb8f6c13233ba336352bdff293894c706575`. The headers, the notice, MacLauncher's GLSL wrapper and the embedded SPIR-V ship with the component. Ordinary builds and game launches use the embedded shaders and download no shader compiler.

### Camera integration

Camera projection integration uses Godot 4.4 GDExtension headers, Streamline 2.9 headers and DXMT sources at fixed commits. The [source inventory](../../scripts/upstream-overlays.json) records those commits, the licenses and MacLauncher's module adapters.

- The native [camera API](../../src/modules/shared/reshade/temporal/README.md) binds projection metadata to the Metal textures or command buffer of the same frame.
- The [Godot adapter](../../src/modules/godot/graphics/README.md) supplies this metadata from eligible native Metal views.
- The [Streamline adapter](../../src/modules/crossover/temporal/streamline/README.md) keeps the game's original interposer and passes its camera constants through the [DXMT adapter](../../src/modules/crossover/temporal/dxmt/README.md).

The adapted DXMT components include their LGPL notice and corresponding source. Compatible original DXMT support libraries are installed separately from the selected CrossOver or Sikarugir engine.

### Model acquisition

Lossless Scaling model files are downloaded first through the `download_depot 993090 993091` command of an installed Mac Steam client. MacLauncher's integration in `src/modules/shared/reshade/steam-client-models.js` waits for a new completion record and then imports from Steam's known content directories. It copies or changes no Steam authentication files or platform settings.

The alternative download uses Valve's binary-only macOS SteamCMD bootstrap from `https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz`, which Valve replaces in place. The archive's compression is detected when it is extracted, and an archive that places `steamcmd` inside a folder is used from that folder. The download is accepted when its `steamcmd` file is a Mach-O executable that passes `codesign --verify --strict` against Valve's Developer ID (team `MXGJJ98X76`); this check does not run the file. The Terminal session starts that executable directly with the environment of Valve's `steamcmd.sh` and restarts it when it exits with status 42 after updating itself. The archive's unsigned shell script is not run.

SteamCMD updates itself from Valve and downloads application 993090 through an authenticated Steam account. SteamCMD and Lossless Scaling are proprietary, are acquired only on request and are not redistributed with MacLauncher. The acquisition entry point is `src/modules/shared/reshade/steam-models.js`.

The optional Apple silicon neural provider embeds MLX-DLSS at commit `7870371e8bf6c03967213f1a5d40db6c5a3bee38` through MacLauncher's [`neural` adapter](../../src/modules/shared/reshade/neural/). Its source is Apache-2.0. The exact MLX Swift and Swift package dependency versions are recorded in `native/Package.resolved`, and the producer build uses the official MLX Swift 0.31.6 Metal library download recorded in `native/upstream.json`. The live provider requires Apple silicon and macOS 14 or later, and its separately loaded AVFoundation video command requires macOS 26 or later. The staged provider's file list records native hashes, architecture and operating-system requirements, original notices and the exact dependency versions. Model weights are separate from these source licenses: the local model manager imports supplied `.dlssmodel` packages and never downloads or distributes vendor weights.

### Shader collections

A [shader library](../../src/modules/shared/reshade/managed-shader-packs.json) lists the Anime4K, ArtCNN, Chroma from Luma, mpv, qUINT and other upstream shader collection repositories that can be downloaded. Collections are refreshed, downloaded and removed in Graphics management. Packages keep their source, includes, assets and license notices, and ArtCNN acquisition selects the GLSL sources and skips the model archives. The original mpv and libplacebo declarations describe resizing and video-plane requirements. The original provider parsers handle executable syntax and parameter metadata, and the standard libplacebo scaling choices come from the installed provider's exported filter registry.

Proprietary model files are never included. The included SweetFX and RetroArch CRT collection ships as source with the shared module. The [shader catalog](../../src/modules/shared/reshade/shader-packs.json) and the [native method table](../../src/modules/shared/reshade/native-filter/index.js) record exact source revisions and dependency paths, and the [shader notices](../../src/modules/shared/reshade/shader-collection/NOTICE.md) describe the licenses and included source files. The native staging command uses existing binaries and downloads nothing.

For changes to presets only, `node scripts/stage-reshade.mjs --effects-only` verifies the current build and creates a new version of it with the current effect files, leaving earlier versions unmodified. Native binaries, signatures, the source archive, upstream commits and native notices stay exactly the same, and no native build or source checkout is used.

Third-party effects keep their complete adapted source and embedded license notice. Their upstream commit, original and adapted checksums, and adaptations are recorded in the [effect source inventory](../../src/modules/shared/reshade/effect-sources.json) and in the included runtime manifest. Staging verifies each adapted checksum and adds its notice to the distribution record.

CAS Sharpen uses AMD's MIT-licensed CAS implementation from SweetFX source revision `93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361`. MacLauncher's [effect](../../src/modules/shared/reshade/effects/cas.fx) keeps the original port credits and the nine-sample linear-light calculation. Explicit texel offsets and sRGB transfer functions let it run on the shared Metal and OpenGL effect paths.

## Runtime and tool packages

The source inventory covers every configured app submodule, including reference projects and tools. Copied shader sources and archive adaptations retain their original source commits without duplicate checkout declarations. Producer dependencies stay in the Builds or Android source repository that consumes them. MacLauncher's own versioned helpers are recorded separately from upstream projects. [Runtime distribution](RUNTIME_DISTRIBUTION.md) lists the native package versions and where each comes from.

Every Git source that MacLauncher uses is tracked as a Git submodule at an exact commit, including small tools, build dependencies and nested sources. A new upstream version is compared against that commit and against the module's adaptations, and the checkouts are never edited. Submodules used only as references can stay uninitialized and are excluded from the app. Downloads that are only binaries record exact versions and checksums and need no source checkout.

EasyRPG, ScummVM, ScummVM Tools, RFVP, Xash3D FWGS, Browser Woditor, JPEXS FFDec, Near Infinity and AssetRipper use the publishers' release downloads and are not built from source. Their version managers record exact versions, the downloaded files, checksums and installed license notices.

### mac32

[mac32](https://github.com/Shagulka/mac32) is downloaded from its publisher and used as a binary only. The catalog lists each GitHub release with the source revision of its tag and its Intel Mac archive. The name `mac32-<version>-macos.zip` is preferred, and a renamed or differently packaged archive is also accepted. The download is checked as described in [Runtime release catalogs](RUNTIME_CATALOGS.md#integrity). The package's x86_64 host declares its minimum macOS version, which installation reads from the executable, and its i386 guest libraries are included.

MacLauncher's [catalog, manager and launch adapter](../../src/modules/mac32) keep the original app bundle, manage shared installations and keep the upstream `COPYING` and `NOTICE` files. The download is not rebuilt, and no source checkout is needed. The core is GPL-3.0-or-later, the LLVM guest libraries are Apache-2.0 with LLVM exception, and the Steamworks.NET descriptions are MIT. The [32-bit Mac guide](../game-types/MACOS.md#32-bit-mac) describes runtime selection and API limits.

### RFVP and shared game tools

RFVP's rolling Mac snapshots keep their exact source commit and download checksum. An included native host launches the downloaded engine library directly; it does not rebuild RFVP or open the publisher's separate game-library interface.

Xash3D FWGS snapshots from the rolling `continuous` release keep their exact source commit and archive checksum in the same way. The publisher's archive, with Half-Life's game libraries built from hlsdk-portable, is installed unchanged and launched directly.

CrossOver registrations identify local application paths. MacLauncher neither acquires nor redistributes the application.

The included `rpgrt` 0.2.0 library is the published npm package, with its version and integrity hash recorded in `pnpm-lock.yaml`. Its compiled JavaScript API supplies LCF inspection without the package's CLI.

### Sikarugir

[Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and the matching [Template libraries](https://github.com/Sikarugir-App/Template/releases/tag/v1.0) are binary downloads from the publisher. Each installation records separate engine and Template versions, publisher asset IDs, byte counts and SHA-256 checksums. Only their runtime components are installed, and the Creator and wrapper applications are not used.

[Wine](https://github.com/Sikarugir-App/wine), [DXMT](https://github.com/Sikarugir-App/dxmt), [DXVK](https://github.com/Sikarugir-App/dxvk), [MoltenVK](https://github.com/Sikarugir-App/MoltenVK) and each support library keep their published source and licenses. Corresponding source is provided as each component's license requires; a binary download needs no Git submodule and no local build. The [Sikarugir guide](SIKARUGIR.md) distinguishes Direct3D renderers, Vulkan drivers and Apple's separately licensed D3DMetal component.

The [Windows catalog](../../src/modules/crossover/sikarugir/runtime/catalog.js) lists the publisher's downloads, and the engine source repositories are recorded separately. The engine archives do not name an exact Git revision for their Wine patch set, so the archive checksums identify the downloaded binaries.

Template's DXMT version file labels the package `v0.80-244-g7c8dee1`, while its 64-bit D3D11 library embeds `v0.80-250-g427228c`. The package label and the embedded build version are recorded separately, and the publisher's archive does not name an exact source commit for that embedded build.

## Upstream commits and updates

The commands in this section are developer checks that need Node.js and Git on `PATH`; installed runtimes need neither. Each backend recipe lists its own build prerequisites.

### Initialization

Local builds and CI use the same source initializer:

```sh
node scripts/init-submodules.cjs
```

The initializer checks out the exact commits recorded as Gitlinks. Ordinary setup selects the app and test sources in `build/source-dependencies.json`; nested dependencies require an explicit `recursiveSubmodules` entry. The maintainer selection uses `.gitmodules`: `maclauncher-recursive = false` keeps only the primary checkout, and `maclauncher-init = false` marks reference-only sources.

- `--dry-run` lists the plan without fetching.
- `-- PATH ...` selects declared top-level paths.
- `--all` selects the enabled maintainer sources and their declared nested dependencies. Sources marked `maclauncher-recursive = false` keep only their primary checkout. Reference-only sources can be selected explicitly with `-- PATH ...`.

Sources are fetched from their recorded public mirrors at their exact commits. Initialization leaves tracked local edits intact and never follows a moving branch. After launcher changes are pulled with `git pull --no-recurse-submodules`, running the initializer again fetches any updated commits.

### Inventory checks

The source inventory is checked against the checkout with this command:

```sh
node scripts/check-upstream-overlays.cjs
node scripts/check-upstream-overlays.cjs --json
```

The audit runs offline. It compares the Git index, the checked-out commits, the commits recorded by modules and catalogs, adaptation versions, archive checksums, the hashes of MacLauncher's files and the source guards, which are the expected hashes of the upstream files that an adaptation changes. New submodules and new adaptations need inventory entries. Uninitialized dependencies are reported separately, and the audit does not fetch, initialize or modify them. Git's automatic fetching of missing partial-clone objects is turned off. An unresolved license still limits how its component can be distributed.

A catalog reference into an array selects an exact version record regardless of its position. Missing or duplicate records fail the audit, and adding a new version does not change how an earlier one is identified.

A public checkout mirror, when one is recorded, is stored separately from the repository URL that the upstream project declares. Both origins and the exact commit are checked, and a mirror entry does not allow other origin changes. Explicit candidate fetching uses the recorded mirror, and ordinary checks stay offline.

### Applying an upstream revision

To try a new upstream commit, the same script takes the full commit and a separate work directory:

```sh
node scripts/check-upstream-overlays.cjs \
  --project impacto-current \
  --candidate ba51381fb65da70697be29e6a817dc4af5c98d19 \
  --work-dir /absolute/work/impacto-candidate \
  --recipe impacto-windows-current-v10
```

The command reads Git objects into an isolated copy of the source, runs the declared backend apply routine and writes `candidate-report.json` there. It checks the recorded hashes of the original and adapted files, including that new files do not already exist, and the report lists conflicts, the source scope and the required build and tests. Copies of the Ramen and CoreAudio output are checked separately. The HEAD, index and tracked-file status of the vendored checkout are compared before and after the run. Source-only checks never compile or launch third-party code.

- `--source /absolute/local/checkout` selects a separate checkout.
- Recipes with extra Git inputs accept `--dependency project-id=/absolute/local/checkout`. OpenGMK, for example, needs Ramen and Udon at their recorded commits.
- `--fetch` fetches only the requested commit into the new work directory. It never updates a vendored checkout or follows a moving branch. Missing nested commits need a complete local checkout, because nested sources are never fetched implicitly.

`sourceScopes` limits each Git input to the files that its apply routine needs. A scope can select a file inside a nested submodule; the copier then checks the parent Gitlink, the nested origin and its exact commit before copying that file. Files outside the scope are left out. Scope selection never weakens the checksum checks of source or adapted files.

When a changed upstream file no longer matches its source guard, the adaptation and its guards are updated and the complete native package is rebuilt. Changed bytes or behavior produce a new version, and existing versions and their recorded sources stay unchanged. Component licenses still govern distribution.

Build-only recipes and runtime shims record the source snapshot and the compiled binary separately. Source checks report original and adapted file hashes, and native packages keep their own manifests and build recipes. Binary-only SDK and MKXP releases stay in their runtime catalogs.

- The Bink 2 adaptation targets the FFmpeg source archive, whose SHA is recorded separately. The [Impacto builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/mages/native/current-build.js) verifies all original and adapted patch hashes and checks the compiled decoder.
- RLVM uses its unmodified published Mac app, and its [catalog](../../src/modules/siglus/runtime/rlvm-catalog.js) records the release commit, the asset ID and any SHA-256 that GitHub publishes for the asset. MacLauncher's small [Cocoa adapter](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/vn-adaptations/rlvm/adapter.m) selects the imported game automatically, and [the profile](../../src/modules/siglus/runtime/adapter-profile.json) records source and binary hashes and the exact universal-library build command. No RLVM source build or checkout is needed.

## Adaptation recipes

### Tool builds

RPGMakerDecrypter is listed in **Runtimes → Tools** and installs when an extraction or reconstruction action needs it. MV and MZ extraction works on a private copy of the game data. The [MacLauncher Builds scripts](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers) package the macOS arm64 CLI and its dependency notices.

The [RPGMakerDecrypter builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.js) compiles unmodified upstream code with MacLauncher's MSBuild properties, dependency version targets and dependency locks. Its source check verifies that all 33 selected upstream files are identical in the configured copy. [Its build inputs](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-source.json) record the exact source archive, the .NET SDK and runtime, and the NuGet inputs. The build uses neutral source paths and an explicit upstream version that does not depend on the parent Git repository.

The [LuaSteam source recipe](../../src/modules/love/runtime/luasteam-source-overlay.js) checks the selected LuaSteam sources, LuaJIT API headers and Steamworks SDK headers separately, then stages their exact bytes in a build directory of its own. The bridge binds the host's Lua 5.1 C API and does not link a second Lua VM. Its [source package](../../src/modules/love/runtime/luasteam-package.js) includes the MIT inputs and their notices and records the separately licensed Valve SDK inputs by revision and hash. SDK headers, the SDK readme and proprietary SDK libraries are left out of that package. A new bridge version must keep the same host Lua interface and pass the declared ABI checks before its catalog entry changes.

### Integration map

The inventory groups the adaptations as follows. The JSON holds the exact revisions, nested dependencies and file hashes; this table describes what each adaptation is for.

| Projects | MacLauncher integration or adaptation | Build or apply entry |
| --- | --- | --- |
| [Kawariki](https://github.com/Orochimarufan/Kawariki), [rpgmakermlinux-cicpoffs](https://github.com/bakustarver/rpgmakermlinux-cicpoffs) | Web compatibility scripts and RGSS Ruby script additions | [Web host](../../src/modules/shared/web/runtime/nwjs-patched-launcher.js), [RGSS assets](../../src/modules/rgss/assets.js) |
| [evbunpack](https://github.com/mos9527/evbunpack) | Packed executable extraction reference | [Packed RGSS](../../src/modules/rgss/packaged.js) |
| [WolfDec](https://github.com/Sinflower/WolfDec) | Reference for independent WOLF DX archive parsing and container conversion; source and binaries are excluded from distribution | [WOLF archive reader](../../src/modules/wolfrpg/archive.js) |
| MacLauncher [MKXP configuration helper](../../src/modules/rgss/overlays/mkxpz-config.c) and [display metadata](../../src/modules/rgss/overlays/mkxpz-identity.m) | Versioned per-launch configuration/CWD isolation and game display metadata; shared publisher runtime remains unchanged | [Builder](../../scripts/stage-mkxpz-config-helper.cjs), [Loader/declaration](../../src/modules/rgss/runtime/mkxpz-config-helper.js) |
| [MKXP-Z](https://github.com/mkxp-z/mkxp-z/tree/37a04d14413454551a7b6aadbb4e93e67168accb) | macOS path-cache filename normalization through CoreFoundation NFC; explicit malformed UTF-8 and capacity errors | [Source adaptation](../../src/modules/rgss/overlays/mkxpz-filename-nfc/source.json), [build recipe](../../scripts/build-mkxpz-nfc.cjs), [build catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/rgss/runtime/owned-builds.json); distinct from installed publisher binaries |
| [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | Unmodified source; deterministic build properties, explicit version and neutral source paths | [Builder/source preparation](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.js), [Build properties](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.props), [Dependency targets](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.targets) |
| [rpatool](https://codeberg.org/shiz/rpatool), [unrpyc](https://github.com/CensoredUsername/unrpyc), its [legacy branch](https://github.com/CensoredUsername/unrpyc/tree/legacy), [UnRen Gideon](https://github.com/VepsrP/UnRen-Gideon-mod-) | Python archive/decompiler compatibility shims | [UnRen imports](../../src/modules/renpy/resources/unren/vendor.py) |
| [Universal RenPy Walkthrough](https://github.com/BCassO/universal-renpy-walkthrough) | Offline updater override | [RenPy actions](../../src/modules/renpy/main.js) |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | AppKit build configuration; MacLauncher OpenGL helper | [Builder](../../src/modules/gamemaker/runtime/butterscotch.js) |
| MacLauncher [graphics helper](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers/gamemaker-opengl-helper) | Software OpenGL helper for official GameMaker runners that draw through OpenGL | [Builds script](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/gamemaker-opengl-helper/build.mjs), [Launcher adapter](../../src/modules/gamemaker/runtime/opengl-fallback.js), [Version catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/gamemaker-opengl-helper.json) |
| MacLauncher offline Steam API and encrypted-ticket loader | Independent MIT implementations; fixed-width native and manual callbacks, local state and the exact interfaces each calling library expects; ticket operations remain unavailable | [API source/build](../../src/modules/shared/runtime/steamworks/native/offline-0.5.0), [Ticket source/build](../../src/modules/shared/runtime/steamworks/native/ticket-0.1.0), [Catalogs and limits](STEAM_API.md) |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK), [Ramen](https://github.com/viriuwu/ramen), [Udon](https://github.com/Adamcake/udon) | AppKit/OpenGL/CoreAudio, file/save/window compatibility, native extension guard, decompiler workspace | [Shared source recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/source-build.js) |
| [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GameMaker HTML5](https://github.com/YoYoGames/GameMaker-HTML5) | Decompiler integration and export/version references | [GameMaker tools](../../src/modules/gamemaker/tools.js), [HTML5 detection](../../src/modules/gamemaker-html5/detect.js) |
| [goldberg-mac](https://github.com/squareloopthings/goldberg-mac), [gbe_fork](https://github.com/Detanup01/gbe_fork), [Abseil](https://github.com/abseil/abseil-cpp) | Legacy adaptation; SDK-based packages are excluded from the app distribution | [Source adaptation](../../src/modules/shared/runtime/steamworks/source-overlay.js), [Offline builder](../../src/modules/shared/runtime/steamworks/build.js) |
| [LuaSteam](https://github.com/uspgamedev/luasteam), [LuaJIT](https://luajit.org) | Host Lua 5.1 linkage and exact native Steam bridge; proprietary SDK headers are separate build inputs, excluded from its source package | [Source adaptation](../../src/modules/love/runtime/luasteam-source-overlay.js), [Builder](../../src/modules/love/runtime/luasteam-build.js) |
| [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2), [KAG3](https://github.com/krkrsdl2/kag3) | Native storage, font and monitor bridge, and limited script integration | [Native bridge](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/kirikiri/native-compat.js), [Builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/kirikiri/build.js) |
| [PlayCover](https://github.com/PlayCover/PlayCover), [PlayTools](https://github.com/PlayCover/PlayTools) | PlayCover releases (GPL-3.0), downloaded from the publisher and using their bundled PlayTools framework for unencrypted ARM64 IPA adaptation | [PlayCover version, release commit and archive hash](../../src/modules/ios/runtime/catalog.js), [iOS integration](../game-types/IOS.md) |
| [Klepton](https://github.com/shinyquagsire23/Klepton), [dex2jvm](https://github.com/kksimp/dex2jvm) | Android Java/native host, APK conversion and shared graphics presentation | [Android builder](../../src/modules/android/native/build.mjs), [Source commits](../../src/modules/android/native/source-pins.json) |
| [AIM](https://github.com/hahnlee/aim) | ART host execution and original Android ELF transport; MacLauncher supplies app launch, shared services, presentation and isolated storage; process liveness includes the upstream exited-child correction from `60296444b08dca5c72f6f7bae098961337a746ca` | [ART upstream record](../../src/modules/android/art/supplier.json), [ART assembly recipe](../../src/modules/android/art/build.mjs), [Process liveness patch](../../src/modules/android/art/adapters/aim-process-liveness.patch) |
| [AIM APK reader](https://github.com/hahnlee/aim/tree/934009283f69c251f57ed95ef1dff296546bb6ad/crates/aim-apps) | Included standalone APK metadata helper using original binary XML, resource-table, raster, vector and adaptive-icon parsing; MacLauncher locale and split resource selection and JSON protocol; Apache-2.0 | [Sources](../../src/modules/android/native/apk-metadata/sources.json), [Adapter](../../src/modules/android/native/apk-metadata/adapt.mjs), [Build](../../src/modules/android/native/apk-metadata/build.mjs), [Protocol and source packaging](../../src/modules/android/native/apk-metadata/README.md) |
| [smali dexlib2](https://github.com/google/smali) | Original DEX parsing/writing for exact ART platform delegates, including hidden-API metadata; BSD-3-Clause; build tool | [Artifact records](../../src/modules/android/art/dex-tools.json), [Delegation tool](../../src/modules/android/art/dex-bodies.mjs) |
| [Android apksig](https://android.googlesource.com/platform/tools/apksig/) | Offline APK signature verification (Apache-2.0), official Google Maven artifact | [Artifact record](../../src/modules/android/native/apksig-binary.json), [License](../../src/modules/android/native/notices/apksig/LICENSE) |
| Android [framework](https://android.googlesource.com/platform/frameworks/base) and [libcore](https://android.googlesource.com/platform/libcore) | Complete executable framework with precise JVM and native platform adaptations; original alarm JNI uses the same epoll and timerfd implementation as native applications | [Android source commits](../../src/modules/android/native/source-pins.json), [Alarm native module](../../src/modules/android/native/alarm/README.md), [Included notices](../../src/modules/android/native/notices) |
| Android [libcore](https://android.googlesource.com/platform/libcore) and [ART](https://android.googlesource.com/platform/art) native Memory | Complete memory-operation units and native tables; JDK buffer and cleaner ownership | [Source commits](../../src/modules/android/native/source-pins.json), [Native builder](../../src/modules/android/native/libcore/build.mjs) |
| Android [Conscrypt](https://android.googlesource.com/platform/external/conscrypt) and [BoringSSL](https://android.googlesource.com/platform/external/boringssl) | Complete original Android JNI provider, crypto/TLS modules and CA roots using the OpenJDK/Darwin native ABI | [Source commits](../../src/modules/android/native/source-pins.json), [Native builder](../../src/modules/android/native/conscrypt/build.mjs) |
| Android [Apache HTTP legacy module](https://android.googlesource.com/platform/external/apache-http) | Complete `org.apache.http.legacy` implementation, including HTTP clients, codecs, logging and Android helpers; Apache-2.0 | [Original module builder](../../src/modules/android/native/framework-modules.mjs), [Source commits](../../src/modules/android/native/source-pins.json) |
| Android [StatsD](https://android.googlesource.com/platform/packages/modules/StatsD) | Original `service-statsd` Java implementation with shared framework dependencies; Apache-2.0 | [Original module builder](../../src/modules/android/native/framework-modules.mjs), [Source commits](../../src/modules/android/native/source-pins.json) |
| Android [Binder RPC](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/binder/) and [libutils](https://android.googlesource.com/platform/system/core/+/refs/heads/main/libutils/) | Original Binder/Parcel JNI, portable Binder SDK, IMemory/MemoryDealer and cutils property implementations; Darwin sockets, shared descriptor/memory ownership, property-provider calls and shutdown polling | [Builder and adapters](../../src/modules/android/native/binder-rpc/build.mjs), [Source commits](../../src/modules/android/native/source-pins.json) |
| Android [media framework](https://android.googlesource.com/platform/frameworks/av) | Original media formats, extractor and buffer algorithms, with typed native playback, VideoToolbox and CoreAudio integration; Apache-2.0 | [Media builder](../../src/modules/android/native/media-foundation/build.mjs), [Source commits](../../src/modules/android/native/source-pins.json) |
| [system3-sdl2](https://github.com/kichikuou/system3-sdl2), [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2), [xsystem4](https://github.com/nunuhara/xsystem4) | SDL runtime portability, executable-relative resources and versioned Mac graphics/shader adaptations | [System3 portable builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/alicesoft/system3-portable.js), [System3.5 portable builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/alicesoft/system35-portable-v3.js), [System4 portable builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/alicesoft/system4-portable-v3.js) |
| [sys3c](https://github.com/kichikuou/sys3c), [xsys35c](https://github.com/kichikuou/xsys35c) | MacLauncher CMake tool build | [Decompiler builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/alicesoft/decompiler-build.js) |
| [FNA](https://github.com/FNA-XNA/FNA) and its nested libraries | Native OpenGL policy, ABI forwarders and generic .NET host | [Builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/fna/runtime/build.js) |
| [HashLink](https://github.com/HaxeFoundation/hashlink), [SDL](https://github.com/libsdl-org/SDL), [OpenAL Soft](https://github.com/kcat/openal-soft) | Current upstream build, plus a 1.9 build at its own recorded commit for codec and native compatibility | [Current builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/hashlink/runtime/build.js), [Legacy builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/hashlink/runtime/legacy-build.js) |
| [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) | MacLauncher CMake and Cocoa Mac entry | [Builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/nscripter/runtime/onscripter-en-build-v3.js) |
| [ai5-sdl2](https://github.com/nunuhara/ai5-sdl2) and libai5 | Save and graphics integration, archive and disc access, and portable dependencies at fixed versions | [Portable builder/applier](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/ai5/runtime/portable-build-v4.js), [earlier source adapter](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/ai5/runtime/build.js) |
| [libnpengine](https://github.com/FGRE/libnpengine), [libnpa](https://github.com/FGRE/libnpa) | Mac entry, private storage, NSS compiler/interpreter/object compatibility | [Builder/applier](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/nitroplus/runtime/build.js) |
| [GemRB](https://github.com/gemrb/gemrb) | Native CLI entry, shared scripting references, and SDL2, audio and Python dependencies at fixed versions | [Portable builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gemrb/runtime/portable-build-v5.js), [guarded adaptation](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gemrb/runtime/portable-overlay-v5.js) |
| [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) | Compiled Lua profile and MacLauncher runtime wrappers in the VNDS package | [Profile verification/preparation](../../src/modules/vnds/prepare.js) |
| [siglus_rs](https://github.com/xmoezzz/siglus_rs) | Upstream native runtime and published assets at exact versions | [Catalog](../../src/modules/siglus/runtime/catalog.js) |
| [OpenBGI](https://github.com/Cytlan/openbgi) | Archive and compiled-program tools; no native interpreter | [BGI / Ethornell](../game-types/BGI.md) |
| [ReMinori](https://github.com/luoyily/ReMinori) | Original PAZ/PE profiles, macOS platform integration, private saves and versioned movie bridge | [Source adaptation](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/overlay.js), [native builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/build.js), [movie builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/movie-build.js) |
| [FelineSystem2](https://github.com/kokseen1/FelineSystem2) | CatSystem2 source reference, excluded from runtime distribution because it does not play CatSystem2 games | [Source adapter](../../src/modules/catsystem2/runtime/port.js) |
| [Impacto](https://github.com/CommitteeOfZero/impacto), [avcpp](https://github.com/h4tr3d/avcpp), [LibAtrac9](https://github.com/Thealexbarney/LibAtrac9), [magic_enum](https://github.com/Neargye/magic_enum), [FFmpeg](https://ffmpeg.org), [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core) | Windows resource/script support, Mac portability, exact decoder ABI and dependency patches | [Builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/mages/native/current-build.js), [earlier Impacto applier](../../src/modules/mages/native/adapter.js), [Dependency patch applier](../../src/modules/mages/native/source-patches.js) |

Source apply checks cover their declared files and nested inputs, and native package builds compile the complete runtime. VNDS compiles its MoonScript source to Lua and records the compiled profile in the package manifest.

### Android sources

Android also supports [Mac.apk](https://github.com/kksimp/Mac.apk) publisher releases and the [AIM](https://github.com/hahnlee/aim) source submodule. Mac.apk versions and download records belong to its own catalog. AIM's patches and build script leave the source checkout unchanged, and the additional files packaged with it record exact binary checksums, dependencies and notices. Android system images are acquired separately and are not part of MacLauncher distributions.

The Android GLES3 adapter also uses three compile-time headers from the existing nested `krkrsdl2/external/krkrz/external/angle` source at commit `f82b1b4dc548dc8325ec83c11cd2363f3656a894`: `include/GLES3/gl3.h`, `include/GLES3/gl3platform.h` and `include/KHR/khrplatform.h`. The builder and stager verify their recorded bytes and keep their original paths in the source archive, together with the Khronos MIT and SGI-B-2.0 notices. These headers do not replace or rebuild the separately recorded portable ANGLE binaries.
