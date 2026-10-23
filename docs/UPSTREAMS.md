# Maintaining upstream adaptations

## External store clients

Steam protocol access uses the npm-published `steam-user` 5.3.0 package; the
lockfile pins its dependency closure. Tracked pnpm patches canonicalize
`node-bignumber`'s version metadata and use synchronous cipher operations in
`@doctormckay/steam-crypto` for Node.js compatibility. Original licenses remain
with those packages. The owned Steam Families adapter follows the
[Steam client protobuf definitions](https://github.com/SteamDatabase/Protobufs/blob/master/steam/steammessages_familygroups.steamclient.proto).
Local app-cache parsing follows the documented
[SteamAppInfo format](https://github.com/ValveResourceFormat/SteamAppInfo).

The managed Legendary package closure is pinned by version, URL, size and SHA-256
in `src/core/external-store-tools.json`. Packages and license directories are
extracted with the included Python, without a source build. GOGdl's native
artifacts and exact source revision are declared in `src/core/gogdl-tool.js`.
These tools download on an explicit store action and remain shared internal
dependencies. Their updater inputs are published registry packages or release
artifacts, rather than mutable Git checkouts.

GOG and itch.io use owned HTTPS adapters following
[gog-cli](https://github.com/aleksandarristic/gog-cli) and the
[official itch.io consumer SDK](https://github.com/itchio/go-itchio).
Public itch.io game links use the site's download-page forms without requiring
an API key or an additional helper dependency.
Store-specific account, content-version and download mappings are described in
[External libraries](EXTERNAL.md).

## Runtime adaptations

The included ReShade macOS component is staged with
`node scripts/stage-reshade.mjs <source-directory> <build-directory>` from a universal
build. Its module-owned distribution declaration records binary hashes, CPU
slices, the actual macOS requirement, upstream pins and license notices. The
owned adapter and consumed compiler sources accompany the binary. The CPU-only
Lossless model inspector and native spatial and temporal processors consume MAKO's
GPL-3.0-or-later resource reader, validators and graph sources. Their source,
notices and owned compatibility adapters are included with the combined compiler
and native library. LS1 shader translation uses the separately loaded vkd3d-shader
2.1 library (LGPL-2.1-or-later), built for both Mac architectures from commit
`fb7f9ff3c1f8d972ee6f1b8c6a92caf6c8ba1e10`. Its notice and corresponding
source are included. The owned loader resolves this adjacent library directly;
Wine and a Vulkan driver are not required.
FSR1 uses AMD's MIT-licensed EASU and RCAS headers from FidelityFX-FSR commit
`a21ffb8f6c13233ba336352bdff293894c706575`. Its headers, notice, owned GLSL wrapper
and embedded SPIR-V accompany the component. Ordinary builds and game launches
use the embedded shaders without downloading a shader compiler.

Camera projection integration uses pinned Godot 4.4 GDExtension headers, Streamline
2.9 headers and DXMT sources. The [source inventory](../scripts/upstream-overlays.json)
records their revisions, licenses and module-owned adapters. The native
[camera API](../src/modules/shared/reshade/temporal/README.md) binds projection
metadata to the same frame's Metal textures or command buffer. The
[Godot adapter](../src/modules/godot/graphics/README.md) supplies this metadata
from eligible native Metal views. The
[Streamline adapter](../src/modules/crossover/temporal/streamline/README.md)
preserves the game's original interposer and carries its camera constants through
the [DXMT adapter](../src/modules/crossover/temporal/dxmt/README.md).
The adapted DXMT components include their LGPL notice and corresponding source.
Compatible original DXMT support libraries are managed separately from the
selected CrossOver or Sikarugir engine.

The Lossless Scaling download first uses an installed Mac Steam client's
`download_depot 993090 993091` command. The owned integration in
`src/modules/shared/reshade/steam-client-models.js` waits for a new completion
record before importing from Steam's known content directories; no Steam
authentication files or platform settings are copied or changed.
The alternative download uses Valve's binary-only macOS SteamCMD
bootstrap from `https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz`,
SHA-256 `8ecc17c8988e5acadcc78e631c48490f76150f2dfaa6cf8d7b4b67b097bd753b`.
SteamCMD updates itself from Valve and downloads application 993090 through an
authenticated Steam account. SteamCMD and Lossless Scaling remain proprietary,
are acquired only on request, and are not redistributed with MacLauncher.
The owned acquisition entry point is `src/modules/shared/reshade/steam-models.js`.

The optional Apple Silicon neural provider embeds MLX-DLSS at commit
`7870371e8bf6c03967213f1a5d40db6c5a3bee38` through the module-owned
[`neural` adapter](../src/modules/shared/reshade/neural/). Its source is
Apache-2.0; the exact MLX Swift and Swift package dependencies are pinned in
`native/Package.resolved` and the source inventory. The build uses the official
MLX Swift 0.31.6 Metal library artifact recorded in `native/upstream.json`.
The live provider requires Apple Silicon and macOS 14 or later. Its separately
loaded AVFoundation video command requires macOS 26 or later. The staged
provider inventory includes native hashes, architecture and operating-system
requirements, original notices and dependency identities. Model weights remain
separate from these source licenses: the local model manager imports supplied
`.dlssmodel` packages without downloading or distributing vendor weights.

The managed [shader library](../src/modules/shared/reshade/managed-shader-packs.json)
records pinned Anime4K, ArtCNN, Chroma from Luma and mpv shader collection sources.
Version refresh, download and removal are explicit Graphics management actions.
Installed listings use local metadata. Packages retain source, includes, assets
and license notices; ArtCNN acquisition selects GLSL sources rather than model
archives. The original MPV/libplacebo declarations describe resizing and video
plane requirements. Original provider parsers remain responsible for executable
syntax and parameter metadata. Standard libplacebo scaling choices come from
the installed provider's exported filter registry.

Proprietary model files remain excluded. The included SweetFX and RetroArch CRT
collection ships as source alongside the shared module. The
[shader catalog](../src/modules/shared/reshade/shader-packs.json) records exact
source revisions and dependency paths; the
[shader notices](../src/modules/shared/reshade/shader-collection/NOTICE.md) describe
the licenses and included source files. The native staging command uses existing
binaries and performs no downloads.
For preset-only changes, `node scripts/stage-reshade.mjs --effects-only` verifies
the currently declared payload and creates a new immutable version with the
current effect files. Native binaries, signatures, source archive, upstream pins
and native notices are preserved exactly; no native build or source checkout is used.
Third-party effects retain their complete adapted source and embedded license
notice. Their upstream revision, original and adapted checksums, and adaptations
are recorded in the [effect source inventory](../src/modules/shared/reshade/effect-sources.json)
and included runtime manifest. Staging verifies each adapted checksum and adds
its notice to the distribution declaration.

CAS Sharpen uses the AMD MIT-licensed CAS implementation from the SweetFX
submodule at `93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361`. The owned
[effect](../src/modules/shared/reshade/effects/cas.fx) retains its original port
credits and nine-sample linear-light calculation. Explicit texel offsets and
sRGB transfer functions support the shared Metal and OpenGL effect paths.

[The source inventory](../scripts/upstream-overlays.json) records the exact Git revisions, repository URLs, nested dependencies, license files, owned adaptations, apply entry points, build recipes and focused checks. It covers every configured submodule, including reference projects and tools that are not playable runtimes. Versioned MacLauncher native helpers are recorded separately from upstream Git identities. Native package versions and distribution methods are listed separately in [Runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md).

Every consumed Git source is tracked as a pinned submodule, including small tools, build dependencies and nested sources. Upstream updates are compared against that exact commit and the module-owned adaptations; checkouts remain read-only. Reference-only submodules can remain uninitialized and are excluded from the app. Binary-only runtime downloads retain explicit versions and checksums without requiring a source checkout.

EasyRPG, ScummVM, ScummVM Tools, RFVP, Browser Woditor, JPEXS FFDec, Near Infinity and AssetRipper
use publisher release artifacts rather than source builds. Their module managers
retain exact versions, download identities, checksums and installed notices.

[mac32](https://github.com/Shagulka/mac32) is also a managed binary-only input.
Release `0.1` uses source revision
`dcfed5b9ad1ca1356bddd39ac6a26e564d536c28` and publisher asset
[`mac32-0.1-macos.zip`](https://github.com/Shagulka/mac32/releases/download/v0.1/mac32-0.1-macos.zip),
asset ID `634674147`, 660,386 bytes, SHA-256
`66c3205ad100d76ee4db5fb1cc69ffe910bcd5a384bb0a3cab3ebeef05af3ef2`.
The package's x86_64 host requires macOS 26; its i386 guest libraries are included.
The owned [catalog, manager and launch adapter](../src/modules/mac32) preserve
the original app bundle, manage shared installations and retain upstream
`COPYING` and `NOTICE` files. The download is not rebuilt, and no
source checkout is required. The core uses GPL-3.0-or-later; LLVM guest libraries
use Apache-2.0 with LLVM exception and Steamworks.NET descriptions use MIT.
The [mac32 guide](runtimes/MAC32.md) describes runtime selection and API limits.

RFVP rolling Mac snapshots retain the exact source commit and artifact checksum.
An included native host launches the downloaded engine library directly; it
does not rebuild RFVP or open the publisher's separate game-library interface.
CrossOver registrations identify local application paths without acquiring or
redistributing the application. The included `rpgrt` 0.2.0 library uses the
published npm package identity and integrity recorded in `pnpm-lock.yaml`; its
compiled JavaScript API supplies LCF inspection without the package's CLI.

[Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and matching
[Template libraries](https://github.com/Sikarugir-App/Template/releases/tag/v1.0)
are managed binary downloads. The Windows module records separate engine and
Template versions, publisher asset IDs, byte counts and SHA-256 checksums.
Only their runtime components are installed; Creator and wrapper applications
are not consumed. [Wine](https://github.com/Sikarugir-App/wine),
[DXMT](https://github.com/Sikarugir-App/dxmt),
[DXVK](https://github.com/Sikarugir-App/dxvk),
[MoltenVK](https://github.com/Sikarugir-App/MoltenVK) and each support library
retain their published source and license identities. Required corresponding
source follows the respective component license; a binary download does not
create a Git source dependency or require a local source build.
The [Sikarugir guide](runtimes/SIKARUGIR.md) distinguishes Direct3D renderers,
Vulkan drivers and Apple's separately licensed D3DMetal component.

The [Windows catalog](../src/modules/crossover/sikarugir/runtime/catalog.js)
records these publisher artifacts. Engine source repositories are recorded
separately: the current engine archives do not provide an exact Git revision for
their Wine patch set. Artifact checksums identify the downloaded binaries.

Template's DXMT version file labels the package `v0.80-244-g7c8dee1`; its
64-bit D3D11 library embeds `v0.80-250-g427228c`. The package label and embedded
build identity are recorded separately; the producer archive does not supply an
exact corresponding source revision for that embedded build.

| Artifact | Publisher asset ID | SHA-256 |
| --- | --- | --- |
| [Wine 11.0 revision 1](https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir11.0_1.tar.xz) | `602173037` | `67e29fb3d74f363af39c69ba11f9b13a79812c5db07cf4748672658e4a200a0e` |
| [Wine 10.0 revision 8](https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir10.0_8.tar.xz) | `604320750` | `2a6bcf2a3bf13cddf825599b6bc1e3659cbf71e1282c6d77141a92f6ac8d4c68` |
| [Template 1.0.21](https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-1.0.21.tar.xz) | `604330514` | `bbe996e4e4375318485953d0c7818b7b4b0a4dc1f13303bcc584f99f7602f78d` |

Local builds and CI use the same source initializer:

```sh
node scripts/init-submodules.cjs
```

The initializer uses exact Gitlinks. `.gitmodules` sets `maclauncher-recursive = false` for primary-only sources and `maclauncher-init = false` for optional references; other sources include their pinned nested dependencies. `--dry-run` lists the plan without fetching, `-- PATH ...` selects declared top-level paths, and `--all` includes references while preserving primary-only policy. Recorded public mirrors are used for acquisition and retain their exact source pins. Initialization leaves tracked local edits intact and never follows a moving branch. After pulling launcher changes with `git pull --no-recurse-submodules`, run the initializer again to acquire updated pins.

The source audit command is:

```sh
node scripts/check-upstream-overlays.cjs
node scripts/check-upstream-overlays.cjs --json
```

This is an offline check. It compares the Git index, checked-out revisions, module/catalog pins, adaptation versions, archive pins, owned file hashes and declared source guards. New submodules and owned overlays require inventory entries. Uninitialized dependencies are reported separately; the audit does not fetch, initialize or modify them. Git's automatic fetching of missing partial-clone objects is disabled. An unresolved license remains a distribution limitation.

Array catalog references select an exact version record, independently of order. Missing or duplicate records fail the audit; adding a new version does not change an earlier version's identity.

An explicitly recorded public checkout mirror is recorded independently from the repository URL declared by upstream. Both origins and the exact commit remain checked; a mirror entry does not permit arbitrary origin changes. Explicit candidate fetching uses that recorded mirror, while ordinary checks remain offline.

To check a candidate already present in a local checkout, specify its full commit and a new absolute work directory:

```sh
node scripts/check-upstream-overlays.cjs \
  --project impacto-current \
  --candidate ba51381fb65da70697be29e6a817dc4af5c98d19 \
  --work-dir /absolute/work/impacto-candidate \
  --recipe impacto-windows-current-v10
```

The command reads Git objects into an isolated source copy, invokes the declared backend apply routine, and writes `candidate-report.json` there. Pinned original/adapted hashes are enforced, including new-file absence checks; the report includes conflicts, source scope and required build/tests. Ramen/CoreAudio output copies are checked separately. Vendored checkout HEAD, index and tracked-file status are compared before and after. Source-only checks do not compile or launch third-party code.

`--source /absolute/local/checkout` selects a separate checkout. Recipes with extra Git inputs accept `--dependency project-id=/absolute/local/checkout`; OpenGMK, for example, requires its pinned Ramen and Udon inputs. `--fetch` explicitly fetches only the requested commit into the new owned directory. It never updates a vendored checkout or follows a moving branch. Missing nested commits need a complete local checkout; there is no implicit nested fetch.

`sourceScopes` limits each Git input to the files its apply routine needs. A scope may select a file inside a nested submodule: the copier checks the parent Gitlink, the nested origin and its exact commit before copying that file. Unselected files are omitted. Scope selection never weakens source or adapted-file checksum checks.

A changed upstream file can conflict with the current hash guards. Rebase the module-owned adaptation, update its declared guards, run its focused checks and rebuild the complete native package. Changed bytes or semantics require a new version; existing seals and source identities remain unchanged. Component licenses still govern distribution.

Build-only recipes and runtime shims have separate source snapshot and binary artifact identities. Source checks report original and adapted file hashes; native packages retain their own manifests and build recipes. The Bink 2 adaptation targets the separately SHA-pinned FFmpeg source archive; the [Impacto builder](../src/modules/mages/native/current-build.js) verifies all original/adapted patch hashes and checks the compiled decoder. Binary-only SDK and MKXP releases remain in their runtime catalogs. RLVM uses its unmodified published Mac app: the [catalog](../src/modules/siglus/runtime/rlvm-catalog.js) records the release commit, asset identity and SHA-256. Its small owned [Cocoa adapter](../src/modules/siglus/resources/rlvm-adapter/adapter.m) selects the imported game automatically; [the manifest](../src/modules/siglus/resources/rlvm-adapter/manifest.json) records source/binary hashes and the exact universal-library build command. No RLVM source build or checkout is needed.

The [RPGMakerDecrypter builder](../src/modules/rgss/runtime/decrypter-build.js) compiles unmodified upstream code with owned MSBuild properties, dependency version targets and dependency locks. Its source check verifies all 33 selected upstream files remain identical in the configured copy. The pinned source archive, .NET SDK/runtime and NuGet inputs are recorded in [its build inputs](../src/modules/rgss/runtime/decrypter-source.json). A rebuild must retain the neutral source path map and explicit upstream identity, independent of the parent Git repository, and pass the decryption checks before replacing the bundled tool.

The [LuaSteam source recipe](../src/modules/love/runtime/luasteam-source-overlay.js) checks the selected LuaSteam sources, LuaJIT API headers and Steamworks SDK headers independently, then stages their exact bytes in an owned build directory. The bridge binds the host's Lua 5.1 C API; it does not link a second Lua VM. Its [source package](../src/modules/love/runtime/luasteam-package.js) includes the MIT inputs and their notices, while recording the separately licensed Valve SDK inputs by revision and hash. SDK headers, SDK Readme and proprietary SDK libraries are excluded from that package. A new bridge version must retain the host Lua contract and pass the declared ABI checks before its catalog entry changes.

The inventory groups adaptations as follows. Exact revisions, nested dependencies, file hashes and test paths are in the JSON; this table describes their purpose.

| Projects | Owned integration or adaptation | Apply/build entry |
| --- | --- | --- |
| [Kawariki](https://github.com/Orochimarufan/Kawariki), [rpgmakermlinux-cicpoffs](https://github.com/bakustarver/rpgmakermlinux-cicpoffs) | Web compatibility scripts and RGSS Ruby overlay | [Web host](../src/modules/shared/web/runtime/nwjs-patched-launcher.js), [RGSS assets](../src/modules/rgss/assets.js) |
| [evbunpack](https://github.com/mos9527/evbunpack) | Packed executable extraction reference | [Packed RGSS](../src/modules/rgss/packaged.js) |
| [WolfDec](https://github.com/Sinflower/WolfDec) | Reference for independent WOLF DX archive parsing and container conversion; source and binaries are excluded from distribution | [WOLF archive reader](../src/modules/wolfrpg/archive.js) |
| MacLauncher [MKXP configuration helper](../src/modules/rgss/overlays/mkxpz-config.c) and [display metadata](../src/modules/rgss/overlays/mkxpz-identity.m) | Versioned per-launch configuration/CWD isolation and game display metadata; shared publisher runtime remains unchanged | [Builder](../scripts/stage-mkxpz-config-helper.cjs), [Loader/declaration](../src/modules/rgss/runtime/mkxpz-config-helper.js) |
| [MKXP-Z](https://github.com/mkxp-z/mkxp-z/tree/37a04d14413454551a7b6aadbb4e93e67168accb) | macOS path-cache filename normalization through CoreFoundation NFC; explicit malformed UTF-8 and capacity errors | [Pinned source overlay](../src/modules/rgss/overlays/mkxpz-filename-nfc/source.json), [owned build recipe](../scripts/build-mkxpz-nfc.cjs), [build catalog](../src/modules/rgss/runtime/owned-builds.json); distinct from installed publisher binaries |
| [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | Unmodified source; deterministic build properties, explicit version and neutral source paths | [Builder/source preparation](../src/modules/rgss/runtime/decrypter-build.js), [Build properties](../src/modules/rgss/runtime/decrypter-build.props), [Dependency targets](../src/modules/rgss/runtime/decrypter-build.targets) |
| [rpatool](https://codeberg.org/shiz/rpatool), [unrpyc](https://github.com/CensoredUsername/unrpyc), its [legacy branch](https://github.com/CensoredUsername/unrpyc/tree/legacy), [UnRen Gideon](https://github.com/VepsrP/UnRen-Gideon-mod-) | Python archive/decompiler compatibility shims | [UnRen imports](../src/modules/renpy/resources/unren/vendor.py) |
| [Universal RenPy Walkthrough](https://github.com/BCassO/universal-renpy-walkthrough) | Offline updater override | [RenPy actions](../src/modules/renpy/main.js) |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | AppKit build configuration; owned OpenGL helper | [Builder](../src/modules/gamemaker/runtime/butterscotch.js) |
| MacLauncher [graphics helper](../src/modules/gamemaker/overlays/software-opengl-v2.m) | Versioned software OpenGL helper for pinned official GameMaker runners | [Builder/adapter](../src/modules/gamemaker/runtime/opengl-fallback.js), [Version catalog](../src/modules/gamemaker/runtime/opengl-helper-versions.json) |
| MacLauncher offline Steam API and encrypted-ticket loader | Independent MIT implementations; fixed-width native/manual callbacks, local state and exact consumer contracts; ticket operations remain unavailable | [API source/build](../src/modules/shared/runtime/steamworks/native/offline-0.5.0), [Ticket source/build](../src/modules/shared/runtime/steamworks/native/ticket-0.1.0), [Catalogs and limits](runtimes/STEAM_API.md) |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK), [Ramen](https://github.com/viriuwu/ramen), [Udon](https://github.com/Adamcake/udon) | AppKit/OpenGL/CoreAudio, file/save/window compatibility, native extension guard, decompiler workspace | [Shared source recipe](../src/modules/gamemaker/overlays/opengmk-macos/source-build.js) |
| [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GameMaker HTML5](https://github.com/YoYoGames/GameMaker-HTML5) | Decompiler integration and export/version references | [GameMaker tools](../src/modules/gamemaker/tools.js), [HTML5 detection](../src/modules/gamemaker-html5/detect.js) |
| [goldberg-mac](https://github.com/squareloopthings/goldberg-mac), [gbe_fork](https://github.com/Detanup01/gbe_fork), [Abseil](https://github.com/abseil/abseil-cpp) | Legacy developer adaptation; SDK-based packages are excluded from the app distribution | [Source overlay](../src/modules/shared/runtime/steamworks/source-overlay.js), [Offline builder](../src/modules/shared/runtime/steamworks/build.js) |
| [LuaSteam](https://github.com/uspgamedev/luasteam), [LuaJIT](https://luajit.org) | Host Lua 5.1 linkage and exact native Steam bridge; proprietary SDK headers are separate developer inputs, excluded from its source package | [Source overlay](../src/modules/love/runtime/luasteam-source-overlay.js), [Builder](../src/modules/love/runtime/luasteam-build.js) |
| [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2), [KAG3](https://github.com/krkrsdl2/kag3) | Native storage/font/monitor bridge and bounded script integration | [Native bridge](../src/modules/kirikiri/native-compat.js), [Builder](../src/modules/kirikiri/build.js) |
| [PlayCover](https://github.com/PlayCover/PlayCover), [PlayTools](https://github.com/PlayCover/PlayTools) | Managed PlayCover releases (GPL-3.0), using their bundled PlayTools framework for unencrypted ARM64 IPA adaptation | [PlayCover version, release commit and archive hash](../src/modules/ios/runtime/catalog.js), [iOS integration](runtimes/IOS.md) |
| [Klepton](https://github.com/shinyquagsire23/Klepton), [dex2jvm](https://github.com/kksimp/dex2jvm) | Android Java/native host, APK conversion and shared graphics presentation | [Android builder](../src/modules/android/native/build.mjs), [Source pins](../src/modules/android/native/source-pins.json) |
| [AIM](https://github.com/hahnlee/aim) | ART host execution and original Android ELF transport; MacLauncher supplies app launch, shared services, presentation and isolated storage; process liveness includes the upstream exited-child correction from `60296444b08dca5c72f6f7bae098961337a746ca` | [ART supplier identity](../src/modules/android/art/supplier.json), [ART assembly recipe](../src/modules/android/art/build.mjs), [Process liveness patch](../src/modules/android/art/adapters/aim-process-liveness.patch) |
| [AIM APK reader](https://github.com/hahnlee/aim/tree/934009283f69c251f57ed95ef1dff296546bb6ad/crates/aim-apps) | Included standalone APK metadata helper using original binary XML, resource-table, raster, vector and adaptive-icon parsing; owned locale/split resource selection and JSON protocol; Apache-2.0 | [Pinned sources](../src/modules/android/native/apk-metadata/sources.json), [Adapter](../src/modules/android/native/apk-metadata/adapt.mjs), [Build](../src/modules/android/native/apk-metadata/build.mjs), [Protocol and source packaging](../src/modules/android/native/apk-metadata/README.md) |
| [smali dexlib2](https://github.com/google/smali) | Original DEX parsing/writing for exact ART platform delegates, including hidden-API metadata; BSD-3-Clause; build tool | [Artifact identities](../src/modules/android/art/dex-tools.json), [Delegation tool](../src/modules/android/art/dex-bodies.mjs) |
| [Android apksig](https://android.googlesource.com/platform/tools/apksig/) | Offline APK signature verification (Apache-2.0), official Google Maven artifact | [Artifact identity](../src/modules/android/native/apksig-binary.json), [License](../src/modules/android/native/notices/apksig/LICENSE) |
| Android [framework](https://android.googlesource.com/platform/frameworks/base) and [libcore](https://android.googlesource.com/platform/libcore) | Complete executable framework with precise JVM and native platform adaptations; original alarm JNI uses the shared timer descriptor owner | [Android source pins](../src/modules/android/native/source-pins.json), [Alarm native module](../src/modules/android/native/alarm/README.md), [Included notices](../src/modules/android/native/notices) |
| Android [libcore](https://android.googlesource.com/platform/libcore) and [ART](https://android.googlesource.com/platform/art) native Memory | Complete memory-operation units and native tables; JDK buffer and cleaner ownership | [Source pins](../src/modules/android/native/source-pins.json), [Native builder](../src/modules/android/native/libcore/build.mjs) |
| Android [Conscrypt](https://android.googlesource.com/platform/external/conscrypt) and [BoringSSL](https://android.googlesource.com/platform/external/boringssl) | Complete original Android JNI provider, crypto/TLS modules and CA roots using the OpenJDK/Darwin native ABI | [Source pins](../src/modules/android/native/source-pins.json), [Native builder](../src/modules/android/native/conscrypt/build.mjs) |
| Android [Apache HTTP legacy module](https://android.googlesource.com/platform/external/apache-http) | Complete `org.apache.http.legacy` implementation, including HTTP clients, codecs, logging and Android helpers; Apache-2.0 | [Original module builder](../src/modules/android/native/framework-modules.mjs), [Source pins](../src/modules/android/native/source-pins.json) |
| Android [StatsD](https://android.googlesource.com/platform/packages/modules/StatsD) | Original `service-statsd` Java implementation with shared framework dependencies; Apache-2.0 | [Original module builder](../src/modules/android/native/framework-modules.mjs), [Source pins](../src/modules/android/native/source-pins.json) |
| Android [Binder RPC](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/binder/) and [libutils](https://android.googlesource.com/platform/system/core/+/refs/heads/main/libutils/) | Original Binder/Parcel JNI, portable Binder SDK, IMemory/MemoryDealer and cutils property implementations; Darwin sockets, shared descriptor/memory ownership, property-provider calls and shutdown polling | [Builder and adapters](../src/modules/android/native/binder-rpc/build.mjs), [Source pins](../src/modules/android/native/source-pins.json) |
| Android [media framework](https://android.googlesource.com/platform/frameworks/av) | Original media formats, extractor and buffer algorithms, with typed native playback, VideoToolbox and CoreAudio integration; Apache-2.0 | [Media builder](../src/modules/android/native/media-foundation/build.mjs), [Source pins](../src/modules/android/native/source-pins.json) |
| [system3-sdl2](https://github.com/kichikuou/system3-sdl2), [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2), [xsystem4](https://github.com/nunuhara/xsystem4) | SDL runtime portability, executable-relative resources and versioned Mac graphics/shader adaptations | [System3 portable builder](../src/modules/alicesoft/system3-portable.js), [System3.5 portable builder](../src/modules/alicesoft/system35-portable-v3.js), [System4 portable builder](../src/modules/alicesoft/system4-portable-v3.js) |
| [sys3c](https://github.com/kichikuou/sys3c), [xsys35c](https://github.com/kichikuou/xsys35c) | Owned CMake tool build | [Decompiler builder](../src/modules/alicesoft/decompiler-build.js) |
| [FNA](https://github.com/FNA-XNA/FNA) and its nested libraries | Native OpenGL policy, ABI forwarders and generic managed host | [Builder](../src/modules/fna/runtime/build.js) |
| [HashLink](https://github.com/HaxeFoundation/hashlink), [SDL](https://github.com/libsdl-org/SDL), [OpenAL Soft](https://github.com/kcat/openal-soft) | Current upstream build plus separately pinned 1.9 codec/native compatibility | [Current builder](../src/modules/hashlink/runtime/build.js), [Legacy builder](../src/modules/hashlink/runtime/legacy-build.js) |
| [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) | Owned CMake/Cocoa Mac entry | [Builder](../src/modules/nscripter/runtime/onscripter-en-build-v3.js) |
| [ai5-sdl2](https://github.com/nunuhara/ai5-sdl2) and libai5 | Managed saves/graphics, archive/disc access and pinned portable dependencies | [Portable builder/applier](../src/modules/ai5/runtime/portable-build-v4.js), [earlier source adapter](../src/modules/ai5/runtime/build.js) |
| [libnpengine](https://github.com/FGRE/libnpengine), [libnpa](https://github.com/FGRE/libnpa) | Mac entry, private storage, NSS compiler/interpreter/object compatibility | [Builder/applier](../src/modules/nitroplus/runtime/build.js) |
| [GemRB](https://github.com/gemrb/gemrb) | Native CLI entry, shared scripting references and pinned SDL2/audio/Python closure | [Portable builder](../src/modules/gemrb/runtime/portable-build-v5.js), [guarded overlay](../src/modules/gemrb/runtime/portable-overlay-v5.js), [legacy builder](../src/modules/gemrb/runtime/build.js) |
| [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) | Compiled Lua profile and owned runtime wrappers in the managed VNDS package | [Profile verification/preparation](../src/modules/vnds/prepare.js) |
| [siglus_rs](https://github.com/xmoezzz/siglus_rs) | Upstream native runtime and pinned published assets | [Catalog](../src/modules/siglus/runtime/catalog.js) |
| [OpenBGI](https://github.com/Cytlan/openbgi) | Archive and compiled-program tools; no native interpreter | [VN engine notes](runtimes/VN_ENGINES.md) |
| [ReMinori](https://github.com/luoyily/ReMinori) | Original PAZ/PE profiles, macOS platform integration, private saves and versioned movie bridge | [Source overlay](../src/modules/minori/runtime/overlay.js), [native builder](../src/modules/minori/runtime/build.js), [movie builder](../src/modules/minori/runtime/movie-build.js) |
| [FelineSystem2](https://github.com/kokseen1/FelineSystem2) | Diagnostic Mac source adaptation; unresolved upstream license | [Diagnostic applier](../src/modules/catsystem2/runtime/port.js) |
| [Impacto](https://github.com/CommitteeOfZero/impacto), [avcpp](https://github.com/h4tr3d/avcpp), [LibAtrac9](https://github.com/Thealexbarney/LibAtrac9), [magic_enum](https://github.com/Neargye/magic_enum), [FFmpeg](https://ffmpeg.org), [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core) | Windows resource/script support, Mac portability, exact decoder ABI and pinned dependency overlays | [Builder](../src/modules/mages/native/current-build.js), [earlier Impacto applier](../src/modules/mages/native/adapter.js), [Dependency patch applier](../src/modules/mages/native/source-patches.js) |

Some apply checks intentionally stage only their declared source files and nested inputs. The report records that scope; a complete rebuild remains required. The VNDS source is MoonScript, while the shipped profile is compiled Lua: changing its source pin requires recompilation and regeneration of the profile manifest as well as its wrapper checks.

Android also supports [Mac.apk](https://github.com/kksimp/Mac.apk) publisher releases and
the pinned [AIM](https://github.com/hahnlee/aim) source submodule. Mac.apk versions
and artifact identities belong to its provider catalog. AIM's owned patches and
build entry preserve the pinned source checkout, while its supplemental payload
records exact binary checksums, dependencies and notices. Android system images
are acquired separately and excluded from MacLauncher distributions.

The Android GLES3 adapter also consumes three compile-time headers from the
existing nested `krkrsdl2/external/krkrz/external/angle` source at commit
`f82b1b4dc548dc8325ec83c11cd2363f3656a894`: `include/GLES3/gl3.h`,
`include/GLES3/gl3platform.h` and `include/KHR/khrplatform.h`. The builder and
stager verify their recorded bytes and retain their original paths in the source
archive, together with the Khronos MIT and SGI-B-2.0 notices. These declarations
do not replace or rebuild the separately recorded portable ANGLE binaries.

Node.js and Git are needed for these developer checks; their normal executables
may be on `PATH`. End users running packaged runtimes need neither tool. Build
prerequisites belong to each backend recipe.
