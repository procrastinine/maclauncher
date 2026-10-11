# Runtime distribution and release checks

A released app provides its advertised native backends through managed downloads or selected included packages, without requiring a Git checkout, compiler, Homebrew or development paths. Required downloads remain explicit actions, including confirmation when Play needs a missing runtime. Ordinary startup and catalog inspection stay offline.

## Distribution policy

Delivery balances app size, independent upstream version updates and automatic setup. Large external binaries favor managed downloads. Included builds can resolve difficult acquisition, authentication, patches or builds. Small scripts and stable tools carry less size/update cost; choices follow the needs of each dependency.

Working included and upstream binaries retain their supported formats, architecture, offline behavior and version choices. Compatible published artifacts are preferred over source builds. A build or replacement must provide a required capability or fix a concrete compatibility, portability or resource defect. Incomplete historical build records or lack of byte-identical reproducibility do not by themselves require replacing a working runtime. Artifact checksums, known publisher/source identities and required license notices remain explicit.

General internal import/extraction helpers, including Python, 7-Zip and evbunpack, are bundled dependencies with internal updates. Import requires no separate dependency download or setup prompt; these helpers have no Runtimes tabs or game runtime selection. Small owned cheat/integration scripts are included code and require no repeated network acquisition.

The universal Flash Player is a fixed included player that requires neither a download nor Rosetta. Ruffle remains a separately managed alternative. An older Intel-only projector download does not replace the included universal player. Delivery changes must preserve the required architecture, formats, native ABI, dependencies and macOS support; download availability alone is insufficient.

Larger versioned external game tools, including GDRE and other decompilers, follow the same managed delivery policy. Clicking an action checks for a compatible tool; a missing download prompts for consent, installs automatically and resumes the action. Installed tools are reused. Small archive/decompilation scripts, including RGSS readers and `.rgss3a` extractors, and appropriate MacLauncher custom tools are included directly. They need no separate version manager or download prompt.

- **Manage whenever feasible; download first.** Prefer managed downloads for interchangeable external binaries and new upstream releases. Ren'Py, Godot and public official GameMaker tools and runners follow this policy. Small scripts and long-stable tools may remain included when separate acquisition offers little benefit.
- Inclusion is justified when safely managing new upstream releases is infeasible, such as a backend requiring MacLauncher-specific patches, or when automatic setup is otherwise difficult, such as authentication or a nontrivial build. Small players/helpers requiring compilation can also be included.
- When no compatible macOS artifact is available, source builds are supported where feasible. Inclusion versus an automatic build depends on size, reliability, maintenance and required external tools. Easy builds with available prerequisites can remain managed; substantial setup or required adaptations can favor an included build.
- Download-first delivery makes usable new upstream releases easy to select and install. Patched backends keep their exact adapted builds distinct from stock releases; a new upstream binary does not automatically replace required adaptations. New adapted versions retain their source pins, patches and compatibility profile.
- Include only the minimum compatible versions and their required dependencies. Release catalogs, obsolete builds and unused architectures do not belong in the app. Generated native binaries travel in checksummed release assets, rather than bulk trees in Git; corresponding-source archives are distributed separately from the app.
- Runtimes tabs provide actual version/download/update management. Fixed built-ins without a feasible management flow stay out of those tabs; Settings retains their engine/runtime options, their runtime name/version remains in the inspector, and Play selects them automatically. Explicit version identities and compatibility profiles still apply.
- Management includes feasible automatic source builds: prerequisite installation with consent, source acquisition and compilation are handled by the app. An included fallback can coexist with this flow. Heavy MacLauncher-specific adaptations remain fixed built-ins when new upstream releases cannot safely replace them.
- MKXP-Z preserves the included publisher binary and full version management through optional authenticated GitHub Actions downloads. Ordinary play requires no `gh` authentication or source build. For other manageable backends, Refresh discovers releases and installation downloads the selected version with consent.

Selected immutable packages run directly from app resources, without an installation step or a second runtime copy. Source-build outputs use exact upstream pins and owned adaptations; [upstream maintenance](../UPSTREAMS.md) describes how to update and reapply them.

Managers declare `distributionRequired: true` only for explicitly selected included packages under this policy. A buildable source pin or a release catalog does not cause inclusion. FNA uses this contract because its adapted host includes FNA and native graphics/audio dependencies in addition to the .NET bootstrap. The existing `sourceOnlyManagers()` export retains its name for release-script compatibility and returns the explicitly selected required-package set.

[`distribution-model.cjs`](../../scripts/distribution-model.cjs) is the shared offline model for release payloads, app resource selection and packaging checks. It derives required versions, artifact architectures, supplemental resources and separate corresponding-source archives from module metadata. It also lists runtime delivery capabilities and module-to-host bindings. Downloads and catalog queries remain explicit actions; building this plan makes no network requests.

## Resource and installation contract

