# Upstream sources and adaptations

MacLauncher uses many third-party engines, tools and libraries, called upstream projects here. Some are used unchanged; others need MacLauncher's changes, called adaptations, to work on macOS or with the launcher. The [source inventory](../../scripts/upstream-overlays.json) records the adaptations to the app's source dependencies, while the commit of each dependency is fixed by its Gitlink, Git's record of a submodule commit. The adapted runtime packages are built and published by [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), which also tracks the dependencies used to produce them. [MacLauncher Android](https://github.com/procrastinine/maclauncher-android) tracks the Android platform sources and their dependencies. [Runtime distribution](RUNTIME_DISTRIBUTION.md) describes the downloaded packages, the included components and where their source is kept.

## External store clients

### Steam

MacLauncher's own connections to Steam, such as manual sign-ins and their downloads, use Steam's network protocol through `steam-user` 5.3.0, an npm package whose dependency versions are fixed by the lockfile. Two of those dependencies carry tracked pnpm patches: one canonicalizes the version metadata of `node-bignumber`, and the other makes `@doctormckay/steam-crypto` use synchronous cipher operations for Node.js compatibility. The original licenses stay with those packages.

For libraries shared through Steam Families, MacLauncher's Steam Families adapter requests family membership and shared-library metadata, following the [Steam client protobuf definitions](https://github.com/SteamDatabase/Protobufs/blob/master/steam/steammessages_familygroups.steamclient.proto). The local app cache is parsed according to the documented [SteamAppInfo format](https://github.com/ValveResourceFormat/SteamAppInfo).

### Epic and GOG Galaxy