Generated packages live at `src/resources/native-runtimes/<managerId>/<version>/<arch>/`, with `manifest.json` and `files/`. Runtime helpers also accept the legacy `<managerId>/<arch>/` layout when its manifest matches the requested version. A corrupt or mismatched selected version fails explicitly. Several versions can coexist locally. The pre-pack hook selects only the distribution plan's required packages for `MacLauncher.app/Contents/Resources/native-runtimes/`, outside ASAR. Older local versions and unlisted directories are excluded. Runtime helpers resolve that resource location in packaged apps and the source resource directory during development. Production code never reads `.local/`.

The hook accepts Electron Builder's normalized resource rules: an omitted destination represents the resource root, just as `to: "."` does in the package declaration. Version filters remain explicit in either representation.

App verification compares the packaged `productName` and version with the distribution plan, together with the bundle identity in `Info.plist`. Electron Builder removes build-only configuration from the packaged `package.json`.

Managers can declare finite `distributionVersions` that all must be present. Otherwise the existing offline recommendation selects the required version. Release export and app packaging include exactly that set. Standalone verification and publication inspect every available local version by default; `--versions <version,version>` selects an explicit development set. Publication prepares every selected version before changing resources, verifies the complete result, and rolls the batch back on failure. Unrelated manager/version packages remain intact. Source, version, architecture and minimum-macOS checks apply independently to every package.

Modules can also declare `distributionSupplementals.path`, referencing a module-owned JSON inventory exported as `distributionSupplementals` by the module. Included build outputs retain their own layout and pin every file's bytes, mode, source identity, license notice, CPU slices and actual macOS floor. Full verification requires them; the complete payload archive publishes them in the same transaction as manager packages. Experimental GameMaker software graphics helpers are excluded. Explicit `--only` development verification continues to select manager packages alone.

An optional supplemental `redistribution: "local-only"` restricts a resource to local use. Release export, app packaging and final artifact checks reject it; its presence does not grant permission to distribute it. Other resources must still satisfy their individual license terms.

Supplemental source-packaging revisions are independent of native runtime versions. A revised Steam helper source archive records its explicit `packageVersion` and `sourcePackageVersion`; its unchanged runtime version, library checksum, source overlay and ABI profiles stay bound to the original native build. The selected package seal covers the revised archive and component notices together.

Supplemental native files normally cover every declared launcher CPU. An Intel-only file may explicitly declare `executionArchitecture: "x86_64"` for an Intel child, including under Rosetta in an ARM launcher. Its sealed architecture remains `x86_64`; the module must select an Intel host and request Rosetta before launch. This exception does not allow an Intel library to load into an ARM process. Payload import still verifies the actual native slices, bytes, signature and macOS floor.

The shared Steam helper lists native-code `version` and optional distribution `packageVersion` separately. A source-archive or notice correction gets a new package directory and manifest seal while retaining the unchanged library's code version, source revision, binary checksum and ABI profiles. Lookup validates the exact package identity and does not fall back to an older package. `sourcePackageVersion` records the corresponding-source archive revision.

An explicit `distributionArchitectures` map relates launcher architectures to actual runtime artifacts. For example, `{ "arm64": ["x64"], "x64": ["x64"] }` includes genuine Intel HashLink packages in an Apple Silicon launcher; manifests and Mach-O files remain `x64`/`x86_64`. The module separately requests Rosetta when launching. `{ "arm64": ["arm64"], "x64": [] }` declares a pinned ARM-only backend unavailable in Intel payloads; its catalog pin must also use `hostArchitectures: ["arm64"]` to gate Install and registration. Missing, malformed or entirely empty mappings fail instead of inventing artifacts. An explicit verification selecting no supported packages also fails. ARM/x64 launcher verification deduplicates the same explicitly shared runtime artifact.

[`bundled-native.js`](../../src/modules/shared/runtime/bundled-native.js) supplies shared resolution, integrity and installation helpers. A pinned manager uses `bundledExecution: "direct"` when its launch path keeps runtime resources read-only. `resolveRuntime` returns the exact executable in the sealed resource tree, with `source: "bundled"`, `readOnly: true` and `removable: false`. No `userData/runtimes` copy or registration is created. The runtime UI shows **Included**; the version remains selectable and needs neither Install nor Remove. Game configuration, caches, saves and extracted working files stay in private game storage.

Existing explicitly registered installations take priority for their exact selected version. A damaged registration fails instead of silently choosing the included executable. App resources are never removed by a runtime-uninstall action. Versions, source pins, architectures, ABI requirements and minimum macOS checks remain independent of execution policy; Intel-only packages still request Rosetta on Apple Silicon. Full payload and signature validation precedes direct execution.

Managers requiring writable runtime layouts retain the copy route. Explicit **Install** copies their selected package into `userData/runtimes/<managerId>/<version>/`, verifies the copied signatures, and publishes the completed directory atomically. No source checkout or download is used. `runtime.json` records the exact version/revision, executable and manifest checksums, minimum macOS and build evidence. Removing a runtime removes only this owned copy.

An included source-only catalog can set `distributionRequired: true` on the shared pinned manager. This keeps its exact `distributionVersions` in the app and source-archive plan even when local source compilation is disabled.

[MKXP-Z](MKXPZ.md) runs one shared executable/framework tree. Its included, sealed config helper redirects only the upstream app-config directory transition to each launch's tiny private config directory. Simultaneous games have independent configs, logs and process lifetimes; neither the global runtime nor per-game app trees are copied. RTP, Kawariki and the soundfont use immutable shared asset generations. Exact owned version selections retain priority, and damaged selections do not fall back. The shared helper executes directly from resources with no installation step.

The manifest identifies every payload file by relative path, size, SHA-256 and mode; Mach-O files also record architectures. It includes source/build provenance, executable location, dependency links and copied license notices. Full validation checks inventory, checksums, permissions, architecture and host macOS, rejects symlinks/traversal, and verifies signatures. Runtime selection before execution and explicit Reload check every payload file, including plugins, data, Python files and notices. A successful signature check is reused only while every native file retains the same identity; full byte checks still run before execution. A copied installation retains its manifest independently of the current app's resources, so an app upgrade does not invalidate an intact installation with the same catalog pin. These checks establish package integrity; format and gameplay compatibility remain engine-specific.

Ordinary `getState` broadcasts use `verification: "status"`: sealed manifest/registration checks plus a cached executable identity. Display caches use inode, size, mode and nanosecond modification/change times; changed records, manifests or executable bytes invalidate them. Validated manifests are bounded and cached separately, and validation indexes file paths once rather than repeatedly scanning the full inventory. Display does not claim a fresh auxiliary-file verification. A failed full check remains damaged in subsequent broadcasts; explicit Reload clears display caches and rechecks installed runtimes, allowing a repaired payload to become ready. Install, removal and registration also invalidate affected entries. The default `resolveInstalled` and `verifyInstalled` modes remain full validation, so backend callers cannot accidentally substitute a display result for launch integrity. FNA also caches profile display verification; execution continues to verify its complete profile and sealed dependency closure.

GemRB's embedded Python home is recorded as a relative payload directory. `resolveInstalledEnvironment` resolves only approved Python variables below the verified installation. GemRB sets them only for its child process, together with `PYTHONDONTWRITEBYTECODE=1`; it does not change the launcher's or system Python configuration.

AliceSoft packages include their upstream font files and licenses. `runtimeFiles` binds logical font names to checksummed payload files; `resolveInstalledAsset` returns only contained regular files. The launcher supplies these fonts by default, while an explicit per-game font setting retains priority. A complete runtime includes these required font assets.

## Host requirements

Each sealed manifest records its exact manager/version/source pin, CPU architectures and actual minimum macOS requirement. The installation UI reads that metadata; it does not infer package compatibility from the launcher’s own macOS 13 target or the compiler’s executable deployment flag. Engine guides document pinned profiles.

The checker reads every Mach-O’s load commands and rejects dependencies above the selected release floor or misleading manifest minimums. Incompatible dependencies require rebuilding; changing a binary header does not establish compatibility. App builds require the complete declared distribution set for their selected architecture.

Package limits are 20,000 files, 256 MiB per file and 1 GiB total.

## Preparing packages

For fresh-checkout app builds, [CI setup](../CI.md) describes exporting a complete pinned native payload archive, its explicit URL/checksum configuration, and verification before packaging. `scripts/native-payload.cjs` derives required manager/version/architecture identities and supplemental resources from module metadata, verifies all bundles before export and rejects partial or incorrectly pinned archives during import. It retains each sealed notice and file checksum; publishing a runtime asset remains separate from creating an app build.

Public package provenance contains logical source/build identities and Homebrew `tap/name` formula identities. Private `logPath` and `evidenceSource` fields are omitted; explicitly mapped build prefixes become logical identities, and other remaining private paths stop staging. Verification rejects sealed manifests that still contain fields the public projection would remove; they must be restaged before publication or export. Source/hash identities remain verifiable while sealed file hashes bind the sanitized payload bytes.

The staging input's `provenancePathMappings` accepts `{ "from": "/absolute/build/prefix", "to": "${SOURCE_ROOT}" }` records. Compiler options retain their exact values with those symbolic prefixes. Map specific source, build and dependency prefixes; replacing a broader repository prefix must not leave private `.local/` components behind. Sanitized Homebrew metadata keeps `source.formula` and `source.pkg_version`, without publishing its local `source.path`.

Inspect embedded build paths in native files and installed configuration before sealing, as well as manifest metadata. Make diagnostic source paths logical during compilation and normalize generated build metadata before compiling. The public audit checks per-user macOS temporary directories and distinguishes local build paths from upstream build context while redacting their values. Any retained private build paths require a source rebuild and a new pinned seal; editing sealed executable bytes does not preserve the package's build provenance.

`scripts/stage-native-runtimes.cjs` accepts an explicit JSON build inventory. Each package selects a known manager/version, clean pinned `sourceRoot`, actual executable path and expected original SHA-256. Add `appRoot` for an app bundle, extra `payloads` for runtime data, explicit `extraLibraries` for dependencies loaded dynamically, and `notices` containing actual license files, license labels and primary source URLs. Existing build-record tree/overlay hashes and configure options can be carried in `provenance`; do not label an unrelated executable as a verified source build.