Epic downloads use [Legendary](https://pypi.org/project/legendary-gl/), an open-source command-line client for the Epic Games Store. MacLauncher installs the newest Legendary release on PyPI that has a wheel for the included Python. For each dependency, it takes the newest PyPI release that satisfies the requirement in that wheel's own metadata and has a wheel the included Python accepts; optional extras are left out. Every wheel is verified against PyPI's SHA-256. The included Python then extracts the wheels and their license directories, so nothing is built from source. The installation records each package's version, file and SHA-256.

When an Epic action needs Legendary, PyPI is checked once per session; if PyPI does not answer, the newest installed Legendary is used. Legendary's manifest lookups let MacLauncher confirm an exact Epic build. A newer release without those lookups is still installed, but the newest installed Legendary that has them stays in use. A Legendary without them still downloads the current build.

GOG Galaxy builds are downloaded with [GOGdl](https://github.com/Heroic-Games-Launcher/heroic-gogdl), the GOG downloader of the Heroic Games Launcher project. MacLauncher takes it from the newest Heroic release that offers a Mac executable for this Mac's CPU, and a renamed or universal executable also counts. The download is checked as described in [Runtime release catalogs](RUNTIME_CATALOGS.md#integrity), and the installation records the release's tag commit. If the release list is unavailable, the newest installed GOGdl is used.

Both tools download when a store action needs them. They are used internally and have no entry in **Runtimes**. New versions come from published registry packages or release downloads, never from Git checkouts that can change.

### GOG and itch.io

For GOG and itch.io, MacLauncher uses its own HTTPS adapters, which follow [gog-cli](https://github.com/aleksandarristic/gog-cli) and the [official itch.io consumer SDK](https://github.com/itchio/go-itchio). Public itch.io game links need neither an API key nor an additional helper, since they go through the site's download-page forms. [External libraries](../library/EXTERNAL.md) describes how the accounts, content versions and downloads of each store are mapped.

## Graphics components

### Building the graphics component

MacLauncher applies graphics effects in a native graphics component that ships with the app and attaches to the running game. [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) builds and publishes this component, and the component's [build recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/scripts/graphics-runtime.json) declares its source dependencies, provider recipes and binary inputs. The app's build then downloads the exact package version that the app's package lock, [`build/runtime-packages.json`](../../build/runtime-packages.json), selects.

### Components with their own licenses

Several parts of the graphics component come from other open-source projects and keep their own licenses.

Lossless Scaling is a proprietary upscaling and frame-generation app, and MacLauncher can use the models from a purchased copy, as described under Model acquisition below. To read and run those models, MacLauncher uses code from MAKO, an open-source project for inspecting and processing Lossless Scaling models. The CPU-only Lossless model inspector and the native spatial and temporal processors both use MAKO's resource reader, validators and graph sources, which are under GPL-3.0-or-later. The MAKO source, its notices and MacLauncher's compatibility adapters are included with the combined compiler and native library.

One of these models, LS1, is Lossless Scaling's spatial upscaling network, and its shaders are Direct3D bytecode. To run them on the Mac, MacLauncher translates them with vkd3d-shader 2.1 (LGPL-2.1-or-later), a separately loaded library built for both Mac architectures from commit `fb7f9ff3c1f8d972ee6f1b8c6a92caf6c8ba1e10`. Its notice and corresponding source are included. MacLauncher's loader loads the library directly from beside the processor, and neither Wine nor a Vulkan driver is required.

FSR1, AMD's spatial upscaler, runs EASU reconstruction followed by RCAS sharpening. These steps come from AMD's MIT-licensed EASU and RCAS headers at FidelityFX-FSR commit `a21ffb8f6c13233ba336352bdff293894c706575`. The headers, the notice, MacLauncher's GLSL wrapper and the embedded SPIR-V ship with the component. Ordinary builds and game launches use the embedded shaders, so no shader compiler is downloaded.

### Camera integration

Some temporal upscalers, such as MacLauncher's FSR 2 and FSR 3, need the camera projection that the game used for each frame. Adapters obtain it from Godot games and from Windows games that call DLSS through NVIDIA Streamline. They are built from Godot 4.4 GDExtension headers, Streamline 2.9 headers and DXMT sources at fixed commits, and the [MacLauncher Builds sources](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/maclauncher) record those commits and the module adapters.

- The native [camera API](../../src/modules/shared/reshade/temporal/README.md) binds projection metadata to the Metal textures or command buffer of the same frame.
- In Godot games, the metadata comes from eligible native Metal views through the [Godot adapter](../../src/modules/godot/graphics/README.md).
- On the DXVK and vkd3d-proton DLSS route, the NGX core takes Streamline camera constants from the game's own interposer, as the [Streamline camera](../../src/modules/crossover/temporal/streamline/README.md) notes describe.

DXMT is a Direct3D renderer that runs Windows games on Metal. The adapted DXMT components include their LGPL notice and corresponding source, whereas compatible original DXMT support libraries are installed separately from the selected Wine runtime.

### Model acquisition

LS1 and LSFG, Lossless Scaling's frame generation, use the models from a purchased copy of Lossless Scaling, which is Steam application 993090. MacLauncher can download these model files in two ways. The first goes through an installed Mac Steam client, which receives the `download_depot 993090 993091` command. MacLauncher's integration in `src/modules/shared/reshade/steam-client-models.js` then waits for a new completion record and imports the files from Steam's known content directories. It copies or changes no Steam authentication files or platform settings.

The alternative uses SteamCMD, Valve's command-line Steam client, through its binary-only macOS bootstrap at `https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz`. Valve replaces that archive in place. Its compression is detected when it is extracted, and an archive that places `steamcmd` inside a folder is used from that folder. The download is accepted when its `steamcmd` file is a Mach-O executable that passes `codesign --verify --strict` against Valve's Developer ID (team `MXGJJ98X76`); this check does not run the file. A Terminal session then starts that executable directly with the environment of Valve's `steamcmd.sh`, and it restarts the executable when it exits with status 42 after updating itself. The archive's unsigned shell script is not run.

SteamCMD updates itself from Valve and downloads application 993090 through an authenticated Steam account. Both SteamCMD and Lossless Scaling are proprietary: they are acquired only on request and are not redistributed with MacLauncher. SteamCMD acquisition starts in `src/modules/shared/reshade/steam-models.js`.

Neural rendering, restoration and upscaling run trained models on the GPU through an optional neural provider for Apple silicon. This provider embeds MLX-DLSS, whose source is Apache-2.0, through MacLauncher's [`neural` adapter](../../src/modules/shared/reshade/neural/). Its MLX Swift and Swift package dependency versions, along with the official Metal library download, are recorded in [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/maclauncher/src/modules/shared/reshade/neural). The live provider requires Apple silicon and macOS 14 or later, and its separately loaded AVFoundation video command requires macOS 26 or later. As included in the app, the provider's file list records native hashes, architecture and operating-system requirements, original notices and the exact dependency versions. Model weights, however, are separate from these source licenses: the local model manager imports supplied `.dlssmodel` packages and never downloads or distributes vendor weights.

### Shader collections

Besides the effects included with MacLauncher, many shader collections can be downloaded from their upstream repositories, among them Anime4K, ArtCNN, Chroma from Luma, mpv and qUINT. A [shader library](../../src/modules/shared/reshade/managed-shader-packs.json) lists these repositories, and the collections are refreshed, downloaded and removed in Graphics management. Each package keeps its source, includes, assets and license notices. For ArtCNN, only the GLSL sources are selected, and the model archives are skipped.

For mpv and libplacebo shaders, the original declarations describe resizing and video-plane requirements. Executable syntax and parameter metadata are handled by the original provider parsers, and the standard libplacebo scaling choices come from the installed provider's exported filter registry.

A collection of SweetFX and RetroArch CRT shaders is included with MacLauncher and ships as source with the shared module; proprietary model files, by contrast, are never included. The [shader catalog](../../src/modules/shared/reshade/shader-packs.json) and the [native method table](../../src/modules/shared/reshade/native-filter/index.js) record exact source revisions and dependency paths, and the [shader notices](../../src/modules/shared/reshade/shader-collection/NOTICE.md) describe the licenses and included source files.

When only presets change, `node scripts/stage-reshade.mjs --effects-only` verifies the current build and creates a new version of it with the current effect files, leaving earlier versions unmodified. Native binaries, signatures, the source archive, upstream commits and native notices stay exactly the same. The command reuses the existing binaries and downloads nothing, and no native build or source checkout is used.

Effects adapted from third-party sources keep their complete adapted source and embedded license notice. For each of them, the [effect source inventory](../../src/modules/shared/reshade/effect-sources.json) and the included runtime manifest record the upstream commit, the original and adapted checksums, and the adaptations. When the effects are packaged, each adapted checksum is verified and its notice is added to the distribution record.

CAS Sharpen is based on AMD's MIT-licensed implementation of Contrast Adaptive Sharpening (CAS), taken from SweetFX source revision `93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361`. MacLauncher's [effect](../../src/modules/shared/reshade/effects/cas.fx) keeps the original port credits and the nine-sample linear-light calculation. It runs on the shared Metal and OpenGL effect paths because it uses explicit texel offsets and sRGB transfer functions.

## Runtime and tool packages

For the app's source dependencies, the source inventory describes each adaptation that the app declares, together with its inputs. A submodule needs no inventory entry merely because it is present, since its Gitlink already records the revision to check out. Copied shader sources and archive adaptations keep their original source commits and need no duplicate checkout declarations. Dependencies used to produce packages stay in the Builds or Android source repository that consumes them, and MacLauncher's own versioned helpers are recorded separately from upstream projects. [Runtime distribution](RUNTIME_DISTRIBUTION.md) lists the native package versions and where each comes from.

MacLauncher tracks every Git source it uses as a Git submodule at an exact commit, including small tools, build dependencies and nested sources. A new upstream version is compared against that commit and against the module's adaptations, while the checkouts themselves are never edited. Submodules used only as references can stay uninitialized, and the app leaves them out. Downloads that contain only binaries need no source checkout; they record exact versions and checksums instead.

Several runtimes and tools come from their publishers' release downloads and are not built from source: EasyRPG, ScummVM, ScummVM Tools, RFVP, Xash3D FWGS, UZDoom, Raze, DREAMM, Browser Woditor, JPEXS FFDec, Near Infinity and AssetRipper. Each has a version manager that records the exact versions, the downloaded files, checksums and installed license notices.

### mac32

Current macOS cannot launch apps built only for 32-bit Intel. [mac32](https://github.com/Shagulka/mac32) runs them by loading the 32-bit app inside a 64-bit Intel host process and translating its system-library calls. MacLauncher downloads the publisher's releases of mac32 and uses them as published, without building mac32 from source.

The mac32 catalog lists each GitHub release with its Intel Mac archive and the source revision of the release's tag. An archive named `mac32-<version>-macos.zip` is preferred, although a renamed or differently packaged archive is also accepted. Each download is checked as described in [Runtime release catalogs](RUNTIME_CATALOGS.md#integrity). A release has two parts: the x86_64 host, whose executable declares the minimum macOS version that installation reads, and the i386 guest libraries that the 32-bit app uses, which are included with it.

Within MacLauncher, the [mac32 module](../../src/modules/mac32) provides the catalog, the version manager and the launch adapter. It keeps the original app bundle and the upstream `COPYING` and `NOTICE` files, and each installation is shared between games. Since the download is not rebuilt, no source checkout is needed either. mac32's core is licensed under GPL-3.0-or-later, its LLVM guest libraries under Apache-2.0 with LLVM exception, and its Steamworks.NET descriptions under MIT. The [32-bit Mac guide](../game-types/MACOS.md#32-bit-mac) describes when the runtime is selected and the limits of its API support.

### RFVP and shared game tools

RFVP, an independent interpreter for FAVORITE's FVP visual novel engine, is published as rolling Mac snapshots. MacLauncher records the exact source commit and download checksum of each snapshot. A native host included with MacLauncher then launches the downloaded engine library directly, without rebuilding RFVP or opening the publisher's separate game-library interface.

Half-Life runs on Xash3D FWGS, an open-source engine compatible with GoldSrc. Its snapshots come from the rolling `continuous` release, and their exact source commit and archive checksum are recorded in the same way as RFVP's. The publisher's archive, which includes Half-Life's game libraries built from hlsdk-portable, is installed unchanged and launched directly.

CrossOver, by contrast, is never downloaded. A CrossOver registration only records the path of an application already on the Mac, and MacLauncher neither acquires nor redistributes the application.

For RPG Maker 2000 and 2003 games, MacLauncher reads LCF files, the format of their database and maps, with the `rpgrt` 0.2.0 library. This library is included in the app as the published npm package, and `pnpm-lock.yaml` records its version and integrity hash. MacLauncher uses the library's compiled JavaScript API without the package's command-line interface.

### Sikarugir

The Sikarugir runtime is also installed from the publisher's binaries: the [Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and the matching [Template libraries](https://github.com/Sikarugir-App/Template/releases/tag/v1.0), which supply each engine's support libraries. Each installation records the engine and Template versions separately, along with the publisher's asset IDs, byte counts and SHA-256 checksums. Only the runtime components are installed; Sikarugir's Creator and wrapper applications are not used.

The components inside these downloads ([Wine](https://github.com/Sikarugir-App/wine), [DXMT](https://github.com/Sikarugir-App/dxmt), [DXVK](https://github.com/Sikarugir-App/dxvk), [MoltenVK](https://github.com/Sikarugir-App/MoltenVK) and each support library) keep their published source and licenses, and corresponding source is provided as each component's license requires. Because the downloads are binaries, they need no Git submodule and no local build. The [Sikarugir guide](SIKARUGIR.md) explains the difference between the Direct3D renderers, the Vulkan drivers and Apple's separately licensed D3DMetal component.

MacLauncher's [Windows catalog](../../src/modules/crossover/sikarugir/runtime/catalog.js) lists the publisher's downloads and records the engine source repositories separately. Because the engine archives do not name an exact Git revision for their Wine patch set, the downloaded binaries are identified by their archive checksums.

The Template's DXMT carries two different version labels: its version file labels the package `v0.80-244-g7c8dee1`, while its 64-bit D3D11 library embeds `v0.80-250-g427228c`. The package label and the embedded build version are recorded separately, and the publisher's archive does not name an exact source commit for that embedded build.

## Upstream commits and updates

The commands in this section are developer tools. They check out upstream sources at their recorded commits, compare the checkout with the source inventory and try new upstream revisions. They need Node.js and Git on `PATH`, which installed runtimes do not need. Each backend recipe lists its own build prerequisites.

### Initialization

Local builds and CI check out upstream sources with the same initializer:

```sh
node scripts/init-submodules.cjs
```

The initializer checks out the exact commits recorded as Gitlinks. Ordinary setup selects the app and test sources listed in `build/source-dependencies.json`, and a nested dependency is included only through an explicit `recursiveSubmodules` entry. Maintainers use a selection configured in `.gitmodules` instead: `maclauncher-recursive = false` keeps only the primary checkout, and `maclauncher-init = false` marks reference-only sources.

- `--dry-run` lists the plan without fetching.
- `-- PATH ...` selects declared top-level paths.
- `--all` selects the enabled maintainer sources and their declared nested dependencies. Sources marked `maclauncher-recursive = false` keep only their primary checkout. Reference-only sources can be selected explicitly with `-- PATH ...`.

Each source is fetched from its recorded public mirror at its exact commit. Initialization leaves tracked local edits intact and never follows a moving branch. Once launcher changes are pulled with `git pull --no-recurse-submodules`, running the initializer again fetches any updated commits.

### Inventory checks

Another script audits the checkout against the source inventory:

```sh
node scripts/check-upstream-overlays.cjs
node scripts/check-upstream-overlays.cjs --json
```

The audit runs offline and covers the declared inventory entries. For each entry, it compares the Gitlink, the checkout's origin and commit, and the declared references to exact commits, checksums and adaptation versions. Archive checksums are compared as well, together with the upstream source guards, which are the expected hashes of the upstream files that an adaptation changes. The audit also checks MacLauncher's own adaptation entries for safe paths, and it checks the declared recipe entries and callable adaptation operations. Uninitialized dependencies are reported separately; the audit does not fetch, initialize or modify them, and Git's automatic fetching of missing partial-clone objects is turned off. An unresolved license still limits how its component can be distributed.

Some inventory references point into an array in a catalog. Such a reference selects an exact version record regardless of its position, so adding a new version does not change how an earlier one is identified. Missing or duplicate records fail the audit.

Some sources are checked out from a public mirror. When one is recorded, the mirror is stored separately from the repository URL that the upstream project declares, and the audit checks both origins and the exact commit. A mirror entry permits no other origin changes. Explicit candidate fetching uses the recorded mirror, while ordinary checks stay offline.

### Applying an upstream revision

The same script also tries a new upstream commit. It takes the full commit hash and a separate work directory:

```sh
node scripts/check-upstream-overlays.cjs \
  --project impacto-current \
  --candidate ba51381fb65da70697be29e6a817dc4af5c98d19 \
  --work-dir /absolute/work/impacto-candidate \
  --recipe impacto-windows-current-v10
```

The command works on an isolated copy of the source, which it creates by reading Git objects. In that copy, it runs the declared backend apply routine and writes `candidate-report.json`. It checks the recorded hashes of the original and adapted files, including that new files do not already exist. The report lists conflicts, the source scope and the required build and tests. Copies of the Ramen and CoreAudio output are checked separately. To confirm that the repository's own submodule checkout is left untouched, its HEAD, index and tracked-file status are compared before and after the run. Source-only checks never compile or launch third-party code.

- `--source /absolute/local/checkout` selects a separate checkout.
- Recipes with extra Git inputs accept `--dependency project-id=/absolute/local/checkout`. OpenGMK, for example, needs Ramen and Udon at their recorded commits.
- `--fetch` fetches only the requested commit into the new work directory. It never updates the repository's submodule checkout or follows a moving branch. Missing nested commits need a complete local checkout, because nested sources are never fetched implicitly.

A recipe's `sourceScopes` field limits each Git input to the files that its apply routine needs, and files outside the scope are left out. A scope can also select a file inside a nested submodule. Before copying such a file, the copier checks the parent Gitlink, the nested origin and its exact commit. Scope selection never weakens the checksum checks of source or adapted files.

When a changed upstream file no longer matches its source guard, the adaptation and its guards are updated, and the complete native package is rebuilt. Any change in bytes or behavior produces a new version, while existing versions and their recorded sources stay unchanged. Component licenses still govern distribution.

For build-only recipes and runtime shims, the source snapshot and the compiled binary are recorded separately. Source checks report original and adapted file hashes, and native packages keep their own manifests and build recipes. SDK and MKXP releases that are only binaries stay in their runtime catalogs.

- For Impacto, the Bink 2 adaptation applies to the FFmpeg source archive, whose SHA is recorded separately. The [Impacto builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/mages/native/current-build.js) verifies all original and adapted patch hashes and checks the compiled decoder.
- RLVM runs as its unmodified published Mac app. Its [catalog](../../src/modules/siglus/runtime/rlvm-catalog.js) records the release commit, the asset ID and any SHA-256 that GitHub publishes for the asset. A small MacLauncher [Cocoa adapter](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/vn-adaptations/rlvm/adapter.m) selects the imported game automatically, and [the profile](../../src/modules/siglus/runtime/adapter-profile.json) records source and binary hashes along with the exact universal-library build command. No RLVM source build or checkout is needed.

## Adaptation recipes

### Tool builds

RPGMakerDecrypter extracts RGSS archives and encrypted RPG Maker MV and MZ assets. It is listed in **Runtimes → Tools** and installs when an extraction or reconstruction action needs it. MV and MZ extraction works on a private copy of the game data. The [MacLauncher Builds scripts](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers) package the macOS arm64 CLI and its dependency notices.

The [RPGMakerDecrypter builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.js) compiles the unmodified upstream code with MacLauncher's MSBuild properties, targets that set dependency versions, and dependency lock files. Its source check verifies that all 33 selected upstream files are identical in the configured copy. The exact source archive, the .NET SDK and runtime, and the NuGet inputs are recorded in [its build inputs](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-source.json). The build uses neutral source paths, and its upstream version is set explicitly instead of depending on the parent Git repository.

LÖVE games that use Steam get a Steam bridge, MacLauncher's own build of the LuaSteam native module. Its [LuaSteam source recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/love/runtime/luasteam-source-overlay.js) in MacLauncher Builds checks the selected LuaSteam sources, LuaJIT API headers and Steamworks SDK headers separately, then copies their exact bytes into a build directory of its own. The bridge binds the host's Lua 5.1 C API and links no second Lua VM. Its [build recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/tools/build-luasteam.mjs) packages the MIT inputs and their notices, while the separately licensed Valve SDK inputs are recorded by revision and hash: SDK headers, the SDK readme and proprietary SDK libraries are left out of that package. Before its catalog entry changes, a new bridge version must keep the same host Lua interface and pass the declared ABI checks.

### Integration map

The table below groups the inventory's adaptations and describes what each one is for. Exact revisions, nested dependencies and file hashes are kept in the inventory's JSON.

| Projects | MacLauncher integration or adaptation | Build or apply entry |
| --- | --- | --- |
| [Kawariki](https://github.com/Orochimarufan/Kawariki), [rpgmakermlinux-cicpoffs](https://github.com/bakustarver/rpgmakermlinux-cicpoffs) | Web compatibility scripts and RGSS Ruby script additions | [Web host](../../src/modules/shared/web/runtime/nwjs-patched-launcher.js), [RGSS assets](../../src/modules/rgss/assets.js) |
| [evbunpack](https://github.com/mos9527/evbunpack) | Packed executable extraction reference | [Packed RGSS](../../src/modules/rgss/packaged.js) |
| [WolfDec](https://github.com/Sinflower/WolfDec) | Reference for independent WOLF DX archive parsing and container conversion; source and binaries are excluded from distribution | [WOLF archive reader](../../src/modules/wolfrpg/archive.js) |
| MacLauncher [MKXP configuration helper](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/rgss/overlays/mkxpz-config.c) and [display metadata](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/rgss/overlays/mkxpz-identity.m) | Versioned per-launch configuration/CWD isolation and game display metadata; shared publisher runtime remains unchanged | [Helper profile](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/helper-builds/mkxpz-config-helper.json), [Loader/declaration](../../src/modules/rgss/runtime/mkxpz-config-helper.js) |
| [MKXP-Z](https://github.com/mkxp-z/mkxp-z/tree/37a04d14413454551a7b6aadbb4e93e67168accb) | macOS path-cache filename normalization through CoreFoundation NFC; explicit malformed UTF-8 and capacity errors | [Source adaptation](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json), [build recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/scripts/build-mkxpz-nfc.cjs), [build catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/mkxpz.json); distinct from installed publisher binaries |
| [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | Unmodified source; deterministic build properties, explicit version and neutral source paths | [Builder/source preparation](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.js), [Build properties](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.props), [Dependency targets](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/rpgmaker-decrypter/decrypter-build.targets) |
| [rpatool](https://codeberg.org/shiz/rpatool), [unrpyc](https://github.com/CensoredUsername/unrpyc), its [legacy branch](https://github.com/CensoredUsername/unrpyc/tree/legacy), [UnRen Gideon](https://github.com/VepsrP/UnRen-Gideon-mod-) | Python archive/decompiler compatibility shims | [UnRen imports](../../src/modules/renpy/resources/unren/vendor.py) |
| [Universal RenPy Walkthrough](https://github.com/BCassO/universal-renpy-walkthrough) | Offline updater override | [RenPy actions](../../src/modules/renpy/main.js) |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | AppKit build configuration; MacLauncher OpenGL helper | [Builder](../../src/modules/gamemaker/runtime/butterscotch.js) |
| MacLauncher [graphics helper](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/included-helpers/gamemaker-opengl-helper) | Software OpenGL helper for official GameMaker runners that draw through OpenGL | [Builds script](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/included-helpers/gamemaker-opengl-helper/build.mjs), [Launcher adapter](../../src/modules/gamemaker/runtime/opengl-fallback.js), [Version catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/gamemaker-opengl-helper.json) |
| MacLauncher offline Steam API and encrypted-ticket loader | Independent MIT implementations; fixed-width native and manual callbacks, local state and the exact interfaces each calling library expects; ticket operations remain unavailable | [API source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/offline-0.5.0/source/offline.cpp), [Ticket source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/ticket-0.1.0/source/ticket.cpp), [API contracts](../../src/modules/shared/runtime/steamworks/native/offline-0.5.0), [Ticket contracts](../../src/modules/shared/runtime/steamworks/native/ticket-0.1.0), [Catalogs and limits](STEAM_API.md) |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK), [Ramen](https://github.com/viriuwu/ramen), [Udon](https://github.com/Adamcake/udon) | AppKit/OpenGL/CoreAudio, file/save/window compatibility, native extension guard, decompiler workspace | [Shared source recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/source-build.js) |
| [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GameMaker HTML5](https://github.com/YoYoGames/GameMaker-HTML5) | Decompiler integration and export/version references | [GameMaker tools](../../src/modules/gamemaker/tools.js), [HTML5 detection](../../src/modules/gamemaker-html5/detect.js) |
| [LuaSteam](https://github.com/uspgamedev/luasteam), [LuaJIT](https://luajit.org) | Host Lua 5.1 linkage and exact native Steam bridge; proprietary SDK headers are separate build inputs, excluded from its source package | [Source adaptation](../../src/modules/love/runtime/luasteam-source-overlay.js), [Builder](../../src/modules/love/runtime/luasteam-build.js) |
| [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2), [KAG3](https://github.com/krkrsdl2/kag3) | Native storage, font and monitor bridge, and limited script integration | [Native bridge](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/kirikiri/native-compat.js), [Builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/kirikiri/build.js) |
| [PlayCover](https://github.com/PlayCover/PlayCover), [PlayTools](https://github.com/PlayCover/PlayTools) | PlayCover releases (GPL-3.0), downloaded from the publisher and using their bundled PlayTools framework for unencrypted ARM64 IPA adaptation | [PlayCover version, release commit and archive hash](../../src/modules/ios/runtime/catalog.js), [iOS integration](../game-types/IOS.md) |
| [Klepton](https://github.com/shinyquagsire23/Klepton), [dex2jvm](https://github.com/kksimp/dex2jvm) | Android Java/native host, APK conversion and shared graphics presentation | [Android builder](../../src/modules/android/native/build.mjs), [Source commits](../../src/modules/android/native/source-pins.json) |
| [AIM](https://github.com/hahnlee/aim) | ART host execution and original Android ELF transport; MacLauncher supplies app launch, shared services, presentation and isolated storage | [ART upstream record](../../src/modules/android/art/supplier.json), [ART assembly recipe](../../src/modules/android/art/build.mjs) |
| [AIM APK reader](https://github.com/hahnlee/aim/tree/934009283f69c251f57ed95ef1dff296546bb6ad/crates/aim-apps) | Included standalone APK metadata helper using original binary XML, resource-table, raster, vector and adaptive-icon parsing; MacLauncher locale and split resource selection and JSON protocol; Apache-2.0 | [Adapter](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/android/native/apk-metadata/adapt.mjs), [Build](https://github.com/procrastinine/maclauncher-builds/blob/main/tools/build-apk-metadata.mjs), [Protocol](../../src/modules/android/native/apk-metadata/README.md) |
| [smali dexlib2](https://github.com/google/smali) | Original DEX parsing/writing for exact ART platform delegates, including hidden-API metadata; BSD-3-Clause; build tool | [Artifact records](../../src/modules/android/art/dex-tools.json), [Delegation tool](../../src/modules/android/art/dex-bodies.mjs) |
| [Android apksig](https://android.googlesource.com/platform/tools/apksig/) | Offline APK signature verification (Apache-2.0), official Google Maven artifact | [Artifact record](../../src/modules/android/native/apksig-binary.json), [License](../../src/modules/android/tools/apksig/LICENSE) |
| Android [framework](https://android.googlesource.com/platform/frameworks/base) and [libcore](https://android.googlesource.com/platform/libcore) | Complete executable framework with precise JVM and native platform adaptations; original alarm JNI uses the same epoll and timerfd implementation as native applications | [Android source commits](../../src/modules/android/native/source-pins.json), [Alarm native module](../../src/modules/android/native/alarm/README.md), [License collection](../../scripts/license-files.mjs) |
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
| [Impacto](https://github.com/CommitteeOfZero/impacto), [avcpp](https://github.com/h4tr3d/avcpp), [LibAtrac9](https://github.com/Thealexbarney/LibAtrac9), [magic_enum](https://github.com/Neargye/magic_enum), [FFmpeg](https://ffmpeg.org), [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core) | Windows resource/script support, Mac portability, exact decoder ABI and dependency patches | [Builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/mages/native/current-build.js), [earlier Impacto applier](../../src/modules/mages/native/adapter.js), [Dependency patch applier](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/mages/native/source-patches.js) |

A source apply check covers its declared files and nested inputs, whereas a native package build compiles the complete runtime. For VNDS, the MoonScript source is compiled to Lua, and the package manifest records the compiled profile.

### Android sources

Besides the default MacLauncher Android runtime, Android games can use two optional runtimes: [Mac.apk](https://github.com/kksimp/Mac.apk), installed from its publisher's releases, and [AIM](https://github.com/hahnlee/aim), which comes from a source submodule. Mac.apk versions and download records belong to Mac.apk's own catalog. AIM's patches and build script leave the source checkout unchanged, and the additional files packaged with AIM record exact binary checksums, dependencies and notices. Android system images are acquired separately and are not part of MacLauncher distributions.

Compiling the Android GLES3 adapter needs three Khronos headers: `include/GLES3/gl3.h`, `include/GLES3/gl3platform.h` and `include/KHR/khrplatform.h`. They come from the ANGLE source already nested at `krkrsdl2/external/krkrz/external/angle`, at commit `f82b1b4dc548dc8325ec83c11cd2363f3656a894`. The builder and the packaging step verify their recorded bytes and keep their original paths in the source archive, together with the Khronos MIT and SGI-B-2.0 notices. These compile-time headers do not replace or rebuild the separately recorded portable ANGLE binaries.