Independent Git dependencies can use `additionalSources`: up to 16 unique `{ id, upstreamRevision, sourceTreeSha256, sourceRoot }` inputs. Their exact identities must also appear in the catalog pin and public provenance, without `sourceRoot`. Every checkout and complete tree is checked before native reads and again before sealing; linked, overlapping, missing, extra or changed roots fail. The primary `sourceTreeSha256` continues to identify the primary tree. A combined multi-tree digest can be recorded separately and does not replace these individual checks.

Non-app hosts can set a safe `executableRelative` to preserve a required directory layout. FNA selects `fna/dotnet` and copies the matching `host/`, `shared/`, managed framework, host and native libraries beneath `fna/`. Ordinary executables retain the `bin/<name>` default. App-bundle executable paths cannot be redirected. Distribution relocation/signing can change native bytes: FNA verifies the sealed whole-payload manifest's final hashes, including the retained source/framework profile metadata, instead of accepting the profile's pre-relocation native hashes. See [FNA native host](FNA.md) for its installation and compatibility limits.

```json
{
  "packages": [{
    "managerId": "butterscotch",
    "version": "d66464857303-appkit",
    "sourceRoot": "src/external/Butterscotch",
    "executable": "/absolute/path/to/butterscotch",
    "expectedInputSha256": "<64-character SHA-256>",
    "notices": [{
      "file": "src/external/Butterscotch/LICENSE",
      "name": "Butterscotch",
      "license": "AGPL-3.0-only",
      "sourceUrl": "https://github.com/ButterscotchRunner/Butterscotch/tree/d66464857303a2840a5cc5141c0035440847f441"
    }]
  }]
}
```

Include notices for statically linked components as well as dynamic libraries. The example is a schema illustration, not a complete Butterscotch notice inventory. The stager records Homebrew dependency versions and copies their license files; missing notices require explicit input files. Component notices come from their corresponding upstream sources. Source files and installed libraries remain untouched.

```sh
# Stage the selected native artifacts.
node scripts/stage-native-runtimes.cjs \
  --config .local/runtime-distribution/input.json \
  --only krkrsdl2,butterscotch,gm8-decompiler --maximum-macos 13.0

# Publish only the explicitly selected, verified packages into app resources.
node scripts/publish-native-runtimes.cjs \
  --source .local/runtime-distribution/staged \
  --only krkrsdl2,butterscotch,gm8-decompiler --maximum-macos 13.0

node scripts/verify-native-runtimes.cjs \
  --only krkrsdl2,butterscotch,gm8-decompiler --arch arm64
```

Omitting `--only` requires every explicitly included manager. `--arch x64` stages Intel builds independently; verification accepts `--arch arm64,x64` for a universal launcher. Source revision mismatches, dirty tracked source, missing submodules, changed input checksums, unresolved library paths, wrong architectures, missing notices and excessive macOS floors stop the operation. Failed staging preserves the previously published package.

The stager walks app plugins and extra runtime payloads, recursively closes non-system Mach-O dependencies, rewrites only copied binaries to contained `@loader_path` links, signs those copies, and computes final checksums. Source app aliases are flattened; an unused dangling dylib alias is omitted, while an actual missing dependency still fails. SDL2-compat loads SDL3 through `dlopen`, which is absent from `otool -L`; the explicit SDL3 companion is placed beside it, following the [upstream loader](https://github.com/libsdl-org/sdl2-compat/blob/main/src/sdl2_compat.c). Embedded Python includes matching standard-library/extension payloads, not just the Python library.

`thinToTargetArchitecture: true` can remove unneeded Mach-O slices from staging copies. Dependency discovery follows the selected CPU's load commands; a missing slice fails. Original inputs retain their bytes and modes. The generated `provenance.nativeThinning` records each copied file's original and thinned checksum, byte length and CPU. Relocation, minimum-macOS checks, signing and final payload seals still apply afterwards.

## Corresponding-source archives

Runtime catalog entries and supplemental native declarations can declare a `sourceArtifact` with a versioned relative filename, exact SHA-256 and byte length. `scripts/native-payload.cjs` requires those complete source archives when exporting or importing their release inputs. A supplemental helper can provide its complete source separately instead of embedding build inputs in the app. Missing, changed or mismatched sources fail validation. Native resources and corresponding-source storage must be separate directories.

Source archives are stored under `src/resources/native-runtime-sources/`, outside the app's resource filters and ignored by Git. They travel inside the checksummed build-input payload under `native-sources/`. CI exports them as the separate `MacLauncher-runtime-sources.tar.gz` release asset, with an inner source inventory and an outer checksum in `SHA256SUMS.txt`. The installed app contains the player and notices, without these source archives. `--sources <directory>` selects another source-archive location for explicit export/import commands.

The System3 `1.8.0-macos-v2` source archive contains its exact upstream and YMFM Git bundles, all six dependency source archives, module-owned build adapters, notices and offline rebuild instructions. Source publication must still cover each other distributed component's license requirements; the launcher source archive alone does not include upstream submodule contents.

## Packaging and signing

`scripts/package-mac.mjs` runs the shared packaging checker before the app build. The default requires all declared packages for the requested architecture and a maximum native macOS requirement of 13.0. Missing inputs fail before expensive packaging begins. App builds do not accept a runtime subset.

```sh
# ARM64 package with macOS 13-compatible runtimes.
pnpm run package:mac --arm64

# Optional higher runtime floor for a development package.
pnpm run package:mac --arm64 --runtime-maximum-macos 27.0
```

An explicit higher maximum permits dependencies above the default macOS 13 floor. It leaves the launcher's global minimum unchanged; each runtime still enforces its actual host requirements.

Native package signing happens **before** manifest checksums are finalized. Stage signed releases using `--sign-identity '<Developer ID Application identity>'`; pass the same identity through `--runtime-sign-identity`, `MACLAUNCHER_RUNTIME_SIGN_IDENTITY` or `CSC_NAME` when packaging. The packager's `mac.signIgnore` preserves sealed `native-runtimes/` packages and the original Flash Player bundle, retaining their bytes and signatures while the outer app seals its resources. Ad hoc packages support unsigned development distribution; Developer ID signing/notarization requires independent release validation. Do not edit a signed payload or update its hashes after sealing the app—restage and rebuild it.

Electron Builder's ordinary resource copy can normalize restrictive modes and omit declared regular resource markers. The generic `scripts/native-copy.cjs` restoration runs before app signing: it checks the module catalogs and original sealed inventories, rejects unlisted paths and changed copied bytes, then restores only missing declared files and exact modes. It preserves source manifests and native signatures. Full verification after signing must still match the pinned archive; no repair occurs after the outer app is sealed.

Copied notices and source pins are not an automatic license-compliance determination. Release source distribution must include the corresponding upstream source and module-owned overlays/build instructions required by its licenses. Proprietary GameMaker runner/bootstrap files are excluded from these bundles; the separate pinned official installer obtains vendor packages only on explicit Install. See [GameMaker workflows](GAMEMAKER.md).

## Deterministic packaging checks

These checks are required for every release and run in the [macOS workflow](../CI.md). Use the exact architecture, permitted native macOS floor and payload inventory for the app being built.

```sh
# Inspect the offline delivery plan.
pnpm package:check -- plan --arch arm64 --maximum-macos 13.0

# Check source resources before building.
pnpm package:check -- source --arch arm64 --maximum-macos 13.0

# Check the final app and its zip against the same payload inventory.
pnpm package:check -- app --arch arm64 --maximum-macos 13.0 \
  --app /path/to/MacLauncher.app \
  --inventory /path/to/native-payload-inventory.json \
  --archive /path/to/MacLauncher.zip --sha256 <exact-zip-SHA256>
```

Source checks exercise Electron Builder's actual resource filters and validate required native files, versions, CPU slices, macOS floors, signatures, notices and corresponding-source archives. Final checks require the app's exact identity/version and sealed payload, reject excluded files and duplicate runtime trees, and allow only contained relative app/framework links. ASAR metadata and aliases are checked for bounded sizes, missing targets, cycles and external paths. Zip checks stream every file and link against that app, checking content, size and permissions without creating an extracted copy. The generated `distribution-plan.json` and `packaging-checks.json` accompany CI release artifacts. These deterministic checks supplement source review and actual app testing.

## Runtime inventory

“Direct” below applies to a complete pinned package present in the release for the selected version, architecture and host OS. It does not imply that every upstream release or game format is supported. Module catalogs and sealed manifests list the actual versions and options. Downloaded alternatives and explicit user registrations retain their managed installation paths.

| Runtime or tool | Bundled behavior | Writable or downloaded state | Code and provenance |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron): web, MV/MZ, Construct, Tyrano, GameMaker HTML5 | Built-in host; no runtime install | Private per-game storage and necessary extracted assets | Launcher dependency pin; owned [web host](../../src/modules/shared/web) and module adapters |
| [NW.js](https://github.com/nwjs/nw.js) | Downloaded alternative host | Selected app/SDK version under user data; optional exact Greenworks pairing | Owned [download and launch code](../../src/modules/shared/web/runtime) |
| [Ren'Py](https://github.com/renpy/renpy) SDK and patch modes | Exact SDK download is required | Versioned SDK; global SDK Live2D integration; patch mode copies matching Mac libraries into the private game overlay | Pinned upstream source reference and owned [SDK/patch code](../../src/modules/renpy/runtime), [Live2D integration](RENPY_LIVE2D.md) |
| [MKXP-Z](https://github.com/mkxp-z/mkxp-z) | Included pinned shared binary; no app copies or required install | Tiny private launch configs and immutable shared asset generations; optional GitHub Actions versions remain available through `gh` | [Binary input pin and offline stager](MKXPZ.md); owned config helper, no source submodule or verified-source-build claim |
| [Godot](https://github.com/godotengine/godot) | Exact downloaded native runtime | Version/architecture-specific app; original PCK reads and private game working files | Owned [manager](../../src/modules/godot/runtime) |
| [LÖVE](https://github.com/love2d/love), including [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) | Exact downloaded native runtime; VNDS adapter shared directly from app resources | Runtime app under user data; per-game saves, session settings and necessary audio conversions | Owned [manager](../../src/modules/love/runtime); pinned VNDS source and [adapter](../../src/modules/vnds) |
| [Eclipse Temurin](https://adoptium.net/) Java | Exact downloaded JDK/JRE | Managed Java home and game working directory | Owned [manager](../../src/modules/java/runtime) |
| [Ruffle](https://github.com/ruffle-rs/ruffle) | Exact downloaded runtime | Managed app; original SWF reads | Owned [manager](../../src/modules/flash/runtime) |
| [Adobe Flash projector](https://www.adobe.com/products/flashplayer/end-of-life.html) | Legacy bundled app executes in place | No runtime-install step | Existing module resource; proprietary vendor terms |
| [Official GameMaker](https://gamemaker.io/) runner and Igor | Vendor download or exact local import | Separately versioned Igor/runners; private per-game runner app and saves | Owned [installer/version/ABI code](../../src/modules/gamemaker/runtime); proprietary packages are excluded from native payloads |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | Direct | Private save folder and game working files | Pinned upstream AppKit implementation and owned [builder](../../src/modules/gamemaker/runtime/butterscotch.js) |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK) | Direct | Private writes, extracted included files and copy-on-write highscore data | Pinned source/dependencies; owned [AppKit/OpenGL/CoreAudio overlays and offline build recipe](../../src/modules/gamemaker/overlays/opengmk-macos) |
| [GM8Decompiler](https://github.com/OpenGMK/OpenGMK) | Direct | Private project-export output | Same pinned source; explicit `gm8decompiler` target in the [offline recipe](../../src/modules/gamemaker/overlays/opengmk-macos/source-build.js) |
| [UndertaleModTool CLI](https://github.com/UnderminersTeam/UndertaleModTool) | Downloaded exact native CLI | Private GML/export output | Pinned source reference and [hashed Mac artifact catalog](../../src/modules/gamemaker/runtime/catalog.js) |
| [FNA/XNA host](https://github.com/FNA-XNA/FNA) | Direct complete managed/native profile | Managed game conversion and saves stay private; downloading .NET alone is insufficient | Pinned FNA source and [public profile builder](../../src/modules/fna/runtime/build.js), owned managed host and native graphics/audio code |
| [HashLink](https://github.com/HaxeFoundation/hashlink) | Direct genuine Intel packages; Rosetta when needed | Private per-game overlay; original bytecode/resources read in place | Pinned source/OpenAL and [profile builders](../../src/modules/hashlink/runtime), including exact native-module ABI checks |
| [KiriKiri SDL2](https://github.com/krkrsdl2/krkrsdl2) | Direct | Private script overlays and explicit save-data path | Pinned source/submodules/KAG3; owned [builder and compatibility overlays](../../src/modules/kirikiri) |
| AliceSoft [System 1–3](https://github.com/kichikuou/system3-sdl2) | Direct, including font assets | Explicit private save directory | Pinned source and [build adapter](../../src/modules/alicesoft/build.js) |
| AliceSoft [System 3.5–3.9](https://github.com/kichikuou/xsystem35-sdl2) | Direct, including font assets | Explicit private save directory | Pinned source and [build adapter](../../src/modules/alicesoft/build.js) |
| AliceSoft [System 4](https://github.com/nunuhara/xsystem4) | Direct, including font assets | Explicit private save directory | Pinned source/libsys4 and dependency archives; owned [portable Meson/source builder](../../src/modules/alicesoft/system4-portable.js) |
| AliceSoft [sys3c](https://github.com/kichikuou/sys3c) / [xsys35c](https://github.com/kichikuou/xsys35c) | Both decompilers direct | Private script-export outputs | Pinned sources; owned [CMake build overlay](../../src/modules/alicesoft/decompiler-build.js) |
| [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) | Direct | Private configuration, save files and font/disc work | Pinned source/libai5/nulib; owned [Mac path/disc/encoding builder](../../src/modules/ai5/runtime/build.js) |
| [Impacto](https://github.com/CommitteeOfZero/impacto) Windows adapter | Direct pinned Windows data profile | Private session/configuration and working files | Pinned source and dependency archives; owned [Windows/Bink2 build and codec probe](../../src/modules/mages/native) |
| [libnpengine](https://github.com/FGRE/libnpengine) | Direct | Private save/cache/configuration paths; originals read in place | Pinned engine/libnpa sources; owned [Mac archive/path/text builder](../../src/modules/nitroplus/runtime/build.js) |
| [ReMinori](https://github.com/luoyily/ReMinori) | Direct selected PAZ profile on Apple Silicon, macOS 13+ | Original archives/PE read in place; private saves, configuration, script exports and movie cache | Pinned Rust source and owned [macOS/PAZ builder](../../src/modules/minori/runtime/build.js), [FFmpeg 7.1.2 movie builder](../../src/modules/minori/runtime/movie-build.js) |
| [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) | Direct | Private working directory and save path | Pinned source/SDL archives; owned [Mac compatibility builder](../../src/modules/nscripter/runtime/onscripter-en-build.js) |
| [Onscripter Yuri](https://github.com/YuriSizuku/OnscripterYuri) native / Web | Native pinned package direct; Web download separate | Native game/save working files; versioned Web archive under user data | Pinned engine and complete dependency sources; owned [portable builder](../../src/modules/shared/onsyuri/runtime/portable-build-v3.js) and [version catalog](../../src/modules/shared/onsyuri/runtime/portable-versions.json) |
| [RLVM](https://github.com/eglaysher/rlvm) | Managed upstream Mac download; small Cocoa launch adapter included | Play downloads with consent; 0.14 uses Rosetta on Apple Silicon, macOS fonts and separate per-game saves; no compiler or Python setup | [Catalog](../../src/modules/siglus/runtime/rlvm-catalog.js), [adapter source and build identity](../../src/modules/siglus/resources/rlvm-adapter) |
| [siglus_rs](https://github.com/xmoezzz/siglus_rs) | Direct only when a complete pinned optional profile is supplied | Otherwise download the exact library and assemble the owned host profile under user data; private game/cache/saves | Pinned source/artifact and [host/profile code](../../src/modules/siglus/runtime) |
| [GemRB](https://github.com/gemrb/gemrb) | Direct, with read-only embedded Python | Private configuration/cache/save paths; Python bytecode writes disabled | Separate complete corresponding-source archive and [portable CLI/Python builder](../../src/modules/gemrb/runtime/portable-build-v4.js) |
| [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO) | Pinned downloaded artifact | Managed executable and private game configuration | Owned [catalog/manager](../../src/modules/ikemen/runtime) |
| [Unity Mono player](https://unity.com/releases/editor/archive) | Exact matching vendor component download | Private per-game app/plugin assembly; original game data reads | Owned [version/profile/downloader code](../../src/modules/unity); proprietary player packages are not in Git |
| Native game `.app` | Original app runs directly | Explicit quarantine repair when requested | Owned [generic app module](../../src/modules/generic-app) |
| Archive/decompile helpers: [7-Zip](https://www.7-zip.org/), [Python](https://github.com/python/cpython), [UnRen](https://github.com/VepsrP/UnRen-Gideon-mod-), [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | Existing bundled tool resources are used in place | Private extraction/decompilation outputs | Preserved source/tool notices and owned wrappers; decrypter [pinned source/toolchain recipe](../../src/modules/rgss/runtime/decrypter-build.js) uses mapped paths and explicit upstream identity; [attributions](../ATTRIBUTIONS.md) |
| Experimental software graphics helper | Excluded from the app | Explicit local helper selection for supported runner profiles | Owned [helper source](../../src/modules/gamemaker/overlays/software-opengl.m) and [builder/adapter](../../src/modules/gamemaker/runtime/opengl-fallback.js) |
| Supplemental MacLauncher offline Steam API and ticket loader | Included universal libraries are read from sealed resources | Private local state; exact consumer profiles; tickets and online services remain unavailable | Independent MIT [API source/build](../../src/modules/shared/runtime/steamworks/native/offline-0.5.0) and [ticket source/build](../../src/modules/shared/runtime/steamworks/native/ticket-0.1.0); separate complete source archives; [contracts](STEAM_API.md) |
| Supplemental [LuaSteam](https://github.com/uspgamedev/luasteam) bridge | Included universal bridge is read from sealed resources | Private game configuration; binds the selected LÖVE host's Lua VM and the separately versioned Steam API helper | Pinned source and [owned builder](../../src/modules/love/runtime/luasteam-build.js); MIT core/header notices and source accompany the bridge, with external SDK input identities recorded separately |
| Supplemental [steamworks4j](https://github.com/code-disaster/steamworks4j) JNI and owned Java loader | Included exact 1.9 Intel or 1.10 universal bridge; no install or compiler | Private loader config/state and JNI hardlinks; protected/cross-volume layouts clone or copy only the small JNI, with Intel JVM/Rosetta when required | Exact publisher/class/native hashes, owned loader source and MIT notices; [Java bridge contracts](JAVA_STEAM.md) |
| Supplemental CatSystem2 KIF cipher helper | Included universal executable runs directly; no install or compiler | Explicit private archive/script exports; original archives and keys stay outside the package | Owned MIT [CommonCrypto source and sealed build recipe](CATSYSTEM2.md); exact version, source, binary, CPU and minimum-OS inventory |
| Supplemental MKXP-Z config helper | Included universal library is read from sealed resources | Redirects the selected child's app-config lookup to its unique private session; simultaneous games share unchanged runtime files | Owned [config adapter](../../src/modules/rgss/overlays/mkxpz-config.c), [builder](../../scripts/stage-mkxpz-config-helper.cjs) and [exact supplemental inventory](../../src/modules/rgss/runtime/distribution-supplementals.json) |

Optional [GDRE](https://github.com/GDRETools/gdsdecomp), [ILSpy](https://github.com/icsharpcode/ILSpy) and [Vineflower](https://github.com/Vineflower/vineflower) use separately managed, versioned tools and private export output. BGI and [CatSystem2](CATSYSTEM2.md) tools/source references do not advertise an included playable runtime; archive decoding and diagnostic builds remain separate from gameplay support. [Minori](MINORI.md) supports only its listed PAZ profiles; other encryption and VM editions remain unsupported.

Download catalogs do not establish gameplay compatibility. They retain their provider, version, architecture and installation checks. Platform or source availability restrictions must be visible in catalog state rather than advertising a Build action which requires a missing `.git` checkout.

Downloaded LÖVE and NW.js app bundles validate their executable, framework aliases and any present signature-resource directories before publication and selection. App copies preserve relative symlinks, permissions and file bytes; contained absolute aliases are made relative only in the copy. Broken, cyclic or escaping links mark an installation damaged instead of satisfying Play preparation. Unsigned upstream bundles remain supported; these layout checks do not sign or certify them. Extraction folders can be removed without leaving installed aliases dependent on temporary paths.

Explicit downloaded MKXP-Z installations, Java homes, Ren'Py SDK library copies and the Greenworks/Web download copies also preserve relative symlink text. Raw SDK/library copies retain configured external references; app-bundle confinement is a separate check. Default MKXP-Z Play uses the unchanged shared app directly.

## Source and build recipes in Git

Git records upstream repository locations and exact submodule commits, module catalogs, owned overlays/builders, dependency download hashes, tests and distribution schemas. `src/external/` remains read-only. Builders copy the selected upstream input into an owned build directory before applying patches; changing a local vendored file is not the update workflow. [Upstream maintenance](../UPSTREAMS.md) provides the machine-readable inventory, offline identity check and update/repatch procedure.

A native builder that does not use any upstream submodules can declare a catalog-bound `sourceScope` with `kind: "primary-tree"` and the exact paths of every direct Git submodule. This scope retains the parent commit, all primary files including `.gitmodules`, and each omitted submodule's path and commit in provenance. It neither initializes those unused dependencies nor permits arbitrary file exclusions. Builds without this explicit scope continue to require the complete recursive source checkout.

Generated native packages belong in the pinned versioned release payload, not as bulk binary trees in Git. [CI](../CI.md) imports that archive using an explicit URL and SHA-256, verifies its full contents against this checkout's catalogs and then packages the app. The binary-only MKXP-Z input has its own exact publisher tree/executable hashes and offline staging recipe; it makes no source-build claim. Vendor SDKs and game assets are separate inputs and are never inferred from a developer's local installation.

Official RGSS RTP packs are managed downloads and are excluded from Git, the app and launcher source archives. Play acquires the required pack from the pinned publisher catalog.

The linked builders and required recipes are public module code. The OpenGMK recipe supports both the emulator and decompiler from an extracted checksummed corresponding-source package, with Cargo offline. ONScripter-EN and FNA declare exact source/tool archives in their public `PACKAGES` inventories; MAGES separately binds dependency overlay hashes and exercises the compiled decoder. Portable CMake/Ninja archives have explicit version/checksum pins in [shared build tools](../../src/modules/shared/runtime/native-build-tools.js). Use an owned native-disk build directory for compiler outputs; game/source inputs can remain on a shared volume.

Other builders use installed native dependency prefixes. Their complete pinned library closure, actual versions, hashes, notices and corresponding sources must accompany the release build inventory. A pinned engine commit alone does not reproduce those dependencies, and a valid package seal does not imply a reproducible build. Compiler/SDK versions, overlay/tree/lock hashes and configured options stay in build provenance. Upstream build dates and relocation/signing can change executable bytes; the final manifest always seals the actual output. Required corresponding source and owned patch/build instructions must be available with the matching release under each upstream license.

Review SDK header inputs, compiled libraries and corresponding-source archives separately before public export. An upstream mirror or a component's MIT/LGPL license does not establish permission for separately licensed SDK material. Preserve each component's notices and record its distribution basis; the [Steamworks SDK attribution](../ATTRIBUTIONS.md) identifies the retained Valve headers and external developer inputs.

## Payload verification

CI archives require an explicit launcher architecture and maximum native macOS floor. They include `native-payload.json`, checksummed manifests and regular payload files, with every currently required canonical version and declared supplemental resource. The import checks the archive SHA before extraction, validates the inventory against this checkout's module catalogs and architecture maps, verifies every file and native signature/load command, then uses the transactional publication helper. No `--only` subset is available in this path. An archive pinned for older source pins or without a newly required profile fails until it is rebuilt and explicitly configured.
